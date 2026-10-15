import { describe, expect, it } from "vitest";
import { agreementMatrix, agreementRate, bootstrapCi, cohenKappa, mulberry32, percentile, prf, shuffled } from "../stats";

describe("rng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
    const xs = [a(), a(), a()], ys = [b(), b(), b()];
    expect(xs).toEqual(ys);
    expect(c()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it("shuffles without losing items and does not mutate", () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(src, mulberry32(1));
    expect([...out].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled(src, mulberry32(1))).toEqual(out);
  });
});

describe("percentile", () => {
  it("handles empty, single and interpolated values", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([40, 10, 30, 20], 100)).toBe(40);
    expect(percentile(Array.from({ length: 101 }, (_, i) => i), 95)).toBe(95);
  });
});

describe("agreement + kappa", () => {
  it("agreement ignores items either reader lacks", () => {
    expect(agreementRate(["a", "b", undefined, "c"], ["a", "x", "c", "c"])).toEqual({ rate: 2 / 3, n: 3 });
    expect(agreementRate([], [])).toEqual({ rate: 0, n: 0 });
  });
  it("kappa is 1 for identical, 0 for chance-level, undefined-safe", () => {
    expect(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"])).toBeCloseTo(1);
    // each reader says a/b half the time, independent
    expect(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"])).toBeCloseTo(0);
    // everyone says "a": expected agreement is 1, kappa defined as 0 rather than NaN
    expect(cohenKappa(["a", "a"], ["a", "a"])).toBe(0);
    expect(cohenKappa([], [])).toBe(0);
  });
});

describe("bootstrapCi", () => {
  it("brackets the observed rate and is deterministic", () => {
    const flags = Array.from({ length: 200 }, (_, i) => i % 4 !== 0); // 75%
    const [lo, hi] = bootstrapCi(flags, mulberry32(3), 1000);
    expect(lo).toBeLessThan(0.75);
    expect(hi).toBeGreaterThan(0.75);
    expect(hi - lo).toBeLessThan(0.2);
    expect(bootstrapCi(flags, mulberry32(3), 1000)).toEqual([lo, hi]);
  });
  it("degenerates cleanly", () => {
    expect(bootstrapCi([], mulberry32(1))).toEqual([0, 0]);
    expect(bootstrapCi([true, true, true], mulberry32(1))).toEqual([1, 1]);
  });
});

describe("prf", () => {
  it("computes precision, recall and f1 for a positive class", () => {
    const pred = [true, true, false, false, true];
    const truth = [true, false, true, false, true];
    const r = prf(pred, truth);
    expect(r.precision).toBeCloseTo(2 / 3);
    expect(r.recall).toBeCloseTo(2 / 3);
    expect(r.f1).toBeCloseTo(2 / 3);
    expect(r.positives).toBe(3);
    expect(prf([false], [false])).toMatchObject({ precision: 0, recall: 0, f1: 0 });
  });
});

describe("agreementMatrix", () => {
  it("is symmetric with a unit diagonal, CI and kappa", () => {
    const readers = [
      { id: "x", labels: ["a", "b", "a", "b", "a", "a"] as (string | undefined)[] },
      { id: "y", labels: ["a", "b", "b", "b", "a", undefined] },
      { id: "z", labels: ["b", "b", "b", "a", "a", "a"] },
    ];
    const m = agreementMatrix(readers, mulberry32(5), 200);
    expect(m.readerIds).toEqual(["x", "y", "z"]);
    expect(m.agreement[0][0]).toBe(1);
    expect(m.agreement[0][1]).toBeCloseTo(0.8);
    expect(m.agreement[1][0]).toBe(m.agreement[0][1]);
    expect(m.kappa[1][0]).toBe(m.kappa[0][1]);
    expect(m.ci[0][1][0]).toBeLessThanOrEqual(0.8);
    expect(m.ci[0][1][1]).toBeGreaterThanOrEqual(0.8);
  });
});
