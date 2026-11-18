"use client";

export type TrackPoint = { lat: number; lon: number; ts: number };

export type TrackSession = {
  token: string;
  createdAt: string;
  status: "active" | "safe";
  ownerName: string;
  target: { name: string; lat: number; lon: number };
  last: TrackPoint | null;
  trail: TrackPoint[];
  pinHash: string | null;
};

const PREFIX = "safestride:session:";
const EVENT = "safestride:session-updated";

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function saveSession(session: TrackSession): void {
  localStorage.setItem(PREFIX + session.token, JSON.stringify(session));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: session.token }));
}

export function readSession(token: string): TrackSession | null {
  try {
    const raw = localStorage.getItem(PREFIX + token);
    return raw ? (JSON.parse(raw) as TrackSession) : null;
  } catch {
    return null;
  }
}

export function pushPoint(token: string, point: TrackPoint): void {
  const session = readSession(token);
  if (!session || session.status !== "active") return;
  session.last = point;
  session.trail = [...session.trail.slice(-240), point];
  saveSession(session);
}

export function markSafe(token: string): void {
  const session = readSession(token);
  if (!session) return;
  session.status = "safe";
  saveSession(session);
}

/**
 * Subscribes to session changes. The local driver uses storage events, which
 * reach other tabs on this device. Swapping in a Cloudflare Durable Object
 * broadcast means implementing this same signature against a WebSocket.
 */
export function subscribe(token: string, onChange: (s: TrackSession | null) => void) {
  const emit = () => onChange(readSession(token));

  const onStorage = (e: StorageEvent) => {
    if (e.key === PREFIX + token) emit();
  };
  const onCustom = (e: Event) => {
    if ((e as CustomEvent).detail === token) emit();
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onCustom);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onCustom);
  };
}

export function trackUrl(token: string): string {
  return `${window.location.origin}/track/${token}`;
}

export function alertText(session: TrackSession): string {
  const where = session.last
    ? `https://maps.google.com/?q=${session.last.lat.toFixed(5)},${session.last.lon.toFixed(5)}`
    : "location shared shortly";
  return (
    `EMERGENCY ALERT from ${session.ownerName}: Safe Haven mode activated.\n` +
    `Current location: ${where}\n` +
    `Heading to: ${session.target.name}\n` +
    `Live tracking: ${trackUrl(session.token)}`
  );
}

export async function shareAlert(session: TrackSession): Promise<string> {
  const text = alertText(session);
  const url = trackUrl(session.token);

  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title: "SafeStride emergency alert", text, url });
      return "shared";
    } catch {
      // user dismissed the sheet — fall through to SMS
    }
  }
  window.location.href = `sms:?&body=${encodeURIComponent(text)}`;
  return "sms";
}
