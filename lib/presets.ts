export type Preset = {
  id: string;
  label: string;
  from: { lat: number; lon: number; name: string };
  to: { lat: number; lon: number; name: string };
};

/** Huddersfield, snapped to the walk network at request time. */
export const PRESETS: Preset[] = [
  {
    id: "shift",
    label: "Late shift → Aspley",
    from: { lat: 53.6459, lon: -1.7826, name: "St George's Square" },
    to: { lat: 53.6446, lon: -1.7996, name: "Aspley Halls" },
  },
  {
    id: "commuter",
    label: "Station → University",
    from: { lat: 53.6484, lon: -1.7849, name: "Huddersfield Station" },
    to: { lat: 53.6431, lon: -1.7781, name: "University of Huddersfield" },
  },
  {
    id: "newsome",
    label: "Town → Newsome",
    from: { lat: 53.6462, lon: -1.7809, name: "Market Place" },
    to: { lat: 53.6338, lon: -1.7889, name: "Newsome" },
  },
];

export const DEMO_CENTRE = { lat: 53.6458, lon: -1.785 };
