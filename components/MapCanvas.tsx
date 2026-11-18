"use client";

import { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import IncidentDetails from "@/components/IncidentDetails";
import { timeAgo } from "@/lib/incidents";
import { tierLabel } from "@/lib/venues";
import { isMapped, type Incident, type RouteResult, type Venue } from "@/lib/types";

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
  /** GPS accuracy circle around the user's position */
  accuracy?: { centre: [number, number]; metres: number } | null;
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
  accuracy = null,
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

      {!compact &&
        incidents.filter(isMapped).map((inc, i) => (
          <Circle
            key={`inc-r-${inc.id ?? i}`}
            center={[inc.lat, inc.lon]}
            radius={100}
            pathOptions={{ color: AMBER, weight: 1, opacity: 0.5, fillOpacity: 0.08, dashArray: "2 6" }}
            interactive={false}
          />
        ))}

      {/* open venues: small and neutral so they never compete with the route */}
      {!compact &&
        venues.map((v, i) => (
          <CircleMarker
            key={`${v.name}-${i}`}
            center={[v.lat, v.lon]}
            radius={v.tier === 1 ? 4 : 3}
            bubblingMouseEvents={false}
            pathOptions={{ color: "#0E0E10", weight: 1, fillColor: v.tier === 1 ? "#E4E4E7" : "#A1A1AA", fillOpacity: 0.9 }}
          >
            <Tooltip>
              <b>{v.name}</b>
              <br />
              {tierLabel(v)} · {v.hours}
            </Tooltip>
          </CircleMarker>
        ))}

      {/* the unselected route underneath, the selected one on top */}
      {selected === "safe" ? (
        <>
          {fastest && <RouteLine route={fastest} kind="fastest" active={false} />}
          {safe && <RouteLine route={safe} kind="safe" active />}
        </>
      ) : (
        <>
          {safe && <RouteLine route={safe} kind="safe" active={false} />}
          {fastest && <RouteLine route={fastest} kind="fastest" active />}
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

      {labelled.map(({ venue, metres, note }, i) => (
        <CircleMarker
          key={`lab-${venue.name}-${i}`}
          center={[venue.lat, venue.lon]}
          radius={5}
          bubblingMouseEvents={false}
          pathOptions={{ color: "#0E0E10", fillColor: "#FFFFFF", fillOpacity: 1, weight: 2 }}
        >
          <Tooltip permanent direction="auto" offset={[0, 0]} className="ss-callout ss-callout-venue">
            <span className="ss-callout-title">{venue.name}</span>
            {metres > 0 && <span className="ss-callout-dist"> · {Math.round(metres)}m</span>}
            {note && (
              <>
                <br />
                <span className="ss-callout-sub">{note}</span>
              </>
            )}
          </Tooltip>
        </CircleMarker>
      ))}

      {!compact &&
        incidents.filter(isMapped).map((inc, i) => (
          <CircleMarker
            key={`inc-${inc.id ?? i}`}
            center={[inc.lat, inc.lon]}
            radius={11}
            bubblingMouseEvents={false}
            pathOptions={{ color: AMBER, fillColor: AMBER, fillOpacity: 0.35, weight: 2, dashArray: "3 3" }}
          >
            {/* 100 m detour radius the router applies */}
            <Tooltip permanent direction="top" offset={[0, -10]} className="ss-callout ss-callout-amber">
              <span className="ss-callout-title">! {inc.category}</span>
              <span className="ss-callout-sub"> · {timeAgo(inc.firstReportedAt ?? inc.publishedAt)} · tap</span>
            </Tooltip>
            <Popup className="ss-popup" maxWidth={290} minWidth={240} autoPanPadding={[16, 16]}>
              <IncidentDetails inc={inc} />
            </Popup>
          </CircleMarker>
        ))}
      {accuracy && accuracy.metres < 2000 && (
        <Circle
          center={accuracy.centre}
          radius={accuracy.metres}
          interactive={false}
          pathOptions={{ color: "#3B82F6", weight: 1, opacity: 0.6, fillColor: "#3B82F6", fillOpacity: 0.12 }}
        />
      )}

      {origin && !compact && trail.length === 0 && (
        <Marker position={origin} icon={pinIcon("A")} zIndexOffset={900} keyboard={false}>
          <Tooltip direction="right" offset={[14, -14]} className="ss-tag">
            Start
          </Tooltip>
        </Marker>
      )}
      {origin && (compact || trail.length > 0) && (
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

      {destination && !sos && !compact && trail.length === 0 && (
        <Marker position={destination} icon={pinIcon("B")} zIndexOffset={1000} keyboard={false}>
          <Tooltip direction="right" offset={[14, -14]} className="ss-tag">
            Destination
          </Tooltip>
        </Marker>
      )}
      {destination && !sos && (compact || trail.length > 0) && (
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

/** Square A / B pins (matches the A / B badges in the route form). */
function pinIcon(letter: "A" | "B") {
  return L.divIcon({
    className: "",
    html: `<div class="ss-pin ss-pin-${letter.toLowerCase()}">${letter}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export const BAND_COLOUR = { safe: "#2BFF88", caution: "#FFC233", risky: "#FF4D4D" } as const;

/**
 * The selected route: thick, dark-cased, each stretch coloured by its safety
 * band. The other route: thin dashed white for comparison.
 */
function RouteLine({ route, kind, active }: { route: RouteResult; kind: "safe" | "fastest"; active: boolean }) {
  const label = `${kind === "safe" ? "Recommended (lit & open)" : "Shortest"} · ${route.audit.minutes} min · safety ${route.audit.safetyScore}/100`;
  if (!active) {
    return (
      <>
        <Polyline positions={route.coords} interactive={false} pathOptions={{ color: "#0E0E10", weight: 6, opacity: 0.55, lineCap: "round" }} />
        <Polyline positions={route.coords} pathOptions={{ color: "#F4F4F5", weight: 3, opacity: 0.75, dashArray: "1 8", lineCap: "round" }}>
          <Tooltip sticky>{label} — tap its card or the switch to view</Tooltip>
        </Polyline>
      </>
    );
  }
  return (
    <>
      <Polyline
        positions={route.coords}
        interactive={false}
        pathOptions={{ color: "#000000", weight: 12, opacity: 0.85, lineCap: "round", lineJoin: "round" }}
      />
      {route.segments.map((seg, i) => (
        <Polyline
          key={i}
          positions={seg.coords}
          pathOptions={{ color: BAND_COLOUR[seg.band], weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" }}
        >
          <Tooltip sticky>
            {label}
            <br />
            This stretch: {seg.band === "safe" ? "safe" : seg.band === "caution" ? "caution" : "risky — dark, isolated or near an incident"}
          </Tooltip>
        </Polyline>
      ))}
    </>
  );
}
