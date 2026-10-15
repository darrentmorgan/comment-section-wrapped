import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  YoutubeError,
  cleanText,
  clearCommentCache,
  collectChannelComments,
  fetchVideoComments,
  listRecentVideos,
  mapThread,
  parseChannelInput,
  parseIsoDuration,
  resolveChannel,
} from "../youtube";

const UC = "UC" + "a".repeat(22);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const err = (status: number, reason: string, message = "x") => json({ error: { code: status, message, errors: [{ reason }] } }, status);
const mkctx = (f: unknown) => ({ key: "K", fetchImpl: f as typeof fetch, sleep: async () => {}, quota: { used: 0 } });

describe("parseChannelInput", () => {
  it("parses ids, handles, urls, legacy forms", () => {
    expect(parseChannelInput(UC)).toEqual({ kind: "id", value: UC });
    expect(parseChannelInput(`https://www.youtube.com/channel/${UC}`)).toEqual({ kind: "id", value: UC });
    expect(parseChannelInput("@MrBeast")).toEqual({ kind: "handle", value: "@MrBeast" });
    expect(parseChannelInput("https://youtube.com/@some.handle/videos?x=1")).toEqual({ kind: "handle", value: "@some.handle" });
    expect(parseChannelInput("youtube.com/@%E3%83%86%E3%82%B9%E3%83%88")).toEqual({ kind: "handle", value: "@テスト" });
    expect(parseChannelInput("https://www.youtube.com/user/legacyName")).toEqual({ kind: "username", value: "legacyName" });
    expect(parseChannelInput("https://www.youtube.com/c/CustomName")).toEqual({ kind: "custom", value: "CustomName" });
    expect(parseChannelInput("https://www.youtube.com/SomeName")).toEqual({ kind: "custom", value: "SomeName" });
    expect(parseChannelInput("barehandle")).toEqual({ kind: "custom", value: "barehandle" });
  });
  it("survives malformed percent sequences and never treats youtu.be as a channel", () => {
    expect(() => parseChannelInput("@foo%")).not.toThrow();
    expect(parseChannelInput("@foo%")).toEqual({ kind: "handle", value: "@foo%" });
    expect(parseChannelInput("https://www.youtube.com/@bad%zz/videos")).toEqual({ kind: "handle", value: "@bad%zz" });
    expect(parseChannelInput("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
  });
  it("rejects junk and non-channel urls", () => {
    expect(parseChannelInput("")).toBeNull();
    expect(parseChannelInput("https://example.com/@x")).toBeNull();
    expect(parseChannelInput("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(parseChannelInput("two words")).toBeNull();
  });
});

describe("resolveChannel", () => {
  it("uses forHandle and maps the channel", async () => {
    const f = vi.fn(async () =>
      json({
        items: [
          {
            id: UC,
            snippet: { title: "Chan", customUrl: "@chan", thumbnails: { default: { url: "d" }, high: { url: "h" } } },
            statistics: { subscriberCount: "1200", videoCount: "50" },
            contentDetails: { relatedPlaylists: { uploads: "UUxyz" } },
          },
        ],
      }),
    );
    const ch = await resolveChannel({ kind: "handle", value: "@chan" }, mkctx(f));
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("forHandle=%40chan");
    expect(ch).toMatchObject({ id: UC, title: "Chan", handle: "@chan", avatar: "h", uploadsPlaylistId: "UUxyz", subscriberCount: 1200, videoCount: 50 });
  });
  it("custom names fall back handle -> username, then 404 with help", async () => {
    const f = vi.fn(async () => json({}));
    await expect(resolveChannel({ kind: "custom", value: "nope" }, mkctx(f))).rejects.toMatchObject({ status: 404, reason: "channelNotFound" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(String((f.mock.calls[1] as unknown[])[0])).toContain("forUsername=nope");
  });
});

describe("listRecentVideos", () => {
  it("skips private/deleted, maps stats, flags comments disabled, caps at maxVideos", async () => {
    const f = vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes("/playlistItems")) {
        return json({
          items: [
            { snippet: { title: "a" }, contentDetails: { videoId: "v1" } },
            { snippet: { title: "Private video" }, contentDetails: { videoId: "vp" } },
            { snippet: { title: "b" }, contentDetails: { videoId: "v2" } },
            { snippet: { title: "c" }, contentDetails: { videoId: "v3" } },
          ],
        });
      }
      return json({
        items: [
          { id: "v1", snippet: { title: "A", publishedAt: "2026-01-02T00:00:00Z", thumbnails: { high: { url: "t1" } } }, statistics: { commentCount: "12", viewCount: "100" }, contentDetails: { duration: "PT10M5S" } },
          { id: "v2", snippet: { title: "B", publishedAt: "2026-01-01T00:00:00Z" }, statistics: { viewCount: "5" }, contentDetails: { duration: "PT30S" } },
          { id: "v3", snippet: { title: "C", publishedAt: "2025-12-01T00:00:00Z" }, statistics: { commentCount: "3" } },
        ],
      });
    });
    const vs = await listRecentVideos({ uploadsPlaylistId: "UUx" } as never, { maxVideos: 2 }, mkctx(f));
    expect(vs.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(vs[0]).toMatchObject({ commentCount: 12, commentsDisabled: false, durationSec: 605, thumbnail: "t1" });
    expect(vs[1].commentsDisabled).toBe(true);
    expect(vs[1].thumbnail).toContain("i.ytimg.com/vi/v2");
  });
  it("shorts can be excluded", async () => {
    const f = vi.fn(async (u: unknown) =>
      String(u).includes("/playlistItems")
        ? json({ items: [{ snippet: { title: "s" }, contentDetails: { videoId: "s1" } }] })
        : json({ items: [{ id: "s1", snippet: {}, statistics: { commentCount: "1" }, contentDetails: { duration: "PT45S" } }] }),
    );
    expect(await listRecentVideos({ uploadsPlaylistId: "UUx" } as never, { maxVideos: 5, includeShorts: false }, mkctx(f))).toHaveLength(0);
  });
  it("empty channel (playlistNotFound) yields no videos", async () => {
    const f = vi.fn(async () => err(404, "playlistNotFound"));
    expect(await listRecentVideos({ uploadsPlaylistId: "UUx" } as never, { maxVideos: 5 }, mkctx(f))).toEqual([]);
  });
});

const thread = (id: string, author?: string) => ({
  snippet: {
    videoId: "v1",
    totalReplyCount: 2,
    topLevelComment: { id, snippet: { authorDisplayName: "@Someone", authorProfileImageUrl: "av", authorChannelId: author ? { value: author } : undefined, textDisplay: `text ${id}`, likeCount: 3, publishedAt: "2026-01-01T00:00:00Z" } },
  },
});

describe("comments", () => {
  beforeEach(() => clearCommentCache());

  it("maps threads; falls back to a name hash when authorChannelId is missing", () => {
    const a = mapThread(thread("c1", "UCx"), "v1")!;
    expect(a).toMatchObject({ id: "c1", authorId: "UCx", likes: 3, replyCount: 2 });
    const b = mapThread(thread("c2"), "v1")!;
    expect(b.authorId).toMatch(/^name_/);
  });

  it("pages until the cap, requests plainText/time/100", async () => {
    let call = 0;
    const f = vi.fn(async () => {
      call++;
      return json({ items: Array.from({ length: 100 }, (_, i) => thread(`p${call}_${i}`, "UCx")), nextPageToken: "more" });
    });
    const pages: number[] = [];
    const r = await fetchVideoComments("v1", 250, mkctx(f), (p) => pages.push(p.length), "time");
    expect(r.comments).toHaveLength(250);
    expect(pages).toEqual([100, 100, 50]);
    expect(f).toHaveBeenCalledTimes(3);
    const url = String((f.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("textFormat=plainText");
    expect(url).toContain("order=time");
    expect(url).toContain("maxResults=100");
    expect(url).not.toContain("search");
  });

  it("skips comments-disabled videos silently", async () => {
    const f = vi.fn(async () => err(403, "commentsDisabled"));
    const r = await fetchVideoComments("v1", 100, mkctx(f));
    expect(r.skipped).toBe("disabled");
  });

  it("mapThread prefers textOriginal and cleans HTML textDisplay", () => {
    const t = thread("h1", "UCx");
    const sn = t.snippet.topLevelComment.snippet as Record<string, unknown>;
    sn.textDisplay = `It&#39;s great &amp; <a href="https://www.youtube.com/channel/UCzzz">@RealName</a><br>second &quot;line&quot;`;
    expect(mapThread(t, "v1")!.text).toBe(`It's great & @RealName\nsecond "line"`);
    sn.textOriginal = "raw original";
    expect(mapThread(t, "v1")!.text).toBe("raw original");
    expect(cleanText("a &lt;b&gt; &#x1F600; &unknown;")).toBe("a <b> \u{1F600} &unknown;");
  });

  it("requests textOriginal in the fields mask", async () => {
    const f = vi.fn(async () => json({ items: [thread("a", "UCx")] }));
    await fetchVideoComments("v1", 10, mkctx(f));
    expect(decodeURIComponent(String((f.mock.calls[0] as unknown[])[0]))).toContain("textOriginal");
  });

  it("a persistent rateLimitExceeded is NOT reported as comments-disabled", async () => {
    const f = vi.fn(async () => err(403, "rateLimitExceeded"));
    await expect(fetchVideoComments("v1", 100, mkctx(f))).rejects.toMatchObject({ reason: "rateLimitExceeded" });
    expect(f.mock.calls.length).toBeGreaterThan(3);
  });

  it("an explicit per-video forbidden is skipped; other 403s throw", async () => {
    expect((await fetchVideoComments("v1", 10, mkctx(vi.fn(async () => err(403, "forbidden"))))).skipped).toBe("forbidden");
    await expect(fetchVideoComments("v2", 10, mkctx(vi.fn(async () => err(403, "somethingElse"))))).rejects.toMatchObject({ status: 403 });
  });

  it("times out a hung request and retries it as a network error", async () => {
    let n = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (++n === 1) return new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("timed out"))));
      return json({ items: [thread("a", "UCx")] });
    });
    const r = await fetchVideoComments("v1", 10, { ...mkctx(f), timeoutMs: 20 });
    expect(r.comments).toHaveLength(1);
    expect(n).toBe(2);
  });

  it("quotaExceeded is fatal and not retried", async () => {
    const f = vi.fn(async () => err(403, "quotaExceeded"));
    await expect(fetchVideoComments("v1", 100, mkctx(f))).rejects.toSatisfy((e: YoutubeError) => e.fatal && e.reason === "quotaExceeded");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx with backoff", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 3 ? err(503, "backendError") : json({ items: [thread("a", "UCx")] })));
    const r = await fetchVideoComments("v1", 10, mkctx(f));
    expect(r.comments).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("serves repeat fetches from the in-memory cache", async () => {
    const f = vi.fn(async () => json({ items: [thread("a", "UCx")] }));
    await fetchVideoComments("v1", 10, mkctx(f));
    await fetchVideoComments("v1", 10, mkctx(f));
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("collectChannelComments", () => {
  beforeEach(() => clearCommentCache());
  it("resolves, lists, streams comments and tracks quota; skips zero-comment videos", async () => {
    const f = vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes("/channels")) return json({ items: [{ id: UC, snippet: { title: "T", customUrl: "@t" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } }, statistics: { videoCount: "2" } }] });
      if (url.includes("/playlistItems")) return json({ items: [{ snippet: { title: "a" }, contentDetails: { videoId: "v1" } }, { snippet: { title: "b" }, contentDetails: { videoId: "v2" } }] });
      if (url.includes("/videos?")) return json({ items: [{ id: "v1", snippet: { title: "A" }, statistics: { commentCount: "5" } }, { id: "v2", snippet: { title: "B" }, statistics: { commentCount: "0" } }] });
      return json({ items: [thread("a", "UCx"), thread("b", "UCy")] });
    });
    const got: number[] = [];
    const r = await collectChannelComments({ channel: "@t", maxVideos: 5, maxCommentsPerVideo: 100 }, { onComments: (_p, total) => got.push(total) }, mkctx(f));
    expect(got).toEqual([2]);
    expect(r.total).toBe(2);
    expect(r.quotaUsed).toBe(4); // channels + playlistItems + videos + 1 commentThreads page
  });
  const channelFetch = (commentHandler: (url: string) => Response, ids = ["v1", "v2", "v3"]) =>
    vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes("/channels")) return json({ items: [{ id: UC, snippet: { title: "T", customUrl: "@t" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } }, statistics: { videoCount: "3" } }] });
      if (url.includes("/playlistItems")) return json({ items: ids.map((id) => ({ snippet: { title: id }, contentDetails: { videoId: id } })) });
      if (url.includes("/videos?")) return json({ items: ids.map((id) => ({ id, snippet: { title: id }, statistics: { commentCount: "5" } })) });
      return commentHandler(url);
    });

  it("a flaky video is skipped with a warning and the run continues", async () => {
    const f = channelFetch((url) => (url.includes("videoId=v2") ? err(500, "backendError") : json({ items: [thread("a" + url.slice(-3), "UCx")] })));
    const warnings: string[] = [];
    const r = await collectChannelComments({ channel: "@t", maxVideos: 5, maxCommentsPerVideo: 100 }, { onWarning: (m) => warnings.push(m) }, mkctx(f));
    expect(r.total).toBe(2);
    expect(r.skipped).toEqual([{ videoId: "v2", reason: "backendError" }]);
    expect(warnings).toHaveLength(1);
  });

  it("every video failing is an error, not a silent empty run", async () => {
    const f = channelFetch(() => err(500, "backendError"));
    await expect(collectChannelComments({ channel: "@t", maxVideos: 5, maxCommentsPerVideo: 100 }, {}, mkctx(f))).rejects.toMatchObject({ status: 500 });
  });

  it("a fatal error aborts the pool and stops handing out videos", async () => {
    const f = channelFetch(() => err(403, "quotaExceeded"), ["v1", "v2", "v3", "v4", "v5", "v6"]);
    await expect(collectChannelComments({ channel: "@t", maxVideos: 6, maxCommentsPerVideo: 100, concurrency: 1 }, {}, mkctx(f))).rejects.toMatchObject({ reason: "quotaExceeded" });
    const commentCalls = f.mock.calls.filter((c) => String((c as unknown[])[0]).includes("/commentThreads"));
    expect(commentCalls).toHaveLength(1);
  });

  it("shouldStop aborts the run early", async () => {
    const f = channelFetch(() => json({ items: [thread("x", "UCx")] }), ["v1", "v2", "v3", "v4"]);
    const boom = new Error("classifier dead");
    let stop: Error | null = null;
    await expect(
      collectChannelComments(
        { channel: "@t", maxVideos: 4, maxCommentsPerVideo: 100, concurrency: 1 },
        { onComments: () => (stop = boom), shouldStop: () => stop },
        mkctx(f),
      ),
    ).rejects.toBe(boom);
    expect(f.mock.calls.filter((c) => String((c as unknown[])[0]).includes("/commentThreads"))).toHaveLength(1);
  });

  it("requests relevance order by default (top comments), time order on request, and caches per order", async () => {
    const f = channelFetch(() => json({ items: [thread("x", "UCx")] }), ["v1"]);
    await collectChannelComments({ channel: "@t", maxVideos: 1, maxCommentsPerVideo: 100 }, {}, mkctx(f));
    const urls = () => f.mock.calls.map((c) => String((c as unknown[])[0])).filter((u) => u.includes("/commentThreads"));
    expect(urls()[0]).toContain("order=relevance");
    await collectChannelComments({ channel: "@t", maxVideos: 1, maxCommentsPerVideo: 100, order: "time" }, {}, mkctx(f));
    expect(urls()).toHaveLength(2);
    expect(urls()[1]).toContain("order=time");
  });

  it("fetches 12 videos at once by default", async () => {
    clearCommentCache();
    const ids = Array.from({ length: 30 }, (_, i) => `vid${i}`);
    let inflight = 0;
    let peak = 0;
    const base = channelFetch(() => json({ items: [] }), ids);
    const f = vi.fn(async (u: unknown) => {
      const url = String(u);
      if (!url.includes("/commentThreads")) return base(u);
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return json({ items: [thread("c" + url.slice(-6), "UCx")] });
    });
    await collectChannelComments({ channel: "@t", maxVideos: 30, maxCommentsPerVideo: 100 }, {}, mkctx(f));
    expect(peak).toBe(12);
  });

  it("bad input gives a helpful error", async () => {
    await expect(collectChannelComments({ channel: "https://example.com", maxVideos: 1, maxCommentsPerVideo: 1 }, {}, mkctx(vi.fn()))).rejects.toMatchObject({ reason: "badInput" });
  });
});

describe("parseIsoDuration", () => {
  it("parses", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT59S")).toBe(59);
    expect(parseIsoDuration(undefined)).toBe(0);
  });
});
