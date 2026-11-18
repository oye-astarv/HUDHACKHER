"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { fetchSession, type PublicSession } from "@/lib/tracking";
import type { Venue } from "@/lib/types";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-zinc-500">loading map…</div>,
});

const POLL_MS = 3000;

function sessionIdFromUrl(): string | null {
  const m = window.location.pathname.match(/\/track\/([a-z0-9]+)/);
  return m?.[1] ?? new URLSearchParams(window.location.search).get("id");
}

export default function TrackClient() {
  const [id, setId] = useState<string | null>(null);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "offline">("loading");
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    setId(sessionIdFromUrl());
  }, []);

  useEffect(() => {
    if (id === null) return;
    let live = true;
    const poll = async () => {
      try {
        const { status, body } = await fetchSession(id);
        if (!live) return;
        if (status === 200) {
          setSession(body);
          setState("ok");
        } else if (status === 404) {
          setState("missing");
        }
      } catch {
        if (live) setState((s) => (s === "ok" ? "ok" : "offline"));
      }
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, [id]);

  if (state === "missing" || (id === null && state !== "loading")) {
    return (
      <Frame>
        <div className="grid min-h-[70vh] place-items-center p-8 text-center">
          <div className="max-w-sm space-y-3">
            <h1 className="text-lg font-semibold">Tracking link not found</h1>
            <p className="text-sm text-zinc-400">
              This alert has ended and its location data was deleted (sessions expire after 3 hours), or the link is
              incomplete. If you&apos;re worried, call them — or 999 in an emergency.
            </p>
          </div>
        </div>
      </Frame>
    );
  }

  if (!session) {
    return (
      <Frame>
        <div className="grid min-h-[70vh] place-items-center">
          <p className="text-xs text-zinc-500">{state === "offline" ? "Can't reach the server — retrying…" : "Loading live location…"}</p>
        </div>
      </Frame>
    );
  }

  const ageS = session.last ? Math.round((Date.now() - session.last.ts) / 1000) : null;
  const stale = ageS == null || ageS > 60;
  const status =
    session.status === "safe"
      ? { label: "MARKED SAFE", cls: "bg-safe text-ink" }
      : stale
        ? { label: "ACTIVE · NO RECENT FIX", cls: "bg-amber-500 text-ink" }
        : { label: "ACTIVE EMERGENCY", cls: "bg-alarm text-white" };

  const target: Venue = {
    name: session.target.name,
    lat: session.target.lat,
    lon: session.target.lon,
    tier: 2,
    kind: "venue",
    hours: "",
    openMask: 0,
  };
  const trail = session.trail.map((p) => [p.lat, p.lon] as [number, number]);
  const here: [number, number] | null = session.last ? [session.last.lat, session.last.lon] : null;

  return (
    <Frame>
      <header className="space-y-2 border-b border-edge bg-ink px-4 pb-3 pt-[max(env(safe-area-inset-top),14px)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">SafeStride · follower view</p>
        <span className={`inline-flex items-center gap-2 px-2.5 py-1 text-[12px] font-bold ${status.cls}`}>
          {session.status === "active" && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
          {status.label}
        </span>
        <h1 className="text-lg font-bold leading-snug">
          {session.status === "safe"
            ? `${session.ownerName} has marked themselves safe`
            : `${session.ownerName} is heading to ${session.target.name}`}
        </h1>
        <p className="text-[12px] text-zinc-400">
          Alert started {new Date(session.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          {ageS != null && ` · last update ${ageS < 60 ? `${ageS}s` : `${Math.round(ageS / 60)} min`} ago`}
          {session.resolvedAt &&
            ` · safe at ${new Date(session.resolvedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
        </p>
      </header>

      <div className="h-[55vh] border-b border-edge">
        <MapCanvas
          centre={here ?? [target.lat, target.lon]}
          trail={trail}
          walk={here}
          destination={[target.lat, target.lon]}
          labelled={[{ venue: target, metres: 0, note: "Target safe haven" }]}
        />
      </div>

      <div className="space-y-2 p-4">
        {here && (
          <a
            className="block bg-panel px-3 py-3 text-[13px] font-semibold text-safe"
            href={`https://maps.google.com/?q=${here[0]},${here[1]}`}
            target="_blank"
            rel="noreferrer"
          >
            Open current position in Google Maps →
          </a>
        )}
        {session.status === "active" && (
          <a href="tel:999" className="block bg-alarm px-3 py-3 text-center text-[15px] font-extrabold text-white">
            Call 999
          </a>
        )}
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Updates every few seconds while the alert is active. Location data is deleted automatically 3 hours after the
          alert started.
        </p>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-[var(--app-h)] max-w-md border-x border-edge bg-panel">{children}</main>;
}
