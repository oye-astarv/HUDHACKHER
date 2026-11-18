import { distanceM } from "./geo";
import raw from "@/config/regions.json";

export type Place = { lat: number; lon: number; name: string };
export type Preset = { id: string; label: string; from: Place; to: Place };
export type BBox = { s: number; w: number; n: number; e: number };

export type Region = {
  id: string;
  name: string;
  county: string;
  centre: [number, number];
  radiusM: number;
  presets: Preset[];
};

/** Every covered town. Add one in config/regions.json, then build its data. */
export const REGIONS: Region[] = (raw as unknown as Region[]).map((r) => ({
  id: r.id,
  name: r.name,
  county: r.county,
  centre: r.centre,
  radiusM: r.radiusM,
  presets: r.presets,
}));

export const DEFAULT_REGION = REGIONS[0];

export const regionById = (id: string | null | undefined) => REGIONS.find((r) => r.id === id) ?? null;

/** Same square the data builder downloads (scripts/build-data.mjs). */
export function bboxOf(r: Region): BBox {
  const dLat = r.radiusM / 111320;
  const dLon = r.radiusM / (111320 * Math.cos((r.centre[0] * Math.PI) / 180));
  return { s: r.centre[0] - dLat, w: r.centre[1] - dLon, n: r.centre[0] + dLat, e: r.centre[1] + dLon };
}

export function inRegion(r: Region, lat: number, lon: number): boolean {
  const b = bboxOf(r);
  return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
}

/** The covered region containing a point, or null. */
export const regionAt = (lat: number, lon: number) => REGIONS.find((r) => inRegion(r, lat, lon)) ?? null;

export function nearestRegion(lat: number, lon: number): { region: Region; km: number } {
  let best = { region: REGIONS[0], km: Infinity };
  for (const r of REGIONS) {
    const km = distanceM(lat, lon, r.centre[0], r.centre[1]) / 1000;
    if (km < best.km) best = { region: r, km };
  }
  return best;
}

export const dataPath = (r: Region, file: string) => `/data/${r.id}/${file}`;
