import { distanceM } from "./geo";
import {
  aStar,
  FLAG_PARK,
  FLAG_PATH,
  snap,
  type AdjEntry,
  type PreparedGraph,
} from "./graph";
import {
  LIGHT,
  type Incident,
  type RouteAudit,
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

/**
 * Street lighting penalty. Note `unknown` is *not* priced as lit: on an unlit
 * path after dark we can't know, so we default to the cautious side.
 */
export function lightingFactor(entry: AdjEntry, isDark: boolean): number {
  if (!isDark) return 1;

  const inDarkPark = (entry.flags & FLAG_PARK) !== 0;
  const isPath = (entry.flags & FLAG_PATH) !== 0;

  if (entry.light === LIGHT.TAGGED_NO) return 3.5;
  if (inDarkPark && isPath) return 3.5;

  switch (entry.light) {
    case LIGHT.TAGGED_YES:
    case LIGHT.LAMP_NEAR:
      return 1;
    case LIGHT.CLASS_PRIOR:
      return 0.85;
    case LIGHT.UNKNOWN:
      // Uncertain is not the same as safe: price it above a street we know is lit.
      return isPath ? 2.8 : 1.9;
    default:
      return 1;
  }
}

/** Edges within 100m of a recent incident, so routing can detour around them. */
export function incidentEdgeSet(
  g: PreparedGraph,
  incidents: Incident[]
): Set<number> {
  const out = new Set<number>();
  if (incidents.length === 0) return out;

  for (let i = 0; i < g.edgeMid.length; i++) {
    const [lat, lon] = g.edgeMid[i];
    for (const inc of incidents) {
      if (distanceM(lat, lon, inc.lat, inc.lon) <= 100) {
        out.add(i);
        break;
      }
    }
  }
  return out;
}

function safeWeight(entry: AdjEntry, ctx: RouteContext): number {
  let cost = entry.len;
  cost *= lightingFactor(entry, ctx.isDark);
  // Mild enough that "eyes on the street" can't outvote an unlit shortcut.
  if (ctx.isDark && ((entry.openMask >> ctx.hour) & 1) === 1) cost *= 0.75;
  if (ctx.incidentEdges.has(entry.edge)) cost *= 5;
  return cost;
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

  for (const ei of path.edges) {
    const [, , len, light, , flags] = g.art.edges[ei];
    if ((flags & FLAG_PARK) !== 0) parkMetres += len;

    if (light === LIGHT.TAGGED_YES || light === LIGHT.LAMP_NEAR) lit += len;
    else if (light === LIGHT.CLASS_PRIOR) inferred += len;
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
  const incidentsOnPath = incidents.filter((inc) =>
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
  };
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
  const safePath = aStar(graph, start, goal, (e) => safeWeight(e, ctx), 0.5);

  if (!fastestPath || !safePath) {
    return { error: "No walkable route found between those points." };
  }

  const fastest: RouteResult = {
    kind: "fastest",
    coords: fastestPath.coords,
    audit: auditRoute(graph, fastestPath, ctx, venues, incidents),
  };
  const safe: RouteResult = {
    kind: "safe",
    coords: safePath.coords,
    audit: auditRoute(graph, safePath, ctx, venues, incidents),
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
