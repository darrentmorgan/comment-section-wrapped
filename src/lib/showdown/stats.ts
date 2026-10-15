// Pure statistics for the showdown: seeded RNG, percentiles, agreement, Cohen's kappa, bootstrap CIs.
import type { ShowdownMatrix } from "../types";

/** Small seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Linear-interpolated percentile (p in 0..100). 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Label = string | undefined;

/** Share of items where both readers gave a label and the labels match. */
export function agreementRate(a: readonly Label[], b: readonly Label[]): { rate: number; n: number } {
  let n = 0;
  let same = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined || b[i] === undefined) continue;
    n++;
    if (a[i] === b[i]) same++;
  }
  return { rate: n ? same / n : 0, n };
}

/** Cohen's kappa over items both readers labelled. 0 when undefined (no items, or chance agreement is 1). */
export function cohenKappa(a: readonly Label[], b: readonly Label[]): number {
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  let n = 0;
  let same = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) continue;
    n++;
    if (x === y) same++;
    ca.set(x, (ca.get(x) ?? 0) + 1);
    cb.set(y, (cb.get(y) ?? 0) + 1);
  }
  if (n === 0) return 0;
  let pe = 0;
  for (const [k, v] of ca) pe += (v / n) * ((cb.get(k) ?? 0) / n);
  if (pe >= 1) return 0;
  return (same / n - pe) / (1 - pe);
}

/** Percentile bootstrap 95% CI of the mean of 0/1 flags. */
export function bootstrapCi(flags: readonly (boolean | number)[], rng: () => number, resamples = 1000): [number, number] {
  const n = flags.length;
  if (n === 0) return [0, 0];
  const v = flags.map((f) => (f ? 1 : 0) as number);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[Math.floor(rng() * n)];
    means.push(s / n);
  }
  return [percentile(means, 2.5), percentile(means, 97.5)];
}

/** Precision / recall / F1 of boolean predictions against boolean truth for the positive class. */
export function prf(pred: readonly boolean[], truth: readonly boolean[]): { precision: number; recall: number; f1: number; positives: number; n: number } {
  let tp = 0, fp = 0, fn = 0, positives = 0;
  const n = Math.min(pred.length, truth.length);
  for (let i = 0; i < n; i++) {
    if (truth[i]) positives++;
    if (pred[i] && truth[i]) tp++;
    else if (pred[i] && !truth[i]) fp++;
    else if (!pred[i] && truth[i]) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, positives, n };
}

/** N x N pairwise agreement, bootstrap CI and kappa. Readers are aligned by index; undefined = no answer. */
export function agreementMatrix(readers: { id: string; labels: readonly Label[] }[], rng: () => number, resamples = 1000): ShowdownMatrix {
  const k = readers.length;
  const agreement = Array.from({ length: k }, () => Array<number>(k).fill(1));
  const kappa = Array.from({ length: k }, () => Array<number>(k).fill(1));
  const ci = Array.from({ length: k }, () => Array.from({ length: k }, () => [1, 1] as [number, number]));
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const a = readers[i].labels;
      const b = readers[j].labels;
      const { rate } = agreementRate(a, b);
      const flags: boolean[] = [];
      for (let t = 0; t < Math.min(a.length, b.length); t++) if (a[t] !== undefined && b[t] !== undefined) flags.push(a[t] === b[t]);
      const interval = bootstrapCi(flags, rng, resamples);
      const kap = cohenKappa(a, b);
      agreement[i][j] = agreement[j][i] = rate;
      kappa[i][j] = kappa[j][i] = kap;
      ci[i][j] = ci[j][i] = interval;
    }
  }
  return { readerIds: readers.map((r) => r.id), agreement, ci, kappa };
}

/** Weighted mean. 0 when the weights sum to 0. */
export function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let w = 0;
  let s = 0;
  const n = Math.min(values.length, weights.length);
  for (let i = 0; i < n; i++) {
    w += weights[i];
    s += values[i] * weights[i];
  }
  return w > 0 ? s / w : 0;
}

/** Weighted percentile (p in 0..100): the smallest value whose cumulative weight reaches p%. 0 for empty / zero weight. */
export function weightedPercentile(values: readonly number[], weights: readonly number[], p: number): number {
  const idx = values.map((_, i) => i).filter((i) => (weights[i] ?? 0) > 0).sort((a, b) => values[a] - values[b]);
  const total = idx.reduce((t, i) => t + weights[i], 0);
  if (!idx.length || total <= 0) return 0;
  const target = (Math.min(100, Math.max(0, p)) / 100) * total;
  let cum = 0;
  for (const i of idx) {
    cum += weights[i];
    if (cum >= target - 1e-12) return values[i];
  }
  return values[idx[idx.length - 1]];
}

/**
 * Paired percentile-bootstrap 95% CI of (mean(a) - mean(b)) for two readers scored on the same items.
 * Valid for "is reader A really better than B on these items", which overlapping marginal CIs cannot answer.
 */
export function pairedDiffCi(a: readonly (boolean | number)[], b: readonly (boolean | number)[], rng: () => number, resamples = 1000): [number, number] {
  const n = Math.min(a.length, b.length);
  if (n === 0) return [0, 0];
  const d = Array.from({ length: n }, (_, i) => (a[i] ? 1 : 0) - (b[i] ? 1 : 0));
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rng() * n)];
    diffs.push(s / n);
  }
  return [percentile(diffs, 2.5), percentile(diffs, 97.5)];
}
