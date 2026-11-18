"use client";

import SunCalc from "suncalc";
import type { GraphArtifact, Incident, Venue } from "./types";

const CACHE = new Map<string, unknown>();

async function loadJson<T>(path: string): Promise<T> {
  if (CACHE.has(path)) return CACHE.get(path) as T;
  // Revalidate rather than trust a cached copy: incidents.json changes every
  // time the news pipeline runs, and a stale copy silently hides new pins.
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  const data = (await res.json()) as T;
  CACHE.set(path, data);
  return data;
}

export type DataBundle = {
  graph: GraphArtifact;
  venues: Venue[];
  incidents: Incident[];
};

export async function loadData(): Promise<DataBundle> {
  const [graph, venues, incidents] = await Promise.all([
    loadJson<GraphArtifact>("/data/graph.json"),
    loadJson<Venue[]>("/data/venues.json"),
    loadJson<Incident[]>("/data/incidents.json").catch(() => [] as Incident[]),
  ]);
  return { graph, venues, incidents };
}

export type DayLight = {
  sunset: Date | null;
  sunrise: Date | null;
  isDark: boolean;
  label: string;
};

/**
 * Sun times for the simulated timestamp at the current location.
 * `hour` is a float in 14..25 so the slider can run past midnight.
 */
export function dayLight(
  lat: number,
  lon: number,
  hour: number,
  base = new Date()
): DayLight {
  const t = new Date(base);
  const dayOffset = hour >= 24 ? 1 : 0;
  t.setDate(t.getDate() + dayOffset);
  t.setHours(Math.floor(hour % 24), Math.round((hour % 1) * 60), 0, 0);

  const times = SunCalc.getTimes(t, lat, lon);
  const sunset = times.sunset && !isNaN(times.sunset.getTime()) ? times.sunset : null;
  const sunrise = times.sunrise && !isNaN(times.sunrise.getTime()) ? times.sunrise : null;

  const isDark =
    (sunset && t >= sunset) || (sunrise ? t <= sunrise : false) || !sunset;

  const label = t.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return { sunset, sunrise, isDark: Boolean(isDark), label };
}

export const fmtTime = (d: Date | null): string =>
  d
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "—";
