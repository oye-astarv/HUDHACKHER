import { distanceM } from "./geo";
import {
  aStar,
  FLAG_ALLEY,
  FLAG_BUSY,
  FLAG_CCTV,
  FLAG_MAJOR,
  FLAG_PARK,
  FLAG_PATH,
  FLAG_SERVICE,
  FLAG_STEPS,
  FLAG_TRACK,
  FLAG_TUNNEL,
  snap,
  type AdjEntry,
  type PreparedGraph,
} from "./graph";
import {
  isMapped,
  LIGHT,
  type Incident,
  type RouteAudit,
  type RouteSegment,
  type RouteResponse,
  type RouteResult,
  type Venue,
} from "./types";

const WALK_SPEED_MPS = 1.33; // 4.8 km/h, UK average pedestrian pace

export type RouteContext = {
  hour: number;
  isDark: boolean;
  incidentEdges: Set<number>;
};

/** Edges within 100m of a recent incident, so routing can detour around them. */
export function incidentEdgeSet(
  g: PreparedGraph,
  incidents: Incident[]
): Set<number> {
  const out = new Set<number>();
  const mapped = incidents.filter(isMapped);
  if (mapped.length === 0) return out;

  for (let i = 0; i < g.edgeMid.length; i++) {
    const [lat, lon] = g.edgeMid[i];
    for (const inc of mapped) {
      if (distanceM(lat, lon, inc.lat, inc.lon) <= 100) {
        out.add(i);
        break;
      }
    }
  }
  return out;
}

/**
 * Safety model. Every street segment gets a RISK score from 0 (safe) to 1.5
 * (avoid), built from common pedestrian-safety indicators after dark:
 *
 *   lighting      mapped lit / lamp 0 · main road 0.05 · no data: residential
 *                 street 0.12 (UK adopted streets are council-lit), service road
 *                 0.45, footpath 0.6 · mapped unlit or park path 0.9
 *   isolation     underpass +0.6 · alley/snicket +0.5 · track +0.5 ·
 *                 off-road footpath +0.15 · service road/car park +0.15 · steps +0.15
 *   activity      open venue within 50 m −0.15 · main road −0.1 ·
 *                 high street / bus stop −0.1 · CCTV −0.05
 *   news          within 100 m of a recent reported incident +1.0
 *
 * Routing cost = length × (1 + RISK_WEIGHT × risk), so after dark a risky
 * street costs up to 6× its length and the safe route really does detour.
 * In daylight lighting is ignored; isolation, footfall and incidents still count
 * at a lower weight, so quiet footpaths and car parks are still avoided.
 */
export const RISK = {
  light: { lit: 0, mainRoad: 0.05, unknownStreet: 0.12, unknownService: 0.45, unknownPath: 0.6, unlit: 0.9 },
  isolation: { underpass: 0.6, alley: 0.5, track: 0.5, footpath: 0.15, service: 0.15, steps: 0.15 },
  activity: { openVenue: -0.15, mainRoad: -0.1, busy: -0.1, cctv: -0.05 },
  incident: 1,
} as const;

export const RISK_WEIGHT = { dark: 3.5, day: 1.2 } as const;

/** Risk bands used for the coloured route and the audit. */
export const BAND = { safe: 0.25, caution: 0.55 } as const;
export type Band = "safe" | "caution" | "risky";
export const bandOf = (risk: number): Band => (risk < BAND.safe ? "safe" : risk < BAND.caution ? "caution" : "risky");

export function edgeRisk(
  e: { light: number; flags: number; openMask: number; edge: number },
  ctx: RouteContext
): number {
  const f = e.flags;
  const isPath = (f & FLAG_PATH) !== 0;
  const inPark = (f & FLAG_PARK) !== 0;
  const incident = ctx.incidentEdges.has(e.edge) ? RISK.incident : 0;

  let iso = 0;
  if (f & FLAG_TUNNEL) iso += RISK.isolation.underpass;
  if (f & FLAG_ALLEY) iso += RISK.isolation.alley;
  if (f & FLAG_TRACK) iso += RISK.isolation.track;

  if (!ctx.isDark) {
    let day = iso * 0.6 + incident;
    if (isPath && !(f & (FLAG_STEPS | FLAG_TRACK))) day += 0.1;
    if (f & FLAG_SERVICE) day += 0.1;
    if (f & FLAG_MAJOR) day -= 0.05;
    if (f & FLAG_BUSY) day -= 0.05;
    return Math.max(0, Math.min(1.5, day));
  }

  let light: number;
  if (e.light === LIGHT.TAGGED_NO || (inPark && isPath)) light = RISK.light.unlit;
  else if (e.light === LIGHT.TAGGED_YES || e.light === LIGHT.LAMP_NEAR) light = RISK.light.lit;
  else if (e.light === LIGHT.CLASS_PRIOR) light = RISK.light.mainRoad;
  else light = isPath ? RISK.light.unknownPath : f & FLAG_SERVICE ? RISK.light.unknownService : RISK.light.unknownStreet;

  if (isPath && !(f & (FLAG_STEPS | FLAG_TRACK))) iso += RISK.isolation.footpath;
  if (f & FLAG_SERVICE) iso += RISK.isolation.service;
  if (f & FLAG_STEPS) iso += RISK.isolation.steps;

  let act = 0;
  if (((e.openMask >> ctx.hour) & 1) === 1) act += RISK.activity.openVenue;
  if (f & FLAG_MAJOR) act += RISK.activity.mainRoad;
  if (f & FLAG_BUSY) act += RISK.activity.busy;
  if (f & FLAG_CCTV) act += RISK.activity.cctv;

  return Math.max(0, Math.min(1.5, light + iso + act + incident));
}

function safeWeight(entry: AdjEntry, ctx: RouteContext): number {
  const k = ctx.isDark ? RISK_WEIGHT.dark : RISK_WEIGHT.day;
  return entry.len * (1 + k * edgeRisk(entry, ctx));
}

type PathLike = { edges: number[]; coords: [number, number][]; metres: number };

function auditRoute(
  g: PreparedGraph,
  path: PathLike,
  ctx: RouteContext,
  venues: Venue[],
  incidents: Incident[]
): RouteAudit {
  let lit = 0;
  let inferred = 0;
  let unknown = 0;
  let parkMetres = 0;
  const nearVenues = new Set<number>();
  let tier1 = 0;
  const m = { major: 0, busy: 0, cctv: 0, alley: 0, tunnel: 0, track: 0, service: 0, steps: 0, footpath: 0 };
  const band = { safe: 0, caution: 0, risky: 0 };
  let riskSum = 0;

  for (const ei of path.edges) {
    const [, , len, light, openMask, flags] = g.art.edges[ei];
    const risk = edgeRisk({ light, flags, openMask, edge: ei }, ctx);
    band[bandOf(risk)] += len;
    riskSum += risk * len;
    if ((flags & FLAG_PARK) !== 0) parkMetres += len;
    if (flags & FLAG_MAJOR) m.major += len;
    if (flags & FLAG_BUSY) m.busy += len;
    if (flags & FLAG_CCTV) m.cctv += len;
    if (flags & FLAG_ALLEY) m.alley += len;
    if (flags & FLAG_TUNNEL) m.tunnel += len;
    if (flags & FLAG_TRACK) m.track += len;
    if (flags & FLAG_SERVICE) m.service += len;
    if (flags & FLAG_STEPS) m.steps += len;
    if (flags & FLAG_PATH && !(flags & (FLAG_STEPS | FLAG_TRACK))) m.footpath += len;

    if (light === LIGHT.TAGGED_YES || light === LIGHT.LAMP_NEAR) lit += len;
    else if (light === LIGHT.CLASS_PRIOR) inferred += len;
    // unmapped ordinary streets count as likely lit (UK adopted highway), shown as inferred
    else if (light === LIGHT.UNKNOWN && !(flags & (FLAG_PATH | FLAG_SERVICE | FLAG_TRACK | FLAG_PARK))) inferred += len;
    else if (light === LIGHT.UNKNOWN) unknown += len;

    const mid = g.edgeMid[ei];
    for (let vi = 0; vi < venues.length; vi++) {
      if (nearVenues.has(vi)) continue;
      const v = venues[vi];
      if (((v.openMask >> ctx.hour) & 1) === 0) continue;
      if (distanceM(mid[0], mid[1], v.lat, v.lon) <= 50) nearVenues.add(vi);
    }
  }

  // incidents the *fastest* route would have walked through but this one avoids
  const incidentsOnPath = incidents.filter(isMapped).filter((inc) =>
    path.edges.some((ei) => {
      const mid = g.edgeMid[ei];
      return distanceM(mid[0], mid[1], inc.lat, inc.lon) <= 100;
    })
  ).length;

  for (const vi of nearVenues) if (venues[vi].tier === 1) tier1++;

  const total = Math.max(1, path.metres);
  return {
    metres: Math.round(path.metres),
    minutes: Math.max(1, Math.round(path.metres / WALK_SPEED_MPS / 60)),
    litShare: lit / total,
    inferredShare: inferred / total,
    unknownShare: unknown / total,
    parkMetres: Math.round(parkMetres),
    openVenues: nearVenues.size,
    incidentsOnPath,
    tier1Venues: tier1,
    mainRoadShare: m.major / total,
    busyShare: m.busy / total,
    cctvMetres: Math.round(m.cctv),
    alleyMetres: Math.round(m.alley),
    underpassMetres: Math.round(m.tunnel),
    trackMetres: Math.round(m.track),
    serviceMetres: Math.round(m.service),
    stepsMetres: Math.round(m.steps),
    footpathMetres: Math.round(m.footpath),
    // 100 = every metre scores zero risk; 0 = average risk of 1 ("avoid")
    safetyScore: Math.max(0, Math.round(100 * (1 - riskSum / total))),
    safeMetres: Math.round(band.safe),
    cautionMetres: Math.round(band.caution),
    riskyMetres: Math.round(band.risky),
  };
}

/** Consecutive edges merged into runs of the same risk band, for colouring the map. */
function segmentsOf(g: PreparedGraph, path: PathLike, ctx: RouteContext): RouteSegment[] {
  const out: RouteSegment[] = [];
  path.edges.forEach((ei, i) => {
    const [, , , light, openMask, flags] = g.art.edges[ei];
    const b = bandOf(edgeRisk({ light, flags, openMask, edge: ei }, ctx));
    const a = path.coords[i];
    const z = path.coords[i + 1];
    const last = out[out.length - 1];
    if (last && last.band === b) last.coords.push(z);
    else out.push({ band: b, coords: [a, z] });
  });
  return out;
}

export function computeRoutes(args: {
  graph: PreparedGraph;
  venues: Venue[];
  incidents: Incident[];
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  hour: number;
  isDark: boolean;
  sunset: string;
  sunrise: string;
}): RouteResponse | { error: string } {
  const { graph, venues, incidents, origin, destination, hour, isDark } = args;

  const start = snap(graph, origin.lat, origin.lon);
  const goal = snap(graph, destination.lat, destination.lon);
  if (start === goal) return { error: "Origin and destination are the same place." };

  const ctx: RouteContext = {
    hour: ((hour % 24) + 24) % 24,
    isDark,
    incidentEdges: incidentEdgeSet(graph, incidents),
  };

  const fastestPath = aStar(graph, start, goal, (e) => e.len, 1);
  const safePath = aStar(graph, start, goal, (e) => safeWeight(e, ctx), 1); // cost ≥ length, so straight-line distance stays admissible

  if (!fastestPath || !safePath) {
    return { error: "No walkable route found between those points." };
  }

  const fastest: RouteResult = {
    kind: "fastest",
    coords: fastestPath.coords,
    audit: auditRoute(graph, fastestPath, ctx, venues, incidents),
    segments: segmentsOf(graph, fastestPath, ctx),
  };
  const safe: RouteResult = {
    kind: "safe",
    coords: safePath.coords,
    audit: auditRoute(graph, safePath, ctx, venues, incidents),
    segments: segmentsOf(graph, safePath, ctx),
  };

  return {
    hour: ctx.hour,
    isDark,
    sunset: args.sunset,
    sunrise: args.sunrise,
    origin,
    destination,
    fastest,
    safe,
    sameRoute: fastestPath.edges.join(",") === safePath.edges.join(","),
  };
}

/** Nearest open venue, preferring tier-1 staffed refuges. */
export function nearestHaven(
  venues: Venue[],
  from: { lat: number; lon: number },
  hour: number
): { venue: Venue; metres: number } | null {
  let best: { venue: Venue; metres: number } | null = null;
  for (const v of venues) {
    if (((v.openMask >> hour) & 1) === 0) continue;
    const d = distanceM(from.lat, from.lon, v.lat, v.lon);
    // tier-1 venues win up to 120m further away
    const score = v.tier === 1 ? d - 120 : d;
    if (!best || score < (best.venue.tier === 1 ? best.metres - 120 : best.metres)) {
      best = { venue: v, metres: d };
    }
  }
  return best;
}

export function routeTo(
  graph: PreparedGraph,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): PathLike | null {
  const start = snap(graph, from.lat, from.lon);
  const goal = snap(graph, to.lat, to.lon);
  if (start === goal) return { edges: [], coords: [graph.nodes[goal]], metres: 0 };
  return aStar(graph, start, goal, (e) => e.len, 1);
}
