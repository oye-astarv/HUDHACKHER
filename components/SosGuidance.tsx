"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { walkingSteps } from "@/lib/directions";
import type { ActiveAlert } from "@/lib/tracking";
import type { Venue } from "@/lib/types";
import { openUntil, tierLabel } from "@/lib/venues";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

export type SosState =
  | { phase: "sending" }
  | { phase: "active"; alert: ActiveAlert }
  | { phase: "failed"; error: string };

export default function SosGuidance({
  state,
  haven,
  you,
  hour,
  gpsNote,
  simulating,
  onToggleSimulate,
  onBack,
  onRetry,
  onShareManual,
  onResolve,
}: {
  state: SosState;
  haven: { venue: Venue; metres: number; coords: [number, number][] };
  you: [number, number];
  hour: number;
  gpsNote: string | null;
  simulating: boolean;
  onToggleSimulate: () => void;
  onBack: () => void;
  onRetry: () => void;
  onShareManual: () => void;
  onResolve: (pin: string) => Promise<string | null>;
}) {
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const steps = useMemo(() => walkingSteps(haven.coords, haven.venue.name), [haven]);
  const minutes = Math.max(1, Math.round(haven.metres / 1.33 / 60));
  const open = openUntil(haven.venue, hour);

  const banner = (() => {
    if (state.phase === "sending") return { title: "Sending alert…", sub: "Locking your location and contacting your network" };
    if (state.phase === "failed") return { title: "Alert not sent", sub: state.error };
    const { alert } = state;
    const sent = alert.dispatch.results.filter((r) => r.ok).map((r) => r.name);
    if (alert.dispatch.mode === "sms" && sent.length > 0) {
      const every = alert.updatesMinutes
        ? ` · updates every ${alert.updatesMinutes} min`
        : "";
      return {
        title: "Alert Active · Live location shared",
        sub: `Alerted ${joinNames(sent)}${every}`,
      };
    }
    return {
      title: "Alert Active · Live location streaming",
      sub:
        alert.dispatch.mode === "manual"
          ? "No message sender set up on the server — tap Send alert below"
          : "Sending failed — tap Send alert below",
    };
  })();

  const failed =
    state.phase === "active" ? state.alert.dispatch.results.filter((r) => !r.ok) : [];
  const needsManual =
    state.phase === "active" &&
    (state.alert.dispatch.mode === "manual" || state.alert.dispatch.results.every((r) => !r.ok));

  const submitPin = async () => {
    setBusy(true);
    setPinError(await onResolve(pin));
    setBusy(false);
    setPin("");
  };

  return (
    <div className="fixed inset-0 z-[2000] overflow-y-auto bg-ink">
      <div className="mx-auto min-h-full max-w-md border-x border-edge bg-ink">
        <header className="flex items-center gap-3 border-b border-edge px-4 pb-3 pt-[max(env(safe-area-inset-top),14px)]">
          <button onClick={onBack} aria-label="Back to route audit" className="p-1 text-2xl leading-none text-slate-300">
            ←
          </button>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Active alert guidance</p>
            <h1 className="text-xl font-extrabold uppercase tracking-tight">Safe haven guidance</h1>
          </div>
        </header>

        <div className="space-y-3 p-4">
          <div className={`flex items-center gap-3 rounded-sm px-4 py-3 ${state.phase === "failed" ? "bg-amber-600" : "bg-alarm"}`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-white ${state.phase !== "failed" ? "animate-pulse" : ""}`} />
            <div className="flex-1">
              <p className="text-[15px] font-bold leading-snug text-white">{banner.title}</p>
              <p className="text-[12px] text-white/85">{banner.sub}</p>
            </div>
            <ShieldIcon />
          </div>

          {state.phase === "failed" && (
            <button onClick={onRetry} className="w-full rounded-sm border border-edge bg-panel py-3 text-sm font-semibold">
              Retry sending alert
            </button>
          )}

          <section className="border-l-4 border-safe bg-panel">
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-safe">➤ Nearest open safe haven</p>
              <p className="text-[12px] font-semibold text-safe">{Math.round(haven.metres)}m away</p>
            </div>

            <div className="m-4 h-40 overflow-hidden border border-edge">
              <MapCanvas
                compact
                centre={you}
                sos={{ coords: haven.coords, venue: haven.venue }}
                origin={you}
              />
            </div>

            <div className="flex items-start justify-between gap-3 px-4">
              <h2 className="text-[28px] font-extrabold uppercase leading-[1.05] tracking-tight">{haven.venue.name}</h2>
              <p className="shrink-0 text-[40px] font-extrabold leading-none text-safe">
                {Math.round(haven.metres)}
                <span className="text-lg font-semibold">M</span>
              </p>
            </div>

            <div className="mx-4 mt-3 flex items-start gap-2 bg-ink/60 px-3 py-2">
              <span className="mt-1 h-2 w-2 shrink-0 bg-safe" />
              <p className="text-[12px] font-semibold uppercase tracking-wider text-slate-200">
                {[open, tierLabel(haven.venue), `${minutes} min walk`].filter(Boolean).join(" · ")}
                {haven.venue.assumed ? " · hours estimated" : ""}
              </p>
            </div>

            <div className="mx-4 mt-3 bg-[#2A2A2E] px-3 py-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">Route to safe haven</p>
              <ol className="mt-1 space-y-1">
                {steps.slice(0, 4).map((s, i) => (
                  <li key={i} className={`flex gap-2 ${i === 0 ? "text-[17px] font-extrabold uppercase leading-snug" : "text-[13px] text-slate-300"}`}>
                    <span className="text-safe">{i === 0 ? "↱" : "·"}</span>
                    {s.text}
                  </li>
                ))}
              </ol>
            </div>

            <div className="mx-4 my-3 flex items-center justify-between border border-edge px-3 py-2 text-[11px] text-slate-400">
              <span>{gpsNote ?? "Streaming your GPS every 5 s"}</span>
              <button onClick={onToggleSimulate} className="font-semibold text-safe">
                {simulating ? "Stop demo walk" : "Demo: move pin"}
              </button>
            </div>
          </section>

          {state.phase === "active" && (
            <section className="space-y-2 border border-edge bg-panel p-3">
              {failed.length > 0 && state.alert.dispatch.mode === "sms" && (
                <p className="text-[11px] text-amber-300">
                  Couldn&apos;t reach {joinNames(failed.map((f) => f.name))}: {failed[0].error}
                </p>
              )}
              <button
                onClick={onShareManual}
                className={`w-full py-3 text-sm font-bold ${needsManual ? "bg-safe text-ink" : "border border-edge text-slate-200"}`}
              >
                Send alert {needsManual ? "now" : "again"} by SMS
              </button>
              <p className="truncate text-center font-mono text-[10px] text-slate-500">{state.alert.trackUrl}</p>
            </section>
          )}

          {state.phase === "active" && !pinOpen && (
            <button
              onClick={() => setPinOpen(true)}
              className="flex w-full items-center justify-center gap-3 border border-edge bg-panel py-4 text-[17px] font-semibold"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full border-2 border-slate-300 text-[10px]">✓</span>
              I&apos;m Safe — Enter PIN to End Alert
            </button>
          )}

          {pinOpen && (
            <section className="space-y-2 border border-edge bg-panel p-4">
              <p className="text-sm font-semibold">Enter your 4-digit Safety PIN</p>
              <input
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                onKeyDown={(e) => e.key === "Enter" && pin.length === 4 && submitPin()}
                inputMode="numeric"
                type="password"
                placeholder="••••"
                className="ss-input text-center text-2xl tracking-[0.6em]"
                aria-label="Safety PIN"
              />
              {pinError && <p className="text-[12px] text-red-300">{pinError}</p>}
              <div className="flex gap-2">
                <button onClick={() => setPinOpen(false)} className="flex-1 border border-edge py-3 text-sm">
                  Cancel
                </button>
                <button
                  disabled={pin.length !== 4 || busy}
                  onClick={submitPin}
                  className="flex-[2] bg-safe py-3 text-sm font-bold text-ink disabled:opacity-50"
                >
                  {busy ? "Checking…" : "End alert"}
                </button>
              </div>
            </section>
          )}

          <a href="tel:999" className="flex items-center gap-4 bg-alarm px-5 py-4">
            <PhoneIcon />
            <div className="flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/85">Emergency services</p>
              <p className="text-2xl font-extrabold text-white">Call 999 Emergency</p>
            </div>
            <span className="text-2xl text-white">→</span>
          </a>
          <p className="pb-6 text-center text-[10px] text-slate-500">
            Can&apos;t speak? Call 999, then press 55 when prompted (Silent Solution).
          </p>
        </div>
      </div>
    </div>
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" aria-hidden>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}
