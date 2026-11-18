import type { Incident } from "./types";

const DAY = 86400_000;

export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/** When it happened, as precisely as the reports allow — never guessed. */
export function whenHappened(inc: Incident): { label: string; exact: boolean } {
  if (inc.occurredAt) {
    return {
      label: `${fmtDateTime(inc.occurredAt)}${inc.occurredText ? ` (“${inc.occurredText}”)` : ""}`,
      exact: true,
    };
  }
  if (inc.occurredText) return { label: `“${inc.occurredText}” (as reported)`, exact: true };
  const first = inc.firstReportedAt ?? inc.publishedAt;
  return { label: `Not stated — first reported ${fmtDateTime(first)}`, exact: false };
}

export function sourceLine(inc: Incident): string {
  const lead = inc.publisher ?? inc.source ?? "news report";
  const others = inc.alsoReported?.filter(Boolean) ?? [];
  if (!others.length) return lead;
  return `${lead} · also ${others.slice(0, 3).join(", ")}${others.length > 3 ? ` +${others.length - 3}` : ""}`;
}

export const extractionLabel = (inc: Incident) =>
  inc.confidence === "llm" ? "AI-extracted from the report" : "Keyword match — check the report";

export const isRecent = (inc: Incident, hours = 72) =>
  Date.now() - Date.parse(inc.firstReportedAt ?? inc.publishedAt) < hours * 3600_000;

export const CATEGORY_TONE: Record<string, string> = {
  "Police Cordon": "#F59E0B",
  Assault: "#EF4444",
  "Sexual Offence": "#EF4444",
  "Anti-Social Behaviour": "#F59E0B",
  Hazard: "#FBBF24",
};
