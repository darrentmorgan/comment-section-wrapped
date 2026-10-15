// View model and pure helpers for the Showdown screens. Kept separate from the server summary shape so the UI
// does not depend on it: `toShowdownView` is the one adapter. Every number shown comes from a measured field.
import type { ShowdownCodeMiss, ShowdownDisagreement, ShowdownReaderKind, ShowdownSummary, Vibe } from "@/lib/types";

export type ReaderKind = "decision" | "llm" | "baseline" | "referee";

export interface Interval {
  value: number; // 0..1
  lo?: number;
  hi?: number;
}

export interface ShowdownReader {
  id: string;
  label: string;
  /** short name for grid headers */
  short: string;
  kind: ReaderKind;
  /** false = lane was not run (no key, skipped) */
  enabled: boolean;
  /** shown on a lane that did not run, e.g. "waiting for a key" */
  note?: string;
  /** "batch" = 50 comments per request, vibe only, the app's own prompt: a different question set, never ranked against the rest */
  mode: "per-comment" | "batch";
  costPer1k?: number; // USD per 1,000 comments, weighted to the channel's natural mix
  costSource?: "api" | "computed";
  /** under load, `inFlight` requests at once. For batch readers this is per 50-comment request. */
  p50Ms?: number;
  p95Ms?: number;
  /** one request at a time (the fair latency comparison); absent for batch and baselines */
  serialP50Ms?: number;
  serialP95Ms?: number;
  /** requests in flight during the race */
  inFlight?: number;
  okCount?: number;
  failedCount?: number;
  throughput?: number; // comments per second
  failureRate?: number; // 0..1
  /** wall-clock seconds this reader took on the sample in the real run */
  wallSec?: number;
  totalCostUsd?: number;
  /** projected USD to read every de-duplicated comment on the channel (`poolSize`) */
  projectedAllUsd?: number;
  /** agreement with the referee model (not accuracy) */
  vsReferee?: Interval;
  /** mean confidence when it agreed vs disagreed with the referee, decision models only */
  confRight?: number;
  confWrong?: number;
}

export interface DisagreementView {
  id: string;
  text: string;
  answers: { readerId: string; vibe: Vibe }[];
  referee?: Vibe;
  /** one line on why this is here, e.g. "multilingual" */
  tag?: string;
  /** server's judgement that a viewer can tell why this is contested (long enough, Latin script) */
  readable?: boolean;
}

/** A comment the keyword rules got wrong and most models got right (vs the referee). */
export interface CodeMissView {
  id: string;
  text: string;
  rules: Vibe;
  referee: Vibe;
  right: number;
  of: number;
}

export interface ShowdownView {
  /** true for fixtures and mock streams: always labelled on screen */
  simulated: boolean;
  /** comments in the sample */
  sampleSize: number;
  /** size of the referee subset, if any */
  refereeN?: number;
  refereeLabel?: string;
  readers: ShowdownReader[];
  /** pairwise matrix over enabled non-referee readers, ids in matrix order */
  matrix?: { ids: string[]; agreement: number[][]; kappa: number[][] };
  disagreements: DisagreementView[];
  /** where plain code loses: rules wrong, models right. Empty for older runs. */
  codeMisses: CodeMissView[];
  totalCostUsd: number;
  /** de-duplicated comments the whole-channel projection is based on */
  poolSize?: number;
  /** honest caveats from the server summary, shown on the verdict and the dashboard */
  caveats: string[];
  /** how many comments split the model readers, and how many were compared at all */
  split?: { compared: number; split: number };
}

export const READER_COLORS = ["#7fa88a", "#7e98b0", "#a98fb0", "#d08a52", "#b87a86", "#c9a049", "#6aa6a0", "#9aa56a", "#b08f78", "#8a86b5"];
/** Known readers keep one hue each (the ScaleDown family shares a hue, batch a darker shade). Others take the next free hue. */
const FIXED_COLORS: Record<string, string> = { scaledown: "#7fa88a", "scaledown-batch": "#5a8068", jev: "#7e98b0", haiku: "#a98fb0", gemma: "#6aa6a0", luna: "#b87a86" };
const BASELINE = "#8a8273";
const REFEREE = "#efe8da";

/** Stable colour per reader: model readers keep a distinct hue each; baselines grey, referee bone. */
export function readerColor(view: ShowdownView, id: string): string {
  const r = view.readers.find((x) => x.id === id);
  if (!r) return BASELINE;
  if (r.kind === "baseline") return BASELINE;
  if (r.kind === "referee") return REFEREE;
  if (FIXED_COLORS[id]) return FIXED_COLORS[id];
  const used = new Set(Object.values(FIXED_COLORS));
  const free = READER_COLORS.filter((c) => !used.has(c));
  const others = view.readers.filter((x) => (x.kind === "decision" || x.kind === "llm") && !FIXED_COLORS[x.id]);
  return free[Math.max(0, others.findIndex((x) => x.id === id)) % free.length];
}

export const ran = (r: ShowdownReader) => r.enabled && r.kind !== "referee";

/** Number of distinct answers across readers, the primary rank for a funny disagreement. */
export function distinctAnswers(d: DisagreementView): number {
  return new Set(d.answers.map((a) => a.vibe)).size;
}

/** Cheap local check so the client never imports server code: mostly Latin letters and a few words. */
export function isWatchable(text: string): boolean {
  const t = text.trim();
  const letters = t.match(/\p{L}/gu) ?? [];
  const latin = t.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return t.length >= 20 && t.split(/\s+/).length >= 3 && letters.length > 0 && latin / letters.length >= 0.5;
}

/**
 * The most contested comments a viewer can actually read: mostly Latin, a few words, ideally with a referee verdict.
 * Most distinct answers first; at most `n`. Ties keep the incoming order (the server ranks by spread, readability and camera-safety).
 */
export function pickDisagreements(list: DisagreementView[], n = 4): DisagreementView[] {
  return list
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.answers.length >= 2 && distinctAnswers(d) >= 2 && d.text.trim().length > 0 && d.readable !== false && isWatchable(d.text))
    .sort((a, b) => distinctAnswers(b.d) - distinctAnswers(a.d) || Number(!!b.d.referee) - Number(!!a.d.referee) || a.i - b.i)
    .slice(0, n)
    .map(({ d }) => d);
}

/**
 * Code vs models: the keyword-rules reader, the always-guess baseline, the per-comment model closest to the referee,
 * and up to 3 readable comments the rules got wrong and the models got right. Null when any piece is missing.
 */
export function edgeOf(view: ShowdownView): { rules: ShowdownReader; guess?: ShowdownReader; best: ShowdownReader; examples: CodeMissView[] } | null {
  const base = view.readers.filter((r) => ran(r) && r.kind === "baseline" && r.vsReferee);
  const rules = base.find((r) => r.id === "rules" || /keyword|rules/i.test(r.label));
  const guess = base.find((r) => r !== rules);
  const best = view.readers
    .filter((r) => ran(r) && (r.kind === "decision" || r.kind === "llm") && r.mode === "per-comment" && r.vsReferee)
    .sort((a, b) => b.vsReferee!.value - a.vsReferee!.value)[0];
  const examples = (view.codeMisses ?? []).filter((m) => isWatchable(m.text)).slice(0, 3);
  if (!rules || !best || !examples.length) return null;
  return { rules, guess, best, examples };
}

/** "3 of 6 said funny": the most common answer and how many gave it. */
export function tally(answers: { vibe: Vibe }[]): { vibe: Vibe; count: number; of: number } | null {
  if (!answers.length) return null;
  const c = new Map<Vibe, number>();
  for (const a of answers) c.set(a.vibe, (c.get(a.vibe) ?? 0) + 1);
  const [vibe, count] = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
  return { vibe, count, of: answers.length };
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
export const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
/** Lane wall time: "30.1 s" under a minute, "1m 33s" above, so close lanes stay comparable. */
export function fmtWall(sec: number): string {
  if (sec < 0.05) return "instant";
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const r = Math.round(sec);
  return `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, "0")}s`;
}
export function fmtCost1k(r: ShowdownReader): string {
  if (r.costPer1k === undefined) return "n/a";
  if (r.costPer1k === 0) return "free";
  return `$${r.costPer1k < 1 ? r.costPer1k.toFixed(3) : r.costPer1k.toFixed(2)}`;
}

/**
 * Race timing. Each lane's real wall time sets how long its bar takes, with the slowest lane stretched to `raceMs`.
 * Readers with no wall time (baselines) finish almost at once. Returns 0..1 progress for each reader at `elapsedMs`.
 */
export function laneProgress(view: ShowdownView, elapsedMs: number, raceMs: number): Record<string, number> {
  const walls = view.readers.filter((r) => r.enabled).map((r) => r.wallSec ?? 0);
  const maxWall = Math.max(...walls, 0.001);
  const out: Record<string, number> = {};
  for (const r of view.readers) {
    if (!r.enabled) {
      out[r.id] = 0;
      continue;
    }
    const dur = Math.max(0.04, (r.wallSec ?? 0) / maxWall) * raceMs;
    out[r.id] = Math.min(1, elapsedMs / dur);
  }
  return out;
}

/** Per-comment readers ranked by when they finish the sample (batch mode is a different job and gets no place). 1 = first. */
export function finishOrder(view: ShowdownView): Record<string, number> {
  const racers = view.readers.filter((r) => r.enabled && r.kind !== "baseline" && r.kind !== "referee" && r.mode === "per-comment" && r.wallSec !== undefined).sort((a, b) => a.wallSec! - b.wallSec!);
  return Object.fromEntries(racers.map((r, i) => [r.id, i + 1] as const));
}

export interface VerdictLine {
  text: string;
}
export interface VerdictTile {
  label: string;
  reader: string;
  big: string;
  sub: string;
}

const overlaps = (a: Interval, b: Interval) => {
  const alo = a.lo ?? a.value;
  const ahi = a.hi ?? a.value;
  const blo = b.lo ?? b.value;
  const bhi = b.hi ?? b.value;
  return alo <= bhi && blo <= ahi;
};

/** Readers that answered the same questions, so they may be ranked against each other. */
const comparable = (view: ShowdownView) => view.readers.filter((r) => ran(r) && r.kind !== "baseline" && r.mode === "per-comment");

/**
 * "What I learned" lines and three stat tiles, written only from measured fields. Only per-comment readers (identical
 * questions) are ranked; batch mode is mentioned but never named cheapest or fastest. No winner is named unless the gap is
 * lopsided: cost or speed at least 3x apart, or agreement intervals that do not overlap.
 */
export function verdict(view: ShowdownView): { headline: string; lines: VerdictLine[]; tiles: VerdictTile[]; lopsided: boolean } {
  const lines: VerdictLine[] = [];
  const tiles: VerdictTile[] = [];
  let lopsided = false;
  const models = comparable(view);

  const priced = models.filter((r) => r.costPer1k !== undefined && r.costPer1k > 0).sort((a, b) => a.costPer1k! - b.costPer1k!);
  if (priced.length >= 2) {
    const ratio = priced[priced.length - 1].costPer1k! / priced[0].costPer1k!;
    tiles.push({ label: "Cheapest", reader: priced[0].label, big: fmtCost1k(priced[0]), sub: "per 1,000 comments" });
    if (ratio >= 3) {
      lopsided = true;
      lines.push({ text: `${priced[0].label} was the cheapest at ${fmtCost1k(priced[0])} per 1,000 comments. ${priced[priced.length - 1].label} cost ${Math.round(ratio)}x that.` });
    } else {
      lines.push({ text: `Costs landed within ${ratio.toFixed(1)}x of each other, from ${fmtCost1k(priced[0])} to ${fmtCost1k(priced[priced.length - 1])} per 1,000.` });
    }
  }

  // Latency is ranked one request at a time when every reader has it; otherwise the loaded median, and the line says so.
  const serial = models.length >= 2 && models.every((r) => r.serialP50Ms !== undefined);
  const speed = (r: ShowdownReader) => (serial ? r.serialP50Ms : r.p50Ms);
  const timed = models.filter((r) => speed(r) !== undefined).sort((a, b) => speed(a)! - speed(b)!);
  if (timed.length >= 2) {
    const ratio = speed(timed[timed.length - 1])! / speed(timed[0])!;
    const how = serial ? "asked one at a time" : "under load";
    tiles.push({ label: serial ? "Fastest alone" : "Fastest under load", reader: timed[0].label, big: fmtMs(speed(timed[0])!), sub: "median response" });
    if (ratio >= 3) {
      lopsided = true;
      lines.push({ text: `${timed[0].label} answered fastest ${how}: median ${fmtMs(speed(timed[0])!)}, against ${fmtMs(speed(timed[timed.length - 1])!)} for ${timed[timed.length - 1].label}.` });
    } else {
      lines.push({ text: `Median response times ${how} were all between ${fmtMs(speed(timed[0])!)} and ${fmtMs(speed(timed[timed.length - 1])!)}.` });
    }
  }

  const agreeing = models.filter((r) => r.vsReferee).sort((a, b) => b.vsReferee!.value - a.vsReferee!.value);
  const refName = view.refereeLabel ?? "the referee model";
  if (agreeing.length >= 2) {
    const top = agreeing[0];
    tiles.push({ label: "Closest to the referee", reader: top.label, big: fmtPct(top.vsReferee!.value), sub: "agreement, not accuracy" });
    const tied = agreeing.filter((r) => overlaps(r.vsReferee!, top.vsReferee!));
    if (tied.length === agreeing.length) {
      lines.push({ text: `Nobody separated from the pack: every reader agreed with ${refName} between ${fmtPct(agreeing[agreeing.length - 1].vsReferee!.value)} and ${fmtPct(top.vsReferee!.value)}, and those ranges overlap.` });
    } else if (tied.length === 1) {
      lopsided = true;
      lines.push({ text: `${top.label} agreed with ${refName} most, ${fmtPct(top.vsReferee!.value)}, clear of the others.` });
    } else {
      const who = tied.length <= 2 ? tied.map((r) => r.label).join(" and ") : `${top.label} and ${tied.length - 1} others`;
      lines.push({ text: `${who} agreed with ${refName} most, ${fmtPct(top.vsReferee!.value)} at the top, with overlapping ranges.` });
    }
    const base = view.readers.find((r) => r.kind === "baseline" && r.enabled && r.vsReferee);
    if (base?.vsReferee) lines.push({ text: `For scale, "${base.label}" agreed ${fmtPct(base.vsReferee.value)} of the time. The best model reached ${fmtPct(top.vsReferee!.value)}.` });
  } else if (agreeing.length === 1) {
    lines.push({ text: `${agreeing[0].label} agreed with ${refName} ${fmtPct(agreeing[0].vsReferee!.value)} of the time.` });
  }

  if (view.matrix) {
    const { ids, agreement } = view.matrix;
    let lo = { v: 2, a: "", b: "" };
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (agreement[i][j] < lo.v) lo = { v: agreement[i][j], a: ids[i], b: ids[j] };
    const name = (id: string) => view.readers.find((r) => r.id === id)?.label ?? id;
    if (lo.a) lines.push({ text: `The pair that disagreed most: ${name(lo.a)} and ${name(lo.b)}, ${fmtPct(lo.v)} the same.` });
  }

  const cheap = priced[0];
  const closest = agreeing[0];
  const headline = !lopsided || tiles.length < 2 ? "No runaway winner." : cheap && closest && cheap.id !== closest.id ? "The cheapest was not the closest." : "One reader led on more than one count.";
  return { headline, lines, tiles, lopsided };
}

/* ---- adapter from the API summary ---- */

const KIND: Record<ShowdownReaderKind, ReaderKind> = { decisions: "decision", batch: "decision", llm: "llm", baseline: "baseline", saved: "baseline", referee: "referee" };

/**
 * Accepts the body of GET /api/runs/[id]/showdown ({summary, disagreements}).
 * Returns null when there is nothing to show, so the story simply ends without those slides.
 * Disagreements the server marked not camera-safe are dropped here.
 */
export function toShowdownView(body: { summary?: ShowdownSummary; disagreements?: ShowdownDisagreement[]; codeMisses?: ShowdownCodeMiss[]; simulated?: boolean } | null | undefined): ShowdownView | null {
  const s = body?.summary;
  if (!s || !Array.isArray(s.readers) || !s.readers.length) return null;
  const refIds = new Set(s.refereeIds ?? []);
  // "saved" is the original batch labels the sample was drawn from. It is a reference, not a contestant, so it never appears as a lane.
  const readers: ShowdownReader[] = s.readers
    .filter((r) => r.kind !== "saved")
    .map((r) => {
      const st = s.stats?.[r.id];
      const kind = refIds.has(r.id) ? "referee" : KIND[r.kind] ?? "llm";
      const ok = r.enabled && r.status !== "skipped" && r.status !== "failed" && (kind === "referee" || !!st);
      const short = r.label.replace(/^(Claude|ScaleDown) /, "").replace(/^Referee: /, "");
      const mode = r.mode ?? (r.kind === "batch" ? "batch" : "per-comment");
      return {
        id: r.id,
        label: r.label,
        short,
        kind,
        mode,
        enabled: ok,
        note: r.note,
        costPer1k: st?.costPer1k,
        costSource: st?.costSource === "computed" ? "computed" : st?.costSource === "api" ? "api" : undefined,
        p50Ms: st && st.p50Ms > 0 ? st.p50Ms : undefined,
        p95Ms: st ? (st.p95AllMs ?? st.p95Ms) > 0 ? (st.p95AllMs ?? st.p95Ms) : undefined : undefined,
        serialP50Ms: st?.serialP50Ms && st.serialP50Ms > 0 ? st.serialP50Ms : undefined,
        serialP95Ms: st?.serialP95Ms && st.serialP95Ms > 0 ? st.serialP95Ms : undefined,
        inFlight: st?.concurrency?.final,
        okCount: st?.ok,
        failedCount: st?.failed,
        throughput: st && st.throughputPerSec > 0 ? st.throughputPerSec : undefined,
        failureRate: st?.failureRate,
        wallSec: st ? st.wallMs / 1000 : undefined,
        totalCostUsd: st?.costUsd,
        projectedAllUsd: st?.projectedCostAll ?? undefined,
        vsReferee: st?.agreementWithReferee ? { value: st.agreementWithReferee.rate, lo: st.agreementWithReferee.lo, hi: st.agreementWithReferee.hi } : undefined,
        confRight: st?.meanConfidenceRight,
        confWrong: st?.meanConfidenceWrong,
      } satisfies ShowdownReader;
    });
  // The primary referee is the one agreement is scored against: it has no agreement-with-referee of its own.
  const refs = readers.filter((r) => r.kind === "referee" && r.enabled);
  const referee = refs.find((r) => s.stats?.[r.id] && !s.stats[r.id].agreementWithReferee) ?? refs[0];
  const known = new Set(readers.map((r) => r.id));
  const disagreements: DisagreementView[] = (body?.disagreements ?? [])
    .filter((d) => d.cameraSafe !== false)
    .map((d) => ({ id: d.commentId, text: d.text, answers: d.answers.filter((a) => known.has(a.readerId)).map((a) => ({ readerId: a.readerId, vibe: a.vibe })), referee: d.referee?.vibe, tag: undefined, readable: d.readable }));
  const ids = (s.matrix?.readerIds ?? []).map((id, i) => ({ id, i })).filter(({ id }) => known.has(id));
  return {
    simulated: s.simulated === true || body?.simulated === true,
    sampleSize: s.sampleSize,
    refereeN: s.refereeSize || undefined,
    refereeLabel: referee ? `the referee (${referee.label.replace(/^Referee: /, "").replace(/ \(referee\)$/, "")})` : undefined,
    readers,
    matrix: ids.length >= 2 ? { ids: ids.map((x) => x.id), agreement: ids.map((r) => ids.map((c) => s.matrix.agreement[r.i][c.i])), kappa: ids.map((r) => ids.map((c) => s.matrix.kappa[r.i][c.i])) } : undefined,
    disagreements,
    codeMisses: (body?.codeMisses ?? []).filter((m) => m.cameraSafe).map((m) => ({ id: m.commentId, text: m.text, rules: m.rules, referee: m.referee, right: m.right, of: m.of })),
    totalCostUsd: s.totalCostUsd,
    poolSize: s.poolSize,
    caveats: Array.isArray(s.caveats) ? s.caveats : [],
    split: s.disagreementCounts ? { compared: s.disagreementCounts.compared, split: s.disagreementCounts.split } : undefined,
  };
}
