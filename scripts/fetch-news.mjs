#!/usr/bin/env node
/**
 * SafeStride incident pipeline.
 *
 *   RSS feeds → (Gemini structured extraction | keyword heuristic) → Nominatim
 *   → public/data/incidents.json
 *
 * Runs entirely locally so the demo never scrapes live at request time. If
 * GEMINI_API_KEY is set the LLM does the street extraction; otherwise a
 * conservative keyword + street-name matcher does it, which is enough to demo
 * the detour behaviour.
 *
 *   GEMINI_API_KEY=... node scripts/fetch-news.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "data");
const UA = "SafeStride/0.1 (night-time pedestrian safety demo; contact: demo@example.org)";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const FEEDS = [
  {
    name: "Google News · Huddersfield safety",
    url: "https://news.google.com/rss/search?q=Huddersfield+(police+OR+assault+OR+cordon+OR+attack+OR+closure+OR+harassment)+when:7d&hl=en-GB&gl=GB&ceid=GB:en",
  },
  {
    name: "ExaminerLive · Huddersfield",
    url: "https://www.examinerlive.co.uk/all-about/huddersfield?service=rss",
  },
];

// Roughly the same 3km box the graph covers — anything outside is dropped.
const BBOX = { s: 53.6188, w: -1.8305, n: 53.6728, e: -1.7395 };

const SAFETY_WORDS =
  /(police|assault|attack|cordon|closure|closed|harass|robbery|stab|fight|incident|arrest|antisocial|anti-social|probe|inquiry|crash|fire|flood|roadworks)/i;

const CATEGORY_RULES = [
  [/cordon/i, "Police Cordon"],
  [/assault|stab|attack|robbery|harass/i, "Assault"],
  [/anti-?social|youths|gang/i, "Anti-Social Behaviour"],
  [/clos|roadworks|flood|fire|crash|collision/i, "Hazard"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
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
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const block of blocks) {
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    const description = decodeXml(
      block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""
    );
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    if (!title) continue;
    items.push({ title, link, description, pubDate, feed: feed.name });
  }
  console.log(`  ${feed.name}: ${items.length} items`);
  return items;
}

/** Conservative fallback extractor: headline keywords only, no invention. */
function heuristic(item) {
  const haystack = `${item.title} ${item.description}`;
  if (!SAFETY_WORDS.test(haystack)) return null;

  const category =
    CATEGORY_RULES.find(([re]) => re.test(haystack))?.[1] ?? "Hazard";

  // Streets named in the headline, e.g. "Northumberland Street"
  const streetMatch = item.title.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(Street|Road|Lane|Avenue|Place|Square|Hill|Way|Croft|Grove|Drive|Terrace|Crescent)\b/
  );
  const street = streetMatch
    ? `${streetMatch[1]} ${streetMatch[2]}, Huddersfield`
    : "Huddersfield town centre";

  return {
    is_pedestrian_safety_relevant: true,
    category,
    street_or_landmark: street,
    one_line_summary: item.title.slice(0, 160),
    confidence: "heuristic",
  };
}

async function geminiExtract(item) {
  const prompt = `You extract pedestrian safety incidents from UK local news.
Return ONLY JSON matching this shape:
{"is_pedestrian_safety_relevant":boolean,"category":"Police Cordon"|"Assault"|"Anti-Social Behaviour"|"Hazard","street_or_landmark":string,"one_line_summary":string}
Use a real street or landmark in or near Huddersfield, UK if one is named. If no street is named, use "Huddersfield town centre". Set is_pedestrian_safety_relevant false for sport, business, entertainment or national news.

Headline: ${item.title}
Summary: ${item.description}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return { ...JSON.parse(text), confidence: "llm" };
}

function inArea(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= BBOX.s &&
    lat <= BBOX.n &&
    lon >= BBOX.w &&
    lon <= BBOX.e
  );
}

/**
 * Photon first (structured street/city fields, no UA policy friction), with
 * Nominatim as a fallback — note Nominatim 403s unless a Referer is sent.
 */
async function geocode(query) {
  try {
    const url =
      "https://photon.komoot.io/api/?limit=1&lang=en&lat=53.6458&lon=-1.785&q=" +
      encodeURIComponent(query);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const json = await res.json();
      const feature = json.features?.[0];
      const [lon, lat] = feature?.geometry?.coordinates ?? [];
      if (inArea(lat, lon)) return { lat, lon };
      return null;
    }
  } catch {
    // fall through to Nominatim
  }

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" +
      encodeURIComponent(query);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://safestride.local/" },
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    const lat = Number(results[0].lat);
    const lon = Number(results[0].lon);
    return inArea(lat, lon) ? { lat, lon } : null;
  } catch (err) {
    throw new Error(`geocode failed: ${err.message}`);
  }
}

async function main() {
  console.log(`SafeStride news pipeline · extraction=${GEMINI_KEY ? MODEL : "heuristic"}`);

  const items = [];
  for (const feed of FEEDS) {
    try {
      items.push(...(await fetchFeed(feed)));
    } catch (err) {
      console.warn(`  ! ${err.message}`);
    }
  }

  const seen = new Set();
  const candidates = [];
  for (const item of items) {
    const key = item.title.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    let extracted = null;
    if (GEMINI_KEY) {
      try {
        extracted = await geminiExtract(item);
      } catch (err) {
        console.warn(`  ! gemini: ${err.message}`);
        extracted = heuristic(item);
      }
    } else {
      extracted = heuristic(item);
    }

    if (!extracted?.is_pedestrian_safety_relevant) continue;
    if (!extracted.street_or_landmark) continue;
    candidates.push({ item, extracted });
  }

  console.log(`  ${candidates.length} safety-relevant candidates`);

  const incidents = [];
  for (const { item, extracted } of candidates.slice(0, 12)) {
    const place = extracted.street_or_landmark;
    const query = /huddersfield/i.test(place) ? place : `${place}, Huddersfield, UK`;

    let point = null;
    try {
      point = await geocode(query);
    } catch (err) {
      console.warn(`  ! nominatim: ${err.message}`);
    }
    await sleep(700);

    if (!point) {
      console.warn(`  · no in-area match for "${place}"`);
      continue;
    }

    // Two headlines about the same spot are one pin, not two warnings.
    const cell = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
    if (incidents.some((i) => `${i.lat.toFixed(4)},${i.lon.toFixed(4)}` === cell)) {
      continue;
    }

    incidents.push({
      category: extracted.category ?? "Hazard",
      street: place,
      summary: extracted.one_line_summary ?? item.title,
      lat: point.lat,
      lon: point.lon,
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      url: item.link,
      source: item.feed,
      confidence: extracted.confidence,
    });
    console.log(`  ✓ ${extracted.category} @ ${place}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "incidents.json");
  await fs.writeFile(out, JSON.stringify(incidents, null, 1));
  console.log(`\nWrote ${incidents.length} incidents to ${path.relative(process.cwd(), out)}`);
  if (incidents.length === 0) {
    console.log(
      "No incidents matched inside the demo area. The map will simply show none — it does not invent them."
    );
  }
}

main().catch((err) => {
  console.error("\nPipeline failed:", err.message);
  process.exitCode = 1;
});
