export type LatLon = { lat: number; lon: number };

/** Evidence quality for a street's lighting. Ordered by strength. */
export const LIGHT = {
  TAGGED_YES: 0,
  LAMP_NEAR: 1,
  CLASS_PRIOR: 2,
  UNKNOWN: 3,
  TAGGED_NO: 4,
} as const;

export type LightCode = (typeof LIGHT)[keyof typeof LIGHT];

export const LIGHT_LABEL: Record<number, string> = {
  0: "lit (mapped)",
  1: "lit (lamp within 25m)",
  2: "likely lit (major road)",
  3: "no lighting data",
  4: "mapped unlit",
};

/** One undirected edge. Stored once; the router walks it both ways. */
export type RawEdge = [
  u: number,
  v: number,
  length_m: number,
  light: number,
  /** 24-bit mask: bit `h` set when a venue within 50m is open at hour h. */
  openMask: number,
  /** bit0 = inside a park polygon, bit1 = path/footway/track type */
  flags: number,
];

export type GraphArtifact = {
  version: number;
  city: string;
  builtAt: string;
  centre: [number, number];
  source: string;
  counts: { nodes: number; edges: number; venues: number };
  /** [lat, lon] pairs, index = node id */
  nodes: [number, number][];
  edges: RawEdge[];
};

export type Venue = {
  name: string;
  lat: number;
  lon: number;
  /** 1 = Ask for Angela / staffed refuge, 2 = 24h & late-night staffed */
  tier: 1 | 2;
  kind: string;
  hours: string;
  /** true when the hours were inferred, not read from a mapped opening_hours tag */
  assumed?: boolean;
  /** 24-bit mask: bit `h` set when open at hour h */
  openMask: number;
};

export type Incident = {
  category: string;
  street: string;
  summary: string;
  lat: number;
  lon: number;
  publishedAt: string;
  url: string;
  source?: string;
  confidence?: string;
};

export type RouteAudit = {
  metres: number;
  minutes: number;
  /** share of distance that is lit at the query hour (tagged or lamp) */
  litShare: number;
  /** share that is lit only by road-class inference */
  inferredShare: number;
  /** share with no lighting evidence at all */
  unknownShare: number;
  parkMetres: number;
  openVenues: number;
  incidentsOnPath: number;
  tier1Venues: number;
};

export type RouteResult = {
  kind: "fastest" | "safe";
  coords: [number, number][];
  audit: RouteAudit;
};

export type RouteResponse = {
  hour: number;
  isDark: boolean;
  sunset: string;
  sunrise: string;
  origin: LatLon;
  destination: LatLon;
  fastest: RouteResult;
  safe: RouteResult;
  sameRoute: boolean;
};
