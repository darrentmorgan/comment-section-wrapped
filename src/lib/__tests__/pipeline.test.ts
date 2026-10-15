import { beforeEach, describe, expect, it } from "vitest";
import { resetRouteCache } from "../scaledown";
import { describeError, runAnalysis, wouldRunLive } from "../pipeline";
import { clearCommentCache } from "../youtube";
import type { ProgressEvent, WrappedResult } from "../types";

async function run(req: Parameters<typeof runAnalysis>[0], opts: Parameters<typeof runAnalysis>[2]) {
  const events: ProgressEvent[] = [];
  await runAnalysis(req, (e) => events.push(e), opts);
  return events;
}
const resultOf = (ev: ProgressEvent[]) => ev.find((e) => e.type === "result") as { type: "result"; result: WrappedResult } | undefined;

describe("demo mode", () => {
  it("streams a coherent run and ends with a demo result", async () => {
    const ev = await run({ channel: "@whatever", demo: true }, { env: {}, demoDurationMs: 300 });
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe("status");
    expect(types.indexOf("channel")).toBeLessThan(types.indexOf("videos"));
    expect(types.indexOf("videos")).toBeLessThan(types.indexOf("fetched"));
    expect(types.at(-1)).toBe("status");
    expect(types).not.toContain("error");

    const fetched = ev.filter((e) => e.type === "fetched").map((e) => (e as { total: number }).total);
    expect([...fetched].sort((a, b) => a - b)).toEqual(fetched);
    const cls = ev.filter((e) => e.type === "classified") as Extract<ProgressEvent, { type: "classified" }>[];
    expect(cls.length).toBeGreaterThan(2);
    for (let i = 1; i < cls.length; i++) {
      expect(cls[i].done).toBeGreaterThanOrEqual(cls[i - 1].done);
      expect(cls[i].costUsd).toBeGreaterThanOrEqual(cls[i - 1].costUsd);
      expect(cls[i].done).toBeLessThanOrEqual(cls[i].total);
    }
    expect(cls.at(-1)!.done).toBe(cls.at(-1)!.total);
    expect(cls.some((c) => c.sample.length > 0)).toBe(true);

    const r = resultOf(ev)!.result;
    expect(r.demo).toBe(true);
    expect(r.totals.comments).toBe(cls.at(-1)!.total);
    expect(r.usage.costUsd).toBeCloseTo(cls.at(-1)!.costUsd, 9);
    expect(r.usage.classifyCalls).toBeGreaterThan(500);
    expect(Number.isFinite(r.usage.elapsedMs)).toBe(true);
    expect(r.personas.length).toBeGreaterThan(10);
  });

  it("falls back to demo when keys are missing, even without demo:true", async () => {
    const ev = await run({ channel: "@someone" }, { env: { YOUTUBE_API_KEY: "only-one" }, demoDurationMs: 200 });
    expect(resultOf(ev)!.result.demo).toBe(true);
  });

  it("stops quietly when the client aborts", async () => {
    const ac = new AbortController();
    const ev: ProgressEvent[] = [];
    const p = runAnalysis({ channel: "x", demo: true }, (e) => ev.push(e), { env: {}, demoDurationMs: 400, signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    await p;
    expect(ev.some((e) => e.type === "result")).toBe(false);
    expect(ev.some((e) => e.type === "error")).toBe(false);
  });
});

// ---------------------------------------------------------------- live path with both APIs mocked
const UC = "UC" + "b".repeat(22);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function mockFetch(opts: { quota?: boolean } = {}) {
  const calls = { classify: 0, summarize: 0, yt: 0 };
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://www.googleapis.com/youtube/v3/")) {
      calls.yt++;
      const u = new URL(url);
      const path = u.pathname.split("/").pop();
      if (path === "channels") return json({ items: [{ id: UC, snippet: { title: "Mock Chan", customUrl: "@mock", thumbnails: { high: { url: "av" } } }, statistics: { subscriberCount: "10", videoCount: "4" }, contentDetails: { relatedPlaylists: { uploads: "UUmock" } } }] });
      if (path === "playlistItems") return json({ items: [1, 2, 3, 4].map((i) => ({ snippet: { title: `v${i}` }, contentDetails: { videoId: `vid${i}` } })) });
      if (path === "videos") return json({ items: [1, 2, 3, 4].map((i) => ({ id: `vid${i}`, snippet: { title: `Video ${i}`, publishedAt: `2026-0${i}-01T00:00:00Z` }, statistics: { commentCount: "60" } })) });
      if (path === "commentThreads") {
        if (opts.quota) return json({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403);
        const vid = u.searchParams.get("videoId")!;
        const n = Number(vid.slice(3));
        const items = Array.from({ length: 60 }, (_, i) => {
          const isA = i < 2; // two comments per video: arcs need 5+ comments
          const text = isA ? (n <= 2 ? "love this channel" : "i hate this channel") + ` v${n} no${i}` : `filler comment ${i}`;
          return {
            snippet: {
              videoId: vid,
              totalReplyCount: 0,
              topLevelComment: { id: `${vid}_c${i}`, snippet: { authorDisplayName: isA ? "@A" : `@u${vid}${i}`, authorChannelId: { value: isA ? "UCvillain" : `UCu${vid}${i}` }, textDisplay: text, likeCount: 1, publishedAt: `2026-0${n}-02T00:00:0${i % 10}Z` } },
            },
          };
        });
        return json({ items });
      }
    }
    // Like the real key: the documented /classify is forbidden, the chat route works.
    if (url.endsWith("/classify")) return new Response("forbidden", { status: 403 });
    const reqBody = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/v1/chat/completions") && reqBody.model === "classify") {
      calls.classify++;
      const body = reqBody;
      const inner = {
        results: body.chunks.map((c: { id: string; text: string }) => {
          const top = c.text.includes("hate") ? "toxic" : c.text.includes("love") ? "supportive" : "question";
          const scores: Record<string, number> = { toxic: 0.01, critical: 0.01, supportive: 0.01, funny: 0.01, question: 0.01, spam: 0.01 };
          scores[top] = 0.95;
          return { id: c.id, top_label: top, scores };
        }),
      };
      return json({ choices: [{ message: { content: JSON.stringify(inner) } }], usage: { prompt_tokens: 500 } });
    }
    if (url.endsWith("/v1/chat/completions")) {
      calls.summarize++;
      return json({ choices: [{ message: { content: JSON.stringify({ summary: "Loved this channel at first, then hated this channel by spring." }) } }], usage: { prompt_tokens: 80 } });
    }
    return new Response("unexpected " + url, { status: 500 });
  };
  return { f: f as typeof fetch, calls };
}

describe("live mode (mocked APIs)", () => {
  beforeEach(() => resetRouteCache());
  const env = { SCALEDOWN_API_KEY: "sd-test", YOUTUBE_API_KEY: "yt-test" };

  it("defaults to top comments (relevance) and exposes every classified comment via onClassified", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const urls: string[] = [];
    const wrapped = (async (u: unknown, init?: RequestInit) => {
      urls.push(String(u));
      return f(u as string, init);
    }) as typeof fetch;
    let all: import("../types").ClassifiedComment[] = [];
    await run({ channel: "@mock" }, { env, fetchImpl: wrapped, sleep: async () => {}, onClassified: (c) => (all = c) });
    expect(urls.filter((u) => u.includes("/commentThreads")).every((u) => u.includes("order=relevance"))).toBe(true);
    expect(all).toHaveLength(240);
    expect(all[0].scores.supportive).toBeGreaterThanOrEqual(0);
  });

  it("fetches, classifies in batches of 50, finds the villain, upgrades the verdict", async () => {
    clearCommentCache();
    const { f, calls } = mockFetch();
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: f, sleep: async () => {} });
    expect(ev.some((e) => e.type === "error")).toBe(false);
    const r = resultOf(ev)!.result;
    expect(r.demo).toBe(false);
    expect(r.channel.title).toBe("Mock Chan");
    expect(r.totals.comments).toBe(240);
    expect(calls.classify).toBe(5);
    expect(r.usage.classifyCalls).toBe(5);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.costUsd).toBeGreaterThan(0);
    const v = r.personas.find((p) => p.authorId === "UCvillain");
    expect(v?.kind).toBe("villain_arc");
    expect(r.mostLoyal?.authorId).toBe("UCvillain");
    expect(r.mostLoyal?.videosCommented).toBe(4);
    expect(v?.verdict).toBe("Loved this channel at first, then hated this channel by spring.");
    expect(calls.summarize).toBeGreaterThanOrEqual(1);
    expect(r.videos.map((x) => x.commentCount)).toEqual([60, 60, 60, 60]);
    const fetchedEvents = ev.filter((e) => e.type === "fetched");
    expect(fetchedEvents.length).toBeGreaterThan(1);
  });

  it("emits the per-video fetch cap as each video's comment count, so the Reading strip advances", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 25 }, { env, fetchImpl: f, sleep: async () => {} });
    const vids = ev.find((e) => e.type === "videos") as Extract<ProgressEvent, { type: "videos" }>;
    // the mock reports 60 comments per video; only 25 are fetched
    expect(vids.videos.map((v) => v.commentCount)).toEqual([25, 25, 25, 25]);
  });

  it("streams a real running count of distinct commenters on the fetched events", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: f, sleep: async () => {} });
    const fe = ev.filter((e) => e.type === "fetched") as Extract<ProgressEvent, { type: "fetched" }>[];
    const counts = fe.map((e) => e.commenters ?? -1);
    expect(counts.every((c) => c >= 0)).toBe(true);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    // 4 videos x 58 one-off commenters + the one repeat commenter
    expect(counts.at(-1)).toBe(4 * 58 + 1);
    expect(resultOf(ev)!.result.totals.commenters).toBe(4 * 58 + 1);
  });

  it("ends the classified stream at 100% and reports nothing unclassified on a clean run", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: f, sleep: async () => {} });
    const cls = ev.filter((e) => e.type === "classified") as Extract<ProgressEvent, { type: "classified" }>[];
    expect(cls.at(-1)!.done).toBe(cls.at(-1)!.total);
    expect(cls.at(-1)!.done).toBe(240);
    expect(resultOf(ev)!.result.usage.unclassified ?? 0).toBe(0);
  });

  it("a comment ScaleDown cannot classify is reported, and the progress still ends at done = total", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const wrapped = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/v1/chat/completions")) {
        const b = JSON.parse(String(init?.body ?? "{}"));
        if (b.model === "classify" && b.chunks.some((c: { id: string }) => c.id === "vid2_c5")) return new Response("Classification failed", { status: 502 });
      }
      return f(input as never, init);
    }) as typeof fetch;
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: wrapped, sleep: async () => {} });
    const r = resultOf(ev)!.result;
    expect(r.totals.comments).toBe(239);
    expect(r.usage.unclassified).toBe(1);
    const cls = ev.filter((e) => e.type === "classified") as Extract<ProgressEvent, { type: "classified" }>[];
    expect(cls.at(-1)!.done).toBe(239);
    expect(cls.at(-1)!.total).toBe(239);
  });

  it("surfaces a YouTube quota error as an error event", async () => {
    clearCommentCache();
    const { f } = mockFetch({ quota: true });
    const ev = await run({ channel: "@mock" }, { env, fetchImpl: f, sleep: async () => {} });
    const err = ev.find((e) => e.type === "error") as { message: string } | undefined;
    expect(err?.message).toBe("The YouTube API daily quota is used up. Come back after midnight Pacific, or watch the recorded run.");
    expect(resultOf(ev)).toBeUndefined();
  });

  it("reports a ScaleDown 402 as a clear error and never leaks the keys", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const wrapped = (async (input: unknown, init?: RequestInit) => (String(input).endsWith("/v1/chat/completions") && JSON.parse(String(init?.body ?? "{}")).model === "classify" ? new Response("pay up", { status: 402 }) : f(input as never, init))) as typeof fetch;
    const ev = await run({ channel: "@mock" }, { env, fetchImpl: wrapped, sleep: async () => {} });
    const err = ev.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/credits/i);
    expect(JSON.stringify(ev)).not.toMatch(/sd-test|yt-test/);
  });

  it("fails fast when ScaleDown is out of credits: stops fetching YouTube comments instead of burning quota", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const wrapped = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/commentThreads")) await new Promise((r) => setTimeout(r, 25));
      if (url.endsWith("/v1/chat/completions") && JSON.parse(String(init?.body ?? "{}")).model === "classify") return new Response("pay up", { status: 402 });
      return f(input as never, init);
    }) as typeof fetch;
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: wrapped, sleep: async () => {} });
    expect((ev.find((e) => e.type === "error") as { message: string }).message).toMatch(/credits/i);
    // 3 videos are in flight when the 402 lands; the 4th video's comments are never accepted.
    const fetched = ev.filter((e) => e.type === "fetched").map((e) => (e as { total: number }).total);
    expect(Math.max(...fetched)).toBeLessThanOrEqual(180);
  });

  it("one flaky video is skipped with a warning; the rest of the run completes", async () => {
    clearCommentCache();
    const { f } = mockFetch();
    const wrapped = (async (input: unknown, init?: RequestInit) =>
      String(input).includes("/commentThreads") && String(input).includes("videoId=vid2") ? json({ error: { code: 500, errors: [{ reason: "backendError" }] } }, 500) : f(input as never, init)) as typeof fetch;
    const ev = await run({ channel: "@mock", maxVideos: 4, maxCommentsPerVideo: 100 }, { env, fetchImpl: wrapped, sleep: async () => {} });
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(ev.some((e) => e.type === "status" && /Skipped one video/.test(e.message))).toBe(true);
    const r = resultOf(ev)!.result;
    expect(r.totals.comments).toBe(180);
    expect(r.usage.endToEndMs).toBeGreaterThanOrEqual(0);
  });

  it("bad channel input gives a helpful error", async () => {
    const ev = await run({ channel: "https://example.com/nope" }, { env, fetchImpl: mockFetch().f, sleep: async () => {} });
    expect((ev.find((e) => e.type === "error") as { message: string }).message).toMatch(/@handle/);
  });
});



describe("provider selection", () => {
  const env = { YOUTUBE_API_KEY: "yt-test", OPENROUTER_API_KEY: "sk-test" };

  it("requires YouTube and the selected provider key and respects forced demo", () => {
    expect(wouldRunLive({ channel: "x" }, env)).toBe(true);
    expect(wouldRunLive({ channel: "x", demo: true }, env)).toBe(false);
    expect(wouldRunLive({ channel: "x", provider: "scaledown" }, env)).toBe(false);
    expect(wouldRunLive({ channel: "x" }, { OPENROUTER_API_KEY: "sk-test" })).toBe(false);
  });

  it.each([
    [undefined, false, "openrouter"],
    [undefined, true, "scaledown"],
    ["openrouter", true, "openrouter"],
    ["scaledown", true, "scaledown"],
  ] as const)("runs live with selection %s and both keys %s", async (provider, both, expected) => {
    clearCommentCache();
    resetRouteCache();
    const original = mockFetch();
    let openrouterCalls = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith("https://openrouter.ai/")) {
        openrouterCalls++;
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("custom/model");
        const input = JSON.parse(body.messages[1].content);
        return json({ choices: [{ message: { content: JSON.stringify({ results: input.map((c: { id: string }) => ({ id: c.id, scores: { supportive: 1 } })) }) } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.002 } });
      }
      return original.f(url as string, init);
    }) as typeof fetch;
    const events = await run({ channel: "@mock", provider }, { env: { ...env, ...(both ? { SCALEDOWN_API_KEY: "sd-test" } : {}), OPENROUTER_MODEL: "custom/model" }, fetchImpl: f, sleep: async () => {}, demoDurationMs: 50 });
    const result = resultOf(events)?.result;
    expect(result?.demo).toBe(false);
    expect(result?.totals.comments).toBe(240);
    expect(result?.usage).toMatchObject({ provider: expected, model: expected === "openrouter" ? "custom/model" : "classify" });
    expect(openrouterCalls > 0).toBe(expected === "openrouter");
    if (expected === "openrouter") expect(result?.usage.costUsd).toBeCloseTo(0.024);
  });

  it("scrubs bearer credentials and replaces configuration names in user errors", () => {
    const msg = describeError(new Error('Authorization: Bearer sk-test; Check YOUTUBE_API_KEY and SCALEDOWN_API_KEY and OPENROUTER_API_KEY.'));
    expect(msg).not.toContain("sk-test");
    expect(msg).not.toMatch(/_API_KEY/);
    expect(msg).toContain("your YouTube key");
  });

  it("scrubs known keys even when a fetch error contains no bearer prefix", async () => {
    clearCommentCache();
    const events = await run({ channel: "@mock" }, { env, fetchImpl: async () => { throw new Error("request failed for yt-test and sk-test"); }, sleep: async () => {} });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/yt-test|sk-test/);
  });

  it("evaluates default environment safely without a process global", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("process", undefined);
    try { expect(wouldRunLive({ channel: "x" })).toBe(false); }
    finally { vi.unstubAllGlobals(); }
  });
});

it("points to the recorded run when no comments can be classified", async () => {
  clearCommentCache();
  const { f } = mockFetch();
  const wrapped = (async (input: unknown, init?: RequestInit) => String(input).endsWith("/v1/chat/completions") ? json({ results: [] }) : f(input as never, init)) as typeof fetch;
  const ev = await run({ channel: "@mock" }, { env: { SCALEDOWN_API_KEY: "sd-test", YOUTUBE_API_KEY: "yt-test" }, fetchImpl: wrapped, sleep: async () => {} });
  expect(ev.find((e) => e.type === "error")).toMatchObject({ message: "ScaleDown could not classify any of the comments. Try again in a minute, or watch the recorded run." });
});
