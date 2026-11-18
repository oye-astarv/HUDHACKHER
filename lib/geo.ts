import type { LatLon } from "./types";

const R = 6371000;
const RAD = Math.PI / 180;

/** Metres between two points (haversine). */
export function distanceM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function nearestPoint(
  points: [number, number][],
  target: LatLon
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    // cheap planar pre-check keeps this to ~2ms over 35k nodes
    const dLat = points[i][0] - target.lat;
    const dLon = points[i][1] - target.lon;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

type HeapEntry = { node: number; f: number };

/** Minimal binary min-heap keyed on f. */
export class MinHeap {
  private items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: number, f: number): void {
    const items = this.items;
    items.push({ node, f });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= items[i].f) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): HeapEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as HeapEntry;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l].f < items[smallest].f) smallest = l;
        if (r < items.length && items[r].f < items[smallest].f) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Point `metres` along a [lat,lon] polyline (the walk scrubber). */
export function pointAlong(
  coords: [number, number][],
  metres: number
): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1) return coords[0];

  let remaining = Math.max(0, metres);
  for (let i = 1; i < coords.length; i++) {
    const [aLat, aLon] = coords[i - 1];
    const [bLat, bLon] = coords[i];
    const seg = distanceM(aLat, aLon, bLat, bLon);
    if (remaining <= seg || i === coords.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t];
    }
    remaining -= seg;
  }
  return coords[coords.length - 1];
}

/** Total length of a [lat,lon] polyline in metres. */
export function polylineLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}
