# SafeStride

Night-time pedestrian safe routing and one-tap emergency alerts. A mobile-first PWA (Next.js) with a Cloudflare Worker + Durable Object backend.

- **Two routes, compared:** shortest vs "lit & open", scored on street lighting, main roads, footfall (high streets, bus stops), open venues, CCTV, and avoiding alleys, underpasses, tracks, unlit park paths and recent news incidents. The app explains why the recommended route was chosen.
- **Safe havens:** pubs, bars, hotels, stations, police, A&E, petrol stations and late shops that are open at the chosen time (OpenStreetMap, with estimated hours flagged).
- **Local news alerts:** BBC, local papers and police news, merged per event, with where/when/source. Optional Groq LLM extraction.
- **SOS:** finds the nearest open safe haven, sends a WhatsApp alert (Twilio) with a live-tracking link, streams GPS every 5 s, and needs your 4-digit PIN to end.

## Run locally

```bash
npm install
npm run dev        # app on http://localhost:3000
npm run dev:api    # Worker + Durable Object on :8787 (the app proxies /api to it)
```

Copy `.dev.vars.example` to `.dev.vars` for Twilio WhatsApp and Groq keys. Without them, SOS still works with a manual "Share alert" button, and news uses keyword matching.

Deploy to Cloudflare: `npx wrangler login`, then `npm run deploy`. Add secrets with `npx wrangler secret put NAME`.

## Towns / regions

Each covered town is one entry in [`config/regions.json`](config/regions.json) with its own data in `public/data/<id>/`. The app has a town picker and switches automatically when your GPS is inside another covered town.

Covered now: **Huddersfield** (2.5 km around the centre). **Leeds** (2.2 km around the city centre) is configured and its news is built. Its street map still needs `npm run data:graph -- --region leeds`; until then the app shows a "map not built yet" screen with a button back to Huddersfield.

### Adding a town

1. Add an entry to `config/regions.json`:
   - `id`, `name`, `county`;
   - `centre` [lat, lon] and `radiusM` (keep it 3 km or less so the map stays small enough for phones);
   - `police` (force name);
   - `bbcFeed` (the BBC regional RSS feed);
   - `localFeeds` (local paper RSS);
   - `publishers`, `areas` (neighbourhood names), `outside` (nearby towns to exclude) and `landmarks`;
   - 1–3 `presets` (demo routes).
2. Build its map, then fetch its news:
   ```bash
   npm run data:graph -- --region <id>
   ```
   ```bash
   npm run data:news -- --region <id>
   ```
   The map build uses public Overpass servers, which are often busy. Downloads are split into tiles and cached in `.cache/`, so rerunning after a failure only fetches what's missing.
3. Reload the app; the town appears in the picker.

Each town adds about 1–1.5 MB of map data, which the browser downloads only when that town is selected. Very large areas (whole counties or the country) would need a server-side router instead.

## Data sources

- **OpenStreetMap via Overpass:** streets, lighting tags, lamps, parks, CCTV, bus stops, venues and opening hours.
- **Nominatim / Photon:** address search and geocoding.
- **News:** BBC RSS, local paper RSS, and Google News RSS (trusted UK outlets only).
- **Map tiles:** OpenStreetMap.
