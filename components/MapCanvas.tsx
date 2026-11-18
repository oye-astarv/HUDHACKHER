"use client";

import { useEffect } from "react";
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

const C = {
  casing: "#0A0C0F",
  safe: "#7FBFA8",
  fast: "#D4715B",
  haven: "#9AD6C0",
  warn: "#C9A227",
  trail: "#6E9BC4",
  ink: "#0A0C0F",
  muted: "#8A93A0",
};

type Labelled = { venue: Venue; metres: number; note: string };

type Props = {
  centre: [number, number];
  fastest?: RouteResult | null;
  safe?: RouteResult | null;
  venues?: Venue[];
  incidents?: Incident[];
  sos?: { coords: [number, number][]; venue: Venue } | null;
  walk?: [number, number] | null;
  /** Follower view: everywhere the alert has been. */
  trail?: [number, number][];
  /** Follower view: the safe haven being walked to. */
  destination?: [number, number] | null;
  labelled?: Labelled[];
  onPick?: (lat: number, lon: number) => void;
};

function ClickToPick({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function Fit({ fastest, safe, trail, destination }: {
  fastest?: RouteResult | null;
  safe?: RouteResult | null;
  trail?: [number, number][];
  destination?: [number, number] | null;
}) {
  const map = useMap();

  useEffect(() => {
    const coords = [
      ...(fastest?.coords ?? []),
      ...(safe?.coords ?? []),
      ...(trail ?? []),
      ...(destination ? [destination] : []),
    ];
    if (coords.length < 2) return;
    const lats = coords.map((c) => c[0]);
    const lons = coords.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      // Fit into the strip the bottom sheet leaves visible, and skip animation
      // so a Leaflet zoom transition can't outlive React's double-mount.
      {
        paddingTopLeft: [28, 108],
        paddingBottomRight: [28, Math.round(map.getSize().y * 0.3)],
        maxZoom: 17,
        animate: false,
      }
    );
  }, [fastest, safe, trail, destination, map]);

  return null;
}

export default function MapCanvas({
  centre,
  fastest,
  safe,
  venues = [],
  incidents = [],
  sos,
  walk,
  trail,
  destination,
  labelled = [],
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
      {/* CARTO serves "API KEY REQUIRED" placeholders without a key, so the
          basemap is Esri's keyless dark canvas. maxNativeZoom keeps zooming
          past z16 by upscaling the last real tiles. */}
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        attribution="Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ"
        maxNativeZoom={16}
        maxZoom={19}
        className="map-tiles"
      />

      {onPick && <ClickToPick onPick={onPick} />}
      <Fit fastest={fastest} safe={safe} trail={trail} destination={destination} />

      {/* A dark casing under each line keeps both readable over busy streets. */}
      {fastest && (
        <>
          <Polyline
            positions={fastest.coords}
            pathOptions={{ color: C.casing, weight: 5, opacity: 0.55 }}
          />
          <Polyline
            positions={fastest.coords}
            pathOptions={{
              color: C.fast,
              weight: 2,
              opacity: 0.95,
              dashArray: "1 6",
              lineCap: "round",
            }}
          >
            <Tooltip sticky>Fastest · {fastest.audit.minutes} min</Tooltip>
          </Polyline>
        </>
      )}

      {safe && (
        <>
          <Polyline
            positions={safe.coords}
            pathOptions={{ color: C.casing, weight: 7, opacity: 0.6 }}
          />
          <Polyline
            positions={safe.coords}
            pathOptions={{ color: C.safe, weight: 3, opacity: 1, lineCap: "round" }}
          >
            <Tooltip sticky>Eyes on the street · {safe.audit.minutes} min</Tooltip>
          </Polyline>
        </>
      )}

      {/* emergency route to the nearest safe haven */}
      {sos && (
        <>
          <Polyline
            positions={sos.coords}
            pathOptions={{ color: C.casing, weight: 6, opacity: 0.6 }}
          />
          <Polyline
            positions={sos.coords}
            pathOptions={{
              color: C.haven,
              weight: 2.5,
              opacity: 1,
              dashArray: "6 5",
              lineCap: "round",
            }}
          />
        </>
      )}

      {/* follower view: where the alert has already been */}
      {trail && trail.length > 1 && (
        <Polyline
          positions={trail}
          pathOptions={{ color: C.trail, weight: 2.5, opacity: 0.85, lineCap: "round" }}
        />
      )}

      {walk && (
        <>
          <CircleMarker
            center={walk}
            radius={12}
            pathOptions={{ color: C.safe, fillColor: C.safe, fillOpacity: 0.14, weight: 0 }}
          />
          <CircleMarker
            center={walk}
            radius={5}
            pathOptions={{ color: C.ink, fillColor: "#E6E9EE", fillOpacity: 1, weight: 2 }}
          />
        </>
      )}

      {/* Hollow rings instead of filled dots: 100+ venues stay readable */}
      {venues.map((v, i) => (
        <CircleMarker
          key={`${v.name}-${i}`}
          center={[v.lat, v.lon]}
          radius={v.tier === 1 ? 5 : 3.5}
          pathOptions={{
            color: v.tier === 1 ? C.haven : C.muted,
            fillColor: C.ink,
            fillOpacity: 0.7,
            weight: 1.4,
            opacity: v.tier === 1 ? 0.95 : 0.7,
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

      {destination && (
        <CircleMarker
          center={destination}
          radius={9}
          pathOptions={{ color: C.haven, weight: 1.5, fillOpacity: 0.15, fillColor: C.haven }}
        />
      )}

      {labelled.map((l, i) => (
        <CircleMarker
          key={`labelled-${l.venue.name}-${i}`}
          center={[l.venue.lat, l.venue.lon]}
          radius={7}
          pathOptions={{ color: C.haven, weight: 1.5, fillOpacity: 0.2, fillColor: C.haven }}
        >
          <Tooltip permanent direction="top">
            {l.venue.name}
          </Tooltip>
        </CircleMarker>
      ))}

      {sos && (
        <CircleMarker
          center={[sos.venue.lat, sos.venue.lon]}
          radius={11}
          pathOptions={{ color: C.haven, weight: 1.5, fillOpacity: 0.12, fillColor: C.haven }}
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
          radius={4.5}
          pathOptions={{
            color: C.warn,
            fillColor: C.warn,
            fillOpacity: 0.7,
            weight: 1.5,
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
