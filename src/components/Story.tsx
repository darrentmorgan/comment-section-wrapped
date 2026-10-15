"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { ClassifiedComment, Persona, PersonaKind, WrappedResult } from "@/lib/types";
import { usePhone, usePortrait } from "./usePortrait";
import { EASE, Shell, Sub, Title } from "./storyKit";
import { badDayCounts, cameraSafe } from "@/lib/personas";
import { ArcTimeline, MiniArc, turningPoint } from "./ArcTimeline";
import { CountUp } from "./CountUp";
import { fmtDuration, fmtInt, fmtMoney, fmtMonth, pct } from "./format";
import { Avatar, CommentText, Handle } from "./mask";
import { AgreementSlide, CardsSlide, DisagreeSlide, EDGE_FIRST_MS, EDGE_STEP_MS, EdgeSlide, RaceSlide, VerdictSlide } from "./ShowdownSlides";
import { type ShowdownView, edgeOf, pickDisagreements, ran } from "./showdown";
import { KIND_META, VIBE_META, VIBE_ORDER, sentColor, spread } from "./vibes";

const first = (r: WrappedResult, k: PersonaKind) => r.personas.find((p) => p.kind === k && cameraSafe(p.headlineComment));

interface SlideDef {
  id: string;
  ms: number;
  render: () => React.ReactNode;
}

/* ---------------- slides ---------------- */

function IntroSlide({ r }: { r: WrappedResult }) {
  const portrait = usePortrait();
  const phone = usePhone();
  const len = Array.from(r.channel.title).length;
  // short names get blown up to fill a phone frame; long ones stay legible
  const f = len <= 8 ? 1.4 : len <= 11 ? 1.2 : len <= 16 ? 1.0 : 0.8;
  return (
    <Shell accent="#a98fb0">
      <div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, ease: EASE }}>
          <Avatar name={r.channel.title} src={r.channel.avatar || undefined} size={phone ? 112 : portrait ? 190 : 110} alwaysShow className="ring-1 ring-bone/30" />
        </motion.div>
        <h2 className="display intro-title mt-6" style={{ ["--f" as string]: f }}>
          <span className="headline-line"><span style={{ animationDelay: "0.1s" }}>{r.channel.title}</span></span>
          <span className="headline-line"><span style={{ animationDelay: "0.22s" }} className="text-bone/35">Wrapped.</span></span>
        </h2>
      </div>
      <div className="flex flex-wrap gap-x-[6vmin] gap-y-3">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.6, ease: EASE }}>
          <div className="display tabular-nums text-[calc(var(--kt)*clamp(2.4rem,8vmin,5.4rem))]">
            <CountUp to={r.totals.comments} format={(n) => fmtInt(n)} duration={1.8} delay={0.7} />
          </div>
          <p className="kicker mt-2">comments read</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8, duration: 0.6, ease: EASE }}>
          <div className="display tabular-nums text-[calc(var(--kt)*clamp(2.4rem,8vmin,5.4rem))]">
            <CountUp to={r.totals.commenters} format={(n) => fmtInt(n)} duration={1.8} delay={0.9} />
          </div>
          <p className="kicker mt-2">people</p>
        </motion.div>
      </div>
      <Sub delay={1.3}>
        The top ~1,000 comments on each of the last {r.videos.length} videos, read by a model so I did not have to.
      </Sub>
    </Shell>
  );
}

function VibeSlide({ r }: { r: WrappedResult }) {
  const t = r.totals;
  const nasty = pct(t.byVibe.toxic + t.byVibe.critical, t.comments);
  const sweet = pct(t.byVibe.supportive, t.comments);
  const max = Math.max(...VIBE_ORDER.map((v) => t.byVibe[v]), 1);
  return (
    <Shell accent="#d08a52">
      <Title size="big">The mood of the room</Title>
      <div className="flex flex-wrap items-end gap-x-6">
        <div className="display tabular-nums text-[calc(var(--kt)*clamp(4.5rem,22vmin,15rem))] leading-[0.85]" style={{ color: "#d08a52" }}>
          <CountUp to={nasty} format={(n) => `${Math.round(n)}%`} duration={1} delay={0.3} />
        </div>
        <p className="st-sub mb-2 max-w-[22ch] leading-tight text-bone/85">of comments were critical or toxic. {Math.round(sweet)}% were positive or friendly.</p>
      </div>
      <ul className="flex flex-col gap-[1.4dvh]">
        {VIBE_ORDER.map((v, i) => (
          <li key={v} className="st-meta grid grid-cols-[8.5rem_1fr_6rem] items-center gap-3">
            <span className="font-semibold uppercase tracking-[0.12em] text-[0.78em]" style={{ color: VIBE_META[v].color }}>{VIBE_META[v].label}</span>
            <span className="h-[clamp(12px,2.2vmin,22px)] overflow-hidden bg-bone/10">
              <motion.span
                className="block h-full origin-left"
                style={{ background: VIBE_META[v].color, width: `${(t.byVibe[v] / max) * 100}%` }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.5 + i * 0.08, duration: 1, ease: EASE }}
              />
            </span>
            <span className="num text-right text-bone/80">{fmtInt(t.byVibe[v])}</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function PersonaBlock({ p, line, accent, delay = 0, compact = false }: { p: Persona; line: string; accent: string; delay?: number; compact?: boolean }) {
  const portrait = usePortrait();
  const phone = usePhone();
  const pos = ((p.avgSentiment + 1) / 2) * 100;
  return (
    <div className="flex min-w-0 flex-col gap-[2.2dvh]">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: delay + 0.15, duration: 0.7, ease: EASE }} className="flex items-center gap-4">
        <Avatar name={p.authorName} src={p.authorAvatar} size={phone ? (compact ? 52 : 72) : portrait && !compact ? 132 : 88} className="ring-1 ring-bone/30" />
        <div className="min-w-0">
          <Handle name={p.authorName} className="display-soft st-handle block truncate" />
          <span className="st-meta text-mute">{fmtInt(p.commentCount)} comments across {p.videoCount} videos</span>
        </div>
      </motion.div>
      <Sub delay={delay + 0.3} className={compact ? "hidden" : ""}>{line}</Sub>
      <motion.blockquote
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: delay + 0.5, duration: 0.8, ease: EASE }}
        className="border-l-[3px] py-1 pl-[clamp(1rem,2.6vmin,2rem)] font-serif font-medium leading-tight"
        style={{ borderColor: accent }}
      >
        <div className={`st-quote ${compact ? "st-quote-sm" : ""}`}>&ldquo;<CommentText text={p.headlineComment} />&rdquo;</div>
      </motion.blockquote>
      <Sub delay={delay + 1.1} className="!text-bone">{p.verdict}</Sub>
      <div className={`max-w-[560px] ${compact ? "hidden" : ""}`}>
        <div className="relative h-px bg-bone/40">
          <span className="absolute left-0 top-1/2 h-[7px] w-px -translate-y-1/2 bg-bone/60" />
          <span className="absolute left-1/2 top-1/2 h-[7px] w-px -translate-y-1/2 bg-bone/60" />
          <span className="absolute right-0 top-1/2 h-[7px] w-px -translate-y-1/2 bg-bone/60" />
          <motion.span
            className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-bone"
            initial={{ left: "50%" }}
            animate={{ left: `${pos}%` }}
            transition={{ delay: delay + 0.7, duration: 0.9, ease: EASE }}
          />
        </div>
        <div className="kicker mt-3 flex justify-between"><span>nasty</span><span>lovely</span></div>
      </div>
    </div>
  );
}

function PersonaSlide({ p, title, line, accent }: { p: Persona; title: string; line: string; accent: string }) {
  return (
    <Shell accent={accent}>
      <Title size="big" color={accent}>{title}</Title>
      <PersonaBlock p={p} line={line} accent={accent} />
    </Shell>
  );
}

/** Comedian and Reply Guy share one slide: two quick characters instead of two near-identical slides. */
function CastSlide({ items }: { items: { p: Persona; title: string; line: string; accent: string }[] }) {
  return (
    <Shell accent={items[0].accent}>
      <Title size="big">The regulars</Title>
      <div className="st-split">
        {items.map((i, k) => (
          <div key={i.p.authorId}>
            <p className="display-soft st-handle mb-[1.4dvh]" style={{ color: i.accent }}>{i.title}</p>
            <PersonaBlock p={i.p} line={i.line} accent={i.accent} delay={k * 0.35} compact />
          </div>
        ))}
      </div>
    </Shell>
  );
}

const BEFORE_AT = 0.5;
type ArcKind = "villain_arc" | "redemption_arc" | "bad_day";

/** Up to `n` comments from `pool`, the most extreme in direction `dir`, shown in timeline order. */
function extremes(pool: Persona["timeline"], dir: 1 | -1, n: number) {
  const idx = pool.map((_, i) => i).sort((x, y) => dir * pool[y].sentiment - dir * pool[x].sentiment).slice(0, n).sort((x, y) => x - y);
  return idx.map((i) => pool[i]);
}

/**
 * The headline reveal. The chart draws while real "before" comments cycle in, the tone flips (the accent rule changes
 * colour) as the line crosses the turning point and the "after" quote slams in, then the arc is stamped.
 */
function ArcSlide({ p, kind, title, accent, headline, stamp }: { p: Persona; kind: ArcKind; title: string; accent: string; headline: string; stamp: string }) {
  const reduced = useReducedMotion();
  const tl = p.timeline;
  const n = tl.length;
  const bad = kind === "bad_day";
  const villain = kind === "villain_arc" || bad;
  // bad day: the single lowest point; arcs: where the tone flips for good
  const fi = bad ? tl.reduce((best, t, i) => (t.sentiment < tl[best].sentiment ? i : best), 0) : turningPoint(tl, kind);
  const DRAW = 2.6;
  // the slam lands as the drawn line reaches the turning point
  const swapAt = Math.min(3.6, Math.max(1.9, BEFORE_AT + (n > 1 ? fi / (n - 1) : 0.5) * DRAW + 0.1));
  const stampAt = swapAt + 1.5;
  const beforeAll = tl.slice(0, Math.max(1, fi));
  // "Lovely" cards must actually be lovely
  const beforePool = bad && beforeAll.some((t) => t.sentiment > 0.2) ? beforeAll.filter((t) => t.sentiment > 0.2) : beforeAll;
  const afterPool = bad ? [tl[fi]] : tl.slice(Math.min(fi, n - 1));
  const pre = extremes(beforePool, villain ? 1 : -1, 3);
  const after = extremes(afterPool, villain ? -1 : 1, 1)[0];
  const kindCount = bad ? badDayCounts(tl.map((t) => t.sentiment)).warm : new Set(tl.slice(0, fi).map((t) => t.videoId)).size;
  const beforeColor = villain ? "#7fa88a" : "#d0614a";
  const afterColor = villain ? "#d0614a" : "#7fa88a";
  const recovered = bad && tl.slice(fi + 1).some((t) => t.sentiment > 0.2);
  const flipLabel = bad ? "the bad day" : `${fmtMonth(tl[fi].t)} · ${kindCount} videos in`;

  const card = (q: Persona["timeline"][number], label: string, color: string) => (
    <div className="border-l-[3px] bg-ink-2 p-[clamp(1.1rem,2.8vmin,2.2rem)]" style={{ borderColor: color }}>
      <p className="kicker" style={{ color }}>{label} · {fmtMonth(q.t)}</p>
      <p className="st-quote mt-2 font-serif font-medium leading-tight">&ldquo;<CommentText text={q.text} />&rdquo;</p>
    </div>
  );
  const slot = (swapAt - BEFORE_AT) / Math.max(1, pre.length);

  return (
    <Shell accent={bad ? "#7fa88a" : accent} shift={{ color: afterColor, at: swapAt }} shakeAt={swapAt}>
      <div>
        <Title size="big" color={accent}>{title}</Title>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mt-3 flex flex-wrap items-center gap-3">
          <Avatar name={p.authorName} src={p.authorAvatar} size={52} />
          <Handle name={p.authorName} className="display-soft st-handle" />
          <span className="st-meta text-mute">{headline}</span>
        </motion.div>
      </div>
      <div className="st-split" style={{ ["--cols" as string]: "minmax(0,1.3fr) minmax(0,1fr)" }}>
        <div className="relative">
          <ArcTimeline timeline={tl} hideQuotes drawSeconds={DRAW} startDelay={BEFORE_AT} flip={{ index: fi, label: flipLabel, at: swapAt - 0.1, color: afterColor }} />
          <span
            className="slam absolute right-[1%] top-[2%] border-y-2 bg-ink px-4 py-1.5 text-[calc(var(--kt)*clamp(0.9rem,2.4vmin,1.6rem))] font-semibold uppercase tracking-[0.2em]"
            style={{ color: afterColor, borderColor: afterColor, animationDelay: `${stampAt}s`, opacity: 0 }}
          >
            {stamp}
          </span>
        </div>
        <div className="flex flex-col gap-[2dvh]">
          {reduced ? (
            <>
              {card(pre[0], bad ? "Lovely" : "Before", beforeColor)}
              {card(after, bad ? "The bad day" : "After", afterColor)}
            </>
          ) : (
            <div className="grid">
              {pre.map((q, k) => (
                <motion.div
                  key={k}
                  className="[grid-area:1/1]"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: [0, 1, 1, 0], y: [24, 0, 0, -12] }}
                  transition={{ delay: BEFORE_AT + k * slot, duration: slot + (k === pre.length - 1 ? 0 : 0.15), times: [0, 0.15, 0.85, 1], ease: "easeOut" }}
                >
                  {card(q, bad ? "Lovely" : "Before", beforeColor)}
                </motion.div>
              ))}
              <div className="[grid-area:1/1]">
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: swapAt, duration: 0.6, ease: EASE }}
                >
                  {card(after, bad ? "The bad day" : "After", afterColor)}
                </motion.div>
              </div>
            </div>
          )}
          {bad ? (
            recovered && <Sub delay={stampAt + 0.4} className="!text-bone">Then right back to being lovely.</Sub>
          ) : (
            <Sub delay={stampAt + 0.4} className="!text-bone">{p.verdict}</Sub>
          )}
        </div>
      </div>
    </Shell>
  );
}

function MostLoyalSlide({ m }: { m: NonNullable<WrappedResult["mostLoyal"]> }) {
  const portrait = usePortrait();
  const phone = usePhone();
  const SEG = Math.min(m.totalVideos, 60);
  const lit = Math.round((m.videosCommented / m.totalVideos) * SEG);
  return (
    <Shell accent="#c9a049">
      <Title size="big" color="#c9a049">The most loyal</Title>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7, ease: EASE }} className="flex items-center gap-4">
        <Avatar name={m.authorName} src={m.authorAvatar} size={phone ? 72 : portrait ? 132 : 88} className="ring-1 ring-bone/30" />
        <div className="min-w-0">
          <Handle name={m.authorName} className="display-soft st-handle block truncate" />
          <span className="st-meta text-mute">{fmtInt(m.commentCount)} comments</span>
        </div>
      </motion.div>
      <div>
        <div className="flex items-end gap-x-4">
          <div className="display tabular-nums leading-[0.85] text-[calc(var(--kt)*clamp(5rem,25vmin,17rem))]" style={{ color: "#c9a049" }}>
            <CountUp to={m.videosCommented} format={(n) => String(Math.round(n))} duration={1.6} delay={0.5} />
          </div>
          <p className="display-soft mb-[1.2vmin] text-[calc(var(--kb)*clamp(1.6rem,5vmin,3.6rem))] text-bone/85">of {m.totalVideos} videos</p>
        </div>
        <div className="mt-[3dvh] flex gap-[3px]" aria-hidden>
          {Array.from({ length: SEG }, (_, i) => (
            <motion.span
              key={i}
              className="h-[clamp(22px,4.2dvh,46px)] flex-1"
              style={{ background: i < lit ? "#c9a049" : "rgba(239,232,218,0.1)" }}
              initial={{ opacity: 0.2 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 + (i / SEG) * 1.6, duration: 0.25 }}
            />
          ))}
        </div>
      </div>
      <motion.blockquote
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.1, duration: 0.8, ease: EASE }}
        className="border-l-[3px] py-1 pl-[clamp(1rem,2.6vmin,2rem)] font-serif font-medium leading-tight"
        style={{ borderColor: "#c9a049" }}
      >
        <div className="st-quote">&ldquo;<CommentText text={m.headlineComment} />&rdquo;</div>
      </motion.blockquote>
      <Sub delay={2.6} className="!max-w-[30ch] !text-[#c9a049] font-medium [&]:text-[calc(var(--kb)*clamp(1.5rem,4.6vmin,3rem))]">{m.verdict}</Sub>
    </Shell>
  );
}

const worstOf = (p: Persona) => p.timeline.reduce((a, b) => (b.sentiment < a.sentiment ? b : a));
/** The comparison only works with real contrast and quotes that can sit on screen: mostly-nasty vs exactly one nasty, both safe. */
export const alwaysWorthShowing = (hater: Persona, oneOff: Persona) =>
  hater.authorId !== oneOff.authorId &&
  nastyCount(hater) / Math.max(1, hater.timeline.length) >= 0.5 &&
  nastyCount(oneOff) === 1 &&
  cameraSafe(worstOf(hater).text) &&
  cameraSafe(worstOf(oneOff).text);
const nastyCount = (p: Persona) => p.timeline.filter((x) => x.sentiment <= -0.4).length;

function AlwaysSlide({ hater, oneOff }: { hater: Persona; oneOff: Persona }) {
  const cols = [
    { p: hater, answer: "Always.", color: "#d0614a", note: "nasty on", delay: 0.4 },
    { p: oneOff, answer: "Just once.", color: "#d08a52", note: "nasty on", delay: 0.8 },
  ];
  return (
    <Shell accent="#d0614a">
      <Title size="big">Always this nasty?</Title>
      <div className="st-split">
        {cols.map(({ p, answer, color, note, delay }) => (
          <motion.div
            key={p.authorId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, duration: 0.8, ease: EASE }}
            className="border-t-2 pt-[clamp(0.8rem,2vmin,1.4rem)]"
            style={{ borderColor: color }}
          >
            <div className="flex items-center gap-3">
              <Avatar name={p.authorName} src={p.authorAvatar} size={52} />
              <Handle name={p.authorName} className="display-soft st-handle" />
            </div>
            <div className="my-3">
              <MiniArc timeline={p.timeline} className="w-full" />
            </div>
            <div className="display text-[calc(var(--kt)*clamp(2.4rem,8vmin,5.6rem))]" style={{ color }}>{answer}</div>
            <p className="st-meta mt-2 text-bone/80">
              {note} <b className="num text-bone">{nastyCount(p)}</b> of {p.timeline.length} comments
            </p>
            <p className="st-meta mt-2 italic text-mute">&ldquo;<CommentText text={worstOf(p).text} />&rdquo;</p>
          </motion.div>
        ))}
      </div>
    </Shell>
  );
}

function ClashSlide({ r }: { r: WrappedResult }) {
  const f = r.topComments.funniest[0];
  const n = r.topComments.nastiest[0];
  const card = (c: ClassifiedComment, label: string, color: string, delay: number) => (
    <motion.figure
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.8, ease: EASE }}
      className="border-t-2 pt-[clamp(0.8rem,2vmin,1.4rem)]"
      style={{ borderColor: color }}
    >
      <figcaption className="kicker" style={{ color }}>{label}</figcaption>
      <blockquote className="st-quote mt-3 font-serif font-medium leading-tight">&ldquo;<CommentText text={c.text} />&rdquo;</blockquote>
      <div className="st-meta mt-4 flex items-center gap-3 text-mute">
        <Avatar name={c.authorName} src={c.authorAvatar} size={36} />
        <Handle name={c.authorName} />
        <span className="num ml-auto">{fmtInt(c.likes)} likes</span>
      </div>
    </motion.figure>
  );
  return (
    <Shell accent="#a98fb0">
      <Title size="big">Best and worst, in public</Title>
      <div className="st-split">
        {f && card(f, "The funniest", VIBE_META.funny.color, 0.35)}
        {n && card(n, "The nastiest", VIBE_META.toxic.color, 0.8)}
      </div>
    </Shell>
  );
}

function VideoCallout({ v, s, label, color, delay }: { v: WrappedResult["videos"][number]; s: number; label: string; color: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.7, ease: EASE }}
      className="flex items-center gap-4 border-t-2 pt-3"
      style={{ borderColor: color }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img referrerPolicy="no-referrer" src={v.thumbnail} alt="" className="aspect-video w-[28%] shrink-0 object-cover" />
      <div className="min-w-0">
        <p className="kicker" style={{ color }}>{label} <span className="num normal-case tracking-normal text-mute">mood {s >= 0 ? "+" : ""}{s.toFixed(2)}</span></p>
        <p className="st-meta line-clamp-2 font-semibold leading-snug">{v.title}</p>
      </div>
    </motion.div>
  );
}

function HeatSlide({ r }: { r: WrappedResult }) {
  const pv = r.videos.map((v) => ({ v, s: r.perVideo.find((x) => x.videoId === v.id)?.avgSentiment ?? 0 }));
  const sorted = [...pv].sort((a, b) => +new Date(a.v.publishedAt) - +new Date(b.v.publishedAt)); // oldest -> newest
  const best = sorted.reduce((a, b) => (b.s > a.s ? b : a), sorted[0]);
  const worst = sorted.reduce((a, b) => (b.s < a.s ? b : a), sorted[0]);
  const scale = spread(sorted.map((x) => x.s));
  const lo = Math.min(...sorted.map((x) => x.s));
  const hi = Math.max(...sorted.map((x) => x.s));
  const half = Math.floor(sorted.length / 2);
  const avg = (xs: { s: number }[]) => (xs.length ? xs.reduce((a, b) => a + b.s, 0) / xs.length : 0);
  // The headline comes from the data: earlier half vs later half.
  const delta = half > 0 ? avg(sorted.slice(sorted.length - half)) - avg(sorted.slice(0, half)) : 0;
  const flat = hi - lo < 0.2; // a narrow spread must not read as drama
  const title = flat ? "A steady room" : delta < -0.06 ? "The room got colder" : delta > 0.06 ? "The room warmed up" : "Hot and cold";
  const accent = delta < -0.06 ? "#d0614a" : delta > 0.06 ? "#7fa88a" : "#d08a52";
  return (
    <Shell accent={accent}>
      <div>
        <Title size="big">{title}</Title>
        <Sub className="mt-3">
          Average mood of each video, oldest to newest. Bars are scaled to this channel: mood runs from <b className="num text-bone">{lo >= 0 ? "+" : ""}{lo.toFixed(2)}</b> to <b className="num text-bone">{hi >= 0 ? "+" : ""}{hi.toFixed(2)}</b>.
        </Sub>
      </div>
      <div>
        <div className="heat-bars">
          {sorted.map((x, i) => {
            const h = 14 + (hi === lo ? 0.5 : (x.s - lo) / (hi - lo)) * 86;
            const isWorst = x === worst;
            return (
              <motion.div
                key={x.v.id}
                title={x.v.title}
                initial={{ scaleY: 0, opacity: 0.4 }}
                animate={{ scaleY: 1, opacity: 1 }}
                transition={{ delay: 0.25 + i * 0.04, duration: 0.7, ease: EASE }}
                className="origin-bottom"
                style={{ height: `${h}%`, background: sentColor(scale(x.s)), outline: isWorst ? "1.5px solid #efe8da" : undefined, outlineOffset: 2 }}
              />
            );
          })}
        </div>
        <div className="st-meta mt-2 flex justify-between text-mute">
          <span>{fmtMonth(sorted[0].v.publishedAt)}</span>
          <span>{fmtMonth(sorted[sorted.length - 1].v.publishedAt)}</span>
        </div>
      </div>
      <div className="st-split">
        <VideoCallout v={worst.v} s={worst.s} label="Frostiest" color="#d0614a" delay={1.9} />
        <VideoCallout v={best.v} s={best.s} label="Warmest" color="#7fa88a" delay={2.2} />
      </div>
    </Shell>
  );
}

function ReceiptSlide({ r, replay, hasShowdown }: { r: WrappedResult; replay?: string; hasShowdown?: boolean }) {
  const u = r.usage;
  const dp = u.costUsd < 0.1 ? 4 : 2;
  const timeWord = r.demo ? "simulated classification" : "classification time";
  return (
    <Shell accent="#7fa88a">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="display-soft text-[calc(var(--kb)*clamp(1.4rem,4.4vmin,3rem))]">
          The first reader (ScaleDown batch classify, 50 comments per request) got through <b className="font-semibold">{fmtInt(r.totals.comments)}</b> comments.
        </motion.p>
        {r.demo && <span className="kicker border border-critical/70 px-3 py-1 !text-critical">Simulated demo data</span>}
        {replay && !r.demo && <span className="kicker border border-bone/25 px-3 py-1">Replay of a live run, {replay}</span>}
      </div>
      <div className="st-split">
        <div>
          <p className="kicker">It cost</p>
          <div className="display st-hero-num tabular-nums leading-[0.95] text-supportive">
            <CountUp to={u.costUsd} format={(n) => fmtMoney(n, dp)} duration={2} delay={0.5} />
          </div>
        </div>
        <div>
          <p className="kicker">and took</p>
          <div className="display st-hero-num tabular-nums leading-[0.95] text-question">
            <CountUp to={u.elapsedMs / 1000} format={(n) => `${n.toFixed(1)} sec`} duration={2} delay={0.5} />
          </div>
          <p className="st-meta text-bone/70">{timeWord}</p>
        </div>
      </div>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.6 }} className="st-foot max-w-[84ch] leading-[1.3] text-bone/70">
        {fmtInt(u.inputTokens)} input tokens, {fmtInt(u.classifyCalls)} classify calls, cost as reported by the API.
        {!r.demo && ` Time is classification only${u.endToEndMs ? ` (${fmtDuration(u.endToEndMs)} end to end, including YouTube fetching)` : ""}.`}
        {u.unclassified ? ` ${fmtInt(u.unclassified)} comments could not be classified.` : ""}
        {u.estimated ? " Some token counts are estimated." : ""}
        {hasShowdown ? " That is one reader's whole-channel run. A fair side-by-side comes next." : ""}
      </motion.p>
    </Shell>
  );
}

/* ---------------- player ---------------- */

export function Story({ result, onFinish, replay, showdown }: { result: WrappedResult; onFinish: () => void; replay?: string; showdown?: ShowdownView | null }) {
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const down = useRef(0);
  // ?pace=fast trims every slide for tight social cuts
  const pace = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("pace") === "fast" ? 0.7 : 1;
    } catch {
      return 1;
    }
  }, []);

  const slides = useMemo<SlideDef[]>(() => {
    const r = result;
    const out: SlideDef[] = [];
    const ms = (n: number) => Math.round(n * pace);
    const sf = first(r, "superfan");
    const vil = first(r, "villain_arc");
    const red = first(r, "redemption_arc");
    const hat = first(r, "consistent_hater");
    const bads = r.personas.filter((x) => x.kind === "one_bad_day");
    // the cleanest single dip: most kind comments before the lowest point, and only one comment that low
    const dipScore = (x: Persona) => {
      const lows = x.timeline.filter((t) => t.sentiment <= -0.2).length;
      const at = x.timeline.reduce((b, t, i) => (t.sentiment < x.timeline[b].sentiment ? i : b), 0);
      const n = x.timeline.length;
      return (lows === 1 ? 100 : 0) + (at >= 2 && at <= n - 2 ? 50 : 0) + -x.timeline[at].sentiment * 20;
    };
    const ranked = [...bads].sort((a, b) => dipScore(b) - dipScore(a));
    const bad = ranked[0];
    const bad2 = ranked[1] ?? ranked[0];
    const com = first(r, "comedian");
    const rep = first(r, "reply_guy");
    out.push({ id: "intro", ms: ms(3200), render: () => <IntroSlide r={r} /> });
    out.push({ id: "vibe", ms: ms(4500), render: () => <VibeSlide r={r} /> });
    if (sf) out.push({ id: "superfan", ms: ms(4500), render: () => <PersonaSlide p={sf} title="The Superfan" accent={KIND_META.superfan.accent} line={`Warm in ${sf.timeline.filter((t) => t.sentiment > 0.2).length} of ${sf.timeline.length} comments.`} /> });
    if (r.mostLoyal && r.mostLoyal.totalVideos > 0) {
      const m = r.mostLoyal;
      out.push({ id: "loyal", ms: ms(6000), render: () => <MostLoyalSlide m={m} /> });
    }
    if (vil) {
      const tl = vil.timeline;
      out.push({
        id: "villain",
        ms: ms(7200),
        render: () => <ArcSlide p={vil} kind="villain_arc" title="The Villain Arc" accent={KIND_META.villain_arc.accent} stamp="VILLAIN ARC" headline={`Fan in ${fmtMonth(tl[0].t)}. Menace by ${fmtMonth(tl[tl.length - 1].t)}.`} />,
      });
    }
    if (red) {
      const tl = red.timeline;
      out.push({
        id: "redemption",
        ms: ms(7200),
        render: () => <ArcSlide p={red} kind="redemption_arc" title="The Redemption Arc" accent={KIND_META.redemption_arc.accent} stamp="REDEEMED" headline={`Hater in ${fmtMonth(tl[0].t)}. Believer by ${fmtMonth(tl[tl.length - 1].t)}.`} />,
      });
    }
    if (bad && bad.timeline.length >= 4) {
      const kind = badDayCounts(bad.timeline.map((t) => t.sentiment)).warm;
      out.push({
        id: "badday",
        ms: ms(7200),
        render: () => <ArcSlide p={bad} kind="bad_day" title="One bad day" accent={KIND_META.one_bad_day.accent} stamp="ONE BAD DAY" headline={`${kind} warm comments. One rough one.`} />,
      });
    }
    // the always-nasty comparison needs a bad-day persona the bad-day slide has NOT already used
    const alt = bad && bad.timeline.length >= 4 ? bads.find((b) => b.authorId !== bad.authorId) : bad2;
    if (hat && alt && alwaysWorthShowing(hat, alt)) out.push({ id: "always", ms: ms(5500), render: () => <AlwaysSlide hater={hat} oneOff={alt} /> });
    const cast = [
      com && { p: com, title: "The Comedian", line: `Funny in ${com.timeline.filter((t) => t.vibe === "funny").length} of ${com.timeline.length} comments.`, accent: KIND_META.comedian.accent },
      rep && { p: rep, title: "The Reply Guy", line: `Showed up on ${rep.videoCount} of ${Math.max(r.videos.length, rep.videoCount)} videos.`, accent: KIND_META.reply_guy.accent },
    ].filter(Boolean) as { p: Persona; title: string; line: string; accent: string }[];
    if (cast.length === 1) out.push({ id: "cast", ms: ms(4500), render: () => <PersonaSlide {...cast[0]} /> });
    else if (cast.length === 2) out.push({ id: "cast", ms: ms(5500), render: () => <CastSlide items={cast} /> });
    if (r.topComments.funniest[0] || r.topComments.nastiest[0]) out.push({ id: "clash", ms: ms(5000), render: () => <ClashSlide r={r} /> });
    if (r.perVideo.length && r.videos.length) out.push({ id: "heat", ms: ms(6000), render: () => <HeatSlide r={r} /> });
    out.push({ id: "cost", ms: ms(6000), render: () => <ReceiptSlide r={r} replay={replay} hasShowdown={!!showdown && showdown.readers.filter(ran).length >= 2} /> });
    if (showdown && showdown.readers.filter(ran).length >= 2) {
      const sd = showdown;
      out.push({ id: "sd-race", ms: ms(8500), render: () => <RaceSlide view={sd} /> });
      out.push({ id: "sd-cards", ms: ms(7000), render: () => <CardsSlide view={sd} /> });
      out.push({ id: "sd-agree", ms: ms(9000), render: () => <AgreementSlide view={sd} /> });
      const edge = edgeOf(sd);
      if (edge) out.push({ id: "sd-edge", ms: ms(EDGE_FIRST_MS + edge.examples.length * EDGE_STEP_MS + 900), render: () => <EdgeSlide view={sd} /> });
      pickDisagreements(sd.disagreements, 4).forEach((d, i) => out.push({ id: `sd-dis-${d.id}`, ms: ms(7500), render: () => <DisagreeSlide view={sd} d={d} index={i} /> }));
      out.push({ id: "sd-verdict", ms: ms(9500), render: () => <VerdictSlide view={sd} /> });
    }
    return out;
  }, [result, pace, replay, showdown]);

  const next = useCallback(() => {
    setIdx((i) => {
      if (i >= slides.length - 1) {
        queueMicrotask(onFinish);
        return i;
      }
      return i + 1;
    });
  }, [slides.length, onFinish]);
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "Escape") onFinish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onFinish]);

  const cur = slides[idx];

  return (
    <section
      className="story-root fixed inset-0 z-10 select-none bg-ink"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-nonav]")) return;
        down.current = performance.now();
        setPaused(true);
      }}
      onPointerUp={(e) => {
        if ((e.target as HTMLElement).closest("[data-nonav]") || !down.current) return;
        const held = performance.now() - down.current;
        down.current = 0;
        setPaused(false);
        if (held < 260) {
          const x = e.clientX / window.innerWidth;
          if (x < 0.33) prev();
          else next();
        }
      }}
      onPointerCancel={() => {
        down.current = 0;
        setPaused(false);
      }}
    >
      <motion.div key={cur.id} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.3 }}>
        {cur.render()}
      </motion.div>

      <div className="absolute inset-x-0 top-0 z-30 flex gap-1.5 px-[max(0.75rem,2vmin)] pt-[max(0.75rem,2vmin)]" data-nonav>
        {slides.map((s, i) => (
          <div key={s.id} className="h-[3px] flex-1 overflow-hidden bg-bone/20">
            <div
              key={i === idx ? `a${idx}` : `i${i}`}
              className="h-full origin-left bg-bone"
              style={
                i < idx
                  ? { transform: "scaleX(1)" }
                  : i === idx
                    ? { animation: `barfill ${s.ms}ms linear forwards`, animationPlayState: paused ? "paused" : "running" }
                    : { transform: "scaleX(0)" }
              }
              onAnimationEnd={i === idx ? next : undefined}
            />
          </div>
        ))}
      </div>

      <div className="absolute left-[max(0.75rem,2vmin)] top-[calc(max(0.75rem,2vmin)+14px)] z-30 flex items-center gap-2" data-nonav>
        <button type="button" onClick={onFinish} className="border border-bone/20 bg-ink px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-bone/85 transition-colors hover:border-bone/50">
          Skip<span className="max-sm:hidden"> to summary</span>
        </button>
        {paused && <span className="bg-bone px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">Paused</span>}
      </div>

      {result.demo && (
        <div className="pointer-events-none absolute bottom-[max(0.75rem,2vmin)] left-[max(0.75rem,2vmin)] z-30 border border-bone/20 bg-ink px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-bone/80">
          Demo mode · fictional data and people
        </div>
      )}
    </section>
  );
}
