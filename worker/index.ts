/**
 * SafeStride Worker: serves the static PWA (out/) and the emergency API.
 *
 *   POST /api/emergency/trigger     start a session + SMS the contacts
 *   GET  /api/track/:id             follower view polls this
 *   POST /api/track/:id             owner device pushes a GPS fix
 *   POST /api/track/:id/resolve     owner ends the alert with the Safety PIN
 *
 * One Durable Object per session holds its state; an alarm deletes it after
 * SESSION_TTL_MS so live location is never kept longer than needed.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ASSETS: Fetcher;
  TRACK: DurableObjectNamespace<TrackSession>;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** E.164 SMS sender, e.g. +447700900123 (a Twilio number that can send SMS) */
  TWILIO_SMS_FROM?: string;
  /**
   * Textbelt key. "textbelt" is the public key: one free text per day, no
   * signup — enough to demo a real SMS arriving on a phone.
   */
  TEXTBELT_KEY?: string;
  /** Override the Twilio API host. Only for pointing at a local mock in tests. */
  TWILIO_BASE_URL?: string;
  /**
   * textbee.dev key: free tier texts through your own Android phone's SIM
   * (300 messages/month), no card. Used when Twilio is not configured.
   */
  TEXTBEE_API_KEY?: string;
  /** Override the textbee host. Only for pointing at a local mock in tests. */
  TEXTBEE_BASE_URL?: string;
  /** Minutes between automatic position texts while an alert is active. */
  SMS_UPDATE_MINUTES?: string;
  /** Origin used in the tracking link sent to contacts, e.g. https://safestride.example.workers.dev */
  PUBLIC_ORIGIN?: string;
}

const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_UPDATE_MINUTES = 10;
const MAX_UPDATES = 12; // caps what one alert can spend on update texts
const MAX_TRAIL = 240;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;
const ID_RE = /^[a-z0-9]{24}$/;

type Point = { lat: number; lon: number; ts: number };

type Stored = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "safe";
  ownerName: string;
  contactNames: string[];
  /** Kept for the life of the alert so the follow-up texts can reach them. */
  contacts: Contact[];
  trackUrl: string;
  updateMinutes: number;
  updatesSent: number;
  target: { name: string; lat: number; lon: number };
  last: Point | null;
  trail: Point[];
  ownerKeyHash: string;
  pinSalt: string;
  pinHash: string;
  attempts: number;
  lockedUntil: number;
  resolvedAt: string | null;
};

export type PublicSession = Omit<
  Stored,
  "ownerKeyHash" | "pinSalt" | "pinHash" | "attempts" | "lockedUntil" | "contacts"
>;

// ---------- helpers ----------

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return hex(b);
}

function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
}

async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/**
 * UK-friendly E.164: "07700 900123" -> "+447700900123". Done server-side too,
 * so a client that forgets to normalise can't silently send to nobody.
 */
function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.replace(/[\s()-]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^0\d{9,10}$/.test(p)) p = "+44" + p.slice(1);
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

const isLat = (n: unknown): n is number => typeof n === "number" && n >= -90 && n <= 90;
const isLon = (n: unknown): n is number => typeof n === "number" && n >= -180 && n <= 180;
const cleanText = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The SOS SMS protocol. One alert is up to three kinds of text:
 *   ALERT  — sent by trigger() the moment SOS is pressed
 *   UPDATE — repeated by the session's own alarm while it stays active
 *   SAFE   — sent by the resolve route when the Safety PIN ends the alert
 * `plain` variants drop URLs for the free Textbelt key, which refuses links.
 */
function londonClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

function updateMessages(s: Stored, ms: number): { full: string; plain: string } {
  const time = londonClock(ms);
  const p = s.last;
  const at = p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : "an unknown position";
  const away = p ? metresBetween(p, s.target) : null;
  const near = away != null ? `, ${away}m from ${s.target.name}` : "";
  return {
    full: `SafeStride UPDATE ${time}: ${s.ownerName} is at ${at}${near}. Live: ${s.trackUrl}`,
    plain: `SafeStride UPDATE ${time}: ${s.ownerName} is at ${at}${near}.`,
  };
}

function safeMessages(
  ownerName: string,
  ms: number,
  last: Point | null
): { full: string; plain: string } {
  const time = londonClock(ms);
  const at = last ? ` near ${last.lat.toFixed(5)},${last.lon.toFixed(5)}` : "";
  return {
    full: `SafeStride SAFE ${time}: ${ownerName} marked themselves safe${at}. Live tracking has stopped.`,
    plain: `SafeStride SAFE ${time}: ${ownerName} marked themselves safe${at}. Live tracking has stopped.`,
  };
}

async function sendToContacts(
  env: Env,
  contacts: Contact[],
  msg: { full: string; plain: string }
): Promise<void> {
  const body = onFreeTextbelt(env) ? msg.plain : msg.full;
  await Promise.all(
    contacts.map((c) => sendSms(env, c.phone, body).catch(() => undefined))
  );
}

// ---------- Durable Object ----------

export class TrackSession extends DurableObject<Env> {
  async init(record: Stored): Promise<boolean> {
    if (await this.ctx.storage.get("s")) return false;
    await this.ctx.storage.put("s", record);
    const firstUpdate = Date.now() + record.updateMinutes * 60_000;
    await this.ctx.storage.setAlarm(Math.min(firstUpdate, Date.now() + SESSION_TTL_MS));
    return true;
  }

  async read(): Promise<PublicSession | null> {
    const s = await this.ctx.storage.get<Stored>("s");
    if (!s) return null;
    const { ownerKeyHash, pinSalt, pinHash, attempts, lockedUntil, contacts, ...pub } = s;
    void ownerKeyHash, pinSalt, pinHash, attempts, lockedUntil, contacts;
    return pub;
  }

  async push(ownerKey: string, point: Point): Promise<"ok" | "forbidden" | "gone" | "closed"> {
    const s = await this.ctx.storage.get<Stored>("s");
    if (!s) return "gone";
    if (!safeEqual(await sha256(ownerKey), s.ownerKeyHash)) return "forbidden";
    if (s.status !== "active") return "closed";
    s.last = point;
    s.trail = [...s.trail.slice(-(MAX_TRAIL - 1)), point];
    await this.ctx.storage.put("s", s);
    return "ok";
  }

  async resolve(ownerKey: string, pinVerifier: string): Promise<{
    ok: boolean;
    error?: string;
    retryAfterS?: number;
    left?: number;
    /** Present on a real transition, so the route can send the SAFE text. */
    contacts?: Contact[];
    ownerName?: string;
    last?: Point | null;
  }> {
    const s = await this.ctx.storage.get<Stored>("s");
    if (!s) return { ok: false, error: "gone" };
    if (!safeEqual(await sha256(ownerKey), s.ownerKeyHash)) return { ok: false, error: "forbidden" };
    if (s.status === "safe") return { ok: true };

    const now = Date.now();
    if (s.lockedUntil > now) {
      return { ok: false, error: "locked", retryAfterS: Math.ceil((s.lockedUntil - now) / 1000) };
    }

    const hash = await sha256(`${s.pinSalt}:${pinVerifier}`);
    if (!safeEqual(hash, s.pinHash)) {
      s.attempts += 1;
      if (s.attempts >= MAX_PIN_ATTEMPTS) {
        s.attempts = 0;
        s.lockedUntil = now + PIN_LOCK_MS;
      }
      await this.ctx.storage.put("s", s);
      return { ok: false, error: "wrong_pin", left: MAX_PIN_ATTEMPTS - s.attempts };
    }

    s.status = "safe";
    s.resolvedAt = new Date(now).toISOString();
    s.attempts = 0;
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.deleteAlarm();
    return { ok: true, contacts: s.contacts, ownerName: s.ownerName, last: s.last };
  }

  /**
   * Drives the UPDATE part of the protocol while an alert stays active, then
   * wipes the session (and the stored contact numbers) when it expires.
   */
  async alarm(): Promise<void> {
    const s = await this.ctx.storage.get<Stored>("s");
    if (!s) return;

    const expires = new Date(s.expiresAt).getTime();
    if (Date.now() >= expires) {
      await this.ctx.storage.deleteAll();
      return;
    }

    if (s.status !== "active" || s.updateMinutes <= 0 || s.updatesSent >= MAX_UPDATES) {
      await this.ctx.storage.setAlarm(expires);
      return;
    }

    await sendToContacts(this.env, s.contacts, updateMessages(s, Date.now()));
    s.updatesSent += 1;
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(
      Math.min(Date.now() + s.updateMinutes * 60_000, expires)
    );
  }
}

// ---------- SMS dispatch ----------

type Contact = { name: string; phone: string };
type DispatchResult = { name: string; ok: boolean; error?: string };

const twilioReady = (env: Env) =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);
const textbeeReady = (env: Env) => Boolean(env.TEXTBEE_API_KEY);

/** The public Textbelt key is rate-limited to one text a day. */
const onFreeTextbelt = (env: Env) =>
  !twilioReady(env) && !textbeeReady(env) && env.TEXTBELT_KEY === "textbelt";

/** Twilio, else textbee, else Textbelt. */
async function sendSms(env: Env, to: string, body: string): Promise<void> {
  if (twilioReady(env)) return sendViaTwilio(env, to, body);
  if (textbeeReady(env)) return sendViaTextbee(env, to, body);
  return sendViaTextbelt(env, to, body);
}

/** Free tier: the message is pushed to your Android phone, which sends the SMS. */
async function sendViaTextbee(env: Env, to: string, body: string): Promise<void> {
  const base = (env.TEXTBEE_BASE_URL ?? "https://api.textbee.dev").replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/gateway/send-sms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.TEXTBEE_API_KEY! },
    body: JSON.stringify({ message: body, recipients: [to], simSlotIndex: 0 }),
  });
  const out = (await res.json().catch(() => null)) as {
    message?: string;
    error?: string;
    smsBatchId?: string;
  } | null;
  if (!res.ok) throw new Error(out?.message ?? out?.error ?? `HTTP ${res.status}`);
}

async function sendViaTextbelt(env: Env, to: string, body: string): Promise<void> {
  const res = await fetch("https://textbelt.com/text", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: to, message: body, key: env.TEXTBELT_KEY! }),
  });
  const out = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    quotaRemaining?: number;
  } | null;
  if (!res.ok || !out?.success) throw new Error(out?.error ?? `HTTP ${res.status}`);
}

async function sendViaTwilio(env: Env, to: string, body: string): Promise<void> {
  const base = (env.TWILIO_BASE_URL ?? "https://api.twilio.com").replace(/\/$/, "");
  const url = `${base}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    From: env.TWILIO_SMS_FROM!,
    To: to,
    Body: body,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const out = (await res.json().catch(() => null)) as {
    sid?: string;
    status?: string;
    message?: string;
    code?: number;
  } | null;
  if (!res.ok) {
    throw new Error(out?.message ? `${out.code ?? res.status}: ${out.message}` : `HTTP ${res.status}`);
  }
  // Twilio accepts the message (201) but can still report a terminal failure.
  if (out?.status === "failed" || out?.status === "undelivered") {
    throw new Error(`Twilio marked the message ${out.status}`);
  }
}

/**
 * Origin for the tracking link. PUBLIC_ORIGIN wins; in local dev the Next.js
 * proxy forwards from :3000, so trust X-Forwarded-Host only on localhost.
 */
function publicOrigin(req: Request, env: Env): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const url = new URL(req.url);
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd && /^(localhost|127\.0\.0\.1)$/.test(url.hostname) && /^[\w.-]+(:\d+)?$/.test(fwd)) {
    return `${req.headers.get("x-forwarded-proto") === "https" ? "https" : "http"}://${fwd}`;
  }
  return url.origin;
}

// ---------- routes ----------

async function trigger(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ error: "bad_json" }, 400);

  const ownerName = cleanText(body.ownerName, 40) || "A SafeStride user";
  const pinVerifier = cleanText(body.pinVerifier, 128);
  if (!/^[0-9a-f]{64}$/.test(pinVerifier)) return json({ error: "pin_required" }, 400);

  const origin = body.origin as { lat?: unknown; lon?: unknown } | undefined;
  const target = body.target as
    | { name?: unknown; lat?: unknown; lon?: unknown; metres?: unknown }
    | undefined;
  if (!origin || !isLat(origin.lat) || !isLon(origin.lon)) return json({ error: "bad_origin" }, 400);
  if (!target || !isLat(target.lat) || !isLon(target.lon)) return json({ error: "bad_target" }, 400);
  const targetName = cleanText(target.name, 80) || "nearest safe haven";
  const metres = typeof target.metres === "number" ? Math.max(0, Math.round(target.metres)) : null;

  const contacts: Contact[] = (Array.isArray(body.contacts) ? body.contacts : [])
    .slice(0, 3)
    .map((c: { name?: unknown; phone?: unknown }) => ({
      name: cleanText(c?.name, 30),
      phone: normalisePhone(c?.phone),
    }))
    .filter((c): c is Contact => Boolean(c.phone));

  const id = randomId();
  const ownerKey = randomHex(32);
  const pinSalt = randomHex(16);
  const now = Date.now();

  const base = publicOrigin(req, env);
  const trackUrl = `${base}/track/${id}`;
  const parsedUpdates = Number(env.SMS_UPDATE_MINUTES);
  const updateMinutes =
    Number.isFinite(parsedUpdates) && parsedUpdates >= 0
      ? Math.min(180, Math.floor(parsedUpdates))
      : DEFAULT_UPDATE_MINUTES;

  const record: Stored = {
    id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    status: "active",
    ownerName,
    contactNames: contacts.map((c) => c.name || "contact"),
    contacts,
    trackUrl,
    updateMinutes,
    updatesSent: 0,
    target: { name: targetName, lat: target.lat, lon: target.lon },
    last: { lat: origin.lat, lon: origin.lon, ts: now },
    trail: [{ lat: origin.lat, lon: origin.lon, ts: now }],
    ownerKeyHash: await sha256(ownerKey),
    pinSalt,
    pinHash: await sha256(`${pinSalt}:${pinVerifier}`),
    attempts: 0,
    lockedUntil: 0,
    resolvedAt: null,
  };

  const stub = env.TRACK.get(env.TRACK.idFromName(id));
  if (!(await stub.init(record))) return json({ error: "collision" }, 500);

  const time = new Date(now).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
  const walk = metres != null ? `, ${metres}m / ${Math.max(1, Math.round(metres / 1.33 / 60))} min` : "";
  // Kept short on purpose: every extra line is another 160-character segment.
  const message =
    `SafeStride ALERT ${time}: ${ownerName} needs help at ` +
    `https://maps.google.com/?q=${origin.lat.toFixed(5)},${origin.lon.toFixed(5)} ` +
    `Walking to ${targetName}${walk}. Live: ${trackUrl}`;

  if (contacts.length === 0) {
    return json({ error: "no_valid_contacts" }, 400);
  }

  // The free Textbelt key refuses messages containing URLs, so that path gets
  // a link-free alert (coordinates only) instead of losing the whole text.
  const smsBody = onFreeTextbelt(env)
    ? `SafeStride ALERT ${time}: ${ownerName} needs help at ` +
      `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)} walking to ${targetName}.`
    : message;

  const configured = twilioReady(env) || textbeeReady(env) || Boolean(env.TEXTBELT_KEY);
  let results: DispatchResult[] = [];
  if (configured && contacts.length > 0) {
    results = await Promise.all(
      contacts.map(async (c) => {
        try {
          await sendSms(env, c.phone, smsBody);
          return { name: c.name, ok: true };
        } catch (e) {
          return { name: c.name, ok: false, error: (e as Error).message };
        }
      })
    );
  }

  return json({
    id,
    ownerKey,
    trackUrl,
    message,
    expiresAt: record.expiresAt,
    updatesMinutes: updateMinutes,
    dispatch: {
      mode: configured ? "sms" : "manual",
      provider: twilioReady(env)
        ? "twilio"
        : textbeeReady(env)
          ? "textbee"
          : env.TEXTBELT_KEY
            ? "textbelt"
            : null,
      results,
      configured,
    },
  });
}

async function trackRoute(req: Request, env: Env, id: string, action: string | undefined): Promise<Response> {
  if (!ID_RE.test(id)) return json({ error: "not_found" }, 404);
  const stub = env.TRACK.get(env.TRACK.idFromName(id));

  if (req.method === "GET" && !action) {
    const s = await stub.read();
    return s ? json(s) : json({ error: "not_found" }, 404);
  }

  if (req.method !== "POST") return json({ error: "method" }, 405);
  const body = await readJson(req);
  const ownerKey = cleanText(body?.ownerKey, 128);
  if (!ownerKey) return json({ error: "forbidden" }, 403);

  if (!action) {
    if (!isLat(body?.lat) || !isLon(body?.lon)) return json({ error: "bad_point" }, 400);
    const result = await stub.push(ownerKey, { lat: body.lat, lon: body.lon, ts: Date.now() });
    const status = { ok: 200, forbidden: 403, gone: 404, closed: 409 }[result];
    return json({ result }, status);
  }

  if (action === "resolve") {
    const r = await stub.resolve(ownerKey, cleanText(body?.pinVerifier, 128));
    // Close the loop with the contacts: the alert ends with an explicit SAFE.
    if (r.ok && r.contacts?.length) {
      await sendToContacts(
        env,
        r.contacts,
        safeMessages(r.ownerName ?? "The SafeStride user", Date.now(), r.last ?? null)
      );
    }
    const status = r.ok ? 200 : r.error === "forbidden" ? 403 : r.error === "gone" ? 404 : r.error === "locked" ? 429 : 401;
    return json({ ok: r.ok, error: r.error, retryAfterS: r.retryAfterS, left: r.left }, status);
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "api") {
      if (parts[1] === "emergency" && parts[2] === "trigger" && req.method === "POST") {
        return trigger(req, env);
      }
      if (parts[1] === "track" && parts[2] && parts.length <= 4) {
        return trackRoute(req, env, parts[2], parts[3]);
      }
      return json({ error: "not_found" }, 404);
    }

    // /track/{id} is one static page; the client reads the id from the URL.
    if (parts[0] === "track") {
      return env.ASSETS.fetch(new Request(new URL("/track", url), req));
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
