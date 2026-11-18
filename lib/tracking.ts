"use client";

import { sha256Hex } from "./sha256";

/**
 * Client side of the emergency loop: the user's profile (name, trusted
 * contacts, Safety PIN verifier) lives in localStorage; live sessions live in
 * the Cloudflare Durable Object behind /api.
 */

export type Contact = { name: string; phone: string };

export type Profile = {
  ownerName: string;
  contacts: Contact[];
  /** sha256("safestride-pin:" + PIN). The PIN itself is never stored. */
  pinVerifier: string;
};

export type ActiveAlert = {
  id: string;
  ownerKey: string;
  trackUrl: string;
  message: string;
  startedAt: string;
  target: { name: string; lat: number; lon: number; metres: number };
  dispatch: {
    mode: "sms" | "manual";
    results: { name: string; ok: boolean; error?: string }[];
    configured?: boolean;
  };
  /** Minutes between automatic UPDATE texts, when the server is sending them. */
  updatesMinutes?: number;
  /** What happened when it was sent, kept so a reload can still explain it. */
  note?: string;
};

export type TrackPoint = { lat: number; lon: number; ts: number };

export type PublicSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "safe";
  ownerName: string;
  contactNames: string[];
  target: { name: string; lat: number; lon: number };
  last: TrackPoint | null;
  trail: TrackPoint[];
  resolvedAt: string | null;
};

const PROFILE_KEY = "safestride:profile";
const ALERT_KEY = "safestride:active-alert";

function readLS<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLS(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / storage blocked — the session still works for this page
  }
}

export const loadProfile = () => readLS<Profile>(PROFILE_KEY);
export const saveProfile = (p: Profile) => writeLS(PROFILE_KEY, p);
export const loadAlert = () => readLS<ActiveAlert>(ALERT_KEY);
export const saveAlert = (a: ActiveAlert | null) => writeLS(ALERT_KEY, a);

export async function pinVerifier(pin: string): Promise<string> {
  const input = `safestride-pin:${pin}`;
  // crypto.subtle only exists in a secure context. A phone opening the app at
  // http://10.x.x.x:3000 has none, and hashing the PIN must not be the thing
  // that breaks saving contacts.
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return sha256Hex(input);
}

/** UK-friendly: "07700 900123" -> "+447700900123". Returns null if invalid. */
export function normalisePhone(input: string): string | null {
  let p = input.replace(/[\s()-]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^0\d{9,10}$/.test(p)) p = "+44" + p.slice(1);
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

export async function triggerEmergency(args: {
  profile: Profile;
  origin: { lat: number; lon: number };
  target: { name: string; lat: number; lon: number; metres: number };
}): Promise<ActiveAlert> {
  const { status, body } = await api<Omit<ActiveAlert, "startedAt" | "target"> & { error?: string }>(
    "/api/emergency/trigger",
    {
      method: "POST",
      body: JSON.stringify({
        ownerName: args.profile.ownerName,
        contacts: args.profile.contacts,
        pinVerifier: args.profile.pinVerifier,
        origin: args.origin,
        target: args.target,
      }),
    }
  );
  if (status !== 200 || !body.id) throw new Error(body.error ?? `server error ${status}`);
  return { ...body, startedAt: new Date().toISOString(), target: args.target };
}

export async function pushPoint(alert: ActiveAlert, lat: number, lon: number) {
  return api<{ result: string }>(`/api/track/${alert.id}`, {
    method: "POST",
    body: JSON.stringify({ ownerKey: alert.ownerKey, lat, lon }),
  });
}

export async function resolveAlert(alert: ActiveAlert, pin: string) {
  return api<{ ok: boolean; error?: string; retryAfterS?: number; left?: number }>(
    `/api/track/${alert.id}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ ownerKey: alert.ownerKey, pinVerifier: await pinVerifier(pin) }),
    }
  );
}

export async function fetchSession(id: string) {
  return api<PublicSession & { error?: string }>(`/api/track/${id}`);
}

/**
 * Hands the alert straight to the phone's messaging app via the sms: scheme,
 * prefilled and addressed. The only tap left is the phone's own Send button.
 */
export function openSmsApp(alert: ActiveAlert, phone?: string): void {
  const body = `?&body=${encodeURIComponent(alert.message)}`;
  window.location.href = phone ? `sms:${phone}${body}` : `sms:${body}`;
}

/**
 * Manual fallback when the server has no SMS credentials or a send failed:
 * opens the phone's own messaging app, prefilled and addressed.
 */
export async function shareManually(alert: ActiveAlert, phone?: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title: "SafeStride emergency alert", text: alert.message });
      return;
    } catch {
      // dismissed — fall through to the messaging app
    }
  }
  openSmsApp(alert, phone);
}
