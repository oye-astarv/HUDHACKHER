"use client";

import { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { Incident, RouteResult, Venue } from "@/lib/types";

export type LabelledVenue = { venue: Venue; metres: number; note: string };

type Props = {
  centre: [number, number];
  fastest?: RouteResult | null;
  safe?: RouteResult | null;
  selected?: "safe" | "fastest";
  venues?: Venue[];
  /** a few venues shown with a permanent callout */
  labelled?: LabelledVenue[];
  incidents?: Incident[];
  sos?: { coords: [number, number][]; venue: Venue } | null;
  origin?: [number, number] | null;
  destination?: [number, number] | null;
  walk?: [number, number] | null;
  trail?: [number, number][];
  onPick?: (lat: number, lon: number) => void;
  /** small, non-interactive inset (SOS guidance card) */
  compact?: boolean;
};

const GREEN = "#4ADE80";
const GREY = "#9CA3AF";
const AMBER = "#F59E0B";
const RED = "#DC2626";

function ClickToPick({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function Fit({ coords, compact }: { coords: [number, number][]; compact?: boolean }) {
  const map = useMap();
  const key = coords.length ? `${coords[0]}|${coords[coords.length - 1]}|${coords.length}` : "";
  useEffect(() => {
    if (coords.length < 2) return;
    const lats = coords.map((c) => c[0]);
    const lons = coords.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: compact ? [24, 24] : [36, 36], maxZoom: 18 }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export default function MapCanvas({
  centre,
  fastest = null,
  safe = null,
  selected = "safe",
  venues = [],
  labelled = [],
  incidents = [],
  sos = null,
  origin = null,
  destination = null,
  walk = null,
  trail = [],
  onPick,
  compact = false,
}: Props) {
  const fitCoords: [number, number][] = sos
    ? [...sos.coords, ...(walk ? [walk] : [])]
    : trail.length
      ? [...trail, ...(destination ? [destination] : [])]
      : [...(fastest?.coords ?? []), ...(safe?.coords ?? [])];

  return (
    <MapContainer
      center={centre}
      zoom={15}
      zoomControl={false}
      attributionControl={!compact}
      dragging={!compact}
      scrollWheelZoom={!compact}
      doubleClickZoom={!compact}
      touchZoom={!compact}
      keyboard={!compact}
      className="h-full w-full"
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        className="dark-tiles"
        attribution="&copy; OpenStreetMap contributors"
        maxZoom={19}
      />

      {onPick && !compact && <ClickToPick onPick={onPick} />}
      <Fit coords={fitCoords} compact={compact} />

      {/* shortest: dashed grey */}
      {fastest && (
        <Polyline
          positions={fastest.coords}
          pathOptions={{
            color: GREY,
            weight: selected === "fastest" ? 5 : 3.5,
            opacity: selected === "fastest" ? 0.95 : 0.7,
            dashArray: "7 8",
            lineCap: "round",
          }}
        >
          <Tooltip sticky>Shortest route · {fastest.audit.minutes} min</Tooltip>
        </Polyline>
      )}

      {/* lit & open: solid green with a soft glow */}
      {safe && (
        <>
          <Polyline positions={safe.coords} pathOptions={{ color: GREEN, weight: 12, opacity: 0.14 }} />
          <Polyline
            positions={safe.coords}
            pathOptions={{
              color: GREEN,
              weight: selected === "safe" ? 5 : 3.5,
              opacity: selected === "safe" ? 1 : 0.7,
              lineCap: "round",
            }}
          >
            <Tooltip sticky>Lit &amp; open route · {safe.audit.minutes} min</Tooltip>
          </Polyline>
        </>
      )}

      {sos && (
        <Polyline
          positions={sos.coords}
          pathOptions={{ color: GREEN, weight: compact ? 4 : 6, opacity: 0.95, dashArray: compact ? "6 5" : undefined }}
        />
      )}

      {trail.length > 1 && (
        <Polyline positions={trail} pathOptions={{ color: "#60A5FA", weight: 4, opacity: 0.8 }} />
      )}

      {!compact &&
        venues.map((v, i) => (
          <CircleMarker
            key={`${v.name}-${i}`}
            center={[v.lat, v.lon]}
            radius={v.tier === 1 ? 5 : 4}
            pathOptions={{
              color: GREEN,
              fillColor: GREEN,
              fillOpacity: v.tier === 1 ? 0.8 : 0.45,
              weight: 1.5,
              opacity: 0.8,
            }}
          >
            <Tooltip>
              <b>{v.name}</b>
              <br />
              {v.tier === 1 ? "Staffed venue (Ask for Angela)" : "Late-night staffed"} · {v.hours}
              {v.assumed ? " (hours assumed)" : ""}
            </Tooltip>
          </CircleMarker>
        ))}

      {labelled.map(({ venue, metres, note }, i) => (
        <CircleMarker
          key={`lab-${venue.name}-${i}`}
          center={[venue.lat, venue.lon]}
          radius={6}
          pathOptions={{ color: GREEN, fillColor: GREEN, fillOpacity: 1, weight: 2 }}
        >
          <Tooltip permanent direction={i % 2 ? "left" : "right"} offset={[i % 2 ? -8 : 8, 0]} className="ss-callout ss-callout-green">
            <span className="ss-callout-title">{venue.name}</span>
            {metres > 0 && <span className="ss-callout-dist"> · {Math.round(metres)}m</span>}
            <br />
            <span className="ss-callout-sub">
              {note}
            </span>
          </Tooltip>
        </CircleMarker>
      ))}

      {!compact &&
        incidents.map((inc, i) => (
          <CircleMarker
            key={`inc-${i}`}
            center={[inc.lat, inc.lon]}
            radius={9}
            pathOptions={{ color: AMBER, fillColor: AMBER, fillOpacity: 0.35, weight: 2, dashArray: "3 3" }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]} className="ss-callout ss-callout-amber" interactive>
              <span className="ss-callout-title">! {inc.category}</span>
              <br />
              <span className="ss-callout-sub">{inc.street}</span>
            </Tooltip>
          </CircleMarker>
        ))}

      {origin && (
        <CircleMarker
          center={origin}
          radius={compact ? 7 : 8}
          pathOptions={{ color: "#FFFFFF", fillColor: "#3B82F6", fillOpacity: 1, weight: 3 }}
        >
          <Tooltip permanent={compact} direction="bottom" className="ss-tag">
            {compact ? "YOU" : "A · start"}
          </Tooltip>
        </CircleMarker>
      )}

      {destination && !sos && (
        <CircleMarker
          center={destination}
          radius={8}
          pathOptions={{ color: "#FFFFFF", fillColor: RED, fillOpacity: 1, weight: 3 }}
        >
          <Tooltip direction="top" className="ss-tag">
            B · destination
          </Tooltip>
        </CircleMarker>
      )}

      {walk && (
        <CircleMarker
          center={walk}
          radius={9}
          pathOptions={{ color: "#FFFFFF", fillColor: "#3B82F6", fillOpacity: 1, weight: 3 }}
        />
      )}

      {sos && (
        <CircleMarker
          center={[sos.venue.lat, sos.venue.lon]}
          radius={compact ? 8 : 12}
          pathOptions={{ color: GREEN, weight: 3, fillOpacity: 0.3, fillColor: GREEN }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]} className="ss-tag ss-tag-green">
            {sos.venue.name.toUpperCase()}
          </Tooltip>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
