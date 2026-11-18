#!/usr/bin/env node
/**
 * SafeStride incident pipeline.
 *
 *   RSS (BBC, ExaminerLive, Google News) → Groq LLM extraction (or keyword
 *   fallback) → Photon/Nominatim geocoding → public/data/incidents.json
 *
 * Runs offline before a demo so the app never scrapes at request time.
 * With GROQ_API_KEY set, the LLM reads each safety-looking article and returns
 * the street, a short factual summary and when it happened. Without a key a
 * conservative keyword matcher is used and items are labelled "keyword match".
 *
 *   npm run data:news        (reads GROQ_API_KEY from .dev.vars if present)
 *   npm run data:news -- --days 14
 *   npm run data:news -- --region leeds      (regions: config/regions.json)
 */

import fs from "node:fs/promises";
import path from "node:path";

const REGIONS = JSON.parse(await fs.readFile(path.join(process.cwd(), "config", "regions.json"), "utf8"));
const regionArg = process.argv.includes("--region")
  ? process.argv[process.argv.indexOf("--region") + 1]
  : REGIONS[0].id;
const REGION = REGIONS.find((r) => r.id === regionArg);
if (!REGION) {
  console.error(`Unknown --region "${regionArg}". Known: ${REGIONS.map((r) => r.id).join(", ")}`);
  process.exit(1);
}
const TOWN = REGION.name;
const OUT_DIR = path.join(process.cwd(), "public", "data", REGION.id);
const UA = "SafeStride/0.2 (night-time pedestrian safety demo)";
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const DAYS = Number(process.argv[process.argv.indexOf("--days") + 1]) || 7;
const MAX_INCIDENTS = 25;

const GN = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;

const FEEDS = [
  // regional feed: keep only stories about this town
  { name: "BBC News · regional", url: REGION.bbcFeed, localOnly: true },
  { name: "BBC News (via Google News)", url: GN(`${TOWN} site:bbc.co.uk when:${DAYS}d`) },
  ...(REGION.localFeeds ?? []),
  {
    name: `Google News · ${TOWN} safety`,
    url: GN(`${TOWN} (police OR assault OR cordon OR attack OR stabbing OR robbery OR harassment OR closure) when:${DAYS}d`),
  },
  { name: `Google News · ${REGION.police}`, url: GN(`"${REGION.police}" ${TOWN} when:${DAYS}d`) },
].filter((f) => f.url);

// Same box the street graph covers (lib/regions.ts bboxOf) — anything outside is dropped.
const BBOX = (() => {
  const dLat = REGION.radiusM / 111320;
  const dLon = REGION.radiusM / (111320 * Math.cos((REGION.centre[0] * Math.PI) / 180));
  return { s: REGION.centre[0] - dLat, w: REGION.centre[1] - dLon, n: REGION.centre[0] + dLat, e: REGION.centre[1] + dLon };
})();

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsRe = (list) => new RegExp(`\\b(${list.map(esc).join("|")})\\b`, "i");

const LOCAL = wordsRe(REGION.areas);

const SAFETY_WORDS =
  /(police|assault|attack|cordon|closure|closed|harass|robbery|robbed|mugg|stab|knife|fight|disorder|arrest|antisocial|anti-social|crash|collision|fire|flood|roadworks|missing|sexual|spiking|spiked|indecent|exposure|weapon|firearm|shot|injur)/i;

// Court outcomes, sentencing and admin stories aren't a live street risk.
const NOT_SAFETY =
  /(football|rugby|giants|town fc|terriers|business|property|recipe|review|weather forecast|horoscope|lottery|\bjobs?\b|prison|jailed|sentenced|sentencing|avoids? (jail|prison)|court|trial|driving ban|fly-?tip|warrant|banned from driving|inquest|council tax|planning|want a (little )?word|wanted by|faces .* want|facing arrest|shut down by police|licen[cs]e)/i;

// Stories led by another town are outside the walk graph.
const OUTSIDE = wordsRe(REGION.outside);
const TOWN_RE = new RegExp(`\\b${esc(TOWN)}\\b`, "i");

// Google News aggregates everyone; keep recognised UK outlets only.
const TRUSTED_PUBLISHERS = new RegExp(
  `^(${[
    "BBC", "ITV", "ITVX", "Sky News", "The Guardian", "The Independent", "Metro", "Evening Standard",
    "Yorkshire Live", "YorkshireLive", "Yorkshire Post", "The Yorkshire Post", "Telegraph & Argus",
    "Halifax Courier", "Dewsbury Reporter", "Leeds Live", "LeedsLive", "Yorkshire Evening Post",
    REGION.police,
    ...(REGION.publishers ?? []),
  ]
    .map(esc)
    .join("|")})`,
  "i"
);

const STOP = new Set(
  `after with from that this have been were they their into over about ${TOWN} ${REGION.police} police news says said will more than when where what which while being women woman man men`
    .toLowerCase()
    .split(/\s+/)
);
const tokens = (s) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.slice(0, 6)) // crude stem: assault/assaults/assaulted
  );
function similar(a, b) {
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / Math.max(1, Math.min(a.size, b.size)) >= 0.5;
}

const CATEGORY_RULES = [
  [/cordon|scene guard|crime scene/i, "Police Cordon"],
  [/sexual|indecent|exposure|spik/i, "Sexual Offence"],
  [/assault|stab|knife|attack|robbery|robbed|mugg|harass|weapon|firearm|shot/i, "Assault"],
  [/anti-?social|youths|gang|disorder|fight/i, "Anti-Social Behaviour"],
  [/clos|roadworks|flood|fire|crash|collision/i, "Hazard"],
];

// Named places the heuristic can recognise even without "Street"/"Road".
const LANDMARKS = REGION.landmarks ?? [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
  });
  if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  for (const block of xml.split(/<item[\s>]/).slice(1)) {
    let title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
    let description = decodeXml(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    let publisher = decodeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "");
    if (!title) continue;

    // Google News appends " - Publisher" and repeats the headline as the description.
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -publisher.length - 3).trim();
    if (description.startsWith(title)) description = description.slice(title.length).replace(/^[\s-]+/, "");
    if (publisher && description.endsWith(publisher)) description = description.slice(0, -publisher.length).trim();
    if (!publisher) publisher = feed.name.split(" · ")[0];

    items.push({ title, link, description, pubDate, feed: feed.name, publisher, localOnly: feed.localOnly });
  }
  return items;
}

/** Conservative fallback extractor: headline/summary keywords only, no invention. */
function heuristic(item) {
  // every outlet's headline for this event: one may name the street when another doesn't
  const text = (item.allText ?? `${item.title}. ${item.description}`).replace(
    new RegExp(`\\b(${esc(TOWN)} (university|uni)|university (campus )?in ${esc(TOWN)})\\b`, "gi"),
    `University of ${TOWN}`
  );
  if (!SAFETY_WORDS.test(text) || NOT_SAFETY.test(item.title)) return null;

  const category = CATEGORY_RULES.find(([re]) => re.test(text))?.[1] ?? "Hazard";

  let place = null;
  let precision = "none";
  const street = text.match(
    /\b((?:[A-Z][a-z']+\s){0,3}[A-Z][a-z']+)\s+(Street|Road|Lane|Avenue|Place|Square|Hill|Way|Croft|Grove|Drive|Terrace|Crescent|Gate|Bank|Park)\b/
  );
  const landmark = LANDMARKS.find((l) => text.toLowerCase().includes(l.toLowerCase()));
  if (street && !/^(West|South|North|East) Yorkshire$/.test(`${street[1]} ${street[2]}`)) {
    place = `${street[1]} ${street[2]}`;
    precision = "street";
  } else if (landmark) {
    place = landmark;
    precision = "landmark";
  } else {
    const area = text.match(LOCAL);
    // the town / borough name alone is too vague to pin
    if (area && area[1].toLowerCase() !== TOWN.toLowerCase() && area[1].toLowerCase() !== REGION.areas[1]) {
      place = area[1];
      precision = "area";
    }
  }

  return {
    is_pedestrian_safety_relevant: true,
    category,
    street_or_landmark: place,
    location_precision: precision,
    summary: item.description ? item.description.slice(0, 280) : item.title,
    occurred_at: null,
    occurred_text: null,
    confidence: "heuristic",
  };
}

async function llmExtract(item) {
  const prompt = `You extract pedestrian-safety incidents from UK local news for a night-time walking app in ${TOWN}, ${REGION.county}.
Use ONLY facts stated in the text. Never invent streets, times or details.
Return ONLY a JSON object:
{
 "is_pedestrian_safety_relevant": boolean,   // false for sport, business, court sentencing of old cases, politics, national news, or events outside ${TOWN}
 "category": "Police Cordon" | "Assault" | "Sexual Offence" | "Anti-Social Behaviour" | "Hazard",
 "street_or_landmark": string | null,        // most specific place in or near ${TOWN}, e.g. a street name
 "location_precision": "street" | "landmark" | "area" | "none",
 "summary": string,                          // 1-2 plain sentences: what happened and what police said, max 240 chars
 "occurred_at": string | null,               // ISO 8601 date/time the incident happened, resolved against the published date; null if not stated
 "occurred_text": string | null              // the time as written, e.g. "Saturday night", "around 11pm on Friday"
}

Published: ${item.pubDate || "unknown"}
Headline: ${item.title}
Summary: ${item.description || "(none)"}
Other outlets' reports of the same event: ${(item.allText ?? "").slice(0, 1200) || "(none)"}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned no text");
  await sleep(2100); // stay under the free-tier requests-per-minute limit
  return { ...JSON.parse(text), confidence: "llm" };
}

function inArea(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;
}

/** Photon first (no UA policy friction), Nominatim as a fallback. */
async function geocode(query) {
  try {
    const url = `https://photon.komoot.io/api/?limit=1&lang=en&lat=${REGION.centre[0]}&lon=${REGION.centre[1]}&q=` + encodeURIComponent(query);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const json = await res.json();
      const [lon, lat] = json.features?.[0]?.geometry?.coordinates ?? [];
      if (inArea(lat, lon)) return { lat, lon };
      return null;
    }
  } catch {
    // fall through to Nominatim
  }
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://safestride.local/" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  const lat = Number(results[0].lat);
  const lon = Number(results[0].lon);
  return inArea(lat, lon) ? { lat, lon } : null;
}

const SOURCE_RANK = (feed) => (/^BBC/.test(feed) ? 0 : /Examiner/.test(feed) ? 1 : 2);

async function main() {
  console.log(`SafeStride news pipeline · ${TOWN} · last ${DAYS} days · extraction=${GROQ_KEY ? `Groq ${MODEL}` : "keyword heuristic (no GROQ_API_KEY)"}`);

  const items = [];
  for (const feed of FEEDS) {
    try {
      const got = await fetchFeed(feed);
      console.log(`  ${feed.name}: ${got.length} items`);
      items.push(...got);
    } catch (err) {
      console.warn(`  ! ${err.message}`);
    }
  }

  const cutoff = Date.now() - DAYS * 86400_000;
  const sorted = items
    .filter((i) => {
      const t = Date.parse(i.pubDate);
      return Number.isFinite(t) && t >= cutoff;
    })
    .filter((i) => LOCAL.test(`${i.title} ${i.description}`))
    .filter((i) => !(OUTSIDE.test(`${i.title} ${i.description}`) && !TOWN_RE.test(i.title)))
    .filter((i) => TRUSTED_PUBLISHERS.test(i.publisher))
    // cheap pre-filter so the LLM only sees safety-looking stories
    .filter((i) => SAFETY_WORDS.test(`${i.title} ${i.description}`) && !NOT_SAFETY.test(i.title))
    .sort((a, b) => SOURCE_RANK(a.feed) - SOURCE_RANK(b.feed) || Date.parse(a.pubDate) - Date.parse(b.pubDate));

  // Many outlets cover one event: cluster them and keep the best-ranked report.
  const fresh = [];
  for (const item of sorted) {
    const t = tokens(item.title);
    const lead = fresh.find((f) => similar(f._tokens, t));
    if (lead) {
      if (!lead.alsoReported.includes(item.publisher) && item.publisher !== lead.publisher) lead.alsoReported.push(item.publisher);
      if (!lead.description && item.description) lead.description = item.description;
      lead.allText += ` ${item.title}. ${item.description}`;
      // earliest report = closest to when it happened
      if (Date.parse(item.pubDate) < Date.parse(lead.firstReported)) lead.firstReported = item.pubDate;
      continue;
    }
    fresh.push({
      ...item,
      _tokens: t,
      alsoReported: [],
      firstReported: item.pubDate,
      allText: `${item.title}. ${item.description}`,
    });
  }
  fresh.sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));

  console.log(`  ${sorted.length} safety stories from trusted outlets → ${fresh.length} distinct events`);

  const incidents = [];
  for (const item of fresh) {
    if (incidents.length >= MAX_INCIDENTS) break;

    let extracted = null;
    if (GROQ_KEY) {
      try {
        extracted = await llmExtract(item);
      } catch (err) {
        console.warn(`  ! groq: ${err.message}`);
        extracted = heuristic(item);
      }
    } else {
      extracted = heuristic(item);
    }
    if (!extracted?.is_pedestrian_safety_relevant) continue;

    const place = extracted.street_or_landmark || null;
    const precision = place ? extracted.location_precision || "street" : "none";

    let point = null;
    if (place) {
      const query = TOWN_RE.test(place) ? place : `${place}, ${TOWN}, UK`;
      try {
        point = await geocode(query);
      } catch (err) {
        console.warn(`  ! geocode: ${err.message}`);
      }
      await sleep(1100); // Nominatim usage policy: max 1 request/second
    }

    // Only street/landmark-level fixes go on the map and affect routing.
    const mapped = Boolean(point) && (precision === "street" || precision === "landmark");

    if (mapped) {
      const cell = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
      const dup = incidents.find((i) => i.lat != null && `${i.lat.toFixed(4)},${i.lon.toFixed(4)}` === cell);
      if (dup) continue; // two headlines about the same spot are one pin
    }

    incidents.push({
      id: `n${incidents.length + 1}`,
      category: extracted.category ?? "Hazard",
      headline: item.title,
      summary: (extracted.summary || item.description || item.title).slice(0, 300),
      street: place ?? `${TOWN} (no street named)`,
      precision,
      lat: mapped ? point.lat : null,
      lon: mapped ? point.lon : null,
      publishedAt: new Date(item.pubDate).toISOString(),
      firstReportedAt: new Date(item.firstReported).toISOString(),
      alsoReported: item.alsoReported.slice(0, 6),
      occurredAt: extracted.occurred_at && Number.isFinite(Date.parse(extracted.occurred_at)) ? new Date(extracted.occurred_at).toISOString() : null,
      occurredText: extracted.occurred_text ?? null,
      url: item.link,
      source: item.feed,
      publisher: item.publisher,
      confidence: extracted.confidence,
    });
    console.log(`  ${mapped ? "✓ map " : "· list"} ${extracted.category} @ ${place ?? "—"} (${item.publisher})`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "incidents.json");
  await fs.writeFile(out, JSON.stringify(incidents, null, 1));
  const onMap = incidents.filter((i) => i.lat != null).length;
  console.log(`\nWrote ${incidents.length} incidents (${onMap} on the map) to ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error("\nPipeline failed:", err.message);
  process.exitCode = 1;
});
