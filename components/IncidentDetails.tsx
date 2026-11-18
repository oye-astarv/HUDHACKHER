"use client";

import { CATEGORY_TONE, extractionLabel, isRecent, sourceLine, timeAgo, whenHappened } from "@/lib/incidents";
import type { Incident } from "@/lib/types";

/** Full detail for one news alert: what, where, when, who reported it. */
export default function IncidentDetails({ inc, onRoute }: { inc: Incident; onRoute?: boolean }) {
  const when = whenHappened(inc);
  const tone = CATEGORY_TONE[inc.category] ?? "#F59E0B";
  const reported = inc.firstReportedAt ?? inc.publishedAt;

  return (
    <div className="space-y-2 text-[12px] leading-snug text-zinc-200">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink" style={{ background: tone }}>
          {inc.category}
        </span>
        {isRecent(inc) && <span className="border border-red-400/60 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">Past 72h</span>}
        {onRoute && <span className="border border-amber-400/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">Near your route</span>}
      </div>

      {inc.headline && <p className="text-[13px] font-bold text-white">{inc.headline}</p>}
      {inc.summary && inc.summary !== inc.headline && <p className="text-zinc-300">{inc.summary}</p>}

      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[11px]">
        <dt className="text-zinc-500">Where</dt>
        <dd>
          {inc.street}
          {inc.lat == null && <span className="text-zinc-500"> · not pinned (no exact place named)</span>}
        </dd>
        <dt className="text-zinc-500">When</dt>
        <dd className={when.exact ? "" : "text-zinc-400"}>{when.label}</dd>
        <dt className="text-zinc-500">Reported</dt>
        <dd>{timeAgo(reported)}</dd>
        <dt className="text-zinc-500">Source</dt>
        <dd>{sourceLine(inc)}</dd>
      </dl>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-zinc-500">{extractionLabel(inc)}</span>
        {inc.url && (
          <a href={inc.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] font-semibold text-safe underline">
            Read the report →
          </a>
        )}
      </div>
    </div>
  );
}
