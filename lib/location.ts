"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Fix = { lat: number; lon: number; accuracy: number; ts: number };

export type LocationState = {
  status: "idle" | "locating" | "ok" | "denied" | "unavailable" | "insecure" | "unsupported";
  /** best fix so far (lowest accuracy radius) */
  fix: Fix | null;
  /** street-level label from reverse geocoding, e.g. "Near 14 Fitzwilliam Street" */
  label: string | null;
};

const GOOD_ENOUGH_M = 20; // stop refining once this accurate
const REFINE_FOR_MS = 45_000; // phones often need 10-30 s to get a satellite fix

/**
 * Street-accurate location: watches the GPS for up to 45 s, keeps the most
 * accurate reading, and stops early once it's within 20 m. A single
 * getCurrentPosition() call often returns a stale, coarse Wi-Fi/cell estimate.
 */
export function usePreciseLocation() {
  const [state, setState] = useState<LocationState>({ status: "idle", fix: null, label: null });
  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bestRef = useRef<Fix | null>(null);
  const labelledAt = useRef<{ lat: number; lon: number } | null>(null);

  const stop = useCallback(() => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setState((s) => (s.status === "locating" ? { ...s, status: s.fix ? "ok" : "unavailable" } : s));
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({ status: "unsupported", fix: null, label: null });
      return;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      // Browsers only give location to https:// pages (or localhost).
      setState({ status: "insecure", fix: null, label: null });
      return;
    }
    stop();
    bestRef.current = null;
    setState((s) => ({ ...s, status: "locating" }));

    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: Fix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          ts: pos.timestamp,
        };
        const best = bestRef.current;
        // keep the most accurate reading; accept a newer one if it's nearly as good
        if (!best || fix.accuracy <= best.accuracy * 1.2) {
          bestRef.current = fix;
          setState((s) => ({ ...s, status: "locating", fix }));
        }
        if (fix.accuracy <= GOOD_ENOUGH_M) stop();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          stop();
          setState({ status: "denied", fix: null, label: null });
        }
        // TIMEOUT / POSITION_UNAVAILABLE: keep watching until the refine window ends
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 }
    );
    timerRef.current = setTimeout(stop, REFINE_FOR_MS);
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  // Street name for the fix (OpenStreetMap Nominatim reverse geocoding), only once
  // the fix is street-level and has moved more than 30 m since the last lookup.
  useEffect(() => {
    const f = state.fix;
    if (!f || f.accuracy > 150) return;
    const prev = labelledAt.current;
    if (prev && Math.hypot((f.lat - prev.lat) * 111_320, (f.lon - prev.lon) * 66_000) < 30) return;
    labelledAt.current = { lat: f.lat, lon: f.lon };
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${f.lat.toFixed(6)}&lon=${f.lon.toFixed(6)}`,
          { signal: ctrl.signal, headers: { "Accept-Language": "en-GB" } }
        );
        if (!res.ok) return;
        const j = (await res.json()) as { address?: Record<string, string>; name?: string };
        const a = j.address ?? {};
        const road = a.road || a.pedestrian || a.footway || a.path;
        const label = road ? `Near ${a.house_number ? a.house_number + " " : ""}${road}` : j.name || null;
        if (label) setState((s) => ({ ...s, label }));
      } catch {
        // offline or rate-limited — keep showing coordinates
      }
    }, 1200);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [state.fix]);

  return { ...state, start, stop };
}

export function accuracyTone(m: number): { text: string; cls: string; precise: boolean } {
  if (m <= 25) return { text: `GPS ±${m} m`, cls: "text-safe", precise: true };
  if (m <= 75) return { text: `GPS ±${m} m`, cls: "text-lime-300", precise: true };
  if (m <= 250) return { text: `Approx. ±${m} m`, cls: "text-amber-300", precise: false };
  return { text: `Rough ±${m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m"}`, cls: "text-red-300", precise: false };
}
