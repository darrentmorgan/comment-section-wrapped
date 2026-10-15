// Behaviour added after the review: fair latency, failures counted, stratified-sample correction, batch mode handling.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ShowdownReader, Vibe } from "../../types";
import { mulberry32, pairedDiffCi, weightedMean, weightedPercentile } from "../stats";
import { SAVED_ID, summarize, type SummaryInput } from "../summarize";
import { runShowdown } from "../runner";
import { readShowdown, type ItemRecord } from "../store";

const rec = (vibe: Vibe | undefined, extra: Partial<ItemRecord> = {}): ItemRecord => ({ vibe, toxic: false, ms: 100, totalMs: 100, costUsd: 0.00002, costSource: "api", attempts: 1, phase: "race", confidence: 0.7, ...extra });
const rd = (id: string, kind: ShowdownReader["kind"], enabled = true, note?: string): ShowdownReader => ({ id, label: id.toUpperCase(), kind, priceNote: "", enabled, note });

describe("weighted stats", () => {
  it("weighted mean and percentile follow the weights", () => {
    expect(weightedMean([1, 3], [3, 1])).toBeCloseTo(1.5);
    expect(weightedMean([1, 3], [0, 0])).toBe(0);
    expect(weightedPercentile([1, 2, 3, 4], [1, 1, 1, 100], 50)).toBe(4);
    expect(weightedPercentile([1, 2, 3, 4], [1, 1, 1, 1], 50)).toBeCloseTo(2, 0);
  });
  it("paired CI of an agreement difference excludes zero for a lopsided pair and spans zero for a tie", () => {
    const rng = mulberry32(1);
    const a = Array.from({ length: 200 }, (_, i) => i % 10 !== 0);
    const b = Array.from({ length: 200 }, (_, i) => i % 2 === 0);
    const [lo] = pairedDiffCi(a, b, rng, 500);
    expect(lo).toBeGreaterThan(0);
    const c = a.slice().reverse();
    const [l2, h2] = pairedDiffCi(a, c, rng, 500);
    expect(l2).toBeLessThanOrEqual(0);
    expect(h2).toBeGreaterThanOrEqual(0);
  });
});

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  const vibes: Vibe[] = ["supportive", "funny", "critical", "question", "spam", "supportive", "funny", "critical", "supportive", "funny"];
  const items = vibes.map((v, i) => ({ id: `c${i}`, text: `a comment number ${i} that is long enough`, savedVibe: v, stratum: i < 8 ? `vibe:${v}` : "long" }));
  const perItem: Record<string, Record<string, ItemRecord>> = {};
  items.forEach((it, i) => {
    perItem[it.id] = {
      good: rec(vibes[i], { ms: 100 }),
      flaky: i % 2 ? rec(undefined, { error: "timeout", ms: 60000 }) : rec(vibes[i], { ms: 100 }),
      "referee-opus": rec(vibes[i], { phase: "referee" }),
    };
  });
  return {
    runId: "r",
    createdAt: "x",
    seed: 1,
    totalComments: 1000,
    poolSize: 900,
    items,
    refereeIds: items.map((i) => i.id),
    weights: new Map(items.map((i, k) => [i.id, k < 8 ? 1 / 8 : 0] as const)),
    readers: [rd("good", "decisions"), rd("flaky", "llm"), rd("referee-opus", "referee"), rd(SAVED_ID, "saved")],
    perItem,
    lanes: { good: { wallMs: 1000, concurrencyStart: 16, concurrencyMax: 16, concurrencyFinal: 16 }, flaky: { wallMs: 1000, concurrencyStart: 16, concurrencyMax: 16, concurrencyFinal: 16 } },
    ...over,
  };
}

describe("agreement counts failures", () => {
  it("a reader that failed half its items cannot beat one that answered everything", () => {
    const { summary } = summarize(input());
    const flaky = summary.stats.flaky;
    expect(flaky.failed).toBe(5);
    expect(flaky.agreementWithReferee).toMatchObject({ rate: 0.5, n: 10 });
    expect(flaky.agreementAnsweredOnly).toMatchObject({ rate: 1, n: 5 });
    expect(summary.stats.good.agreementWithReferee).toMatchObject({ rate: 1, n: 10 });
  });
  it("failures count as disagreements in the pairwise matrix too", () => {
    const { summary } = summarize(input());
    const i = summary.matrix.readerIds.indexOf("good");
    const j = summary.matrix.readerIds.indexOf("flaky");
    expect(summary.matrix.agreement[i][j]).toBeCloseTo(0.5);
  });
});

describe("stratified sample correction", () => {
  it("cost per 1,000 is a natural-mix weighted mean over the vibe strata, not the plain sample mean", () => {
    const i = input();
    // make the two special-stratum items (weight 0) ten times more expensive
    i.perItem.c8.good = rec("supportive", { costUsd: 0.001 });
    i.perItem.c9.good = rec("funny", { costUsd: 0.001 });
    const { summary } = summarize(i);
    expect(summary.stats.good.costPer1k).toBeCloseTo(0.02);
    expect(summary.stats.good.costPer1kSample).toBeGreaterThan(0.1);
    expect(summary.stats.good.projectedCostAll).toBeCloseTo(0.02 * 0.9); // uses the de-duplicated pool of 900
    expect(summary.poolSize).toBe(900);
  });
  it("natural-mix agreement ignores special strata", () => {
    const i = input();
    i.perItem.c8.good = rec("spam");
    i.perItem.c9.good = rec("spam");
    const { summary } = summarize(i);
    expect(summary.stats.good.agreementWithRefereeNatural).toBeCloseTo(1);
  });
});

describe("latency ranking is fair", () => {
  it("ranks 'fastest' on the serial probe and excludes batch lanes", () => {
    const i = input({ readers: [rd("good", "decisions"), rd("flaky", "llm"), rd("bat", "batch"), rd("referee-opus", "referee")] });
    for (const it of i.items) {
      i.perItem[it.id].bat = rec(it.savedVibe, { ms: 5, batch: "b1" });
      i.perItem[it.id].flaky = rec(it.savedVibe, { ms: 400 });
    }
    // probe: good is slow when alone, fast when loaded
    i.perItem.c0.good = rec("supportive", { phase: "probe", ms: 900 });
    i.perItem.c0.flaky = rec("supportive", { phase: "probe", ms: 300 });
    i.lanes.bat = { wallMs: 1000, concurrencyStart: 8, concurrencyMax: 8, concurrencyFinal: 8 };
    const { summary } = summarize(i);
    const line = summary.learned.find((l) => /Fastest/.test(l))!;
    expect(line).toMatch(/FLAKY/);
    expect(line).not.toMatch(/BAT/);
    expect(line).toMatch(/alone/);
    expect(summary.readers.find((r) => r.id === "bat")!.mode).toBe("batch");
  });
  it("batch latency is one number per request, not per comment", () => {
    const i = input({ readers: [rd("bat", "batch"), rd("referee-opus", "referee")] });
    i.items.forEach((it, k) => {
      i.perItem[it.id] = { bat: rec(it.savedVibe, { ms: k < 5 ? 1000 : 9000, batch: k < 5 ? "b1" : "b2" }), "referee-opus": i.perItem[it.id]["referee-opus"] };
    });
    i.lanes = { bat: { wallMs: 1000, concurrencyStart: 8, concurrencyMax: 8, concurrencyFinal: 8 } };
    const { summary } = summarize(i);
    expect(summary.stats.bat.requests).toBe(2);
    expect(summary.stats.bat.p50Ms).toBeCloseTo(5000);
  });
});

describe("failed requests are not hidden from latency", () => {
  it("p95 including failures reflects the time spent giving up", () => {
    const { summary } = summarize(input());
    expect(summary.stats.flaky.p95Ms).toBeLessThan(1000);
    expect(summary.stats.flaky.p95AllMs).toBeGreaterThan(50000);
  });
});

describe("status wording and disagreement counts", () => {
  it("only says 'waiting for a key' when that is the note", () => {
    const i = input({ readers: [rd("good", "decisions"), rd("jev", "decisions", false, "waiting for OPENROUTER_API_KEY"), rd("haiku", "llm", false, "not selected for this run"), rd("referee-opus", "referee")] });
    const { summary } = summarize(i);
    const t = summary.learned.join(" ");
    expect(t).toMatch(/JEV did not run \(waiting for OPENROUTER_API_KEY\)/);
    expect(t).toMatch(/HAIKU was not selected for this run/);
    expect(t).not.toMatch(/HAIKU.*waiting/);
  });
  it("reports how many comments split the models", () => {
    const { summary } = summarize(input());
    expect(summary.disagreementCounts.compared).toBeGreaterThan(0);
    expect(summary.disagreementCounts.split).toBeGreaterThanOrEqual(0);
  });
  it("caveats name the same-family referee, the sampling and use 'a quarter'", () => {
    const i = input();
    i.readers = [...i.readers.filter((r) => r.id !== "flaky"), { ...rd("flaky", "llm"), label: "Claude Haiku 5.5", modelId: "anthropic/claude-haiku-5.5" }];
    const c = summarize(i).summary.caveats.join(" ");
    expect(c).toMatch(/referee is a Claude model/i);
    expect(c).toMatch(/a quarter/);
    expect(c).not.toMatch(/a fifth/);
    expect(c).not.toMatch(/smaller than the 95% interval/);
  });
});

describe("runner", () => {
  const VIBES: Vibe[] = ["toxic", "critical", "supportive", "funny", "question", "spam"];
  async function makeRun() {
    const dir = await mkdtemp(path.join(tmpdir(), "sd-honest-"));
    await mkdir(path.join(dir, "r1"));
    const lines = Array.from({ length: 160 }, (_, i) => {
      const vibe = VIBES[i % 6];
      return JSON.stringify({ id: `c${i}`, videoId: "v", authorId: "u" + i, authorName: "@h" + i, text: `comment ${i} about the video`, vibe, scores: Object.fromEntries(VIBES.map((v) => [v, v === vibe ? 0.8 : 0.04])), likes: 1, publishedAt: "x" });
    });
    await writeFile(path.join(dir, "r1", "comments.jsonl"), lines.join("\n") + "\n");
    return dir;
  }
  const fetchOk = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    if (String(url).includes("/v1/scaledown")) {
      return new Response(JSON.stringify({ answers: { vibe: { type: "choice", choice: "funny", probabilities: { funny: 0.9 }, confidence: 0.9 }, toxic: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 400, cost: 0.00002 } }), { status: 200 });
    }
    void body;
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;

  it("probes a random subset of the whole sample, not the first stratum, and stores the config", async () => {
    const dir = await makeRun();
    const env = { SCALEDOWN_API_KEY: "sd-test" };
    const { file } = await runShowdown({ runId: "r1", dir, env, n: 100, refereeN: 20, probeN: 12, extraReferee: 0, only: ["scaledown"], fetchImpl: fetchOk, sleep: async () => {} });
    const probeIds = file.sample.probeIds!;
    expect(probeIds).toHaveLength(12);
    const strata = new Set(probeIds.map((id) => file.sample.strata[id]));
    expect(strata.size).toBeGreaterThan(2);
    expect(file.config!.n).toBe(100);
    expect(file.config!.probeN).toBe(12);
    expect(file.config!.readers.scaledown.concurrency).toEqual({ start: 16, max: 16 });
    expect(file.lanes.scaledown.fingerprint).toBeTruthy();
    expect(JSON.stringify(file.config)).not.toContain("sd-test");
    expect((await readShowdown("r1", dir))!.summary.stats.scaledown.serialP50Ms).toBeDefined();
  });

  it("does not reuse saved records when a reader's configuration changed", async () => {
    const dir = await makeRun();
    const env = { SCALEDOWN_API_KEY: "sd-test" };
    let calls = 0;
    const counting = (async (u: string, i?: RequestInit) => {
      calls++;
      return (fetchOk as unknown as (u: string, i?: RequestInit) => Promise<Response>)(u, i);
    }) as unknown as typeof fetch;
    const opts = { runId: "r1", dir, env, n: 60, refereeN: 10, probeN: 3, extraReferee: 0, only: ["scaledown"], fetchImpl: counting, sleep: async () => {} };
    await runShowdown(opts);
    const first = calls;
    await runShowdown(opts);
    expect(calls).toBe(first); // same config: everything reused
    calls = 0;
    await runShowdown({ ...opts, env: { ...env, SCALEDOWN_API_BASE: "https://api.example.test" } });
    expect(calls).toBeGreaterThan(0); // base URL changed: records are not relabelled
  });
});
