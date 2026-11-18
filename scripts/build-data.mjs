#!/usr/bin/env node
/**
 * SafeStride data builder.
 *
 * Pulls the walkable street network, park polygons, street lamps and
 * late-night venues around Huddersfield town centre from Overpass, then bakes
 * a routing artifact with lighting evidence already resolved.
 *
 * Everything expensive happens here, once. The browser only ever receives the
 * finished JSON: it never talks to Overpass and never sees a graph too big to
 * parse on a phone.
 *
 *   node scripts/build-data.mjs [--radius 3000] [--no-assume-hours]
 */

import fs from "node:fs/promises";
import path from "node:path";

const CENTRE = { lat: 53.6458, lon: -1.785 };
const RADIUS = Number(argOf("--radius") ?? 1600);
const ASSUME_HOURS = !process.argv.includes("--no-assume-hours");

const OUT_DIR = path.join(process.cwd(), "public", "data");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const UA = "SafeStride/0.1 (night-time pedestrian safety demo)";

const WALK_HIGHWAYS = new Set([
  "footway",
  "path",
  "pedestrian",
  "steps",
  "residential",
  "living_street",
  "unclassified",
  "service",
  "primary",
  "secondary",
  "tertiary",
  "trunk",
  "cycleway",
  "track",
  "bridleway",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

const PATH_HIGHWAYS = new Set([
  "footway",
  "path",
  "pedestrian",
  "steps",
  "track",
  "bridleway",
  "cycleway",
]);

const MAJOR_HIGHWAYS = new Set([
  "primary",
  "secondary",
  "tertiary",
  "trunk",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

const LIGHT = { TAGGED_YES: 0, LAMP_NEAR: 1, CLASS_PRIOR: 2, UNKNOWN: 3, TAGGED_NO: 4 };
const FLAG_PARK = 1;
const FLAG_PATH = 2;

// ---------------------------------------------------------------- helpers

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function bbox() {
  const dLat = RADIUS / 111320;
  const dLon = RADIUS / (111320 * Math.cos((CENTRE.lat * Math.PI) / 180));
  return {
    s: CENTRE.lat - dLat,
    w: CENTRE.lon - dLon,
    n: CENTRE.lat + dLat,
    e: CENTRE.lon + dLon,
  };
}

function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function overpass(query, label, timeoutMs = 120000) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    const started = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timeout|out of memory/i.test(json.remark)) {
        throw new Error(json.remark);
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  ✓ ${label}: ${json.elements?.length ?? 0} elements in ${secs}s (${new URL(endpoint).host})`
      );
      return json.elements ?? [];
    } catch (err) {
      lastErr = err;
      console.warn(`  ! ${label} via ${new URL(endpoint).host}: ${err.message}`);
      await sleep(2500 + attempt * 3000 + Math.random() * 1500);
    }
  }
  throw new Error(`${label} failed after retries: ${lastErr?.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CACHE_DIR = path.join(process.cwd(), ".cache");

/** Overpass layers are cached to disk so a retry never refetches 41k ways. */
async function cached(key, run) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(parsed.elements) && parsed.elements.length > 0) {
      console.log(`  · ${key}: ${parsed.elements.length} elements from cache`);
      return parsed.elements;
    }
  } catch {
    // no cache yet
  }
  const elements = await run();
  await fs.writeFile(file, JSON.stringify({ elements }));
  return elements;
}

// ------------------------------------------------------- opening hours

const DAY_INDEX = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };
const ALL_HOURS = 0xffffff;

/**
 * Parses the common subset of OSM opening_hours into 24-bit hour masks per day.
 * Returns null when the string uses syntax we don't understand, so callers can
 * choose to treat the venue as *unverified* rather than guess.
 */
function parseOpeningHours(spec) {
  if (!spec) return null;
  const text = spec.trim();
  if (/^24\/7$/i.test(text)) return new Array(7).fill(ALL_HOURS);

  const masks = new Array(7).fill(0);
  let matched = false;

  for (const rawRule of text.split(";")) {
    const rule = rawRule.trim();
    if (!rule) continue;
    if (/off\b/i.test(rule) && !/\d{1,2}:\d{2}/.test(rule)) continue;

    const m = rule.match(
      /^([A-Za-z,\s\-–]*?)\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/
    );
    if (!m) continue;

    const days = expandDays(m[1]);
    if (!days) continue;

    const startMin = Number(m[2]) * 60 + Number(m[3]);
    const endMin = Number(m[4]) * 60 + Number(m[5]);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) continue;

    for (const d of days) {
      if (endMin > startMin) {
        for (let h = 0; h < 24; h++) {
          const hourStart = h * 60;
          if (hourStart >= startMin && hourStart < endMin) masks[d] |= 1 << h;
        }
      } else {
        // wraps midnight: 18:00-02:00
        for (let h = 0; h < 24; h++) {
          const hourStart = h * 60;
          if (hourStart >= startMin || hourStart < endMin) masks[d] |= 1 << h;
        }
      }
    }
    matched = true;
  }

  return matched ? masks : null;
}

function expandDays(spec) {
  const clean = (spec || "").replace(/\b(PH|SH)\b/gi, "").trim();
  if (!clean) return [0, 1, 2, 3, 4, 5, 6];

  const out = new Set();
  for (const part of clean.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const range = chunk.split(/[-–]/).map((s) => s.trim());
    if (range.length === 2) {
      const a = DAY_INDEX[cap(range[0])];
      const b = DAY_INDEX[cap(range[1])];
      if (a === undefined || b === undefined) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === b) break;
      }
    } else {
      const only = DAY_INDEX[cap(chunk)];
      if (only === undefined) return null;
      out.add(only);
    }
  }
  return out.size ? [...out] : null;
}

const cap = (s) => s.slice(0, 1).toUpperCase() + s.slice(1, 2).toLowerCase();

// ---------------------------------------------------- geometry helpers

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function makeGrid(cellDeg) {
  const cells = new Map();
  const key = (lat, lon) =>
    `${Math.round(lat / cellDeg)}:${Math.round(lon / cellDeg)}`;
  return {
    add(lat, lon, value) {
      const k = key(lat, lon);
      const bucket = cells.get(k);
      if (bucket) bucket.push({ lat, lon, value });
      else cells.set(k, [{ lat, lon, value }]);
    },
    near(lat, lon, radiusM) {
      const out = [];
      const cLat = Math.round(lat / cellDeg);
      const cLon = Math.round(lon / cellDeg);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const bucket = cells.get(`${cLat + i}:${cLon + j}`);
          if (!bucket) continue;
          for (const item of bucket) {
            if (distanceM(lat, lon, item.lat, item.lon) <= radiusM) out.push(item);
          }
        }
      }
      return out;
    },
  };
}

// ------------------------------------------------------------ main

async function main() {
  const box = bbox();
  console.log(
    `SafeStride data build · radius ${RADIUS}m · bbox ${box.s.toFixed(4)},${box.w.toFixed(4)},${box.n.toFixed(4)},${box.e.toFixed(4)}`
  );
  const span = `${box.s},${box.w},${box.n},${box.e}`;

  // 1. streets
  console.log("\n[1/4] walkable streets");
  const streetQuery = `[out:json][timeout:180];
(
  way["highway"~"^(footway|path|pedestrian|steps|residential|living_street|unclassified|service|primary|secondary|tertiary|trunk|cycleway|track|bridleway|primary_link|secondary_link|tertiary_link)$"](${span});
);
out body;
>;
out skel qt;`;
  const streetEls = await cached("streets", () => overpass(streetQuery, "streets", 150000));

  // 2. parks
  console.log("\n[2/4] parks & open space");
  const parkQuery = `[out:json][timeout:120];
(
  way["leisure"~"^(park|common|garden|recreation_ground)$"](${span});
);
out geom;`;
  const parkEls = await cached("parks", () => overpass(parkQuery, "parks", 90000)).catch((e) => {
    console.warn(`  ! parks unavailable (${e.message}) — park penalty disabled`);
    return [];
  });

  // 3. street lamps
  console.log("\n[3/4] street lamps");
  const lampQuery = `[out:json][timeout:180];
node["highway"="street_lamp"](${span});
out body;`;
  const lampEls = await cached("lamps", () => overpass(lampQuery, "lamps", 120000)).catch((e) => {
    console.warn(`  ! lamps unavailable (${e.message}) — falling back to road class`);
    return [];
  });

  // 4. venues
  console.log("\n[4/4] late-night venues");
  // Split into two lighter queries: one heavy nwr regex over 3km tends to 502.
  const amenityQuery = `[out:json][timeout:180];
nwr["amenity"~"^(pub|bar|pharmacy|fuel|restaurant|fast_food|cafe|hotel|nightclub)$"](${span});
out center tags;`;
  const shopQuery = `[out:json][timeout:180];
(
  nwr["shop"~"^(convenience|supermarket|bakery|greengrocer)$"](${span});
  nwr["railway"="station"](${span});
);
out center tags;`;
  const amenityEls = await cached("venues-amenity", () =>
    overpass(amenityQuery, "venues/amenity", 120000)
  ).catch((e) => {
    console.warn(`  ! amenities unavailable (${e.message})`);
    return [];
  });
  const shopEls = await cached("venues-shop", () =>
    overpass(shopQuery, "venues/shop", 120000)
  ).catch((e) => {
    console.warn(`  ! shops unavailable (${e.message})`);
    return [];
  });
  const venueEls = [...amenityEls, ...shopEls];

  // ---------------------------------------------------------- build graph
  const coords = new Map();
  const ways = [];
  for (const el of streetEls) {
    if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
    else if (el.type === "way" && el.nodes) ways.push(el);
  }

  const parkRings = [];
  for (const el of parkEls) {
    if (el.type !== "way" || !el.geometry) continue;
    const ring = el.geometry.map((p) => [p.lat, p.lon]);
    if (ring.length < 4) continue;
    const lats = ring.map((p) => p[0]);
    const lons = ring.map((p) => p[1]);
    parkRings.push({
      ring,
      bounds: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)],
    });
  }

  const lampGrid = makeGrid(0.0005); // ~55m cells
  for (const el of lampEls) {
    if (el.type === "node" && el.lat != null) lampGrid.add(el.lat, el.lon, el.id);
  }

  // venues first: edge cost depends on them
  const venues = [];
  for (const el of venueEls) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const name = tags.name;
    if (!name) continue;

    const kind =
      tags.amenity || tags.shop || (tags.railway === "station" ? "station" : "venue");

    let tier = 2;
    if (
      ["pub", "bar", "hotel", "nightclub"].includes(tags.amenity) ||
      tags.railway === "station"
    ) {
      tier = 1;
    }

    const rawHours = tags.opening_hours ?? "";
    let masks = parseOpeningHours(rawHours);
    let assumed = false;

    if (!masks && ASSUME_HOURS) {
      // Labelled as an assumption in the UI, never silently treated as fact.
      if (tags.amenity === "fuel" || ["supermarket", "convenience"].includes(tags.shop)) {
        masks = parseOpeningHours("Mo-Su 07:00-23:00");
        assumed = true;
      }
    }
    if (!masks) continue;

    const openMask = masks.reduce((acc, m) => acc | m, 0);
    if (openMask === 0) continue;

    venues.push({
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      tier,
      kind,
      hours: rawHours || (assumed ? "07:00-23:00 (assumed)" : "24/7"),
      assumed,
      openMask,
    });
  }

  const venueGrid = makeGrid(0.0005);
  venues.forEach((v, i) => venueGrid.add(v.lat, v.lon, i));

  // edges
  const nodes = [];
  const nodeIndex = new Map();
  const nodeId = (osmId) => {
    let idx = nodeIndex.get(osmId);
    if (idx === undefined) {
      idx = nodes.length;
      nodeIndex.set(osmId, idx);
      nodes.push(coords.get(osmId));
    }
    return idx;
  };

  const edges = [];
  const seen = new Set();
  const stats = { taggedYes: 0, taggedNo: 0, lampNear: 0, classPrior: 0, unknown: 0, park: 0, skipped: 0 };

  for (const way of ways) {
    const tags = way.tags ?? {};
    const highway = tags.highway;
    if (!WALK_HIGHWAYS.has(highway)) continue;
    if (tags.access === "private" || tags.access === "no") {
      stats.skipped++;
      continue;
    }

    const nodeIds = way.nodes ?? [];
    for (let i = 1; i < nodeIds.length; i++) {
      const a = nodeIds[i - 1];
      const b = nodeIds[i];
      const pa = coords.get(a);
      const pb = coords.get(b);
      if (!pa || !pb) continue;

      const length = distanceM(pa[0], pa[1], pb[0], pb[1]);
      if (length < 0.5 || length > 800) {
        stats.skipped++;
        continue;
      }

      const u = nodeId(a);
      const v = nodeId(b);
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const midLat = (pa[0] + pb[0]) / 2;
      const midLon = (pa[1] + pb[1]) / 2;

      // lighting ladder: explicit tag > mapped lamp > road class > unknown
      let light;
      if (tags.lit === "yes") {
        light = LIGHT.TAGGED_YES;
        stats.taggedYes++;
      } else if (tags.lit === "no") {
        light = LIGHT.TAGGED_NO;
        stats.taggedNo++;
      } else if (lampGrid.near(midLat, midLon, 25).length > 0) {
        light = LIGHT.LAMP_NEAR;
        stats.lampNear++;
      } else if (MAJOR_HIGHWAYS.has(highway)) {
        light = LIGHT.CLASS_PRIOR;
        stats.classPrior++;
      } else {
        light = LIGHT.UNKNOWN;
        stats.unknown++;
      }

      const inPark = parkRings.some(
        (p) =>
          midLat >= p.bounds[0] &&
          midLat <= p.bounds[2] &&
          midLon >= p.bounds[1] &&
          midLon <= p.bounds[3] &&
          pointInRing(midLat, midLon, p.ring)
      );
      if (inPark) stats.park++;

      let flags = 0;
      if (inPark) flags |= FLAG_PARK;
      if (PATH_HIGHWAYS.has(highway)) flags |= FLAG_PATH;

      // "eyes on the street": which hours does this edge have an open venue near it?
      let openMask = 0;
      for (const hit of venueGrid.near(midLat, midLon, 50)) {
        openMask |= venues[hit.value].openMask;
      }

      edges.push([
        u,
        v,
        Number(length.toFixed(1)),
        light,
        openMask,
        flags,
      ]);
    }
  }

  // compact: drop unreferenced nodes and reindex
  const used = new Set();
  for (const [u, v] of edges) {
    used.add(u);
    used.add(v);
  }
  const remap = new Map();
  const compactNodes = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, compactNodes.length);
    compactNodes.push([Number(nodes[i][0].toFixed(6)), Number(nodes[i][1].toFixed(6))]);
  }
  const compactEdges = edges.map(([u, v, len, light, mask, flags]) => [
    remap.get(u),
    remap.get(v),
    len,
    light,
    mask,
    flags,
  ]);

  const graph = {
    version: 1,
    city: "Huddersfield",
    builtAt: new Date().toISOString(),
    centre: [CENTRE.lat, CENTRE.lon],
    source: "OpenStreetMap via Overpass",
    note: "openMask bit h = a venue within 50m is open at hour h on at least one weekday",
    counts: {
      nodes: compactNodes.length,
      edges: compactEdges.length,
      venues: venues.length,
    },
    lighting: {
      taggedYes: stats.taggedYes,
      taggedNo: stats.taggedNo,
      lampNear: stats.lampNear,
      classPrior: stats.classPrior,
      unknown: stats.unknown,
      parkEdges: stats.park,
    },
    nodes: compactNodes,
    edges: compactEdges,
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "graph.json"), JSON.stringify(graph));
  await fs.writeFile(path.join(OUT_DIR, "venues.json"), JSON.stringify(venues));

  const total = compactEdges.length;
  const pct = (n) => `${((n / Math.max(1, total)) * 100).toFixed(1)}%`;
  console.log("\nBuilt:");
  console.log(`  nodes ${compactNodes.length}  edges ${compactEdges.length}`);
  console.log(
    `  lighting: tagged lit ${pct(stats.taggedYes)}, unlit ${pct(stats.taggedNo)}, lamp-near ${pct(
      stats.lampNear
    )}, road-class ${pct(stats.classPrior)}, unknown ${pct(stats.unknown)}`
  );
  console.log(`  park edges ${stats.park}  ·  venues ${venues.length}`);
  const sizeKb = (n) => (n / 1024).toFixed(0) + " KB";
  console.log(
    `  wrote ${path.relative(process.cwd(), OUT_DIR)}/graph.json (${sizeKb(
      (await fs.stat(path.join(OUT_DIR, "graph.json"))).size
    )})`
  );
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exitCode = 1;
});
