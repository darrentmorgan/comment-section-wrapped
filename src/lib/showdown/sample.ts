// Seeded, stratified sample of a saved run. 75% by saved vibe (rare classes oversampled), 25% label-independent
// "special" strata, so the sample is not purely shaped by the classifier that produced the saved labels.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Vibe } from "../types";
import { VIBES } from "../vibes";
import { mulberry32, shuffled } from "./stats";

export interface SampleComment {
  id: string;
  text: string;
  vibe: Vibe; // saved label (from the original batched classifier)
  topScore: number; // max saved probability
}
export interface SampleItem {
  id: string;
  text: string;
  savedVibe: Vibe;
  stratum: string;
}
export interface Sample {
  items: SampleItem[];
  refereeIds: string[];
  /** share of each vibe in the whole (deduplicated) pool, for natural-mix reweighting */
  naturalShares: Record<Vibe, number>;
  /**
   * per item weight = natural share of its saved vibe / number of VIBE-stratum items of that vibe. The special strata
   * (long, non-Latin, emoji, short, low-confidence) are drawn from skewed subpopulations, so they get weight 0 and never
   * stand in for the channel's natural mix. Weights depend on the original batch labels, so a natural-mix figure is approximate.
   */
  weights: Map<string, number>;
  poolSize: number;
}

/** Quotas at size 1000. Other sizes scale proportionally (min 1). */
export const VIBE_QUOTA: Record<Vibe, number> = { toxic: 100, critical: 130, funny: 150, question: 130, spam: 110, supportive: 130 };
export const SPECIAL_QUOTA = 50;
export const SPECIALS = ["long", "non-latin", "emoji", "low-confidence", "short"] as const;

export const normalizeText = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

export function isNonLatin(t: string): boolean {
  const letters = t.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  const latin = t.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters.length < 0.5;
}
export function isEmojiHeavy(t: string): boolean {
  const emoji = t.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  const visible = t.replace(/\s/g, "").length;
  return emoji >= 3 && visible > 0 && emoji / visible >= 0.3;
}

const STRATUM_TEST: Record<(typeof SPECIALS)[number], (c: SampleComment) => boolean> = {
  long: (c) => c.text.length > 300,
  "non-latin": (c) => isNonLatin(c.text),
  emoji: (c) => isEmojiHeavy(c.text),
  "low-confidence": (c) => c.topScore < 0.5,
  short: (c) => c.text.trim().length >= 2 && c.text.trim().length <= 15,
};

export interface SampleOptions {
  size?: number; // default 1000
  refereeSize?: number; // default 25% of size
}

export function buildSample(comments: Iterable<SampleComment>, seed: number, opts: SampleOptions = {}): Sample {
  const size = opts.size ?? 1000;
  const factor = size / 1000;
  const quota = (q: number) => Math.max(1, Math.round(q * factor));

  // Dedup by normalised text, drop under 2 chars. First occurrence wins (file order is stable).
  const seen = new Set<string>();
  const pool: SampleComment[] = [];
  for (const c of comments) {
    const key = normalizeText(c.text ?? "");
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    pool.push(c);
  }

  const natural = Object.fromEntries(VIBES.map((v) => [v, 0])) as Record<Vibe, number>;
  for (const c of pool) natural[c.vibe]++;
  const naturalShares = Object.fromEntries(VIBES.map((v) => [v, pool.length ? natural[v] / pool.length : 0])) as Record<Vibe, number>;

  const rng = mulberry32(seed);
  const chosen = new Set<string>();
  const items: SampleItem[] = [];
  const take = (candidates: SampleComment[], n: number, stratum: string) => {
    let got = 0;
    for (const c of shuffled(candidates, rng)) {
      if (got >= n) break;
      if (chosen.has(c.id)) continue;
      chosen.add(c.id);
      items.push({ id: c.id, text: c.text, savedVibe: c.vibe, stratum });
      got++;
    }
  };
  for (const v of VIBES) take(pool.filter((c) => c.vibe === v), quota(VIBE_QUOTA[v]), `vibe:${v}`);
  for (const s of SPECIALS) take(pool.filter(STRATUM_TEST[s]), quota(SPECIAL_QUOTA), s);

  const refSize = Math.min(items.length, opts.refereeSize ?? Math.round(size * 0.25));
  const refereeIds = shuffled(items, mulberry32(seed + 1))
    .slice(0, refSize)
    .map((i) => i.id);

  const perVibe = Object.fromEntries(VIBES.map((v) => [v, 0])) as Record<Vibe, number>;
  for (const i of items) if (i.stratum.startsWith("vibe:")) perVibe[i.savedVibe]++;
  const weights = new Map<string, number>();
  for (const i of items) weights.set(i.id, i.stratum.startsWith("vibe:") && perVibe[i.savedVibe] ? naturalShares[i.savedVibe] / perVibe[i.savedVibe] : 0);

  return { items, refereeIds, naturalShares, weights, poolSize: pool.length };
}

/** Streams comments.jsonl and keeps only the fields the sampler needs (no handles). */
export async function readSampleComments(file: string): Promise<SampleComment[]> {
  const out: SampleComment[] = [];
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as { id: string; text: string; vibe: Vibe; scores?: Record<string, number> };
      const top = c.scores ? Math.max(...Object.values(c.scores).map(Number).filter(Number.isFinite), 0) : 1;
      out.push({ id: c.id, text: c.text ?? "", vibe: c.vibe, topScore: top });
    } catch {
      /* skip bad line */
    }
  }
  return out;
}
