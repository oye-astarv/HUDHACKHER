"use client";

import { useEffect, useState } from "react";
import { subscribe, type TrackSession } from "@/lib/tracking";

export default function TrackClient({ token }: { token: string }) {
  const [session, setSession] = useState<TrackSession | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribe(token, setSession);
    setLoaded(true);
    return unsubscribe;
  }, [token]);

  if (!loaded) {
    return (
      <main id="app-shell" className="grid place-items-center">
        <p className="text-xs text-slate-500">Loading tracking session…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main id="app-shell" className="grid place-items-center p-8 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-lg font-semibold">Tracking link not found</h1>
          <p className="text-sm text-slate-400">
            This link has expired, or the walk was started on a different
            device. Emergency sessions are stored per browser in this draft.
          </p>
          <a href="/" className="inline-block rounded-lg bg-safe px-3 py-2 text-sm font-semibold text-ink">
            Open SafeStride
          </a>
        </div>
      </main>
    );
  }

  const stale = session.last ? Date.now() - session.last.ts > 90_000 : true;
  const status =
    session.status === "safe"
      ? { label: "MARKED SAFE", tone: "text-safe border-safe/50 bg-safe/10" }
      : stale
        ? { label: "NO RECENT FIX", tone: "text-warn border-warn/50 bg-warn/10" }
        : { label: "ACTIVE EMERGENCY", tone: "text-fast border-fast/50 bg-fast/10" };

  const lastSeen = session.last
    ? `${Math.round((Date.now() - session.last.ts) / 1000)}s ago`
    : "never";

  return (
    <main id="app-shell" className="flex flex-col">
      <header className="space-y-2 border-b border-edge px-4 pb-3 pt-[max(env(safe-area-inset-top),14px)]">
        <p className="text-[11px] uppercase tracking-widest text-slate-500">
          SafeStride · follower view
        </p>
        <div className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${status.tone}`}>
          {status.label}
        </div>
        <h1 className="text-base font-semibold">
          {session.ownerName} is heading to {session.target.name}
        </h1>
        <p className="text-[11px] text-slate-400">
          Started {new Date(session.createdAt).toLocaleTimeString("en-GB")} · last
          fix {lastSeen}
        </p>
      </header>

      <section className="grid flex-1 place-items-center px-4">
        <div className="w-full max-w-sm space-y-3">
          <div className="rounded-xl border border-edge bg-panel p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              {session.status === "safe" ? "Final position" : "Live position"}
            </p>
            <p className="mt-1 font-mono text-sm text-slate-200">
              {session.last
                ? `${session.last.lat.toFixed(5)}, ${session.last.lon.toFixed(5)}`
                : "waiting for the first fix…"}
            </p>
            {session.last && (
              <a
                className="mt-2 inline-block text-[11px] text-safe underline"
                href={`https://maps.google.com/?q=${session.last.lat},${session.last.lon}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Google Maps
              </a>
            )}
          </div>

          <div className="rounded-xl border border-edge bg-panel p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              Target safe haven
            </p>
            <p className="mt-1 text-sm font-medium">{session.target.name}</p>
            <p className="text-[11px] text-slate-400">
              {session.target.lat.toFixed(5)}, {session.target.lon.toFixed(5)}
            </p>
          </div>

          <p className="text-[10px] leading-relaxed text-slate-500">
            {session.trail.length} position updates received. This draft reads
            the session from local browser storage; the Cloudflare Durable Object
            stream makes the same page work across devices.
          </p>
        </div>
      </section>
    </main>
  );
}
