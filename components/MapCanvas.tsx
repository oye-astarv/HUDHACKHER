"use client";

import { useCallback, useEffect } from "react";
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

type Props = {
  centre: [number, number];
  fastest: RouteResult | null;
  safe: RouteResult | null;
  venues: Venue[];
  incidents: Incident[];
  sos: { coords: [number, number][]; venue: Venue } | null;
  walk: [number, number] | null;
  onPick: (lat: number, lon: number) => void;
};

function ClickToPick({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitRoutes({ fastest, safe }: { fastest: RouteResult | null; safe: RouteResult | null }) {
  const map = useMap();

  const fit = useCallback(() => {
    // The map div is sized by CSS after Leaflet mounts, so Leaflet keeps a
    // stale size and paints tiles/routes far outside the visible box until it
    // is told to measure again.
    map.invalidateSize();
    const coords = [...(fastest?.coords ?? []), ...(safe?.coords ?? [])];
    if (coords.length < 2) return;
    const lats = coords.map((c) => c[0]);
    const lons = coords.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [40, 60], maxZoom: 17 }
    );
  }, [fastest, safe, map]);

  useEffect(() => {
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [fit, map]);

  return null;
}

export default function MapCanvas({
  centre,
  fastest,
  safe,
  venues,
  incidents,
  sos,
  walk,
  onPick,
}: Props) {
  return (
    <MapContainer
      center={centre}
      zoom={15}
      zoomControl={false}
      attributionControl
      className="h-full w-full"
    >
      {/* CARTO now serves "API KEY REQUIRED" placeholder tiles without a key,
          so the basemap moved to Esri's keyless dark canvas. maxNativeZoom
          keeps zooming past z16 by upscaling the last real tiles. */}
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        attribution="Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"
        maxNativeZoom={16}
        maxZoom={19}
      />

      <ClickToPick onPick={onPick} />
      <FitRoutes fastest={fastest} safe={safe} />

      {/* fastest: dashed coral */}
      {fastest && (
        <Polyline
          positions={fastest.coords}
          pathOptions={{
            color: "#EF4444",
            weight: 4,
            opacity: 0.85,
            dashArray: "8 8",
            lineCap: "round",
          }}
        >
          <Tooltip sticky>Fastest · {fastest.audit.minutes} min</Tooltip>
        </Polyline>
      )}

      {/* safe: glowing teal underlay + solid line */}
      {safe && (
        <>
          <Polyline
            positions={safe.coords}
            pathOptions={{ color: "#14B8A6", weight: 12, opacity: 0.18 }}
          />
          <Polyline
            positions={safe.coords}
            pathOptions={{ color: "#14B8A6", weight: 5, opacity: 1, lineCap: "round" }}
          >
            <Tooltip sticky>Eyes on the street · {safe.audit.minutes} min</Tooltip>
          </Polyline>
        </>
      )}

      {/* emergency route to the nearest safe haven */}
      {sos && (
        <Polyline
          positions={sos.coords}
          pathOptions={{ color: "#22C55E", weight: 6, opacity: 0.95 }}
        />
      )}

      {walk && (
        <CircleMarker
          center={walk}
          radius={9}
          pathOptions={{ color: "#FFFFFF", fillColor: "#14B8A6", fillOpacity: 1, weight: 3 }}
        />
      )}

      {venues.map((v, i) => (
        <CircleMarker
          key={`${v.name}-${i}`}
          center={[v.lat, v.lon]}
          radius={v.tier === 1 ? 7 : 5}
          pathOptions={{
            color: v.tier === 1 ? "#22C55E" : "#0EA5E9",
            fillColor: v.tier === 1 ? "#22C55E" : "#0EA5E9",
            fillOpacity: 0.75,
            weight: 2,
            opacity: 0.9,
          }}
        >
          <Tooltip>
            <b>{v.name}</b>
            <br />
            {v.tier === 1 ? "Ask for Angela / staffed refuge" : "Late-night refuge"}
            <br />
            {v.hours}
            {v.assumed ? " (hours assumed)" : ""}
          </Tooltip>
        </CircleMarker>
      ))}

      {sos && (
        <CircleMarker
          center={[sos.venue.lat, sos.venue.lon]}
          radius={13}
          pathOptions={{ color: "#22C55E", weight: 3, fillOpacity: 0.25, fillColor: "#22C55E" }}
        >
          <Tooltip permanent direction="top">
            {sos.venue.name}
          </Tooltip>
        </CircleMarker>
      )}

      {incidents.map((inc, i) => (
        <CircleMarker
          key={`inc-${i}`}
          center={[inc.lat, inc.lon]}
          radius={8}
          pathOptions={{
            color: "#F59E0B",
            fillColor: "#F59E0B",
            fillOpacity: 0.5,
            weight: 2,
            dashArray: "3 3",
          }}
        >
          <Tooltip>
            <b>{inc.category}</b>
            <br />
            {inc.street}
            <br />
            {inc.summary}
            {inc.url ? (
              <>
                <br />
                <a href={inc.url} target="_blank" rel="noreferrer">
                  Read the report
                </a>
              </>
            ) : null}
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
