import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIBE_LABELS,
  classifyAll,
  classifyBatch,
  createClassifier,
  newUsage,
  normalizeBaseUrl,
  profileTokens,
  resetRouteCache,
  summarizeVerdict,
} from "../scaledown";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response("nope", { status: code, headers });

function resultFor(id: string, top = "supportive") {
  const scores: Record<string, number> = { toxic: 0.01, critical: 0.01, supportive: 0.01, funny: 0.01, question: 0.01, spam: 0.01 };
  scores[top] = 0.95;
  return { id, top_label: top, matched_labels: null, scores, labels: [] };
}
const echo = (reverse = false) =>
  vi.fn(async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const ids = body.chunks.map((c: { id: string }) => c.id);
    const results = ids.map((id: string) => resultFor(id, id.endsWith("7") ? "toxic" : "supportive"));
    if (reverse) results.reverse();
    return ok({ choices: [{ message: { content: JSON.stringify({ chunk_count: ids.length, results }) } }] });
  });
const cfg = (f: typeof fetch, extra = {}) => ({ apiKey: "k", fetchImpl: f, sleep: async () => {}, random: () => 0, route: "chat" as const, ...extra });
beforeEach(() => resetRouteCache());
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `comment number ${i}` }));

describe("config", () => {
  it("normalizes base url", () => {
    expect(normalizeBaseUrl("https://x.test/v1/")).toBe("https://x.test");
    expect(normalizeBaseUrl(undefined)).toBe("https://api.scaledown.xyz");
  });
});

describe("classifyBatch", () => {
  it("sends the contract: model classify, labels, chunks, reasoning:false, x-api-key", async () => {
    const f = echo();
    await classifyBatch(items(3), cfg(f as unknown as typeof fetch));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.scaledown.xyz/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.reasoning).toBe(false);
    expect(body.model).toBe("classify");
    expect(body.labels).toHaveLength(6);
    expect(body.chunks).toHaveLength(3);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("correlates by id even when results come back shuffled", async () => {
    const f = echo(true);
    const r = await classifyBatch(items(10), cfg(f as unknown as typeof fetch));
    expect(r.outcomes.get("c7")!.vibe).toBe("toxic");
    expect(r.outcomes.get("c3")!.vibe).toBe("supportive");
    const sum = Object.values(r.outcomes.get("c0")!.scores).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("throws (does not silently mark everything unclassified) when the response has no results array", async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: "not json" } }] }));
    const usage = newUsage();
    await expect(classifyBatch(items(3), cfg(f as unknown as typeof fetch), usage)).rejects.toThrow(/unexpected response/);
    expect(usage.calls).toBe(0);
  });

  it("rejects more than 50 chunks", async () => {
    await expect(classifyBatch(items(51), cfg(echo() as unknown as typeof fetch))).rejects.toThrow(/max 50/);
  });

  it("marks chunks missing from the response as unclassified", async () => {
    const f = vi.fn(async () => ok({ results: [resultFor("c0")] }));
    const r = await classifyBatch(items(2), cfg(f as unknown as typeof fetch));
    expect(r.unclassified).toEqual(["c1"]);
  });

  it("on 422 splits the batch in half and retries; a single bad chunk becomes unclassified", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.chunks.some((c: { id: string }) => c.id === "c2")) return status(422);
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const r = await classifyBatch(items(4), cfg(f as unknown as typeof fetch));
    expect(r.unclassified).toEqual(["c2"]);
    expect([...r.outcomes.keys()].sort()).toEqual(["c0", "c1", "c3"]);
  });

  it("backs off and retries on 429, honouring retry-after", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls++;
      if (calls < 3) return status(429, { "retry-after": "2" });
      const body = JSON.parse(String(init!.body));
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const r = await classifyBatch(items(2), cfg(f as unknown as typeof fetch, { sleep: async (ms: number) => void sleeps.push(ms) }));
    expect(r.outcomes.size).toBe(2);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("gives up after maxRetries on persistent 502", async () => {
    const f = vi.fn(async () => status(502));
    await expect(classifyBatch(items(1), cfg(f as unknown as typeof fetch, { maxRetries: 2 }))).rejects.toThrow(/502/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("treats 401 and 402 as fatal without retrying", async () => {
    for (const code of [401, 402]) {
      const f = vi.fn(async () => status(code));
      await expect(classifyBatch(items(1), cfg(f as unknown as typeof fetch))).rejects.toMatchObject({ status: code, fatal: true });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("uses reported usage when present", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      return ok({ usage: { input_tokens: 1000 }, results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const usage = newUsage();
    await classifyBatch(items(2), cfg(f as unknown as typeof fetch), usage);
    expect(usage.inputTokens).toBe(1000);
    expect(usage.costUsd).toBeCloseTo(1000 * 0.05e-6, 12);
    expect(usage.estimated).toBe(false);
  });

  it("falls back to a finite local estimate when usage is absent", async () => {
    const usage = newUsage();
    await classifyBatch(items(5), cfg(echo() as unknown as typeof fetch), usage);
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBeGreaterThan(profileTokens());
    expect(Number.isFinite(usage.costUsd)).toBe(true);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("has sharp rubrics for exactly the six vibes", () => {
    expect(VIBE_LABELS.map((l) => l.name).sort()).toEqual(["critical", "funny", "question", "spam", "supportive", "toxic"]);
    for (const l of VIBE_LABELS) expect(l.rubric.endsWith("?")).toBe(true);
  });
});

describe("route strategy", () => {
  const plain = (init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
  };
  const routed = (nativeStatus: number | "ok", chatStatus: number | "ok") =>
    vi.fn(async (u: unknown, init?: RequestInit) => {
      const isChat = String(u).endsWith("/v1/chat/completions");
      const st = isChat ? chatStatus : nativeStatus;
      if (st !== "ok") return status(st);
      if (isChat) {
        const body = JSON.parse(String(init!.body));
        return ok({ choices: [{ message: { content: JSON.stringify({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) }) } }] });
      }
      return plain(init);
    });
  const auto = (f: ReturnType<typeof routed>) => cfg(f as unknown as typeof fetch, { route: "auto" });

  it("auto: uses the documented /classify (no model field) and caches it", async () => {
    const f = routed("ok", 500);
    const r = await classifyBatch(items(3), auto(f));
    expect(r.outcomes.size).toBe(3);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.scaledown.xyz/classify");
    expect(JSON.parse(String(init.body)).model).toBeUndefined();
    await classifyBatch(items(2), auto(f));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("auto: falls back to the chat route on 403 and remembers it for the process", async () => {
    const f = routed(403, "ok");
    const r = await classifyBatch(items(3), auto(f));
    expect(r.outcomes.size).toBe(3);
    expect(f.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(["https://api.scaledown.xyz/classify", "https://api.scaledown.xyz/v1/chat/completions"]);
    await classifyBatch(items(3), auto(f));
    expect(f).toHaveBeenCalledTimes(3); // second batch went straight to chat
  });

  it("auto: also falls back on 404", async () => {
    const f = routed(404, "ok");
    expect((await classifyBatch(items(1), auto(f))).outcomes.size).toBe(1);
  });

  it("403 on every route is a clear run-fatal error", async () => {
    const f = routed(403, 403);
    await expect(classifyBatch(items(1), auto(f))).rejects.toMatchObject({ status: 403, fatal: true, message: "ScaleDown rejected the key (403)." });
    const g = routed("ok", 403);
    await expect(classifyBatch(items(1), cfg(g as unknown as typeof fetch, { route: "chat" }))).rejects.toMatchObject({ fatal: true });
  });

  it("parses both the plain and the chat-wrapped response shapes", async () => {
    const a = await classifyBatch(items(2), cfg(routed("ok", "ok") as unknown as typeof fetch, { route: "native" }));
    const b = await classifyBatch(items(2), cfg(routed("ok", "ok") as unknown as typeof fetch, { route: "chat" }));
    expect([...a.outcomes.keys()]).toEqual(["c0", "c1"]);
    expect([...b.outcomes.keys()]).toEqual(["c0", "c1"]);
  });
});

describe("createClassifier / classifyAll", () => {
  it("chunks at 50 and bounds concurrency", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const sizes: number[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      const body = JSON.parse(String(init!.body));
      sizes.push(body.chunks.length);
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const { outcomes, usage } = await classifyAll(items(230), cfg(f as unknown as typeof fetch, { concurrency: 3 }));
    expect(outcomes.size).toBe(230);
    expect(usage.calls).toBe(5);
    expect(sizes.sort((a, b) => a - b)).toEqual([30, 50, 50, 50, 50]);
    expect(maxInflight).toBeLessThanOrEqual(3);
  });

  it("streams pushes and rejects drain on a fatal error", async () => {
    const f = vi.fn(async () => status(402));
    const c = createClassifier(cfg(f as unknown as typeof fetch), () => {});
    c.push(items(120));
    await expect(c.drain()).rejects.toMatchObject({ status: 402 });
  });

  it("a batch that exhausts its retries is requeued for a second pass and fully classified", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      calls++;
      // the first batch of 50 fails five times in a row (1 try + 4 retries), then recovers
      if (calls <= 5) return status(502);
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const got: string[] = [];
    const c = createClassifier(cfg(f as unknown as typeof fetch, { concurrency: 1 }), (its) => got.push(...its.map((i) => i.id)));
    c.push(items(50));
    await expect(c.drain()).resolves.toBeUndefined();
    expect(c.classifiedCount()).toBe(50);
    expect(c.unclassifiedCount()).toBe(0);
    expect(new Set(got).size).toBe(50);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped.*50/i));
    warn.mockRestore();
  });

  it("the second pass waits longer between attempts (2s, 5s, 10s)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls++;
      if (calls <= 5 + 3) return status(502); // main pass, then three rescue attempts
      const body = JSON.parse(String(init!.body));
      return ok({ results: body.chunks.map((x: { id: string }) => resultFor(x.id)) });
    });
    const sleeps: number[] = [];
    const c = createClassifier(cfg(f as unknown as typeof fetch, { concurrency: 1, sleep: async (ms: number) => void sleeps.push(ms) }), () => {});
    c.push(items(50));
    await c.drain();
    expect(sleeps.some((ms) => ms >= 10000)).toBe(true);
    expect(sleeps.filter((ms) => ms >= 2000 && ms < 3000).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  it("a batch that keeps failing is bisected so only the poison comment is lost", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.chunks.some((x: { id: string }) => x.id === "c7")) return status(502);
      return ok({ results: body.chunks.map((x: { id: string }) => resultFor(x.id)) });
    });
    const c = createClassifier(cfg(f as unknown as typeof fetch, { maxRetries: 0, concurrency: 1 }), () => {});
    c.push(items(150));
    await expect(c.drain()).resolves.toBeUndefined();
    expect(c.classifiedCount()).toBe(149);
    expect(c.unclassifiedCount()).toBe(1);
    expect(c.failed()).toBeNull();
    vi.restoreAllMocks();
  });

  it("a run where every batch fails dies after repeated failures, and failed() exposes it early", async () => {
    const f = vi.fn(async () => status(502));
    const c = createClassifier(cfg(f as unknown as typeof fetch, { maxRetries: 0, concurrency: 1 }), () => {});
    c.push(items(50 * 8));
    await expect(c.drain()).rejects.toThrow(/502/);
    expect(c.failed()).not.toBeNull();
    expect(f.mock.calls.length).toBeLessThan(8);
  });

  it("failed() is set as soon as a fatal 402 lands, before drain", async () => {
    const f = vi.fn(async () => status(402));
    const c = createClassifier(cfg(f as unknown as typeof fetch), () => {});
    c.push(items(50));
    await new Promise((r) => setTimeout(r, 10));
    expect(c.failed()).toMatchObject({ status: 402 });
    c.push(items(50)); // ignored once dead
    await expect(c.drain()).rejects.toMatchObject({ status: 402 });
  });

  it("defaults to 48 workers, backs off on 429, and all workers share the cooldown", async () => {
    let calls = 0;
    let inflight = 0;
    let maxInflight = 0;
    const sleeps: number[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const n = ++calls;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      if (n === 3) return status(429, { "retry-after": "30" });
      const body = JSON.parse(String(init!.body));
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const c = createClassifier(cfg(f as unknown as typeof fetch, { sleep: async (ms: number) => void sleeps.push(ms) }), () => {});
    c.push(items(50 * 120));
    await c.drain();
    expect(maxInflight).toBeLessThanOrEqual(96);
    expect(maxInflight).toBeGreaterThan(20);
    expect(c.classifiedCount()).toBe(6000);
    expect(sleeps.some((ms) => ms >= 30000)).toBe(true); // Retry-After above 15s is honoured
    expect(sleeps.length).toBeGreaterThan(1); // other workers paused on the shared cooldown too
  });

  it("AIMD: starts at 48, backs off on 504 but never below 16, and grows back up to 96 on success", async () => {
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const n = ++calls;
      await new Promise((r) => setTimeout(r, 2));
      if (n >= 5 && n <= 30) return status(504);
      const body = JSON.parse(String(init!.body));
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const seen: number[] = [];
    const c = createClassifier(cfg(f as unknown as typeof fetch, { maxRetries: 0, onLimitChange: (n: number) => seen.push(n) }), () => {});
    expect(c.concurrencyNow()).toBe(48);
    c.push(items(50 * 400));
    await c.drain();
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(16);
    expect(Math.min(...seen)).toBeLessThan(48);
    expect(Math.max(...seen)).toBeLessThanOrEqual(96);
    expect(Math.max(...seen)).toBeGreaterThan(48);
  });

  it("a burst of simultaneous 504s shrinks the pool once, not once per failure", async () => {
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const n = ++calls;
      await new Promise((r) => setTimeout(r, 2));
      if (n <= 48 && n % 2 === 1) return status(504);
      const body = JSON.parse(String(init!.body));
      return ok({ results: body.chunks.map((c: { id: string }) => resultFor(c.id)) });
    });
    const seen: number[] = [];
    const c = createClassifier(cfg(f as unknown as typeof fetch, { maxRetries: 0, onLimitChange: (n: number) => seen.push(n) }), () => {});
    c.push(items(50 * 60));
    await c.drain();
    const drops = seen.filter((n, i) => n < (i === 0 ? 48 : seen[i - 1])).length;
    expect(drops).toBe(1);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(16);
  });

  it("sends the system prompt on the chat route", async () => {
    const f = echo();
    await classifyBatch(items(2), cfg(f as unknown as typeof fetch));
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/YouTube comments/);
    expect(body.labels.find((l: { name: string }) => l.name === "question").rubric).toMatch(/real question/);
  });

  it("reports busy time and counts", async () => {
    const batches: number[] = [];
    const c = createClassifier(cfg(echo() as unknown as typeof fetch), (its) => batches.push(its.length));
    c.push(items(60));
    await c.drain();
    expect(batches.reduce((a, b) => a + b, 0)).toBe(60);
    expect(c.classifiedCount()).toBe(60);
    expect(c.busyMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("summarizeVerdict", () => {
  it("parses the JSON-string content", async () => {
    const f = vi.fn(async () =>
      ok({
        choices: [{ message: { content: JSON.stringify({ summary: "Went from fan to full-time critic over a few months.", input_tokens: 40 }) } }],
        usage: { prompt_tokens: 42 },
      }),
    );
    const r = await summarizeVerdict("evidence", cfg(f as unknown as typeof fetch));
    expect(r.text).toBe("Went from fan to full-time critic over a few months.");
    expect(r.inputTokens).toBe(42);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("summarize");
    expect(body.max_tokens).toBe(60);
  });
  it("discards output truncated by max_tokens and flags estimated usage", async () => {
    const trunc = vi.fn(async () =>
      ok({ choices: [{ message: { content: JSON.stringify({ summary: "Went from fan to full-time critic and then", finish_reason: "length" }) } }] }),
    );
    const r = await summarizeVerdict("evidence", cfg(trunc as unknown as typeof fetch));
    expect(r.text).toBeNull();
    expect(r.estimated).toBe(true);
    const good = vi.fn(async () =>
      ok({ choices: [{ message: { content: JSON.stringify({ summary: "Went from fan to full-time critic over months.", input_tokens: 40 }) } }] }),
    );
    const g = await summarizeVerdict("evidence", cfg(good as unknown as typeof fetch));
    expect(g.text).toMatch(/critic/);
    expect(g.estimated).toBe(false);
  });
  it("returns null text (never throws) on server errors", async () => {
    const f = vi.fn(async () => status(500));
    const r = await summarizeVerdict("evidence", cfg(f as unknown as typeof fetch));
    expect(r.text).toBeNull();
  });
  it("rejects absurdly short or long output", async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }] }));
    expect((await summarizeVerdict("e", cfg(f as unknown as typeof fetch))).text).toBeNull();
  });
});

it.each([401, 403, 429, 500, 502, 418])("never reflects provider error bodies for status %s", async (status) => {
  const fetcher = vi.fn(async () => new Response("private sk-test comment text", { status }));
  const expected = [401, 403].includes(status) ? `ScaleDown rejected the key (${status}).` : `ScaleDown request failed (${status}). Try again in a minute.`;
  await expect(classifyBatch(items(1), cfg(fetcher as typeof fetch, { maxRetries: 0, max429Retries: 0 }))).rejects.toMatchObject({ message: expected, status });
});

it("keeps arbitrary exception text out of batch and rescue warnings", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const fetcher = vi.fn(async () => { throw Error("private sk-test comment text"); });
    await classifyAll(items(1), cfg(fetcher as typeof fetch, { maxRetries: 0, concurrency: 1 }));
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private sk-test");
    expect(JSON.stringify(warn.mock.calls)).toContain("status 0");
  } finally { warn.mockRestore(); }
});
