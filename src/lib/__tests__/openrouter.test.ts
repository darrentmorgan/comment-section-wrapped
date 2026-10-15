import { describe, expect, it, vi } from "vitest";
import { classifyBatch, createClassifier, DEFAULT_MODEL, summarizeVerdict } from "../openrouter";
import { newUsage } from "../scaledown";
import { VIBES } from "../vibes";

const chunks = [{ id: "a", text: "Love this!" }, { id: "b", text: "Why?" }];
const response = (content: string, usage: unknown = { prompt_tokens: 100, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
const result = (id: string) => ({ id, scores: { supportive: 1 } });
const cfg = (fetchImpl: typeof fetch) => ({ apiKey: "sk-test", fetchImpl, sleep: async () => {}, random: () => 0 });

describe("OpenRouter classifier", () => {
  it("posts batched comments with the shared rubric and correlates scores by id", async () => {
    const f = vi.fn(async () => response(JSON.stringify({ results: [result("b"), result("a")] })));
    const got = await classifyBatch(chunks, cfg(f));
    expect(got.outcomes.get("a")?.vibe).toBe("supportive");
    expect(got.unclassified).toEqual([]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(JSON.parse(body.messages[1].content)).toEqual(chunks);
    for (const vibe of VIBES) expect(body.messages[0].content).toContain(vibe);
    expect(body.messages[0].content).toContain("genuine question seeking an answer");
  });

  it("falls back only for malformed or missing comments without failing the batch", async () => {
    const f = vi.fn(async () => response(JSON.stringify({ results: [result("a"), { id: "b", scores: { spam: "oops" } }] })));
    const got = await classifyBatch(chunks, cfg(f));
    expect(got.outcomes.get("a")?.scores.supportive).toBe(1);
    expect(got.outcomes.get("b")?.scores.supportive).toBeCloseTo(1 / 6);
    expect((await classifyBatch(chunks, cfg(async () => response("{broken")))).outcomes.size).toBe(2);
    expect((await classifyBatch(chunks, cfg(async () => new Response("{broken")))).outcomes.size).toBe(2);
  });

  it.each([429, 500, 502, 503, 504])("retries %s with backoff", async (status) => {
    const f = vi.fn().mockResolvedValueOnce(new Response("busy", { status, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(response(JSON.stringify({ results: [result("a")] })));
    const sleep = vi.fn(async (ms: number) => { void ms; });
    await classifyBatch(chunks.slice(0, 1), { ...cfg(f), sleep });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(2000);
  });

  it("aborts before fetching and during retry sleep", async () => {
    const ac = new AbortController();
    const f = vi.fn(async () => new Response("busy", { status: 429 }));
    await expect(classifyBatch(chunks, { ...cfg(f), signal: ac.signal, sleep: async () => ac.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(f).toHaveBeenCalledTimes(1);
    f.mockClear();
    await expect(classifyBatch(chunks, { ...cfg(f), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f).not.toHaveBeenCalled();
  });

  it("passes the signal to in-flight fetches and interrupts a pending sleep", async () => {
    const ac = new AbortController();
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      ac.abort();
      throw ac.signal.reason;
    });
    await expect(classifyBatch(chunks, { ...cfg(f), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    const waiting = new AbortController();
    const pending = classifyBatch(chunks, { ...cfg(async () => new Response("busy", { status: 429 })), signal: waiting.signal, sleep: () => new Promise(() => {}) });
    waiting.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prefers reported cost, otherwise bills both input and output tokens", async () => {
    const usage = newUsage();
    await classifyBatch(chunks, cfg(async () => response("{}", { prompt_tokens: 100, completion_tokens: 20, cost: 0.004 })), usage);
    expect(usage).toMatchObject({ inputTokens: 100, costUsd: 0.004, calls: 1, estimated: false });
    const fallback = newUsage();
    await classifyBatch(chunks, cfg(async () => response("{}")), fallback);
    expect(fallback.costUsd).toBeCloseTo((100 * 0.09 + 20 * 0.3) / 1_000_000, 10);
  });

  it("streams batches of twenty and rejects drain on rejected credentials", async () => {
    const sizes: number[] = [];
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const items = JSON.parse(body.messages[1].content) as typeof chunks;
      sizes.push(items.length);
      return response(JSON.stringify({ results: items.map((c) => result(c.id)) }));
    });
    const got: string[] = [];
    const c = createClassifier(cfg(f), (items) => got.push(...items.map((i) => i.id)));
    c.push(Array.from({ length: 45 }, (_, i) => ({ id: String(i), text: "great" })));
    await c.drain();
    expect(sizes.sort((a, b) => a - b)).toEqual([5, 20, 20]);
    expect(got).toHaveLength(45);
    expect(c.classifiedCount()).toBe(45);
    expect(c.usage().calls).toBe(3);
    const failed = createClassifier(cfg(async () => new Response("bad key", { status: 401 })), () => {});
    failed.push(chunks);
    await expect(failed.drain()).rejects.toMatchObject({ status: 401 });
    expect(failed.failed()).not.toBeNull();
  });

  it("counts a persistently failing batch as unclassified and keeps the run alive", async () => {
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const items = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as typeof chunks;
      if (items[0].id === "20") return new Response("boom", { status: 500 });
      return response(JSON.stringify({ results: items.map((c) => result(c.id)) }));
    });
    const got: string[] = [];
    const c = createClassifier({ ...cfg(f), concurrency: 1, maxRetries: 1 }, (items) => got.push(...items.map((i) => i.id)));
    c.push(Array.from({ length: 60 }, (_, i) => ({ id: String(i), text: "great" })));
    await expect(c.drain()).resolves.toBeUndefined();
    expect(c.failed()).toBeNull();
    expect(c.classifiedCount()).toBe(40);
    expect(c.unclassifiedCount()).toBe(20);
    expect(got).toHaveLength(40);
  });

  it("fails the run when batches keep failing with zero successes", async () => {
    const c = createClassifier({ ...cfg(async () => new Response("boom", { status: 500 })), concurrency: 1, maxRetries: 0 }, () => {});
    c.push(Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: "x" })));
    await expect(c.drain()).rejects.toMatchObject({ status: 500 });
  });

  it("summarizes with the selected model and sanitizes unusable verdicts", async () => {
    const f = vi.fn(async () => response("Loved this channel at first, then hated this channel by spring.", { prompt_tokens: 42, completion_tokens: 12, cost: 0.001 }));
    const got = await summarizeVerdict("evidence", { ...cfg(f), model: "custom/model" });
    expect(got.text).toMatch(/Loved/);
    expect(got.costUsd).toBe(0.001);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("custom/model");
    expect((await summarizeVerdict("evidence", cfg(async () => response("ok")))).text).toBeNull();
    expect((await summarizeVerdict("evidence", { ...cfg(async () => new Response("busy", { status: 500 })), maxRetries: 0 })).text).toBeNull();
  });
});
