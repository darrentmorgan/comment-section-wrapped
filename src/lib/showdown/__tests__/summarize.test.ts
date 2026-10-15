import { describe, expect, it } from "vitest";
import type { ShowdownReader, Vibe } from "../../types";
import { SAVED_ID, isCameraSafe, summarize } from "../summarize";
import type { ItemRecord } from "../store";

const rec = (vibe: Vibe, extra: Partial<ItemRecord> = {}): ItemRecord => ({ vibe, toxic: vibe === "toxic", ms: 100, totalMs: 100, costUsd: 0.00002, costSource: "api", attempts: 1, phase: "race", confidence: 0.7, ...extra });
const rd = (id: string, kind: ShowdownReader["kind"], enabled = true): ShowdownReader => ({ id, label: id.toUpperCase(), kind, priceNote: "", enabled });

function build() {
  const vibes: Vibe[] = ["supportive", "funny", "critical", "question", "spam", "supportive", "funny", "critical"];
  const items = vibes.map((v, i) => ({ id: `c${i}`, text: `comment ${i}`, savedVibe: v, stratum: i === 7 ? "non-latin" : "vibe:" + v }));
  const perItem: Record<string, Record<string, ItemRecord>> = {};
  items.forEach((it, i) => {
    perItem[it.id] = {
      a: rec(vibes[i], { ms: 100 + i }), // matches truth
      b: rec(i % 2 ? "supportive" : vibes[i], { ms: 300 + i, costUsd: 0.0002 }), // wrong half the time
      "referee-opus": rec(vibes[i], { phase: "referee", costUsd: 0.001 }),
      "always-supportive": rec("supportive", { costUsd: 0, costSource: "free", confidence: undefined }),
    };
  });
  return {
    runId: "r1",
    createdAt: "2026-10-14T00:00:00Z",
    seed: 1,
    totalComments: 1000,
    items,
    refereeIds: items.map((i) => i.id),
    weights: new Map(items.map((i) => [i.id, 1 / items.length] as const)),
    readers: [rd("a", "decisions"), rd("b", "llm"), rd("jev", "decisions", false), rd("always-supportive", "baseline"), rd(SAVED_ID, "saved"), rd("referee-opus", "referee")],
    perItem,
    lanes: { a: { wallMs: 2000, concurrencyStart: 24, concurrencyMax: 48, concurrencyFinal: 24 }, b: { wallMs: 4000, concurrencyStart: 12, concurrencyMax: 32, concurrencyFinal: 12 } },
  };
}

describe("summarize", () => {
  const { summary, disagreements } = summarize(build());
  it("computes cost, latency and throughput per reader", () => {
    const a = summary.stats.a;
    expect(a.ok).toBe(8);
    expect(a.costUsd).toBeCloseTo(8 * 0.00002);
    expect(a.costPer1k).toBeCloseTo(0.02);
    expect(a.projectedCostAll).toBeCloseTo(0.02);
    expect(a.costSource).toBe("api");
    expect(a.p50Ms).toBeCloseTo(103.5);
    expect(a.throughputPerSec).toBeCloseTo(4);
    expect(summary.stats["always-supportive"].costSource).toBe("free");
  });
  it("reports agreement with the referee with a CI, and marks unrun lanes skipped", () => {
    expect(summary.stats.a.agreementWithReferee).toMatchObject({ rate: 1, n: 8 });
    const b = summary.stats.b.agreementWithReferee!;
    expect(b.rate).toBeCloseTo(0.625);
    expect(b.lo).toBeLessThanOrEqual(b.rate);
    expect(b.hi).toBeGreaterThanOrEqual(b.rate);
    expect(summary.readers.find((r) => r.id === "jev")!.status).toBe("skipped");
    expect(summary.stats.jev).toBeUndefined();
    expect(summary.stats["referee-opus"].agreementWithReferee).toBeNull();
  });
  it("builds a matrix of the per-comment readers only (no referee, no saved labels, no batch)", () => {
    expect(summary.matrix.readerIds).toEqual(["a", "b", "always-supportive"]);
    expect(summary.matrix.agreement[0][1]).toBe(summary.matrix.agreement[1][0]);
  });
  it("per-class precision and recall are vs the referee", () => {
    expect(summary.perClassVsReferee.a.funny).toMatchObject({ precision: 1, recall: 1, n: 2 });
    expect(summary.perClassVsReferee.b.supportive!.precision).toBeLessThan(1);
  });
  it("lists disagreements among model readers only, ranked, with referee pick", () => {
    expect(disagreements.length).toBeGreaterThan(0);
    for (const d of disagreements) {
      expect(d.answers.map((x) => x.readerId)).not.toContain("always-supportive");
      expect(d.distinct).toBeGreaterThanOrEqual(2);
      expect(d.referee?.readerId).toBe("referee-opus");
      expect(d.cameraSafe).toBe(true);
    }
    expect(JSON.stringify(summary)).not.toContain("comment 1"); // text lives in disagreements only
  });
  it("learned lines come from measurements, with no vendor claims", () => {
    const text = summary.learned.join(" ");
    expect(text).toMatch(/Cheapest reader: A/);
    expect(text).toMatch(/Closest to the referee \(REFEREE-OPUS\)/);
    expect(text).toMatch(/bar to beat/);
    expect(text).toMatch(/reweighted to the channel/);
    expect(text).toMatch(/JEV was not selected for this run/);
    expect(text).not.toMatch(/\d+x (cheaper|faster)|faster than|cheaper than/i);
    expect(summary.caveats.join(" ")).toMatch(/not accuracy/);
  });
  it("total cost sums every lane", () => {
    const sum = Object.values(summary.stats).reduce((t, s) => t + s.costUsd, 0);
    expect(summary.totalCostUsd).toBeCloseTo(sum);
  });
});

describe("isCameraSafe", () => {
  it("rejects toxic, profane and oversized text", () => {
    expect(isCameraSafe("lovely video", false)).toBe(true);
    expect(isCameraSafe("lovely video", true)).toBe(false);
    expect(isCameraSafe("what the fuck", false)).toBe(false);
    expect(isCameraSafe("x".repeat(300), false)).toBe(false);
  });
});

describe("codeMisses (where keyword rules lose to the models)", () => {
  const input = build();
  input.readers.push(rd("rules", "baseline"));
  for (const id of Object.keys(input.perItem)) input.perItem[id].rules = rec("supportive", { costUsd: 0, costSource: "free", confidence: undefined });
  const { summary, codeMisses } = summarize(input);
  it("keeps comments the rules got wrong and at least 3 in 4 model readers got right", () => {
    expect(codeMisses.map((m) => m.commentId).sort()).toEqual(["c2", "c4", "c6"]);
    for (const m of codeMisses) {
      expect(m.rules).toBe("supportive");
      expect(m.referee).not.toBe("supportive");
      expect(m.right).toBe(2);
      expect(m.of).toBe(2);
    }
  });
  it("keeps comment text out of the summary", () => {
    expect(JSON.stringify(summary)).not.toContain("comment 2");
  });
  it("is empty when no rules reader ran", () => {
    expect(summarize(build()).codeMisses).toEqual([]);
  });
});
