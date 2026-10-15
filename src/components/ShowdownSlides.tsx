"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Vibe } from "@/lib/types";
import { EASE, Shell, Title } from "./storyKit";
import { fmtInt, fmtMoney } from "./format";
import { CommentText } from "./mask";
import { usePhone } from "./usePortrait";
import { VIBE_META } from "./vibes";
import {
  type CodeMissView,
  type DisagreementView,
  type ShowdownReader,
  type ShowdownView,
  edgeOf,
  finishOrder,
  fmtCost1k,
  fmtMs,
  fmtPct,
  laneProgress,
  ran,
  readerColor,
  tally,
  verdict,
} from "./showdown";

const ACCENT = "#7e98b0";
export const RACE_MS = 6000;

export function SimBadge({ view }: { view: ShowdownView }) {
  if (!view.simulated) return null;
  return <span className="kicker w-fit border border-critical/70 px-3 py-1 !text-critical">SIMULATED, placeholder numbers</span>;
}

/** Elapsed ms from mount up to `max`; jumps to the end for reduced motion. */
function useClock(max: number): number {
  const reduced = useReducedMotion();
  const [t, setT] = useState(0);
  useEffect(() => {
    if (reduced) {
      setT(max);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const e = Math.min(max, performance.now() - t0);
      setT(e);
      if (e < max) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [max, reduced]);
  return t;
}

function readerCount(view: ShowdownView) {
  return view.readers.filter((r) => ran(r) && r.kind !== "baseline").length;
}

/* ---- 1. the race ---- */

const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const MODE_TAG = "batch of 50, vibe only";

function ModeTag({ r }: { r: ShowdownReader }) {
  if (r.mode !== "batch") return null;
  // on a phone the full tag wraps to its own line; the footnote spells out what batch means
  return <span className="sd-small shrink-0 border border-bone/25 px-2 py-px uppercase tracking-[0.1em] text-[0.8em] text-mute"><span className="sm:hidden">batch</span><span className="max-sm:hidden">{MODE_TAG}</span></span>;
}

/** requests in flight during the race, taken from the per-comment lanes (they share one setting). */
function inFlightOf(view: ShowdownView): number | undefined {
  return view.readers.find((r) => r.enabled && r.mode === "per-comment" && r.kind !== "baseline" && r.inFlight)?.inFlight;
}

export function RaceSlide({ view }: { view: ShowdownView }) {
  const t = useClock(RACE_MS + 400);
  const prog = laneProgress(view, t, RACE_MS);
  const order = finishOrder(view);
  const models = view.readers.filter((r) => r.enabled && (r.kind === "decision" || r.kind === "llm"));
  const dummies = view.readers.filter((r) => r.enabled && r.kind === "baseline");
  const notRun = view.readers.filter((r) => r.kind !== "referee" && !r.enabled);
  const n = readerCount(view);
  const noun = n >= 2 ? `${n} AI readers` : "some other readers";
  const first = models.find((r) => order[r.id] === 1 && (prog[r.id] ?? 0) >= 1);
  const flight = inFlightOf(view);
  return (
    <Shell accent={ACCENT}>
      <div className="flex flex-col gap-3">
        <div className="[&_h2]:!text-[calc(var(--kt)*clamp(1.8rem,5.6vmin,4.6rem))]">
          <Title size="big">Then I made {noun} argue about {fmtInt(view.sampleSize)} of them.</Title>
        </div>
        <SimBadge view={view} />
      </div>
      <div className="flex flex-1 flex-col justify-evenly gap-[2dvh]">
        <ul className="flex flex-col gap-[1dvh]" aria-label="Readers racing through the same comments">
          {models.map((r) => (
            <Lane key={r.id} r={r} view={view} p={prog[r.id] ?? 0} place={order[r.id]} />
          ))}
        </ul>
        {/* the agreement slide shows the baselines again, so a phone drops them here to fit the lanes */}
        {dummies.length > 0 && (
          <div className="flex flex-col gap-1 border-y border-bone/15 py-2.5 max-sm:hidden">
            <p className="kicker">Free baselines, no model: done before the race starts</p>
            <p className="st-meta text-bone/70">{dummies.map((r) => r.label).join(" · ")}</p>
          </div>
        )}
        <p className="st-sub min-h-[1.4em] font-serif font-medium" style={{ color: first ? readerColor(view, first.id) : "transparent" }} aria-live="polite">
          {first ? `${first.label} finished first.` : "."}
        </p>
      </div>
      <p className="sd-small text-bone/60">
        Same comments, same two questions for every per-comment reader{flight ? `, ${flight} requests at a time each` : ""}. The batch lane is a different job (50 comments per request, vibe only) and gets no place. A sped-up replay of the measured run.
        {notRun.length > 0 && ` Not run: ${notRun.map((r) => r.label).join(", ")}${notRun.some((r) => r.note) ? ` (${notRun.find((r) => r.note)?.note})` : ""}.`}
      </p>
    </Shell>
  );
}

function Lane({ r, view, p, place }: { r: ShowdownReader; view: ShowdownView; p: number; place?: number }) {
  const color = readerColor(view, r.id);
  const done = Math.round(p * view.sampleSize);
  const cost = (r.totalCostUsd ?? (r.costPer1k ?? 0) * (view.sampleSize / 1000)) * p;
  const finished = p >= 1;
  // the footnote already says how many requests were in flight, so a phone lane keeps to one line
  const phone = usePhone();
  return (
    <li className="flex flex-col gap-1">
      <div className="sd-lane flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="h-2.5 w-2.5 shrink-0" style={{ background: color }} />
        <span className="min-w-0 font-semibold leading-tight">{r.label}</span>
        <ModeTag r={r} />
        {finished && place !== undefined && (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }} className="num ml-auto px-2 py-px text-[0.8em] font-semibold uppercase tracking-[0.08em] text-ink" style={{ background: color }}>
            {ORD[place] ?? `${place}th`}
          </motion.span>
        )}
      </div>
      <div className="h-[clamp(8px,1.5vmin,14px)] overflow-hidden bg-bone/10">
        <div className="h-full" style={{ width: `${p * 100}%`, background: color }} />
      </div>
      <p className="num sd-small leading-none text-bone/75">
        {fmtInt(done)} read · {fmtMoney(cost, 4)}
        {finished && r.p50Ms !== undefined && <> · median {fmtMs(r.p50Ms)}{r.mode === "batch" ? (phone ? " per request" : " per 50-comment request") : phone ? "" : ` with ${r.inFlight ?? "several"} at once`}</>}
      </p>
    </li>
  );
}

/* ---- 2. cost and speed ---- */

/** Median shown for ranking: one request at a time when measured, else the loaded one. */
const aloneMs = (r: ShowdownReader) => r.serialP50Ms;

export function CardsSlide({ view }: { view: ShowdownView }) {
  const shown = view.readers.filter((r) => ran(r) && r.kind !== "baseline");
  const skipped = view.readers.filter((r) => !r.enabled && r.kind !== "referee").map((r) => r.label);
  const anyComputed = shown.some((r) => r.costSource === "computed");
  const anyApi = shown.some((r) => r.costSource === "api");
  const rankable = shown.filter((r) => r.mode === "per-comment");
  const cheapest = [...rankable].filter((r) => r.costPer1k !== undefined && r.costPer1k > 0).sort((a, b) => a.costPer1k! - b.costPer1k!)[0]?.id;
  const serialAll = rankable.length > 1 && rankable.every((r) => aloneMs(r) !== undefined);
  const fastest = [...rankable].filter((r) => (serialAll ? aloneMs(r) : r.p50Ms) !== undefined).sort((a, b) => (serialAll ? aloneMs(a)! - aloneMs(b)! : a.p50Ms! - b.p50Ms!))[0]?.id;
  const anyFailed = shown.some((r) => (r.failureRate ?? 0) > 0);
  const flight = inFlightOf(view);
  const phone = usePhone();
  return (
    <Shell accent="#7fa88a">
      <div className="flex flex-col gap-3">
        <Title size="big">What each one cost, and how long it took</Title>
        <SimBadge view={view} />
      </div>
      {phone ? (
        <PhoneCostList view={view} shown={shown} cheapest={cheapest} fastest={fastest} serialAll={serialAll} />
      ) : (
      <div className="sd-grid flex-1 content-evenly">
        {shown.map((r, i) => {
          const batch = r.mode === "batch";
          return (
            <motion.article
              key={r.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + i * 0.1, duration: 0.7, ease: EASE }}
              className="flex min-w-0 flex-col gap-2 border-t-2 pt-[clamp(0.6rem,1.4vmin,1rem)]"
              style={{ borderColor: readerColor(view, r.id) }}
            >
              <p className="st-meta flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                <span className="h-2.5 w-2.5 shrink-0" style={{ background: readerColor(view, r.id) }} />
                <span className="min-w-0 leading-tight">{r.label}</span>
                <ModeTag r={r} />
              </p>
              <div>
                <div className="display sd-card-num tabular-nums leading-none" style={r.id === cheapest ? { color: "#7fa88a" } : undefined}>{fmtCost1k(r)}</div>
                <div className="sd-small text-mute">per 1,000 comments{r.id === cheapest && " · cheapest"}</div>
              </div>
              <dl className="sd-small grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-bone/85">
                {batch ? (
                  <>
                    <dt className="text-mute">median per 50-comment request</dt>
                    <dd className="num whitespace-nowrap text-right">{r.p50Ms !== undefined ? fmtMs(r.p50Ms) : "n/a"}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-mute">median, one at a time</dt>
                    <dd className="num whitespace-nowrap text-right" style={r.id === fastest ? { color: "#7e98b0", fontWeight: 700 } : undefined}>{r.serialP50Ms !== undefined ? fmtMs(r.serialP50Ms) : "n/a"}</dd>
                    <dt className="text-mute">median under load</dt>
                    <dd className="num whitespace-nowrap text-right">{r.p50Ms !== undefined ? fmtMs(r.p50Ms) : "n/a"}</dd>
                  </>
                )}
                <dt className="text-mute">slowest 5%{batch ? " of requests" : " under load"}</dt>
                <dd className="num whitespace-nowrap text-right">{r.p95Ms !== undefined ? fmtMs(r.p95Ms) : "n/a"}</dd>
                <dt className="text-mute">throughput</dt>
                <dd className="num whitespace-nowrap text-right">{r.throughput !== undefined ? `${r.throughput.toFixed(1)}/s` : "n/a"}</dd>
              </dl>
              {(r.id === cheapest || r.id === fastest) && (
                <p className="sd-small font-semibold uppercase tracking-[0.1em]" style={{ color: r.id === fastest ? "#7e98b0" : "#7fa88a" }}>
                  {[r.id === cheapest && "Cheapest", r.id === fastest && (serialAll ? "Fastest alone" : "Fastest under load")].filter(Boolean).join(" · ")}
                </p>
              )}
            </motion.article>
          );
        })}
      </div>
      )}
      {/* the phone list carries its own one-line legend; the dashboard table repeats these caveats in full */}
      <p className="sd-small max-w-[78ch] text-bone/60 max-sm:hidden">
        {anyApi && "Costs as reported by each API, weighted to the channel's usual mix of comments. "}
        {anyComputed && "Where an API gave no cost, it is tokens times list price. "}
        {flight ? `Under load means ${flight} requests in flight at once for every per-comment reader; ` : "Under load means each reader's own setting; "}
        throughput comes from that run. Cost counts successful responses only.
        {anyFailed ? " Some requests failed and are counted in the slowest 5%." : " No requests failed."}
        {shown.some((r) => r.mode === "batch") && " Batch mode is a different job, so it is not ranked."}
        {skipped.length > 0 && ` Not run: ${skipped.join(", ")}.`}
      </p>
    </Shell>
  );
}

/** Seven cards do not fit a phone screen, so there each reader is one row: cost on the left, speed on the right. */
function PhoneCostList({ view, shown, cheapest, fastest, serialAll }: { view: ShowdownView; shown: ShowdownReader[]; cheapest?: string; fastest?: string; serialAll: boolean }) {
  return (
    <ul className="flex flex-col" aria-label="Cost and speed per reader">
      {shown.map((r, i) => {
        const batch = r.mode === "batch";
        const ms = batch ? r.p50Ms : serialAll ? aloneMs(r) : r.p50Ms;
        return (
          <motion.li
            key={r.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.08, duration: 0.6, ease: EASE }}
            className="flex items-center gap-3 border-t border-bone/15 py-2.5"
          >
            <span className="h-8 w-[3px] shrink-0" style={{ background: readerColor(view, r.id) }} />
            <div className="min-w-0 flex-1">
              <p className="st-meta font-semibold leading-tight">{r.label}</p>
              <p className="sd-small text-mute">
                {batch ? "batch of 50, vibe only" : r.id === cheapest && r.id === fastest ? "cheapest · fastest" : r.id === cheapest ? "cheapest" : r.id === fastest ? (serialAll ? "fastest alone" : "fastest under load") : `${r.throughput !== undefined ? r.throughput.toFixed(1) : "n/a"} a second`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="display num text-[1.5rem] leading-none" style={r.id === cheapest ? { color: "#7fa88a" } : undefined}>{fmtCost1k(r)}</p>
              <p className="num sd-small text-mute" style={r.id === fastest ? { color: "#7e98b0", fontWeight: 700 } : undefined}>{ms !== undefined ? fmtMs(ms) : "n/a"}{batch ? " per request" : serialAll ? " alone" : ""}</p>
            </div>
          </motion.li>
        );
      })}
      <li className="sd-small border-t border-bone/15 pt-2 text-mute">Dollars per 1,000 comments, counting successful answers only. Time is the median {serialAll ? "with one request at a time" : "under load"}.</li>
    </ul>
  );
}

/* ---- 3. who agrees with whom ---- */

function RefereeBars({ view }: { view: ShowdownView }) {
  const rows = view.readers.filter((r) => ran(r) && r.vsReferee && r.mode === "per-comment").sort((a, b) => b.vsReferee!.value - a.vsReferee!.value);
  const ref = view.refereeLabel ?? "the referee model";
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-[1.4dvh]">
      <p className="kicker">Agreement with {ref}</p>
      <ul className="flex flex-col gap-[1.5dvh]">
        {rows.map((r, i) => {
          const v = r.vsReferee!;
          const c = readerColor(view, r.id);
          return (
            <li key={r.id} className="flex flex-col gap-1">
              <div className="st-meta flex items-baseline justify-between gap-3">
                <span className="min-w-0 font-semibold leading-tight" style={{ color: c }}>{r.label}</span>
                <span className="num shrink-0">
                  {fmtPct(v.value)}
                  {v.lo !== undefined && v.hi !== undefined && <span className="text-mute"> ({fmtPct(v.lo)} to {fmtPct(v.hi)})</span>}
                </span>
              </div>
              <div className="relative h-[clamp(10px,1.9vmin,18px)] bg-bone/10">
                <motion.div
                  className="h-full origin-left"
                  style={{ width: `${v.value * 100}%`, background: c }}
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ delay: 0.4 + i * 0.08, duration: 1, ease: EASE }}
                />
                {v.lo !== undefined && v.hi !== undefined && (
                  <span aria-hidden className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-bone" style={{ left: `${v.lo * 100}%`, width: `${(v.hi - v.lo) * 100}%` }}>
                    <span className="absolute -left-px top-1/2 h-3.5 w-[3px] -translate-y-1/2 bg-bone" />
                    <span className="absolute -right-px top-1/2 h-3.5 w-[3px] -translate-y-1/2 bg-bone" />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="sd-small text-mute">
        Line = 95% range{view.refereeN ? `, on ${fmtInt(view.refereeN)} comments the referee also read` : ""}. This is agreement, not accuracy. A reader that fails to answer counts as disagreeing. Batch mode asked different questions and is left out.
      </p>
    </div>
  );
}

function HeatGrid({ view }: { view: ShowdownView }) {
  const m = view.matrix;
  if (!m || m.ids.length < 2) return null;
  const rd = (id: string) => view.readers.find((r) => r.id === id);
  const n = m.ids.length;
  return (
    <div className="flex flex-col gap-[1.4dvh] [@media(orientation:portrait)]:hidden">
      <p className="kicker">Pair by pair</p>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `minmax(0,1.5fr) repeat(${n}, minmax(0,1fr))` }} role="table" aria-label="Pairwise agreement and kappa">
        <span />
        {m.ids.map((id) => (
          <span key={id} className="sd-small truncate text-center text-mute" title={rd(id)?.label}>{rd(id)?.short ?? id}</span>
        ))}
        {m.ids.map((row, i) => (
          <HeatRow key={row} label={rd(row)?.short ?? row} cells={m.ids.map((_, j) => ({ a: m.agreement[i][j], k: m.kappa[i][j], self: i === j }))} i={i} />
        ))}
      </div>
      <p className="sd-small text-mute">Percent of the {fmtInt(view.sampleSize)} comments where two readers gave the same vibe. Smaller number is kappa, agreement beyond chance.</p>
    </div>
  );
}

function HeatRow({ label, cells, i }: { label: string; cells: { a: number; k: number; self: boolean }[]; i: number }) {
  return (
    <>
      <span className="sd-small flex items-center truncate text-mute">{label}</span>
      {cells.map((c, j) => (
        <motion.span
          key={j}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 + (i + j) * 0.04, duration: 0.3 }}
          className="flex aspect-[1.8] flex-col items-center justify-center"
          style={{ background: c.self ? "rgba(239,232,218,0.04)" : `color-mix(in oklab, #7fa88a ${Math.round(Math.max(0, c.a - 0.2) * 100)}%, #24211a)` }}
        >
          {c.self ? (
            <span className="sd-small text-mute">-</span>
          ) : (
            <>
              <span className="num sd-small font-semibold">{Math.round(c.a * 100)}</span>
              <span className="num text-[0.75em] sd-small text-bone/70">{c.k.toFixed(2)}</span>
            </>
          )}
        </motion.span>
      ))}
    </>
  );
}

export function AgreementSlide({ view }: { view: ShowdownView }) {
  const hasBars = view.readers.some((r) => ran(r) && r.vsReferee && r.mode === "per-comment");
  return (
    <Shell accent="#a98fb0">
      <div className="flex flex-col gap-3">
        <Title size="big">Who agreed?</Title>
        <SimBadge view={view} />
      </div>
      <div className={hasBars && view.matrix ? "st-split" : ""} style={{ ["--cols" as string]: "minmax(0,1fr) minmax(0,1.5fr)" }}>
        <RefereeBars view={view} />
        <HeatGrid view={view} />
      </div>
    </Shell>
  );
}

/* ---- 3b. could plain code do this? ---- */

export const EDGE_FIRST_MS = 2600;
export const EDGE_STEP_MS = 3800;

/** Keyword rules vs the closest model, then real comments where the rules said one thing and the models another. */
export function EdgeSlide({ view }: { view: ShowdownView }) {
  const e = edgeOf(view);
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const n = e?.examples.length ?? 0;
  useEffect(() => {
    if (reduced || n < 2) return;
    let k = 0;
    let id: ReturnType<typeof setTimeout>;
    const next = () => {
      id = setTimeout(() => {
        k = Math.min(k + 1, n - 1);
        setI(k);
        if (k < n - 1) next();
      }, k === 0 ? EDGE_FIRST_MS + EDGE_STEP_MS : EDGE_STEP_MS);
    };
    next();
    return () => clearTimeout(id);
  }, [n, reduced]);
  if (!e) return null;
  const rows = [e.guess && { r: e.guess, color: "#8a8273", note: "never reads the comment" }, { r: e.rules, color: "#d0614a", note: "keyword and regex rules, free" }, { r: e.best, color: "#7fa88a", note: fmtCost1k(e.best) + " per 1,000" }].filter(Boolean) as { r: ShowdownReader; color: string; note: string }[];
  const gap = Math.round((e.best.vsReferee!.value - e.rules.vsReferee!.value) * 100);
  return (
    <Shell accent="#7fa88a">
      <div className="flex flex-col gap-2">
        <Title size="big">Could plain code do this?</Title>
        <SimBadge view={view} />
      </div>
      <div className="st-split" style={{ ["--cols" as string]: "minmax(0,1fr) minmax(0,1.15fr)" }}>
        <div className="flex flex-col gap-[1.6dvh]">
          <p className="kicker">Agreement with {view.refereeLabel ?? "the referee model"}</p>
          <ul className="flex flex-col gap-[1.8dvh]">
            {rows.map(({ r, color, note }, k) => (
              <li key={r.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="st-meta truncate font-semibold" style={{ color }}>{r.id === e.best.id ? `${r.label} (closest model)` : r.label}</span>
                  <motion.span className="display st-sub shrink-0 !leading-[1.15]" style={{ color }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 + k * 0.35, duration: 0.3 }}>
                    {fmtPct(r.vsReferee!.value)}
                  </motion.span>
                </div>
                <div className="h-[clamp(12px,2.2vmin,22px)] bg-bone/10">
                  <motion.div className="h-full origin-left" style={{ width: `${r.vsReferee!.value * 100}%`, background: color }} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.3 + k * 0.35, duration: 1.1, ease: EASE }} />
                </div>
                <span className="sd-small text-mute">{note}</span>
              </li>
            ))}
          </ul>
          <motion.p className="st-meta font-semibold" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.9, duration: 0.7, ease: EASE }}>
            {gap > 0 ? <>The model is <span style={{ color: "#7fa88a" }}>{gap} points</span> closer. Here is where the code loses:</> : <>No gap on this sample. Code held its own.</>}
          </motion.p>
        </div>
        <div className="relative min-h-[34dvh]">
          <AnimatePresence mode="wait">
            <MissCard key={e.examples[i].id} m={e.examples[i]} first={i === 0} />
          </AnimatePresence>
        </div>
      </div>
      <p className="sd-small text-mute">
        Real comments from the sample. The referee is also a model, so this is agreement, not accuracy{view.refereeN ? `, on ${fmtInt(view.refereeN)} comments it read` : ""}.
      </p>
    </Shell>
  );
}

function MissCard({ m, first }: { m: CodeMissView; first: boolean }) {
  const d = first ? EDGE_FIRST_MS / 1000 : 0;
  const ref = VIBE_META[m.referee];
  const code = VIBE_META[m.rules];
  return (
    <motion.div
      className="flex flex-col gap-[1.6dvh]"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0, transition: { delay: d, duration: 0.7, ease: EASE } }}
      exit={{ opacity: 0, x: -8, transition: { duration: 0.35 } }}
    >
      <blockquote className="border-l-[3px] border-bone/50 py-1 pl-[clamp(1rem,2.6vmin,2rem)] font-serif font-medium leading-tight">
        <div className="st-quote">
          &ldquo;<CommentText text={m.text} max={160} />&rdquo;
        </div>
      </blockquote>
      <div className="flex flex-wrap items-center gap-3">
        <motion.span
          className="relative flex flex-col border-t-2 px-1 py-2 pr-5"
          style={{ borderColor: "#d0614a" }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: d + 0.25, duration: 0.3, ease: EASE }}
        >
          <span className="sd-small text-mute">Keyword rules</span>
          <span className="display-soft st-sub relative w-fit" style={{ color: code.color }}>
            {code.label}
            <motion.span aria-hidden className="absolute left-0 top-1/2 h-px w-full origin-left bg-[#d0614a]" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: d + 0.75, duration: 0.25 }} />
          </span>
        </motion.span>
        <motion.span aria-hidden className="st-sub text-bone/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: d + 0.9, duration: 0.25 }}>
          &rarr;
        </motion.span>
        <motion.span
          className="flex flex-col border-t-2 px-1 py-2 pr-5"
          style={{ borderColor: "#7fa88a" }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: d + 1.0, duration: 0.6, ease: EASE }}
        >
          <span className="sd-small text-mute">{m.right === m.of ? `All ${m.of} models` : `${m.right} of ${m.of} models`} + referee</span>
          <span className="display-soft st-sub" style={{ color: ref.color }}>{ref.label}</span>
        </motion.span>
      </div>
    </motion.div>
  );
}

/* ---- 4. they disagreed ---- */

const ORDINAL = ["They disagreed on this one", "And on this one", "And this one", "Last one"];
const CHIP_GAP = 0.35;

export function DisagreeSlide({ view, d, index }: { view: ShowdownView; d: DisagreementView; index: number }) {
  const answers = d.answers.filter((a) => view.readers.some((r) => r.id === a.readerId && r.enabled));
  const t = tally(answers);
  const refDelay = 0.9 + answers.length * CHIP_GAP + 0.5;
  return (
    <Shell accent={d.referee ? VIBE_META[d.referee].color : "#d08a52"}>
      <div className="flex flex-col gap-2">
        <Title size="big">{ORDINAL[Math.min(index, ORDINAL.length - 1)]}</Title>
        <div className="flex flex-wrap gap-2">
          <SimBadge view={view} />
          {d.tag && <span className="kicker border border-bone/25 px-3 py-0.5">{d.tag}</span>}
        </div>
      </div>
      <motion.blockquote
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.25, duration: 0.8, ease: EASE }}
        className="border-l-[3px] border-bone/50 py-1 pl-[clamp(1rem,2.6vmin,2rem)] font-serif font-medium leading-tight"
      >
        <div className="st-quote">
          &ldquo;<CommentText text={d.text} max={200} />&rdquo;
        </div>
      </motion.blockquote>
      <ul className="sd-grid">
        {answers.map((a, i) => (
          <Chip key={a.readerId} label={view.readers.find((r) => r.id === a.readerId)!.short} vibe={a.vibe} delay={0.9 + i * CHIP_GAP} color={readerColor(view, a.readerId)} match={d.referee ? a.vibe === d.referee : undefined} revealMatchAt={refDelay} />
        ))}
      </ul>
      {t && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 + answers.length * CHIP_GAP, duration: 0.3 }} className="st-meta font-semibold text-bone/85">
          {t.count} of {t.of} said {VIBE_META[t.vibe].label.toLowerCase()}
          {t.count === 1 ? ", and nobody agreed with anybody." : "."}
        </motion.p>
      )}
      {d.referee && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: refDelay, duration: 0.7, ease: EASE }}
          className="flex w-fit flex-col gap-0.5 border-y-2 border-bone py-2 pr-8"
        >
          <span className="kicker">The referee says</span>
          <span className="display st-sub" style={{ color: VIBE_META[d.referee].color }}>{VIBE_META[d.referee].label}</span>
        </motion.div>
      )}
      {view.split && view.split.split > 0 && (
        <p className="sd-small text-mute">
          {fmtInt(view.split.split)} of {fmtInt(view.split.compared)} comments split the models. This is one of the most split that reads well.
        </p>
      )}
    </Shell>
  );
}

function Chip({ label, vibe, delay, color, match, revealMatchAt }: { label: string; vibe: Vibe; delay: number; color: string; match?: boolean; revealMatchAt: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(!!reduced);
  useEffect(() => {
    if (match === undefined || reduced) return;
    const id = setTimeout(() => setShown(true), revealMatchAt * 1000);
    return () => clearTimeout(id);
  }, [match, reduced, revealMatchAt]);
  const verdictColor = match === undefined || !shown ? `color-mix(in oklab, ${color} 45%, transparent)` : match ? "#7fa88a" : "#d0614a";
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease: EASE }}
      className="flex min-w-0 flex-col gap-0.5 border-t-2 pb-1 pt-2 transition-colors duration-500"
      style={{ borderColor: verdictColor }}
    >
      <span className="sd-small leading-tight text-mute">{label}</span>
      <span className="display-soft st-meta" style={{ color: VIBE_META[vibe].color }}>{VIBE_META[vibe].label}</span>
    </motion.li>
  );
}

/* ---- 5. verdict ---- */

export function VerdictSlide({ view }: { view: ShowdownView }) {
  const v = verdict(view);
  const models = view.readers.filter((r) => ran(r) && r.kind !== "baseline").length;
  const dummies = view.readers.filter((r) => ran(r) && r.kind === "baseline").length;
  const extra = v.lines.filter((l) => !/^Costs landed|^Median response|^Nobody|agreed with .* most/.test(l.text)).slice(0, 1);
  const phone = usePhone();
  // a phone has room for the two most important caveats; the dashboard lists them all
  const caveats = view.caveats.filter((c) => /not accuracy|sample|Claude|anecdotal|tuned/i.test(c)).slice(0, phone ? 2 : 4);
  return (
    <Shell accent="#9a9282">
      <div className="flex flex-col gap-3">
        <Title size="big">{v.headline}</Title>
        <SimBadge view={view} />
      </div>
      {v.tiles.length > 0 && (
        <ul className="grid gap-[clamp(8px,1.6vmin,18px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
          {v.tiles.map((tile, i) => (
            <motion.li
              key={tile.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + i * 0.3, duration: 0.7, ease: EASE }}
              className={phone ? "grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 border-t border-bone/30 pt-2.5" : "flex flex-col gap-1 border-t border-bone/30 pt-[clamp(0.6rem,1.6vmin,1.2rem)]"}
            >
              <span className="kicker">{tile.label}</span>
              <span className={`display sd-card-num tabular-nums leading-none ${phone ? "col-start-2 row-span-3 row-start-1 self-center text-right" : ""}`}>{tile.big}</span>
              <span className="st-meta font-semibold leading-tight">{tile.reader}</span>
              <span className="sd-small text-mute">{tile.sub}</span>
            </motion.li>
          ))}
        </ul>
      )}
      {extra.map((l, i) => (
        <motion.p key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4, duration: 0.5 }} className="st-meta max-w-[48ch] leading-snug text-bone/90">
          {l.text}
        </motion.p>
      ))}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2, duration: 0.5 }} className="flex flex-col gap-1.5">
        <p className="sd-small max-w-[70ch] font-semibold text-bone/75">Agreement is not accuracy. Read the fine print.</p>
        <ul className="flex max-w-[70ch] flex-col gap-1">
          {caveats.map((c, i) => (
            <li key={i} className="sd-small leading-snug text-bone/55">{c}</li>
          ))}
        </ul>
      </motion.div>
      <p className="st-meta num text-mute">
        Total spent on the showdown: {fmtMoney(view.totalCostUsd, view.totalCostUsd < 0.1 ? 4 : 2)} across {models} AI readers{dummies ? `, ${dummies} free baselines` : ""} and {fmtInt(view.sampleSize)} comments.
      </p>
    </Shell>
  );
}
