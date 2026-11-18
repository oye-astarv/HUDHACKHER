"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ContactsSetup from "@/components/ContactsSetup";
import SearchBox from "@/components/SearchBox";
import SosGuidance, { type SosState } from "@/components/SosGuidance";
import { dayLight, fmtTime, loadData, type DataBundle } from "@/lib/data";
import { distanceM, pointAlong, polylineLength } from "@/lib/geo";
import { prepare } from "@/lib/graph";
import { DEMO_CENTRE, PRESETS } from "@/lib/presets";
import { computeRoutes, nearestHaven, routeTo } from "@/lib/routing";
import {
  fetchSession,
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
  type PublicSession,
} from "@/lib/tracking";
import type { RouteResult, Venue } from "@/lib/types";
import { openUntil, openVenuesNear, tierLabel, venuesAlong } from "@/lib/venues";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-zinc-500">loading map…</div>,
});

// The walk graph's coverage box (scripts/build-data.mjs).
const BBOX = { s: 53.6188, w: -1.8305, n: 53.6728, e: -1.7395 };
const inCoverage = (lat: number, lon: number) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;

const STREAM_MS = 5000;
const DEMO_STEP_M = 25; // demo walk speed per 5 s tick (≈ brisk walk, sped up for stage demos)

type Tab = "audit" | "havens" | "track" | "network";
type Place = { lat: number; lon: number; name: string };
type Gps = { status: "idle" | "locating" | "ok" | "outside" | "denied" | "unsupported"; fix: Place | null };
type Haven = { venue: Venue; metres: number; coords: [number, number][] };

function initialHour(): number {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 14) return Math.round(h * 4) / 4;
  if (h < 1) return Math.round((h + 24) * 4) / 4;
  return 23.5; // morning: show the night-time behaviour by default
}

export default function Page() {
  const [bundle, setBundle] = useState<DataBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("audit");
  const [skipSetup, setSkipSetup] = useState(false);

  const [presetId, setPresetId] = useState<string | null>(PRESETS[0].id);
  const [origin, setOrigin] = useState<Place>(PRESETS[0].from);
  const [destination, setDestination] = useState<Place>(PRESETS[0].to);
  const [gps, setGps] = useState<Gps>({ status: "idle", fix: null });
  const [hour, setHour] = useState(23.5);
  const [selected, setSelected] = useState<"safe" | "fastest">("safe");
  const [walkMetres, setWalkMetres] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const [haven, setHaven] = useState<Haven | null>(null);
  const [sosState, setSosState] = useState<SosState | null>(null);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [alert, setAlert] = useState<ActiveAlert | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [livePoint, setLivePoint] = useState<[number, number] | null>(null);

  const firedRef = useRef<Set<string>>(new Set());
  const watchRef = useRef<number | null>(null);
  const gpsFixRef = useRef<{ lat: number; lon: number } | null>(null);
  const simRef = useRef({ on: false, metres: 0 });
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);

  // ---------- load ----------
  useEffect(() => {
    setHour(initialHour());
    setProfile(loadProfile());
    setAlert(loadAlert());
    setProfileLoaded(true);
    loadData()
      .then(setBundle)
      .catch((err) => setLoadError(err.message));
  }, []);

  const graph = useMemo(() => (bundle ? prepare(bundle.graph) : null), [bundle]);
  const hourInt = ((Math.floor(hour) % 24) + 24) % 24;
  const light = useMemo(() => dayLight(DEMO_CENTRE.lat, DEMO_CENTRE.lon, hour), [hour]);

  // ---------- GPS ----------
  const locate = useCallback((quiet = false) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGps({ status: "unsupported", fix: null });
      return;
    }
    setGps((g) => ({ ...g, status: "locating" }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: "Your location" };
        gpsFixRef.current = fix;
        if (inCoverage(fix.lat, fix.lon)) {
          setGps({ status: "ok", fix });
          setOrigin(fix);
          setPresetId(null);
        } else {
          setGps({ status: "outside", fix });
          if (!quiet) setToast("You're outside the Huddersfield coverage area — using the demo start point.");
        }
      },
      () => setGps({ status: "denied", fix: null }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    locate(true);
  }, [locate]);

  // ---------- routing ----------
  const routes = useMemo(() => {
    if (!graph || !bundle) return null;
    return computeRoutes({
      graph,
      venues: bundle.venues,
      incidents: bundle.incidents,
      origin,
      destination,
      hour,
      isDark: light.isDark,
      sunset: fmtTime(light.sunset),
      sunrise: fmtTime(light.sunrise),
    });
  }, [graph, bundle, origin, destination, hour, light]);

  const ok = routes && !("error" in routes) ? routes : null;
  const routeError = routes && "error" in routes ? routes.error : null;

  const openVenues = useMemo(
    () => (bundle ? bundle.venues.filter((v) => ((v.openMask >> hourInt) & 1) === 1) : []),
    [bundle, hourInt]
  );

  const labelled = useMemo(() => {
    if (!bundle || !ok) return [];
    return venuesAlong(bundle.venues, ok.safe.coords, origin, hourInt)
      .slice(0, 3)
      .map((x) => ({ ...x, note: `${openUntil(x.venue, hourInt)} · ${x.venue.tier === 1 ? "staffed" : x.venue.kind.replace(/_/g, " ")}` }));
  }, [bundle, ok, origin, hourInt]);

  const chosen: RouteResult | null = ok ? (selected === "safe" ? ok.safe : ok.fastest) : null;
  const walkLength = chosen ? polylineLength(chosen.coords) : 0;
  const walkPoint = chosen && walkMetres > 0 ? pointAlong(chosen.coords, walkMetres) : null;

  // auto check-in when the simulated walker passes an open venue
  useEffect(() => {
    if (!walkPoint) return;
    for (const v of openVenues) {
      if (firedRef.current.has(v.name)) continue;
      if (distanceM(walkPoint[0], walkPoint[1], v.lat, v.lon) < 40) {
        firedRef.current.add(v.name);
        const remaining = Math.max(0, Math.round((walkLength - walkMetres) / 1.33 / 60));
        setToast(`Auto check-in: passed ${v.name} — ${remaining} min from destination`);
      }
    }
  }, [walkPoint, openVenues, walkLength, walkMetres]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---------- emergency loop ----------
  const stopStreaming = useCallback(async () => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null;
    simRef.current = { on: false, metres: 0 };
    setSimulating(false);
    await wakeRef.current?.release().catch(() => undefined);
    wakeRef.current = null;
  }, []);

  const startWatch = useCallback(() => {
    if (watchRef.current != null || !navigator.geolocation) return;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        gpsFixRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
    );
    navigator.wakeLock
      ?.request("screen")
      .then((w) => (wakeRef.current = w))
      .catch(() => undefined);
  }, []);

  /** Where SOS should start from: real GPS when it's inside coverage, else the current origin. */
  const sosStart = useCallback((): { lat: number; lon: number } => {
    const g = gpsFixRef.current;
    if (g && inCoverage(g.lat, g.lon)) return g;
    return { lat: origin.lat, lon: origin.lon };
  }, [origin]);

  const findHaven = useCallback(
    (from: { lat: number; lon: number }): Haven | null => {
      if (!graph || !bundle) return null;
      const found = nearestHaven(bundle.venues, from, hourInt);
      if (!found) return null;
      const path = routeTo(graph, from, { lat: found.venue.lat, lon: found.venue.lon });
      const coords: [number, number][] = path?.coords.length
        ? [[from.lat, from.lon], ...path.coords]
        : [[from.lat, from.lon], [found.venue.lat, found.venue.lon]];
      return { venue: found.venue, metres: path?.metres ?? found.metres, coords };
    },
    [graph, bundle, hourInt]
  );

  const sendAlert = useCallback(
    async (h: Haven, from: { lat: number; lon: number }) => {
      if (!profile) {
        setSosState({ phase: "failed", error: "No trusted contacts yet — set them up in Network, or call 999." });
        return;
      }
      setSosState({ phase: "sending" });
      try {
        const a = await triggerEmergency({
          profile,
          origin: from,
          target: { name: h.venue.name, lat: h.venue.lat, lon: h.venue.lon, metres: Math.round(h.metres) },
        });
        setAlert(a);
        saveAlert(a);
        setSosState({ phase: "active", alert: a });
      } catch (e) {
        setSosState({ phase: "failed", error: `Couldn't reach the alert server (${(e as Error).message}).` });
      }
    },
    [profile]
  );

  const triggerSos = useCallback(async () => {
    if (alert) {
      setGuidanceOpen(true);
      return;
    }
    const from = sosStart();
    const h = findHaven(from);
    if (!h) {
      setToast("No open safe haven found nearby right now — call 999 if you're in danger.");
      return;
    }
    setHaven(h);
    setLivePoint([from.lat, from.lon]);
    setGuidanceOpen(true);
    startWatch();
    await sendAlert(h, from);
  }, [alert, sosStart, findHaven, startWatch, sendAlert]);

  // restore an alert that was active before a reload
  useEffect(() => {
    if (!alert || haven || !graph || !bundle) return;
    fetchSession(alert.id).then(({ status, body }) => {
      if (status !== 200 || body.status !== "active") {
        saveAlert(null);
        setAlert(null);
        return;
      }
      const from = body.last ?? { lat: origin.lat, lon: origin.lon };
      const path = routeTo(graph, from, alert.target);
      setHaven({
        venue: bundle.venues.find((v) => v.name === alert.target.name) ?? {
          name: alert.target.name,
          lat: alert.target.lat,
          lon: alert.target.lon,
          tier: 2,
          kind: "venue",
          hours: "",
          openMask: 0xffffff,
        },
        metres: path?.metres ?? alert.target.metres,
        coords: path?.coords ?? [[from.lat, from.lon], [alert.target.lat, alert.target.lon]],
      });
      setLivePoint([from.lat, from.lon]);
      setSosState({ phase: "active", alert });
      startWatch();
    });
  }, [alert, haven, graph, bundle, origin, startWatch]);

  // stream position every 5 s while an alert is active
  useEffect(() => {
    if (!alert || !haven) return;
    const tick = async () => {
      let p: { lat: number; lon: number } | null = null;
      if (simRef.current.on) {
        simRef.current.metres = Math.min(polylineLength(haven.coords), simRef.current.metres + DEMO_STEP_M);
        const pt = pointAlong(haven.coords, simRef.current.metres);
        if (pt) p = { lat: pt[0], lon: pt[1] };
      } else if (gpsFixRef.current) {
        p = gpsFixRef.current;
      }
      if (!p) return;
      setLivePoint([p.lat, p.lon]);
      const { status } = await pushPoint(alert, p.lat, p.lon).catch(() => ({ status: 0 }));
      if (status === 404 || status === 409) {
        // expired or already resolved elsewhere
        saveAlert(null);
        setAlert(null);
        stopStreaming();
      }
    };
    const id = setInterval(tick, STREAM_MS);
    return () => clearInterval(id);
  }, [alert, haven, stopStreaming]);

  const onResolve = useCallback(
    async (pin: string): Promise<string | null> => {
      if (!alert) return "No active alert.";
      const { status, body } = await resolveAlert(alert, pin).catch(() => ({ status: 0, body: { ok: false } as { ok: boolean; error?: string; left?: number; retryAfterS?: number } }));
      if (status === 200 && body.ok) {
        await stopStreaming();
        saveAlert(null);
        setAlert(null);
        setSosState(null);
        setHaven(null);
        setGuidanceOpen(false);
        setToast("Marked safe. Your contacts' tracking page now shows MARKED SAFE.");
        return null;
      }
      if (body.error === "wrong_pin") return `Incorrect PIN — ${body.left} attempt${body.left === 1 ? "" : "s"} left before a 5-minute lock.`;
      if (body.error === "locked") return `Too many attempts. Try again in ${Math.ceil((body.retryAfterS ?? 300) / 60)} min.`;
      if (status === 0) return "Couldn't reach the server — check your signal and try again.";
      return "Couldn't end the alert.";
    },
    [alert, stopStreaming]
  );

  // ---------- render ----------
  if (loadError) {
    return (
      <Shell>
        <div className="grid min-h-[60vh] place-items-center p-8 text-center">
          <div className="max-w-sm space-y-2">
            <h1 className="text-lg font-semibold">No walk network loaded</h1>
            <p className="text-sm text-zinc-400">{loadError}</p>
            <p className="text-xs text-zinc-500">
              Run <code className="text-safe">npm run data:graph</code>, then reload.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  if (profileLoaded && !profile && !skipSetup) {
    return (
      <Shell>
        <Header />
        <div className="p-5">
          <ContactsSetup
            onboarding
            profile={null}
            onSave={(p) => {
              saveProfile(p);
              setProfile(p);
              setToast("Network saved. SOS will alert them instantly.");
            }}
          />
          <button onClick={() => setSkipSetup(true)} className="mt-4 w-full py-2 text-[12px] text-zinc-500 underline">
            Skip for now — just show me the routes
          </button>
        </div>
      </Shell>
    );
  }

  if (!bundle || !ok) {
    return (
      <Shell>
        <Header />
        <div className="grid min-h-[60vh] place-items-center text-center">
          <div className="space-y-2">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-safe" />
            <p className="text-xs text-zinc-500">{routeError ?? "loading walk network…"}</p>
            {routeError && (
              <button
                className="text-xs font-semibold text-safe"
                onClick={() => {
                  setOrigin(PRESETS[0].from);
                  setDestination(PRESETS[0].to);
                }}
              >
                Reset to demo route
              </button>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const contactCount = profile?.contacts.length ?? 0;
  const deltaMin = ok.safe.audit.minutes - ok.fastest.audit.minutes;
  const fastestHazard =
    ok.fastest.audit.incidentsOnPath > 0 ||
    (light.isDark && (ok.fastest.audit.parkMetres > 0 || ok.fastest.audit.litShare + ok.fastest.audit.inferredShare < 0.7));

  return (
    <Shell>
      <Header />

      {tab === "audit" && (
        <>
          {/* status row */}
          <div className="grid grid-cols-2 border-b border-edge">
            <div className="min-w-0 border-r border-edge p-3">
              <p className="flex items-center gap-2 text-[15px] font-bold">
                <span className="h-2.5 w-2.5 rounded-full bg-safe" /> Huddersfield
              </p>
              <button
                onClick={() => setTab("network")}
                className="mt-2 flex w-full items-center gap-2 border border-edge bg-ink px-2.5 py-2 text-left"
              >
                <ContactIcon />
                <span className="flex-1 text-[13px] leading-tight">
                  Contacts ({contactCount} connected)
                </span>
                <span className={`text-[12px] font-semibold ${contactCount ? "text-safe" : "text-amber-400"}`}>
                  {contactCount ? "Active" : "Set up"}
                </span>
              </button>
            </div>
            <div className="min-w-0 p-3">
              <p className="text-[13px] text-zinc-300">Simulated time</p>
              <div className="mt-2 grid min-w-0 grid-cols-2 border border-edge bg-ink p-0.5 text-[13px]">
                {[
                  { h: 23.5, label: "23:30" },
                  { h: 14, label: "14:00" },
                ].map((o) => (
                  <button
                    key={o.label}
                    onClick={() => setHour(o.h)}
                    className={`py-1.5 font-semibold ${hour === o.h ? "bg-safe text-ink" : "text-zinc-400"}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
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
                  className="h-4 min-w-0 flex-1"
                  aria-label="Simulated time of day"
                />
                <span className="shrink-0 text-right text-[11px] tabular-nums text-zinc-400">{fmtSim(hour)}</span>
              </div>
            </div>
          </div>

          {/* origin */}
          <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
            <Badge letter="A" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-zinc-500">Origin</p>
              <p className="truncate text-[16px] font-medium">{origin.name}</p>
            </div>
            <button
              onClick={() => {
                if (gps.status === "ok" && gps.fix) {
                  setOrigin(gps.fix);
                  setPresetId(null);
                } else locate();
              }}
              className="shrink-0 border border-edge px-2 py-1.5 text-[11px] font-semibold text-safe"
            >
              {gps.status === "locating" ? "Locating…" : "◎ My location"}
            </button>
          </div>

          {/* destination */}
          <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
            <Badge letter="B" red />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-zinc-500">Destination</p>
              <SearchBox
                venues={bundle.venues}
                placeholder={destination.name}
                className="w-full bg-transparent py-0.5 text-[16px] font-medium text-zinc-100 placeholder:text-zinc-100 focus:placeholder:text-zinc-500 focus:outline-none"
                onSelect={(p) => {
                  setDestination({ lat: p.lat, lon: p.lon, name: p.name });
                  setPresetId(null);
                  setWalkMetres(0);
                  firedRef.current.clear();
                }}
              />
            </div>
            <span className="shrink-0 text-zinc-500" aria-hidden>⌕</span>
          </div>

          <div className="flex gap-1.5 overflow-x-auto border-b border-edge px-4 py-2">
            <span className="shrink-0 self-center text-[10px] uppercase tracking-wider text-zinc-500">Demo</span>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setPresetId(p.id);
                  setOrigin(p.from);
                  setDestination(p.to);
                  setWalkMetres(0);
                  firedRef.current.clear();
                }}
                className={`shrink-0 border px-2.5 py-1 text-[11px] ${
                  p.id === presetId ? "border-safe/60 bg-safe/10 text-safe" : "border-edge text-zinc-400"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* map */}
          <div className="relative h-[360px] border-b border-edge">
            <MapCanvas
              centre={[DEMO_CENTRE.lat, DEMO_CENTRE.lon]}
              fastest={ok.fastest}
              safe={ok.sameRoute ? null : ok.safe}
              selected={selected}
              venues={openVenues}
              labelled={labelled}
              incidents={bundle.incidents}
              origin={[origin.lat, origin.lon]}
              destination={[destination.lat, destination.lon]}
              walk={walkPoint}
              onPick={(lat, lon) => {
                setDestination({ lat, lon, name: "Dropped pin" });
                setPresetId(null);
                setWalkMetres(0);
              }}
            />
            {toast && (
              <div className="pointer-events-none absolute inset-x-3 top-3 z-[1000] border border-safe/50 bg-ink/95 px-3 py-2 text-[12px] text-safe">
                {toast}
              </div>
            )}
          </div>

          {/* route comparison */}
          <div className="grid grid-cols-2 border-b border-edge">
            <RouteCard
              title="Lit & Open Route"
              badge={{ text: "Recommended", tone: "green" }}
              route={ok.safe}
              sub={deltaMin > 0 ? `+${deltaMin} min${deltaMin === 1 ? "" : "s"}` : "No extra time"}
              active={selected === "safe"}
              onSelect={() => setSelected("safe")}
              isDark={light.isDark}
            />
            <RouteCard
              title="Shortest Route"
              badge={fastestHazard ? { text: "Hazards", tone: "red" } : undefined}
              route={ok.fastest}
              sub={
                ok.fastest.audit.incidentsOnPath > 0
                  ? "Passes a recent incident"
                  : ok.fastest.audit.parkMetres > 0 && light.isDark
                    ? "Unlit park shortcut"
                    : "Most direct"
              }
              active={selected === "fastest"}
              onSelect={() => setSelected("fastest")}
              isDark={light.isDark}
              muted
            />
          </div>

          <div className="space-y-2 px-4 py-3">
            {ok.sameRoute && (
              <p className="border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                Both routes are the same here — the safest path is also the shortest.
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-zinc-500">
              {light.isDark
                ? `After dark: ${Math.round(ok.safe.audit.litShare * 100)}% of the recommended route is confirmed lit, ${Math.round(ok.safe.audit.inferredShare * 100)}% inferred from road type, ${Math.round(ok.safe.audit.unknownShare * 100)}% has no lighting data.`
                : `Daylight — lighting doesn't affect routing until sunset at ${fmtTime(light.sunset)}.`}
            </p>
            <WalkScrubber length={walkLength} metres={walkMetres} onChange={setWalkMetres} minutes={chosen?.audit.minutes ?? 0} />
          </div>
        </>
      )}

      {tab === "havens" && (
        <HavensList
          venues={bundle.venues}
          from={origin}
          hour={hourInt}
          onRoute={(v) => {
            setDestination({ lat: v.lat, lon: v.lon, name: v.name });
            setPresetId(null);
            setTab("audit");
          }}
        />
      )}

      {tab === "track" && <TrackTab alert={alert} onOpenGuidance={() => setGuidanceOpen(true)} />}

      {tab === "network" && (
        <div className="p-5">
          <ContactsSetup
            profile={profile}
            onSave={(p) => {
              saveProfile(p);
              setProfile(p);
              setToast("Network saved.");
              setTab("audit");
            }}
            onCancel={profile ? () => setTab("audit") : undefined}
          />
        </div>
      )}

      {/* SOS bar */}
      <div className="sticky bottom-[68px] z-[1100] px-4 pb-3 pt-2">
        <button onClick={triggerSos} className="flex w-full items-center gap-3 bg-alarm px-4 py-3 text-left shadow-[0_8px_30px_rgba(217,45,45,0.35)]">
          <span className="grid h-9 w-9 shrink-0 place-items-center bg-white text-[12px] font-extrabold text-alarm">SOS</span>
          <span className="flex-1">
            <span className="block text-[15px] font-extrabold uppercase leading-tight text-white">
              {alert ? "Alert active — open guidance" : "Find safe haven & alert contacts"}
            </span>
            <span className="block text-[11px] text-white/85">
              {alert ? "Live location streaming to your contacts" : "Dispatches live GPS coordinates to trusted contacts"}
            </span>
          </span>
          <span className="text-xl text-white">→</span>
        </button>
      </div>

      <BottomNav tab={tab} onTab={setTab} trackActive={Boolean(alert)} />

      {guidanceOpen && haven && sosState && (
        <SosGuidance
          state={sosState}
          haven={haven}
          you={livePoint ?? [origin.lat, origin.lon]}
          hour={hourInt}
          gpsNote={
            simulating
              ? "Demo walk: moving your pin toward the haven"
              : gpsFixRef.current
                ? "Streaming your GPS every 5 s"
                : "No GPS fix — sharing your start point"
          }
          simulating={simulating}
          onToggleSimulate={() => {
            const on = !simRef.current.on;
            simRef.current = { on, metres: on ? simRef.current.metres : simRef.current.metres };
            setSimulating(on);
          }}
          onBack={() => setGuidanceOpen(false)}
          onRetry={() => sendAlert(haven, livePoint ? { lat: livePoint[0], lon: livePoint[1] } : sosStart())}
          onShareManual={() => alert && shareManually(alert)}
          onResolve={onResolve}
        />
      )}
    </Shell>
  );
}

// ---------- pieces ----------

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-[var(--app-h)] max-w-md border-x border-edge bg-panel pb-[76px]">{children}</main>;
}

function Header() {
  return (
    <header className="flex items-center gap-3 border-b border-edge bg-ink px-4 pb-3 pt-[max(env(safe-area-inset-top),14px)]">
      <span className="h-4 w-4 shrink-0 bg-alarm" />
      <div>
        <p className="text-[13px] font-medium text-zinc-300">SafeStride</p>
        <h1 className="text-[21px] font-bold leading-tight tracking-tight">Huddersfield Route Audit</h1>
      </div>
    </header>
  );
}

function Badge({ letter, red }: { letter: string; red?: boolean }) {
  return (
    <span className={`grid h-6 w-6 shrink-0 place-items-center text-[11px] font-bold ${red ? "bg-alarm text-white" : "bg-zinc-100 text-ink"}`}>
      {letter}
    </span>
  );
}

function RouteCard({
  title,
  badge,
  route,
  sub,
  active,
  onSelect,
  isDark,
  muted,
}: {
  title: string;
  badge?: { text: string; tone: "green" | "red" };
  route: RouteResult;
  sub: string;
  active: boolean;
  onSelect: () => void;
  isDark: boolean;
  muted?: boolean;
}) {
  const a = route.audit;
  const lit = Math.round((a.litShare + a.inferredShare) * 100);
  const litGood = !isDark || lit >= 75;
  return (
    <button
      onClick={onSelect}
      className={`border-l-4 p-4 text-left ${active ? (muted ? "border-zinc-400 bg-ink/50" : "border-safe bg-ink/50") : "border-transparent"} ${muted ? "border-r-0" : "border-r border-r-edge"}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className={`text-[14px] font-semibold leading-tight ${muted ? "text-zinc-400" : "text-safe"}`}>{title}</span>
        {badge && (
          <span
            className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold ${
              badge.tone === "green" ? "bg-safe/15 text-safe" : "bg-alarm/20 text-red-300"
            }`}
          >
            {badge.text}
          </span>
        )}
      </div>
      <p className={`mt-3 text-[34px] font-bold leading-none ${muted ? "text-zinc-500" : "text-white"}`}>
        {a.minutes}
        <span className="ml-1 text-[15px] font-semibold">MIN</span>
      </p>
      <p className="mt-1 text-[12px] text-zinc-500">{sub}</p>
      <dl className="mt-3 space-y-2 border-t border-edge pt-3 text-[12px]">
        <Stat label="Lit roads" value={`${lit}%`} tone={litGood ? "green" : "red"} />
        <Stat label="Open safe havens" value={a.openVenues ? `${a.openVenues} open` : "0 (isolated)"} tone={a.openVenues ? "white" : "muted"} />
        <Stat
          label="News notices"
          value={a.incidentsOnPath ? `${a.incidentsOnPath} incident ahead` : "0 on path"}
          tone={a.incidentsOnPath ? "red" : "green"}
        />
      </dl>
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "green" | "red" | "white" | "muted" }) {
  const c = { green: "text-safe", red: "text-red-400", white: "text-white", muted: "text-zinc-400" }[tone];
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-zinc-400">{label}</dt>
      <dd className={`text-right font-semibold tabular-nums ${c}`}>{value}</dd>
    </div>
  );
}

function WalkScrubber({ length, metres, onChange, minutes }: { length: number; metres: number; onChange: (n: number) => void; minutes: number }) {
  const progress = length > 0 ? metres / length : 0;
  return (
    <div className="border border-edge bg-ink/60 p-2.5">
      <div className="flex justify-between text-[11px] text-zinc-400">
        <span>Simulate walk (auto check-ins at open venues)</span>
        <span className="tabular-nums">{Math.max(0, Math.round(minutes * (1 - progress)))} min left</span>
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
    </div>
  );
}

function HavensList({
  venues,
  from,
  hour,
  onRoute,
}: {
  venues: Venue[];
  from: { lat: number; lon: number; name: string };
  hour: number;
  onRoute: (v: Venue) => void;
}) {
  const list = openVenuesNear(venues, from, hour).slice(0, 20);
  return (
    <div className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Open at {String(hour).padStart(2, "0")}:00 near {from.name}</p>
      <h2 className="mt-1 text-xl font-bold">Safe havens</h2>
      <p className="mt-1 text-[12px] text-zinc-400">Staffed venues (Ask for Angela) are preferred by SOS, up to 120 m further away.</p>
      {list.length === 0 && <p className="mt-6 text-sm text-zinc-400">Nothing mapped is open at this hour.</p>}
      <ul className="mt-3 divide-y divide-edge border border-edge">
        {list.map(({ venue, metres }) => (
          <li key={`${venue.name}-${venue.lat}`} className="flex items-center gap-3 px-3 py-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${venue.tier === 1 ? "bg-safe" : "border border-safe"}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{venue.name}</p>
              <p className="text-[11px] text-zinc-500">
                {tierLabel(venue)} · {openUntil(venue, hour)}
                {venue.assumed ? " (est.)" : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[13px] font-semibold text-safe">{Math.round(metres)}m</p>
              <button onClick={() => onRoute(venue)} className="text-[11px] text-zinc-400 underline">
                Route
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrackTab({ alert, onOpenGuidance }: { alert: ActiveAlert | null; onOpenGuidance: () => void }) {
  const [session, setSession] = useState<PublicSession | null>(null);
  useEffect(() => {
    if (!alert) return;
    let live = true;
    const poll = () =>
      fetchSession(alert.id).then(({ status, body }) => {
        if (live && status === 200) setSession(body);
      });
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [alert]);

  if (!alert) {
    return (
      <div className="p-5">
        <h2 className="text-xl font-bold">Live tracking</h2>
        <p className="mt-2 text-[13px] text-zinc-400">
          No active alert. When you press SOS, your contacts get a link to a live map of your position. It updates every 5
          seconds until you enter your PIN, and is deleted automatically after 3 hours.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 p-5">
      <h2 className="text-xl font-bold">Live tracking</h2>
      <div className="border border-alarm/50 bg-alarm/10 p-3">
        <p className="text-[12px] font-bold uppercase tracking-wider text-red-300">Active emergency</p>
        <p className="mt-1 text-[13px]">Heading to {alert.target.name}</p>
        <p className="text-[11px] text-zinc-400">
          {session?.trail.length ?? 0} position updates sent
          {session?.last ? ` · last ${Math.round((Date.now() - session.last.ts) / 1000)}s ago` : ""}
        </p>
      </div>
      <a href={alert.trackUrl} target="_blank" rel="noreferrer" className="block border border-edge p-3 text-[12px] text-safe underline">
        Open follower view (what your contacts see)
      </a>
      <button onClick={onOpenGuidance} className="w-full bg-alarm py-3 text-sm font-bold text-white">
        Open safe haven guidance
      </button>
    </div>
  );
}

function BottomNav({ tab, onTab, trackActive }: { tab: Tab; onTab: (t: Tab) => void; trackActive: boolean }) {
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "audit", label: "Audit", icon: <ForkIcon /> },
    { id: "havens", label: "Havens", icon: <ShieldIcon /> },
    { id: "track", label: "Track", icon: <TargetIcon /> },
    { id: "network", label: "Network", icon: <ContactIcon /> },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-[1200] mx-auto grid max-w-md grid-cols-4 border-x border-t border-edge bg-ink pb-[env(safe-area-inset-bottom)]">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onTab(it.id)}
          className={`relative flex h-[68px] flex-col items-center justify-center gap-1 text-[12px] font-bold uppercase tracking-wider ${
            tab === it.id ? "bg-alarm text-white" : "text-zinc-400"
          }`}
        >
          {it.icon}
          {it.label}
          {it.id === "track" && trackActive && <span className="absolute right-6 top-3 h-2 w-2 animate-pulse rounded-full bg-red-400" />}
        </button>
      ))}
    </nav>
  );
}

function fmtSim(hour: number): string {
  const h = Math.floor(hour % 24);
  const m = Math.round((hour % 1) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const iconProps = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;
function ForkIcon() {
  return (
    <svg {...iconProps}>
      <path d="M6 3v6a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3M12 15v6M6 3l-2 2M6 3l2 2M18 3l-2 2M18 3l2 2" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function TargetIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
function ContactIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="5" width="18" height="14" rx="1" />
      <circle cx="9" cy="11" r="2.2" />
      <path d="M5.5 16.5c.8-1.6 2-2.4 3.5-2.4s2.7.8 3.5 2.4M14.5 10h4M14.5 13.5h3" />
    </svg>
  );
}
