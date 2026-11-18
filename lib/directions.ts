import { distanceM } from "./geo";

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

function bearing(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export type Step = { text: string; metres: number };

/**
 * Plain walking steps from a polyline. The graph has no street names, so the
 * steps use compass headings and left/right turns instead.
 */
export function walkingSteps(coords: [number, number][], destination: string): Step[] {
  if (coords.length < 2) return [{ text: `You are at ${destination}`, metres: 0 }];

  // merge segments into legs that keep roughly the same heading
  const legs: { heading: number; metres: number }[] = [];
  for (let i = 1; i < coords.length; i++) {
    const m = distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (m < 1) continue;
    const h = bearing(coords[i - 1], coords[i]);
    const prev = legs[legs.length - 1];
    const diff = prev ? ((h - prev.heading + 540) % 360) - 180 : 999;
    if (prev && (Math.abs(diff) < 35 || m < 12)) prev.metres += m;
    else legs.push({ heading: h, metres: m });
  }
  // a short first leg is usually the hop from your exact spot onto the street
  while (legs.length > 1 && legs[0].metres < 25) {
    legs[1].metres += legs[0].metres;
    legs.shift();
  }
  if (legs.length === 0) return [{ text: `You are at ${destination}`, metres: 0 }];

  const steps: Step[] = [];
  legs.forEach((leg, i) => {
    const metres = Math.round(leg.metres / 5) * 5 || Math.round(leg.metres);
    if (i === 0) {
      steps.push({ text: `Head ${COMPASS[Math.round(leg.heading / 45) % 8]} for ${metres} m`, metres });
    } else {
      const diff = ((leg.heading - legs[i - 1].heading + 540) % 360) - 180;
      const turn = Math.abs(diff) > 135 ? "Turn around" : diff > 0 ? "Turn right" : "Turn left";
      steps.push({ text: `${turn}, continue ${metres} m`, metres });
    }
  });
  steps.push({ text: `Arrive at ${destination}`, metres: 0 });
  return steps;
}
