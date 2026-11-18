/**
 * Routing check: N random 0.6-2.5 km walks in a region, safe vs shortest.
 *   npm run eval:routing -- huddersfield 23 300     (region, hour, walks)
 */
import fs from "node:fs";
import { prepare } from "../lib/graph";
import { computeRoutes } from "../lib/routing";
const dir = `public/data/${process.argv[2] ?? "huddersfield"}`;
const graph = JSON.parse(fs.readFileSync(`${dir}/graph.json`, "utf8"));
const venues = JSON.parse(fs.readFileSync(`${dir}/venues.json`, "utf8"));
const incidents = JSON.parse(fs.readFileSync(`${dir}/incidents.json`, "utf8"));
const g = prepare(graph);
const hour = Number(process.argv[3] ?? 23);
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const N = Number(process.argv[4] ?? 300);
const rows: any[] = [];
for (let i = 0; rows.length < N && i < N * 5; i++) {
  const a = g.nodes[Math.floor(rnd() * g.nodes.length)], b = g.nodes[Math.floor(rnd() * g.nodes.length)];
  const d = Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 66000);
  if (d < 600 || d > 2500) continue;
  const r = computeRoutes({ graph: g, venues, incidents, origin: { lat: a[0], lon: a[1] }, destination: { lat: b[0], lon: b[1] }, hour, isDark: hour >= 17 || hour < 7, sunset: "", sunrise: "" });
  if ("error" in r) continue;
  rows.push({ same: r.sameRoute, fR: r.fastest.audit.riskyMetres, sR: r.safe.audit.riskyMetres, fM: r.fastest.audit.metres, sM: r.safe.audit.metres, fS: r.fastest.audit.safetyScore, sS: r.safe.audit.safetyScore, fC: r.fastest.audit.cautionMetres, sC: r.safe.audit.cautionMetres, fLit: r.fastest.audit.litShare, sLit: r.safe.audit.litShare });
}
const n = rows.length, avg = (f: (r: any) => number, rs = rows) => rs.reduce((s, r) => s + f(r), 0) / Math.max(1, rs.length);
const same = rows.filter((r) => r.same), diff = rows.filter((r) => !r.same);
console.log(JSON.stringify({
  walks: n, hour,
  identical_routes_pct: Math.round((100 * same.length) / n),
  identical_but_shortest_had_risky_m: Math.round(avg((r) => r.fR, same)),
  identical_with_zero_risk_pct: Math.round((100 * same.filter((r) => r.fR === 0).length) / Math.max(1, same.length)),
  avg_risky_m_shortest: Math.round(avg((r) => r.fR)), avg_risky_m_recommended: Math.round(avg((r) => r.sR)),
  avg_caution_m_shortest: Math.round(avg((r) => r.fC)), avg_caution_m_recommended: Math.round(avg((r) => r.sC)),
  avg_score_shortest: Math.round(avg((r) => r.fS)), avg_score_recommended: Math.round(avg((r) => r.sS)),
  avg_lit_tagged_pct_shortest: Math.round(100 * avg((r) => r.fLit)), avg_lit_tagged_pct_recommended: Math.round(100 * avg((r) => r.sLit)),
  avg_extra_distance_pct_when_different: Math.round(100 * avg((r) => r.sM / r.fM - 1, diff)),
  walks_where_recommended_is_riskier: rows.filter((r) => r.sR > r.fR + 10).length,
}, null, 1));
