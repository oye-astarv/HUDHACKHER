import { MinHeap, distanceM } from "./geo";
import type { GraphArtifact } from "./types";

export type AdjEntry = {
  to: number;
  len: number;
  light: number;
  openMask: number;
  flags: number;
  edge: number;
};

export type PreparedGraph = {
  art: GraphArtifact;
  nodes: [number, number][];
  adj: AdjEntry[][];
  /** midpoint of each undirected edge, for incident proximity */
  edgeMid: [number, number][];
};

export const FLAG_PARK = 1;
export const FLAG_PATH = 2;

export function prepare(art: GraphArtifact): PreparedGraph {
  const adj: AdjEntry[][] = art.nodes.map(() => []);
  const edgeMid: [number, number][] = [];

  for (let i = 0; i < art.edges.length; i++) {
    const [u, v, len, light, openMask, flags] = art.edges[i];
    adj[u].push({ to: v, len, light, openMask, flags, edge: i });
    adj[v].push({ to: u, len, light, openMask, flags, edge: i });
    edgeMid.push([
      (art.nodes[u][0] + art.nodes[v][0]) / 2,
      (art.nodes[u][1] + art.nodes[v][1]) / 2,
    ]);
  }

  return { art, nodes: art.nodes, adj, edgeMid };
}

export type WeightFn = (entry: AdjEntry) => number;

export type PathResult = {
  nodes: number[];
  edges: number[];
  coords: [number, number][];
  cost: number;
  metres: number;
};

/**
 * A*. `heuristicScale` keeps the heuristic admissible for weighted edges:
 * the cheapest possible multiplier in the safe model is ~0.5, so pass 0.5.
 */
export function aStar(
  g: PreparedGraph,
  start: number,
  goal: number,
  weight: WeightFn,
  heuristicScale: number
): PathResult | null {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();

  const goalLat = g.nodes[goal][0];
  const goalLon = g.nodes[goal][1];
  const h = (i: number) =>
    distanceM(g.nodes[i][0], g.nodes[i][1], goalLat, goalLon) * heuristicScale;

  dist[start] = 0;
  heap.push(start, h(start));

  while (heap.size > 0) {
    const top = heap.pop();
    if (!top) break;
    const u = top.node;
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === goal) break;

    for (const entry of g.adj[u]) {
      if (closed[entry.to]) continue;
      const nd = dist[u] + weight(entry);
      if (nd < dist[entry.to]) {
        dist[entry.to] = nd;
        prevNode[entry.to] = u;
        prevEdge[entry.to] = entry.edge;
        heap.push(entry.to, nd + h(entry.to));
      }
    }
  }

  if (prevNode[goal] === -1 && start !== goal) return null;

  const nodes: number[] = [];
  const edges: number[] = [];
  let cur = goal;
  while (cur !== -1) {
    nodes.push(cur);
    if (prevEdge[cur] !== -1) edges.push(prevEdge[cur]);
    cur = prevNode[cur];
  }
  nodes.reverse();
  edges.reverse();

  let metres = 0;
  for (const ei of edges) metres += g.art.edges[ei][2];

  return {
    nodes,
    edges,
    coords: nodes.map((i) => g.nodes[i]),
    cost: dist[goal],
    metres,
  };
}

/** Index of the graph node closest to a coordinate. */
export function snap(g: PreparedGraph, lat: number, lon: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const dLat = g.nodes[i][0] - lat;
    const dLon = g.nodes[i][1] - lon;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}
