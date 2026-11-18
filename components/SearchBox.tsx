"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bboxOf, inRegion, type Region } from "@/lib/regions";
import type { Venue } from "@/lib/types";

export type Place = { lat: number; lon: number; name: string; detail?: string };


/**
 * Destination search. Mapped venues match instantly (offline); addresses,
 * streets and landmarks come from Nominatim, debounced to respect its
 * 1 request/second usage policy.
 */
export default function SearchBox({
  venues,
  onSelect,
  placeholder = "Where are you going? Street, venue or postcode",
  className = "",
  ariaLabel = "Search destination",
  region,
}: {
  /** results are limited to this region's map area — outside it can't be routed */
  region: Region;
  venues: Venue[];
  onSelect: (p: Place) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const q = query.trim();
  const bbox = useMemo(() => bboxOf(region), [region]);

  const local: Place[] =
    q.length >= 2
      ? venues
          .filter((v) => v.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 4)
          .map((v) => ({ lat: v.lat, lon: v.lon, name: v.name, detail: v.kind }))
      : [];

  useEffect(() => {
    if (q.length < 3) {
      setRemote([]);
      setError(null);
      return;
    }
    const id = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          q,
          format: "jsonv2",
          limit: "6",
          countrycodes: "gb",
          viewbox: `${bbox.w},${bbox.n},${bbox.e},${bbox.s}`,
          bounded: "1",
        });
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?${params}`,
          { signal: ctrl.signal, headers: { "Accept-Language": "en-GB" } }
        );
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const rows = (await res.json()) as {
          lat: string;
          lon: string;
          name?: string;
          display_name: string;
        }[];
        setRemote(
          rows
            .map((r) => {
              const parts = r.display_name.split(", ");
              return {
                lat: Number(r.lat),
                lon: Number(r.lon),
                name: r.name || parts[0],
                detail: parts.slice(1, 3).join(", "),
              };
            })
            .filter((p) => inRegion(region, p.lat, p.lon))
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Search unavailable — tap the map instead.");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 700);
    return () => clearTimeout(id);
  }, [q, bbox, region]);

  const results = [
    ...local,
    ...remote.filter(
      (r) => !local.some((l) => l.name === r.name && Math.abs(l.lat - r.lat) < 0.0005)
    ),
  ];

  const pick = (p: Place) => {
    onSelect(p);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) pick(results[0]);
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={
          className ||
          "w-full rounded-xl border border-edge bg-panel/90 px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-500 focus:border-safe/60 focus:outline-none"
        }
      />
      {open && q.length >= 2 && (
        <ul className="absolute inset-x-0 top-full z-[950] mt-1 max-h-64 overflow-y-auto rounded-xl border border-edge bg-panel/95 py-1 shadow-xl backdrop-blur">
          {results.map((r, i) => (
            <li key={`${r.name}-${r.lat}-${i}`}>
              <button
                onClick={() => pick(r)}
                className="block w-full px-3 py-2 text-left hover:bg-safe/10"
              >
                <span className="block text-[12px] text-slate-200">{r.name}</span>
                {r.detail && (
                  <span className="block text-[10px] text-slate-500">{r.detail}</span>
                )}
              </button>
            </li>
          ))}
          {loading && <li className="px-3 py-2 text-[11px] text-slate-500">searching…</li>}
          {error && <li className="px-3 py-2 text-[11px] text-red-300">{error}</li>}
          {!loading && !error && results.length === 0 && q.length >= 3 && (
            <li className="px-3 py-2 text-[11px] text-slate-500">
              No matches inside the {region.name} map area.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
