import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProgressEvent, Vibe } from "../../types";
import { Limiter, runShowdown } from "../runner";
import { readShowdown } from "../store";

const VIBES: Vibe[] = ["toxic", "critical", "supportive", "funny", "question", "spam"];
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

async function makeRun(count = 160) {
  const dir = await mkdtemp(path.join(tmpdir(), "sd-run-"));
  await mkdir(path.join(dir, "r1"));
  const lines = Array.from({ length: count }, (_, i) => {
    const vibe = VIBES[i % 6];
    const scores = Object.fromEntries(VIBES.map((v) => [v, v === vibe ? 0.8 : 0.04]));
    return JSON.stringify({ id: `c${i}`, videoId: "v", authorId: "UCsecret" + i, authorName: "@realhandle" + i, text: `comment ${i} about the video`, vibe, scores, likes: 1, publishedAt: "x" });
  });
  await writeFile(path.join(dir, "r1", "comments.jsonl"), lines.join("\n") + "\n");
  return dir;
}

/** Deterministic fake of all four providers. The "truth" is the number in the comment text mod 6, with some noise per provider. */
function fakeFetch(calls: Record<string, number> = {}, opts: { failJev?: boolean } = {}) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init!.body));
    const key = u.includes("scaledown.xyz/v1/scaledown") ? "sd" : u.includes("chat/completions") && body.model === "classify" ? "batch" : u.includes("alpha/decisions") ? "jev" : "or:" + body.model;
    calls[key] = (calls[key] ?? 0) + 1;
    const truthOf = (t: string) => VIBES[Number(/comment (\d+)/.exec(t)?.[1] ?? 0) % 6];
    if (key === "sd" || key === "jev") {
      if (key === "jev" && opts.failJev) return new Response("boom", { status: 400 });
      const v = truthOf(body.state.text);
      return ok({ answers: { vibe: { type: "choice", choice: v, probabilities: { [v]: 0.9 }, confidence: 0.9 }, toxic: { type: "noul", noul: v === "toxic" ? 0.9 : 0.1 } }, usage: { input_tokens: 400, output_tokens: 2, cost: 0.00002 } });
    }
    if (key === "batch") {
      const results = body.chunks.map((c: { id: string; text: string }) => {
        const v = truthOf(c.text);
        return { id: c.id, top_label: v, scores: { [v]: 0.9 } };
      });
      return ok({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { prompt_tokens: 100 * body.chunks.length, cost: 0.000005 * body.chunks.length } });
    }
    const v = truthOf(body.messages[1].content);
    return ok({ choices: [{ message: { content: JSON.stringify({ vibe: v, toxic: v === "toxic" }) } }], usage: { prompt_tokens: 300, completion_tokens: 10, cost: 0.0001 } });
  }) as unknown as typeof fetch;
}

const base = { runId: "r1", n: 100, refereeN: 30, probeN: 5, extraReferee: 3, sleep: async () => {} };

describe("Limiter (AIMD)", () => {
  it("halves on rate limit (once per 2s) and grows +4 after 100 clean calls, within bounds", () => {
    let t = 0;
    const l = new Limiter(24, 48, 1, () => t);
    l.rateLimited();
    expect(l.limit).toBe(12);
    l.rateLimited(); // within 2s: ignored
    expect(l.limit).toBe(12);
    t = 3000;
    l.rateLimited();
    expect(l.limit).toBe(6);
    for (let i = 0; i < 100; i++) l.success();
    expect(l.limit).toBe(10);
    for (let i = 0; i < 100 * 20; i++) l.success();
    expect(l.limit).toBe(48);
  });
  it("never lets more than `limit` run at once", async () => {
    const l = new Limiter(3, 3);
    let live = 0, peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await l.acquire();
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2));
        live--;
        l.release();
      }),
    );
    expect(peak).toBe(3);
  });
});

describe("runShowdown", () => {
  it("with only a ScaleDown key: runs ScaleDown lanes and baselines, marks the rest waiting, writes showdown.json", async () => {
    const dir = await makeRun();
    const calls: Record<string, number> = {};
    const events: ProgressEvent[] = [];
    const { summary, disagreements } = await runShowdown({ ...base, dir, env: { SCALEDOWN_API_KEY: "sd-key-123456" }, fetchImpl: fakeFetch(calls), emit: (e) => events.push(e) });
    const N = summary.sampleSize;
    expect(N).toBeGreaterThan(50);
    expect(calls.sd).toBe(N);
    expect(calls.batch).toBe(Math.ceil(N / 50));
    expect(calls.jev).toBeUndefined();
    const byId = Object.fromEntries(summary.readers.map((r) => [r.id, r]));
    expect(byId.scaledown.status).toBe("ok");
    expect(byId["scaledown-batch"].status).toBe("ok");
    expect(byId.jev.status).toBe("skipped");
    expect(byId.jev.note).toBe("waiting for OPENROUTER_API_KEY");
    expect(byId["referee-opus"].status).toBe("skipped");
    expect(summary.stats.scaledown.ok).toBe(N);
    expect(summary.stats.scaledown.serialP50Ms).toBeGreaterThanOrEqual(0);
    expect(summary.stats.scaledown.costUsd).toBeCloseTo(N * 0.00002);
    expect(summary.stats["always-supportive"].costSource).toBe("free");
    expect(summary.stats.scaledown.agreementWithReferee).toBeNull();
    expect(summary.simulated).toBeUndefined();
    expect(disagreements).toBeDefined();

    const start = events.find((e) => e.type === "showdown_start") as Extract<ProgressEvent, { type: "showdown_start" }>;
    expect(start.total).toBe(N);
    expect(start.readers.find((r) => r.id === "jev")).toMatchObject({ enabled: false, note: "waiting for OPENROUTER_API_KEY" });
    expect(events.filter((e) => e.type === "showdown_tick").length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("showdown_done");

    const saved = await readShowdown("r1", dir);
    expect(saved?.version).toBe(1);
    expect(saved?.events.some((e) => e.event.type === "showdown_done")).toBe(false);
    const raw = await readFile(path.join(dir, "r1", "showdown.json"), "utf8");
    expect(raw).not.toContain("realhandle");
    expect(raw).not.toContain("UCsecret");
    expect(raw).not.toContain("sd-key-123456");
    await expect(stat(path.join(dir, "r1", "showdown.partial.jsonl"))).rejects.toThrow();
  });

  it("with an OpenRouter key too: every lane runs, referee agreement and costs appear", async () => {
    const dir = await makeRun();
    const calls: Record<string, number> = {};
    const { summary, disagreements } = await runShowdown({ ...base, dir, env: { SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" }, fetchImpl: fakeFetch(calls) });
    expect(calls.jev).toBe(summary.sampleSize);
    expect(calls["or:anthropic/claude-haiku-5.5"]).toBe(summary.sampleSize);
    expect(calls["or:anthropic/claude-opus-5.5"]).toBeGreaterThanOrEqual(30);
    expect(summary.refereeIds).toContain("referee-opus");
    expect(summary.stats.jev.agreementWithReferee).toMatchObject({ rate: 1, n: 30 });
    expect(summary.stats["always-supportive"].agreementWithReferee!.rate).toBeLessThan(0.5);
    expect(summary.stats.haiku.costSource).toBe("api");
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.learned.join(" ")).toMatch(/bar to beat/);
    // everyone agrees in the fake world except baselines, so hand-picked disagreements are about the baselines only and are filtered out
    expect(disagreements.every((d) => d.distinct >= 2)).toBe(true);
  });

  it("a provider that 400s every call marks its lane failed without sinking the run", async () => {
    const dir = await makeRun();
    const { summary } = await runShowdown({ ...base, dir, env: { SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" }, fetchImpl: fakeFetch({}, { failJev: true }) });
    expect(summary.readers.find((r) => r.id === "jev")!.status).toBe("failed");
    expect(summary.stats.jev.failureRate).toBe(1);
    expect(summary.readers.find((r) => r.id === "scaledown")!.status).toBe("ok");
  });

  it("resumes from the partial file without paying twice", async () => {
    const dir = await makeRun();
    const env = { SCALEDOWN_API_KEY: "sd-key-123456" };
    const ctl = new AbortController();
    let n = 0;
    const inner = fakeFetch();
    const flaky = (async (u: string, i?: RequestInit) => {
      if (++n === 40) ctl.abort();
      return inner(u, i);
    }) as unknown as typeof fetch;
    await runShowdown({ ...base, dir, env, fetchImpl: flaky, signal: ctl.signal }).catch(() => {});
    const calls: Record<string, number> = {};
    const { summary } = await runShowdown({ ...base, dir, env, fetchImpl: fakeFetch(calls) });
    expect(summary.stats.scaledown.ok).toBe(summary.sampleSize);
    expect(calls.sd).toBeLessThan(summary.sampleSize);
    expect((calls.sd ?? 0) + 0).toBeGreaterThan(0);
  });
});

describe("runShowdown failure guard", () => {
  it("stops hammering a lane after 20 failures in a row", async () => {
    const dir = await makeRun(400);
    const calls: Record<string, number> = {};
    const { summary } = await runShowdown({ ...base, n: 200, dir, env: { SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" }, fetchImpl: fakeFetch(calls, { failJev: true }) });
    expect(calls.jev).toBeLessThan(60);
    expect(summary.readers.find((r) => r.id === "jev")!.status).toBe("failed");
    expect(summary.stats.jev.failed).toBe(summary.sampleSize);
  });
});

describe("runShowdown extend", () => {
  it("a second run on a finished showdown pays nothing, and a bigger referee set pays only for the new referee items", async () => {
    const dir = await makeRun();
    const env = { SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" };
    await runShowdown({ ...base, dir, refereeN: 20, extraReferee: 0, env, fetchImpl: fakeFetch() });
    const again: Record<string, number> = {};
    await runShowdown({ ...base, dir, refereeN: 20, extraReferee: 0, env, fetchImpl: fakeFetch(again) });
    expect(Object.keys(again)).toEqual([]);
    const grown: Record<string, number> = {};
    const { summary } = await runShowdown({ ...base, dir, refereeN: 35, extraReferee: 0, env, fetchImpl: fakeFetch(grown) });
    expect(grown["or:anthropic/claude-opus-5.5"]).toBe(15);
    expect(grown.sd).toBeUndefined();
    expect(summary.refereeSize).toBe(35);
  });
});
