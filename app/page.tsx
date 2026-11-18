"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dayLight, fmtTime, loadData, type DataBundle } from "@/lib/data";
import { watchLowBattery } from "@/lib/battery";
import { distanceM, pointAlong, polylineLength } from "@/lib/geo";
import { prepare } from "@/lib/graph";
import { DEMO_CENTRE, PRESETS } from "@/lib/presets";
import { computeRoutes, nearestHaven, routeTo } from "@/lib/routing";
import ContactsSetup from "@/components/ContactsSetup";
import {
  loadAlert,
  loadProfile,
  pushPoint,
  resolveAlert,
  saveAlert,
  saveProfile,
  shareManually,
  triggerEmergency,
  type ActiveAlert,
  type Profile,
} from "@/lib/tracking";
import type { RouteAudit, RouteResult, Venue } from "@/lib/types";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center text-sm text-slate-500">
      loading map…
    </div>
  ),
});

const START_HOUR = 22.5;

export default function Page() {
  const [bundle, setBundle] = useState<DataBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [destination, setDestination] = useState(PRESETS[0].to);
  const [hour, setHour] = useState(START_HOUR);
  const [selected, setSelected] = useState<"safe" | "fastest">("safe");
  const [walkMetres, setWalkMetres] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const [sos, setSos] = useState<{
    venue: Venue;
    metres: number;
    coords: [number, number][];
  } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [alert, setAlert] = useState<ActiveAlert | null>(null);
  const [sending, setSending] = useState(false);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const firedRef = useRef<Set<string>>(new Set());
  const watchRef = useRef<number | null>(null);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    // Trusted contacts + Safety PIN live on this device; the alert itself is
    // created server-side so the SMS can actually be sent.
    const savedProfile = loadProfile();
    setProfile(savedProfile);
    setAlert(loadAlert());
    setSetupOpen(!savedProfile);

    loadData()
      .then(setBundle)
      .catch((err) => setLoadError(err.message));
  }, []);

  const graph = useMemo(() => (bundle ? prepare(bundle.graph) : null), [bundle]);
  const light = useMemo(
    () => dayLight(DEMO_CENTRE.lat, DEMO_CENTRE.lon, hour),
    [hour]
  );

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  const routes = useMemo(() => {
    if (!graph || !bundle) return null;
    return computeRoutes({
      graph,
      venues: bundle.venues,
      incidents: bundle.incidents,
      origin: { lat: preset.from.lat, lon: preset.from.lon },
      destination: { lat: destination.lat, lon: destination.lon },
      hour,
      isDark: light.isDark,
      sunset: fmtTime(light.sunset),
      sunrise: fmtTime(light.sunrise),
    });
  }, [graph, bundle, preset, destination, hour, light]);

  const ok = routes && !("error" in routes) ? routes : null;
  const routeError = routes && "error" in routes ? routes.error : null;

  const openVenues = useMemo(() => {
    if (!bundle) return [];
    const h = ((hour % 24) + 24) % 24;
    return bundle.venues.filter((v) => ((v.openMask >> h) & 1) === 1);
  }, [bundle, hour]);

  const chosen: RouteResult | null = ok
    ? selected === "safe"
      ? ok.safe
      : ok.fastest
    : null;

  const walkLength = chosen ? polylineLength(chosen.coords) : 0;
  const walkPoint = chosen ? pointAlong(chosen.coords, walkMetres) : null;

  // auto check-in when passing an open venue within 40m
  useEffect(() => {
    if (!walkPoint || !ok) return;
    for (const v of openVenues) {
      if (firedRef.current.has(v.name)) continue;
      if (distanceM(walkPoint[0], walkPoint[1], v.lat, v.lon) < 40) {
        firedRef.current.add(v.name);
        const remaining = Math.max(
          0,
          Math.round((walkLength - walkMetres) / 1.33 / 60)
        );
        setToast(
          `Auto check-in: passed ${v.name} — ${remaining} min from destination`
        );
      }
    }
  }, [walkPoint, openVenues, walkLength, walkMetres, ok]);

  // Warn when the walk passes a reported incident.
  useEffect(() => {
    if (!walkPoint || !bundle) return;
    for (const incident of bundle.incidents) {
      const key = `incident:${incident.lat.toFixed(4)},${incident.lon.toFixed(4)}`;
      if (firedRef.current.has(key)) continue;
      // Incidents are geocoded to a street or neighbourhood, not a doorstep,
      // so the radius is generous enough to cover that imprecision.
      if (distanceM(walkPoint[0], walkPoint[1], incident.lat, incident.lon) > 200) continue;
      firedRef.current.add(key);
      setToast(
        `Suspicious activity nearby — ${incident.category.toLowerCase()} reported near ${incident.street}. Stay on the lit main roads.`
      );
    }
  }, [walkPoint, bundle]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(id);
  }, [toast]);

  const keepAwake = useCallback(async () => {
    try {
      wakeRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // unsupported (iOS < 16.4) — the stream degrades to resume-on-focus
    }
  }, []);

  const triggerSos = useCallback(() => {
    if (!graph || !bundle) return;
    const from = { lat: preset.from.lat, lon: preset.from.lon };
    const haven = nearestHaven(bundle.venues, from, ((hour % 24) + 24) % 24);
    if (!haven) {
      setToast("No open safe haven found nearby right now.");
      return;
    }
    const path = routeTo(graph, from, { lat: haven.venue.lat, lon: haven.venue.lon });
    setSos({
      venue: haven.venue,
      metres: haven.metres,
      coords: path?.coords ?? [
        [from.lat, from.lon],
        [haven.venue.lat, haven.venue.lon],
      ],
    });
    setSheetOpen(true);
  }, [graph, bundle, preset, hour]);

  /**
   * Ping the nearest open safe haven from wherever the walk currently is. Used
   * by the 10% battery watchdog and by an explicit ping; keeps a running
   * session's last fix fresh so followers see it immediately.
   */
  const pingSafeHaven = useCallback(
    (reason: string) => {
      if (!graph || !bundle) return;
      const from = walkPoint
        ? { lat: walkPoint[0], lon: walkPoint[1] }
        : { lat: preset.from.lat, lon: preset.from.lon };
      const haven = nearestHaven(bundle.venues, from, ((hour % 24) + 24) % 24);
      if (!haven) {
        setToast(`${reason} — no open safe haven found nearby right now.`);
        return;
      }
      if (alert) {
        void pushPoint(alert, from.lat, from.lon);
      }
      const minutes = Math.max(1, Math.round(haven.metres / 1.33 / 60));
      setToast(
        `${reason} — nearest open safe haven: ${haven.venue.name}, ${Math.round(
          haven.metres
        )} m (${minutes} min).`
      );
    },
    [graph, bundle, walkPoint, preset, hour, alert]
  );

  // 10% battery → ping a safe haven without the user touching anything.
  // The callback goes through a ref so this subscription isn't torn down and
  // rebuilt on every render (walkPoint is a fresh array each time).
  const pingRef = useRef(pingSafeHaven);
  useEffect(() => {
    pingRef.current = pingSafeHaven;
  }, [pingSafeHaven]);

  useEffect(() => {
    if (!graph || !bundle) return;
    const onLow = () => pingRef.current("Battery at 10%");
    const stopWatching = watchLowBattery(onLow);
    window.addEventListener("safestride:low-battery", onLow);
    return () => {
      stopWatching();
      window.removeEventListener("safestride:low-battery", onLow);
    };
  }, [graph, bundle]);

  // Hidden panic trigger: three quick presses of a panic key, or ⌘/Ctrl+Shift+S.
  // Browsers never deliver the power or volume rocker to a web page, but a
  // WebView wrapper (and iOS Action Button → Shortcuts → /?sos=1) can.
  useEffect(() => {
    const PANIC_KEYS = new Set([
      " ",
      "Spacebar",
      "AudioVolumeUp",
      "AudioVolumeDown",
      "MediaPlayPause",
    ]);
    let stamps: number[] = [];

    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        triggerSos();
        return;
      }

      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing || !PANIC_KEYS.has(event.key)) return;

      const now = Date.now();
      stamps = [...stamps.filter((t) => now - t < 1200), now];
      if (stamps.length < 3) return;
      stamps = [];
      event.preventDefault();
      triggerSos();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [triggerSos]);

  // Deep link for hardware buttons / shortcuts: /?sos=1 fires the alert on load.
  useEffect(() => {
    if (!graph || !bundle) return;
    if (new URLSearchParams(window.location.search).get("sos") !== "1") return;
    window.history.replaceState({}, "", window.location.pathname);
    triggerSos();
  }, [graph, bundle, triggerSos]);

  /** Creates the session server-side and asks it to SMS the trusted contacts. */
  const startAlert = useCallback(async () => {
    if (!sos || !profile) return;
    setSending(true);
    setDispatchNote(null);
    try {
      const from = { lat: preset.from.lat, lon: preset.from.lon };
      const created = await triggerEmergency({
        profile,
        origin: from,
        target: {
          name: sos.venue.name,
          lat: sos.venue.lat,
          lon: sos.venue.lon,
          metres: Math.round(sos.metres),
        },
      });
      saveAlert(created);
      setAlert(created);
      await keepAwake();

      const sent = created.dispatch.results.filter((r) => r.ok).length;
      const failed = created.dispatch.results.length - sent;
      setDispatchNote(
        created.dispatch.mode === "sms"
          ? `Texted ${sent} of ${profile.contacts.length} contact${
              profile.contacts.length === 1 ? "" : "s"
            } with your location${failed ? `, ${failed} failed` : ""}.`
          : "SMS is not configured on the server yet — share the alert below."
      );
      if (created.dispatch.mode !== "sms") void shareManually(created);

      if (navigator.geolocation) {
        watchRef.current = navigator.geolocation.watchPosition(
          (pos) => void pushPoint(created, pos.coords.latitude, pos.coords.longitude),
          () => undefined,
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
      }
    } catch (err) {
      setDispatchNote(`Could not reach the alert service: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }, [sos, profile, preset, keepAwake]);

  const resolveSafe = useCallback(async () => {
    if (!alert) return;
    setSending(true);
    setPinError(null);
    try {
      const { body } = await resolveAlert(alert, pin);
      if (!body.ok) {
        setPinError(
          body.error === "locked"
            ? `Too many attempts — try again in ${body.retryAfterS ?? 60}s.`
            : body.error === "forbidden"
              ? "This alert was started on another device."
              : `Incorrect PIN${typeof body.left === "number" ? ` — ${body.left} tries left` : ""}`
        );
        return;
      }
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
      await wakeRef.current?.release();
      wakeRef.current = null;
      setPinPrompt(false);
      setPin("");
      setSos(null);
      setToast("Marked safe. Your contacts can see you are safe.");
    } catch (err) {
      setPinError(`Could not reach the alert service: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }, [alert, pin]);

  if (loadError) {
    return (
      <main id="app-shell" className="grid place-items-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-lg font-semibold">No walk network loaded</h1>
          <p className="text-sm text-slate-400">{loadError}</p>
          <p className="text-xs text-slate-500">
            Run <code className="text-safe">npm run data:graph</code> to build
            the Huddersfield graph, then reload.
          </p>
        </div>
      </main>
    );
  }

  if (setupOpen) {
    return (
      <main id="app-shell" className="overflow-y-auto px-4 pb-8 pt-[max(env(safe-area-inset-top),16px)]">
        <div className="mx-auto max-w-md">
          <ContactsSetup
            profile={profile}
            onboarding={!profile}
            onSave={(next) => {
              saveProfile(next);
              setProfile(next);
              setSetupOpen(false);
              setToast(`Alerts will text ${next.contacts.map((c) => c.name).join(", ")}.`);
            }}
            onCancel={profile ? () => setSetupOpen(false) : undefined}
          />
        </div>
      </main>
    );
  }

  if (!bundle || !ok) {
    return (
      <main id="app-shell" className="grid place-items-center text-center">
        <div className="space-y-2">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-safe" />
          <p className="text-xs text-slate-500">
            {routeError ?? "loading walk network…"}
          </p>
        </div>
      </main>
    );
  }

  const deltaMinutes = ok.safe.audit.minutes - ok.fastest.audit.minutes;

  return (
    <main id="app-shell" className="relative overflow-hidden">
      <div className="absolute inset-0">
        <MapCanvas
          centre={[DEMO_CENTRE.lat, DEMO_CENTRE.lon]}
          fastest={ok.fastest}
          safe={ok.safe}
          venues={openVenues}
          incidents={bundle.incidents}
          sos={sos ? { coords: sos.coords, venue: sos.venue } : null}
          walk={walkPoint}
          onPick={(lat, lon) => {
            setDestination({ lat, lon, name: "Dropped pin" });
            setWalkMetres(0);
          }}
        />
      </div>

      {/* top controls */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] border-b border-white/[0.05] bg-ink/90 pb-3 pt-[max(env(safe-area-inset-top),8px)] backdrop-blur-md">
        <div className="pointer-events-auto mx-auto max-w-md space-y-3 px-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[15px] font-semibold leading-none tracking-[-0.01em] text-slate-50">
                Safe<span className="text-safe">Stride</span>
              </h1>
              <p className="mt-1 text-[10.5px] tracking-wide text-slate-500">
                {light.label} · {light.isDark ? "after dark" : "daylight"} ·
                sunset {fmtTime(light.sunset)}
              </p>
            </div>
            <span className="rounded-md border border-edge/70 px-2 py-1 text-[10px] tabular-nums tracking-wide text-slate-500">
              {bundle.graph.counts.edges.toLocaleString()} streets
            </span>
          </div>

          <div className="flex gap-0.5 rounded-lg border border-edge/70 bg-panel/60 p-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setPresetId(p.id);
                  setDestination(p.to);
                  setWalkMetres(0);
                  firedRef.current.clear();
                }}
                className={`flex-1 rounded-[6px] px-2 py-1.5 text-[10.5px] font-medium transition ${
                  p.id === presetId
                    ? "bg-white/[0.07] text-slate-100"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="tabular-nums text-slate-300">{fmtSim(hour)}</span>
            <input
              type="range"
              min={14}
              max={25}
              step={0.25}
              value={hour}
              onChange={(e) => {
                setHour(Number(e.target.value));
                firedRef.current.clear();
              }}
              className="h-4 flex-1"
              aria-label="Simulated time of day"
            />
            <span className="text-slate-500">01:00</span>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            Engine routes from <b className="text-slate-300">{preset.from.name}</b> to{" "}
            <b className="text-slate-300">{destination.name}</b> · tap the map to
            move the destination
          </p>
        </div>
      </div>

      {toast && (
        <div className="absolute inset-x-0 top-[46%] z-[900] px-4">
          <div className="mx-auto max-w-sm rounded-lg border border-edge/80 bg-panel/95 px-3 py-2 text-[11px] leading-relaxed text-slate-200 shadow-lg backdrop-blur">
            {toast}
          </div>
        </div>
      )}

      {/* SOS */}
      <button
        onClick={triggerSos}
        className="absolute right-4 z-[800] h-14 w-14 rounded-full bg-fast text-[10px] font-semibold uppercase tracking-label text-white ring-1 ring-white/20 transition active:scale-95"
        style={{ bottom: "calc(52% + 8px)" }}
      >
        SOS
      </button>

      {/* bottom sheet */}
      <section
        className="absolute inset-x-0 bottom-0 z-[700] rounded-t-xl border-t border-edge/80 bg-ink/95 backdrop-blur-xl transition-transform"
        style={{
          transform: sheetOpen ? "translateY(0)" : "translateY(58%)",
          maxHeight: "58vh",
        }}
      >
        <button
          onClick={() => setSheetOpen((v) => !v)}
          className="mx-auto block w-full py-2"
          aria-label={sheetOpen ? "Collapse panel" : "Expand panel"}
        >
                            <span className="mx-auto block h-1 w-9 rounded-full bg-edge" />
        </button>

        <div className="max-h-[50vh] overflow-y-auto px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          {sos ? (
            <SosPanel
              alert={alert}
              profile={profile}
              sos={sos}
              dispatchNote={dispatchNote}
              sending={sending}
              pinPrompt={pinPrompt}
              pin={pin}
              pinError={pinError}
              onPin={setPin}
              onStart={startAlert}
              onResolve={() => setPinPrompt(true)}
              onConfirm={resolveSafe}
              onEditContacts={() => setSetupOpen(true)}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <AuditCard
                  title="Eyes on the street"
                  route={ok.safe}
                  other={ok.fastest}
                  tone="safe"
                  active={selected === "safe"}
                  onSelect={() => setSelected("safe")}
                />
                <AuditCard
                  title="Fastest"
                  route={ok.fastest}
                  other={ok.safe}
                  tone="fast"
                  active={selected === "fastest"}
                  onSelect={() => setSelected("fastest")}
                />
              </div>

              {ok.sameRoute && (
                <p className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] text-warn">
                  Both routes are identical here — the safety multipliers agree
                  with distance on this pair. Try another preset or a later hour.
                </p>
              )}

              <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                {Math.round(ok.safe.audit.litShare * 100)}% of the safe route is
                confirmed lit ({Math.round(ok.safe.audit.inferredShare * 100)}% inferred
                from road class, {Math.round(ok.safe.audit.unknownShare * 100)}% no
                lighting data). Sunset {fmtTime(light.sunset)}, sunrise{" "}
                {fmtTime(light.sunrise)}.
              </p>

              <WalkScrubber
                length={walkLength}
                metres={walkMetres}
                onChange={setWalkMetres}
                minutes={chosen?.audit.minutes ?? 0}
              />
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function fmtSim(hour: number): string {
  const h = Math.floor(hour % 24);
  const m = Math.round((hour % 1) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${hour >= 24 ? " (+1d)" : ""}`;
}

function AuditCard({
  title,
  route,
  other,
  tone,
  active,
  onSelect,
}: {
  title: string;
  route: RouteResult;
  other: RouteResult;
  tone: "safe" | "fast";
  active: boolean;
  onSelect: () => void;
}) {
  const delta = route.audit.minutes - other.audit.minutes;
  const colour = tone === "safe" ? "text-safe" : "text-fast";
  const border = active
    ? tone === "safe"
      ? "border-safe/50"
      : "border-fast/50"
    : "border-edge/70";

  return (
    <button
      onClick={onSelect}
      className={`rounded-card border ${border} bg-panel/50 p-3 text-left transition-colors hover:bg-panel-strong/60`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[9.5px] font-semibold uppercase tracking-label ${colour}`}>
          {title}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-slate-600">
          {delta === 0 ? "same" : delta > 0 ? `+${delta} min` : `${delta} min`}
        </span>
      </div>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-slate-50">
        {route.audit.minutes}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-label text-slate-600">
          min
        </span>
      </div>
      <dl className="mt-2.5 space-y-1 border-t border-white/[0.06] pt-2 text-[10.5px] text-slate-500">
        <Row label="lit / main road" value={`${Math.round((route.audit.litShare + route.audit.inferredShare) * 100)}%`} />
        <Row label="open venues" value={String(route.audit.openVenues)} />
        <Row label="through parks" value={`${route.audit.parkMetres} m`} />
        <Row
          label="incidents"
          value={String(route.audit.incidentsOnPath)}
          warn={route.audit.incidentsOnPath > 0}
        />
      </dl>
    </button>
  );
}

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className={`tabular-nums ${warn ? "text-warn" : "text-slate-300"}`}>
        {value}
      </dd>
    </div>
  );
}

function WalkScrubber({
  length,
  metres,
  onChange,
  minutes,
}: {
  length: number;
  metres: number;
  onChange: (n: number) => void;
  minutes: number;
}) {
  const progress = length > 0 ? metres / length : 0;
  return (
    <div className="mt-3 rounded-card border border-edge/80 bg-panel/50 p-3">
      <div className="flex justify-between text-[10px] text-slate-500">
        <span className="uppercase tracking-label">Simulate walk</span>
        <span className="tabular-nums text-slate-400">
          {Math.round(progress * 100)}% · {Math.max(0, Math.round(minutes * (1 - progress)))} min left
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(1, Math.round(length))}
        value={Math.round(metres)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-4 w-full"
        aria-label="Walk progress"
      />
      <p className="mt-1.5 text-[10px] leading-tight text-slate-500">
        Panic trigger: triple-press <kbd className="text-slate-400">space</kbd> or{" "}
        <kbd className="text-slate-400">⌘/Ctrl</kbd>+<kbd className="text-slate-400">⇧</kbd>+<kbd className="text-slate-400">S</kbd> — no
        button to press.
      </p>
    </div>
  );
}

function SosPanel({
  alert,
  profile,
  sos,
  dispatchNote,
  sending,
  pinPrompt,
  pin,
  pinError,
  onPin,
  onStart,
  onResolve,
  onConfirm,
  onEditContacts,
}: {
  alert: ActiveAlert | null;
  profile: Profile | null;
  sos: { venue: Venue; metres: number; coords: [number, number][] };
  dispatchNote: string | null;
  sending: boolean;
  pinPrompt: boolean;
  pin: string;
  pinError: string | null;
  onPin: (v: string) => void;
  onStart: () => void;
  onResolve: () => void;
  onConfirm: () => void;
  onEditContacts: () => void;
}) {
  const minutes = Math.max(1, Math.round(sos.metres / 1.33 / 60));

  if (pinPrompt) {
    return (
      <div className="space-y-3 py-2">
        <h2 className="text-sm font-semibold">Enter your Safety PIN</h2>
        <p className="text-[11px] text-slate-400">
          Ending emergency mode needs your PIN so your phone can&apos;t be used to
          silence the alert.
        </p>
        <input
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, ""))}
          className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-center text-lg tracking-[0.6em]"
          placeholder="••••"
          aria-label="Safety PIN"
        />
        {pinError && <p className="text-[11px] text-fast">{pinError}</p>}
        <button
          onClick={onConfirm}
          disabled={sending}
          className="w-full rounded-card bg-safe py-2.5 text-[13px] font-semibold text-ink disabled:opacity-60"
        >
          {sending ? "Checking…" : "I'm safe"}
        </button>
        <p className="text-[10px] text-slate-600">
          This is the PIN you chose when you added your contacts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-1">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[9.5px] font-semibold uppercase tracking-label text-haven">
            Nearest open safe haven
          </p>
          <h2 className="mt-1 text-[17px] font-semibold leading-tight tracking-tight text-slate-50">
            {sos.venue.name}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {sos.venue.tier === 1 ? "Staffed refuge (Ask for Angela)" : "Late-night staffed"} ·{" "}
            {Math.round(sos.metres)} m · {minutes} min walk · {sos.venue.hours}
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-md border border-haven/30 px-2 py-1 text-[9px] font-medium uppercase tracking-label text-haven">
          open now
        </span>
      </div>

      {!alert ? (
        <div className="space-y-2">
          <button
            onClick={onStart}
            disabled={sending || !profile}
            className="w-full rounded-card bg-fast py-3 text-[13px] font-semibold text-white ring-1 ring-white/15 transition active:scale-[0.99] disabled:opacity-60"
          >
            {sending ? "Sending the alert…" : "Text my contacts & share my location"}
          </button>
          <p className="text-[10px] leading-relaxed text-slate-500">
            {profile
              ? `An SMS with your live location goes to ${profile.contacts
                  .map((c) => c.name)
                  .join(", ")}.`
              : "Add a trusted contact first — the alert reaches them by SMS."}
            <button
              onClick={onEditContacts}
              className="ml-1 underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
            >
              {profile ? "Edit contacts" : "Add a contact"}
            </button>
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="rounded-md border border-safe/25 bg-safe/[0.07] px-2 py-1.5 text-[10px] leading-relaxed text-safe">
            {dispatchNote ?? "Alert sent."}
          </p>
          <code className="block truncate rounded-md border border-edge/80 bg-ink px-2 py-1.5 text-[10px] text-slate-400">
            {alert.trackUrl}
          </code>
          <button
            onClick={onResolve}
            className="w-full rounded-card border border-edge/80 py-2.5 text-[13px] font-semibold text-slate-200 transition hover:bg-white/[0.03]"
          >
            I&apos;m safe — end alert
          </button>
        </div>
      )}
      <p className="text-[10px] leading-relaxed text-slate-500">
        Your PIN ends the alert; it never leaves this phone in the clear. Live
        updates stop when you mark yourself safe, or 3 hours after the alert.
      </p>
    </div>
  );
}
