import { distanceM } from "./geo";
import type { Venue } from "./types";

export const isOpen = (v: Venue, hour: number) => ((v.openMask >> hour) & 1) === 1;

/** "Open 24h", "Open until 00:00", or "" when closed. Hours come from the 24-bit mask. */
export function openUntil(v: Venue, hour: number): string {
  if (!isOpen(v, hour)) return "";
  if ((v.openMask & 0xffffff) === 0xffffff) return "Open 24h";
  let h = hour;
  for (let i = 0; i < 24; i++) {
    h = (h + 1) % 24;
    if (!isOpen(v, h)) return `Open until ${String(h).padStart(2, "0")}:00`;
  }
  return "Open 24h";
}

const KIND_LABEL: Record<string, string> = {
  police: "Police station",
  hospital: "Hospital A&E",
  station: "Staffed rail station",
  bus_station: "Staffed bus station",
  hotel: "Hotel reception",
  hostel: "Hostel reception",
  guest_house: "Guest house",
  pub: "Pub · Ask for Angela",
  bar: "Bar · Ask for Angela",
  nightclub: "Nightclub · Ask for Angela",
  casino: "Casino · staffed",
  cinema: "Cinema · staffed",
  theatre: "Theatre · staffed",
  fuel: "Petrol station",
  supermarket: "Supermarket",
  convenience: "Convenience store",
  alcohol: "Off-licence",
  newsagent: "Newsagent",
  kiosk: "Kiosk",
  pharmacy: "Pharmacy",
  chemist: "Chemist",
  fast_food: "Takeaway",
  restaurant: "Restaurant",
  cafe: "Café",
};

export const kindLabel = (v: Venue) => KIND_LABEL[v.kind] ?? v.kind.replace(/_/g, " ");

export const tierLabel = (v: Venue) =>
  KIND_LABEL[v.kind] ?? (v.tier === 1 ? "Staffed venue · Ask for Angela" : "Late-night staffed refuge");

/** Open venues sorted by walking-line distance from a point. */
export function openVenuesNear(
  venues: Venue[],
  from: { lat: number; lon: number },
  hour: number
): { venue: Venue; metres: number }[] {
  return venues
    .filter((v) => isOpen(v, hour))
    .map((venue) => ({ venue, metres: distanceM(from.lat, from.lon, venue.lat, venue.lon) }))
    .sort((a, b) => a.metres - b.metres);
}

/** Open venues within `radius` metres of any point on a route, nearest-to-route first. */
export function venuesAlong(
  venues: Venue[],
  coords: [number, number][],
  origin: { lat: number; lon: number },
  hour: number,
  radius = 60
): { venue: Venue; metres: number }[] {
  const out: { venue: Venue; metres: number }[] = [];
  for (const v of venues) {
    if (!isOpen(v, hour)) continue;
    let near = false;
    for (let i = 0; i < coords.length; i += 2) {
      if (distanceM(coords[i][0], coords[i][1], v.lat, v.lon) <= radius) {
        near = true;
        break;
      }
    }
    if (near) out.push({ venue: v, metres: distanceM(origin.lat, origin.lon, v.lat, v.lon) });
  }
  return out.sort((a, b) => a.venue.tier - b.venue.tier || a.metres - b.metres);
}
