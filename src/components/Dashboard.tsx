"use client";

import { SiteFooter } from "./SiteFooter";

import { useState } from "react";
import { motion } from "motion/react";
import type { Persona, PersonaKind, WrappedResult } from "@/lib/types";
import { type ShowdownView, ran } from "./showdown";
import { ShowdownTable } from "./ShowdownTable";
import { MiniArc } from "./ArcTimeline";
import { fmtDuration, fmtInt, fmtMoney, fmtMonth, pct } from "./format";
import { usePhone, usePortrait } from "./usePortrait";
import { Avatar, CommentText, Handle } from "./mask";
import { KIND_META, VIBE_META, VIBE_ORDER, sentColor, spread } from "./vibes";

function PersonaCard({ p, i }: { p: Persona; i: number }) {
  const m = KIND_META[p.kind];
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.04, duration: 0.7, ease: [0.25, 0.6, 0.25, 1] }}
      className="relative flex flex-col border-t-2 pt-4"
      style={{ borderColor: m.accent }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="kicker" style={{ color: m.accent }}>{m.label}</span>
        <span className="num text-[13px] text-mute">{fmtInt(p.commentCount)} comments</span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Avatar name={p.authorName} src={p.authorAvatar} size={48} />
        <div className="min-w-0">
          <Handle name={p.authorName} className="display-soft block truncate text-[22px]" />
          <span className="text-[13px] text-mute">{p.videoCount} videos, {fmtMonth(p.timeline[0].t)} to {fmtMonth(p.timeline[p.timeline.length - 1].t)}</span>
        </div>
      </div>
      <MiniArc timeline={p.timeline} className="mt-4 w-full" />
      <p className="mt-3 line-clamp-3 font-serif text-[16px] italic leading-snug text-bone/90">&ldquo;<CommentText text={p.headlineComment} />&rdquo;</p>
      <p className="mt-auto pt-4 text-[15px] font-medium leading-snug">{p.verdict}</p>
    </motion.article>
  );
}

export function Dashboard({ result: r, onReplay, onReset, showdown }: { result: WrappedResult; onReplay: () => void; onReset: () => void; showdown?: ShowdownView | null }) {
  const u = r.usage;
  const portrait = usePortrait();
  // the 1.12em bump is for 1080x1920 recordings; on a real phone it makes body text oversized
  const phone = usePhone();
  const [showAll, setShowAll] = useState(false);
  // 2 per archetype keeps the cast scannable; the rest is one click away
  const PER_KIND = 2;
  const seen: Partial<Record<PersonaKind, number>> = {};
  const shown = showAll
    ? r.personas
    : r.personas.filter((p) => {
        const n = (seen[p.kind] = (seen[p.kind] ?? 0) + 1);
        return n <= PER_KIND;
      });
  const hidden = r.personas.length - shown.length;
  const sorted = [...r.videos].sort((a, b) => +new Date(a.publishedAt) - +new Date(b.publishedAt));
  const scale = spread(r.perVideo.map((x) => x.avgSentiment));
  const sentOf = (id: string) => r.perVideo.find((x) => x.videoId === id)?.avgSentiment ?? 0;
  return (
    <main className={`relative min-h-dvh overflow-hidden px-[max(1.25rem,4vw)] pb-20 pt-24 ${portrait && !phone ? "text-[1.12em]" : ""}`}>
      <div className="mx-auto max-w-[1280px]">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="flex items-center gap-4">
            <Avatar name={r.channel.title} src={r.channel.avatar || undefined} size={64} alwaysShow />
            <div>
              <h1 className="display text-[clamp(2.2rem,6.5vmin,4.8rem)]">{r.channel.title} Wrapped</h1>
              <p className="mt-1 text-mute">{r.channel.handle}{r.demo ? " · demo data, all names fictional" : ""}</p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <button onClick={onReplay} className="border border-bone/25 px-5 py-3.5 sm:py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors hover:border-bone/60">Replay story</button>
            <button onClick={onReset} className="bg-bone px-5 py-3.5 sm:py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink transition-opacity hover:opacity-85">Analyze another channel</button>
          </div>
        </div>

        <section className="mt-10 grid grid-cols-2 gap-x-5 gap-y-6 lg:grid-cols-4">
          {[
            ["comments read", fmtInt(r.totals.comments), undefined],
            ["commenters profiled", fmtInt(r.totals.commenters), undefined],
            ["total cost", fmtMoney(u.costUsd, u.costUsd < 0.1 ? 4 : 2), "#7fa88a"],
            [r.demo ? "simulated classification time" : "classification time", fmtDuration(u.elapsedMs), "#7e98b0"],
          ].map(([label, val, color]) => (
            <div key={label} className="border-t border-bone/30 pt-4">
              <div className="display tabular-nums text-[clamp(2rem,5vmin,3.4rem)]" style={{ color }}>{val}</div>
              <div className="kicker mt-2">{label}</div>
            </div>
          ))}
        </section>

        <section className="mt-12 grid gap-x-10 gap-y-10 lg:grid-cols-[1.2fr_1fr]">
          <div className="border-t border-bone/30 pt-4">
            <h2 className="display-soft text-2xl">Mood of the room</h2>
            <div className="mt-4 flex h-4 overflow-hidden">
              {VIBE_ORDER.map((v) => (
                <div key={v} style={{ width: `${pct(r.totals.byVibe[v], r.totals.comments)}%`, background: VIBE_META[v].color }} />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-mute">
              {VIBE_ORDER.map((v) => (
                <li key={v} className="flex items-center gap-1.5">
                  <span className="h-2 w-2" style={{ background: VIBE_META[v].color }} />
                  {VIBE_META[v].label} <span className="num text-bone">{Math.round(pct(r.totals.byVibe[v], r.totals.comments))}%</span>
                </li>
              ))}
            </ul>
            <h2 className="display-soft mt-8 text-2xl">Video by video</h2>
            <div className="mt-3 flex gap-[3px]">
              {sorted.map((v) => (
                <div key={v.id} title={v.title} className="h-12 flex-1" style={{ background: sentColor(scale(sentOf(v.id))) }} />
              ))}
            </div>
          </div>
          <div className="border-t border-bone/30 pt-4">
            <h2 className="display-soft text-2xl">What it cost</h2>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <div className="display tabular-nums text-[clamp(1.8rem,4vmin,3rem)] text-supportive">{fmtMoney(u.costUsd, u.costUsd < 0.1 ? 4 : 2)}</div>
                <div className="text-sm text-mute">as reported by the API</div>
              </div>
              <div>
                <div className="display tabular-nums text-[clamp(1.8rem,4vmin,3rem)] text-question">{fmtDuration(u.elapsedMs)}</div>
                <div className="text-sm text-mute">classification time</div>
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-snug text-mute">
              {fmtInt(u.inputTokens)} input tokens across {fmtInt(u.classifyCalls)} calls. Nothing here is compared against an assumed price.
            </p>
          </div>
        </section>

        {showdown && showdown.readers.some(ran) && (
          <section className="mt-12 border-t border-bone/30 pt-4" aria-label="Model showdown">
            <h2 className="display-soft text-2xl">Model showdown</h2>
            <p className="mt-1 text-sm text-mute">
              The same {fmtInt(showdown.sampleSize)} comments, sent to each reader. The per-comment readers got identical questions; the batch lane sent 50 comments per request, vibe only, so it is a different job.
              {showdown.simulated ? " SIMULATED: placeholder numbers." : ""} Agreement is with {showdown.refereeLabel ?? "the referee model"}, not accuracy, and a failed answer counts as a disagreement.
            </p>
            <ShowdownTable view={showdown} />
            {showdown.split && showdown.split.compared > 0 && (
              <p className="mt-3 text-sm text-mute">
                {fmtInt(showdown.split.split)} of {fmtInt(showdown.split.compared)} comments split the models; the slides show the most split ones a viewer can read.
              </p>
            )}
            {showdown.caveats.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold text-bone/80">Caveats</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] leading-snug text-mute">
                  {showdown.caveats.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <h2 className="display mt-16 border-t border-bone/30 pt-4 text-[clamp(1.8rem,5vmin,3.2rem)]">The cast</h2>
        <div className="mt-6 grid gap-x-8 gap-y-10 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
          {shown.map((p, i) => (
            <PersonaCard key={`${p.kind}-${p.authorId}`} p={p} i={i} />
          ))}
        </div>
        {r.personas.length === 0 && (
          <p className="mt-5 border-t border-bone/20 pt-4 text-mute">Not enough repeat commenters yet, try more videos.</p>
        )}
        {(hidden > 0 || showAll) && r.personas.length > 0 && (
          <button onClick={() => setShowAll((v) => !v)} className="mt-8 border border-bone/25 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors hover:border-bone/60">
            {showAll ? "Show fewer" : `Show all ${r.personas.length} (${hidden} more)`}
          </button>
        )}
        {r.demo && (
          <p className="mt-12 border-t border-critical/60 pt-3 text-sm text-bone/90">
            Demo mode: all data, names and comments are fictional and generated locally. Cost and time figures are simulated.
          </p>
        )}
        <div className="mt-12 border-t border-line"><SiteFooter /></div>
      </div>
    </main>
  );
}
