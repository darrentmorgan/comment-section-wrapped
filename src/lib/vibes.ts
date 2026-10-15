import type { Vibe } from "./types";

export const VIBES: Vibe[] = ["toxic", "critical", "supportive", "funny", "question", "spam"];

/** ScaleDown Classify list price: USD per 1M input tokens (output is free). */
export const SCALEDOWN_USD_PER_M_INPUT = 0.05;

export function emptyByVibe(): Record<Vibe, number> {
  return { toxic: 0, critical: 0, supportive: 0, funny: 0, question: 0, spam: 0 };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * -1 (nasty) .. +1 (lovely) from calibrated vibe probabilities.
 * Supportive lifts, funny lifts a little (banter), toxic sinks, critical sinks a little.
 */
export function sentimentFromScores(s: Record<Vibe, number>): number {
  const raw = s.supportive + 0.5 * s.funny - s.toxic - 0.5 * s.critical;
  return Math.round(clamp(raw, -1, 1) * 1000) / 1000;
}

/** Coerce a partial / unnormalised score map into a full distribution summing to 1. */
export function normalizeScores(partial: Partial<Record<string, number>>): Record<Vibe, number> {
  const out = emptyByVibe();
  let sum = 0;
  for (const v of VIBES) {
    const x = Number(partial[v]);
    out[v] = Number.isFinite(x) && x > 0 ? x : 0;
    sum += out[v];
  }
  if (sum <= 0) {
    for (const v of VIBES) out[v] = 1 / VIBES.length;
    return out;
  }
  for (const v of VIBES) out[v] = out[v] / sum;
  return out;
}

export function topVibe(scores: Record<Vibe, number>): Vibe {
  let best: Vibe = "question";
  let bestScore = -1;
  for (const v of VIBES) {
    if (scores[v] > bestScore) {
      best = v;
      bestScore = scores[v];
    }
  }
  return best;
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}
