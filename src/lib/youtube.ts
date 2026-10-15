// YouTube Data API v3 client. Server-side only. Public data, API key auth, 1 quota unit per call used here.
// Never calls search.list. Never logs comment text or handles.
import type { RawComment, ResolvedChannel, VideoMeta } from "./raw";
import { hash32, pool, sleep as defaultSleep } from "./util";

const BASE = "https://www.googleapis.com/youtube/v3";

export class YoutubeError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string,
  ) {
    super(message);
    this.name = "YoutubeError";
  }
  /** Errors that mean "stop the whole run and offer demo mode". */
  get fatal(): boolean {
    return (
      ["quotaExceeded", "dailyLimitExceeded", "keyInvalid", "accessNotConfigured", "ipRefererBlocked", "channelNotFound", "badKey"].includes(this.reason)
    );
  }
}

export interface YtContext {
  key: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  quota: { used: number };
  /** per-request timeout, default 15s */
  timeoutMs?: number;
  random?: () => number;
}

/** Exponential backoff with jitter so parallel workers do not retry in lockstep. */
function ytBackoff(attempt: number, ctx: YtContext): number {
  return 500 * 2 ** attempt + Math.floor((ctx.random ?? Math.random)() * 400);
}

export async function ytGet<T = Record<string, unknown>>(path: string, params: Record<string, string | number | undefined>, ctx: YtContext): Promise<T> {
  const f = ctx.fetchImpl ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  qs.set("key", ctx.key);
  const url = `${BASE}/${path}?${qs.toString()}`;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(ctx.timeoutMs ?? 15000);
      res = await f(url, { cache: "no-store", signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      // includes our own timeout: a hung connection is a retryable network error
      if (attempt < 3) {
        await sleep(ytBackoff(attempt, ctx));
        continue;
      }
      throw new YoutubeError(`YouTube network error: ${e instanceof Error ? e.message : String(e)}`, 0, "network");
    }
    ctx.quota.used += 1;
    if (res.ok) return (await res.json()) as T;

    let reason = "unknown";
    let message = `YouTube API ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };
      reason = j.error?.errors?.[0]?.reason ?? "unknown";
      message = j.error?.message ?? message;
      if (res.status === 400 && /API key/i.test(message)) reason = "keyInvalid";
    } catch {
      /* non-JSON error body */
    }
    const rateLimited = reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
    // Rate limits get more attempts than 5xx: a short burst usually clears within a few seconds.
    if ((res.status >= 500 && attempt < 3) || (rateLimited && attempt < 5)) {
      await sleep(ytBackoff(attempt, ctx));
      continue;
    }
    throw new YoutubeError(message, res.status, reason);
  }
}

// ---------------------------------------------------------------- channel resolution

export type ChannelRef = { kind: "id" | "handle" | "username" | "custom"; value: string };

const UC_RE = /^UC[\w-]{22}$/;

/** decodeURIComponent that returns the input untouched on a malformed percent sequence. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a URL, @handle, UC id, or bare word into a lookup reference. Returns null when it cannot be a channel. */
export function parseChannelInput(raw: string): ChannelRef | null {
  const input = (raw ?? "").trim();
  if (!input) return null;
  if (UC_RE.test(input)) return { kind: "id", value: input };
  if (input.startsWith("@")) return { kind: "handle", value: safeDecode(input.split(/[/?#\s]/)[0]) };

  if (/youtube\.com|youtu\.be/i.test(input) || /^https?:\/\//i.test(input)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      return null;
    }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null; // youtu.be/<id> is a video link, never a channel
    const seg = u.pathname.split("/").filter(Boolean).map(safeDecode);
    if (seg.length === 0) return null;
    if (seg[0].startsWith("@")) return { kind: "handle", value: seg[0] };
    if (seg[0] === "channel" && seg[1] && UC_RE.test(seg[1])) return { kind: "id", value: seg[1] };
    if (seg[0] === "user" && seg[1]) return { kind: "username", value: seg[1] };
    if (seg[0] === "c" && seg[1]) return { kind: "custom", value: seg[1] };
    if (["watch", "playlist", "shorts", "feed", "results", "live", "embed"].includes(seg[0])) return null;
    return { kind: "custom", value: seg[0] };
  }
  if (/^[\w.\-]{3,}$/.test(input)) return { kind: "custom", value: input };
  return null;
}

export const CHANNEL_HELP = "Paste the @handle, a youtube.com/@handle link, or a /channel/UC... URL.";

interface ChannelItem {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export async function resolveChannel(ref: ChannelRef, ctx: YtContext): Promise<ResolvedChannel> {
  const attempts: Record<string, string>[] =
    ref.kind === "id"
      ? [{ id: ref.value }]
      : ref.kind === "handle"
        ? [{ forHandle: ref.value }]
        : ref.kind === "username"
          ? [{ forUsername: ref.value }]
          : [{ forHandle: ref.value }, { forUsername: ref.value }];
  for (const filter of attempts) {
    const data = await ytGet<{ items?: ChannelItem[] }>("channels", { part: "snippet,contentDetails,statistics", ...filter }, ctx);
    const item = data.items?.[0];
    if (!item) continue;
    const uploads = item.contentDetails?.relatedPlaylists?.uploads ?? item.id.replace(/^UC/, "UU");
    const th = item.snippet?.thumbnails ?? {};
    return {
      id: item.id,
      title: item.snippet?.title ?? "Unknown channel",
      handle: item.snippet?.customUrl ?? "",
      avatar: th.high?.url ?? th.medium?.url ?? th.default?.url ?? "",
      uploadsPlaylistId: uploads,
      subscriberCount: item.statistics?.hiddenSubscriberCount ? undefined : item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : undefined,
      videoCount: Number(item.statistics?.videoCount ?? 0),
    };
  }
  throw new YoutubeError(`Channel not found. ${CHANNEL_HELP}`, 404, "channelNotFound");
}

// ---------------------------------------------------------------- videos

export function parseIsoDuration(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

interface PlaylistItem {
  snippet?: { title?: string; publishedAt?: string };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}
interface VideoItem {
  id: string;
  snippet?: { title?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> };
  statistics?: { commentCount?: string; viewCount?: string };
  contentDetails?: { duration?: string };
}

export interface ListVideosOptions {
  maxVideos: number;
  includeShorts?: boolean; // default true
}

/** Newest-first uploads with metadata. Skips private/deleted entries. */
export async function listRecentVideos(channel: ResolvedChannel, opts: ListVideosOptions, ctx: YtContext): Promise<VideoMeta[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  // Over-fetch 2x only when Shorts will be filtered out; otherwise one playlist page covers the default 30.
  const target = opts.includeShorts === false ? opts.maxVideos * 2 : opts.maxVideos;
  try {
    do {
      const page = await ytGet<{ items?: PlaylistItem[]; nextPageToken?: string }>(
        "playlistItems",
        { part: "snippet,contentDetails", playlistId: channel.uploadsPlaylistId, maxResults: 50, pageToken },
        ctx,
      );
      for (const it of page.items ?? []) {
        const t = it.snippet?.title;
        const id = it.contentDetails?.videoId;
        if (!id || t === "Private video" || t === "Deleted video") continue;
        ids.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < target);
  } catch (e) {
    if (e instanceof YoutubeError && e.reason === "playlistNotFound") return [];
    throw e;
  }

  const metas: VideoMeta[] = [];
  const candidates = ids.slice(0, target);
  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50);
    const data = await ytGet<{ items?: VideoItem[] }>("videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") }, ctx);
    const byId = new Map((data.items ?? []).map((v) => [v.id, v]));
    for (const id of batch) {
      const v = byId.get(id);
      if (!v) continue;
      const th = v.snippet?.thumbnails ?? {};
      const durationSec = parseIsoDuration(v.contentDetails?.duration);
      if (opts.includeShorts === false && durationSec > 0 && durationSec <= 60) continue;
      const hasCount = v.statistics?.commentCount !== undefined;
      metas.push({
        id,
        title: v.snippet?.title ?? "Untitled",
        publishedAt: v.snippet?.publishedAt ?? new Date(0).toISOString(),
        thumbnail: th.maxres?.url ?? th.standard?.url ?? th.high?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        commentCount: Number(v.statistics?.commentCount ?? 0) || 0,
        commentsDisabled: !hasCount,
        durationSec,
        viewCount: Number(v.statistics?.viewCount ?? 0) || 0,
      });
    }
  }
  return metas.slice(0, opts.maxVideos);
}

// ---------------------------------------------------------------- comments

interface ThreadItem {
  snippet?: {
    videoId?: string;
    totalReplyCount?: number;
    topLevelComment?: {
      id?: string;
      snippet?: {
        authorDisplayName?: string;
        authorProfileImageUrl?: string;
        authorChannelId?: { value?: string };
        textOriginal?: string;
        textDisplay?: string;
        likeCount?: number;
        publishedAt?: string;
      };
    };
  };
}

const THREAD_FIELDS =
  "nextPageToken,items(snippet(videoId,totalReplyCount,topLevelComment(id,snippet(authorDisplayName,authorProfileImageUrl,authorChannelId/value,textOriginal,textDisplay,likeCount,publishedAt))))";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode HTML entities and strip tags. Fallback for textDisplay, which is HTML unless textFormat=plainText is honoured. */
export function cleanText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
      if (g[0] === "#") {
        const cp = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        try {
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        } catch {
          return m;
        }
      }
      return ENTITIES[g.toLowerCase()] ?? m;
    });
}

export function mapThread(t: ThreadItem, fallbackVideoId: string): RawComment | null {
  const top = t.snippet?.topLevelComment;
  const s = top?.snippet;
  if (!top?.id || !s) return null;
  // textOriginal is the raw text; textDisplay can carry HTML (entities, <br>, <a> mention links) so it is cleaned.
  const text = typeof s.textOriginal === "string" ? s.textOriginal : typeof s.textDisplay === "string" ? cleanText(s.textDisplay) : null;
  if (text === null) return null;
  const name = s.authorDisplayName ?? "@unknown";
  return {
    id: top.id,
    videoId: t.snippet?.videoId ?? fallbackVideoId,
    // authorChannelId is the stable key; legacy/deleted accounts lack it, so hash the display name.
    authorId: s.authorChannelId?.value || `name_${hash32(name).toString(36)}`,
    authorName: name,
    authorAvatar: s.authorProfileImageUrl,
    text,
    likes: s.likeCount ?? 0,
    publishedAt: s.publishedAt ?? new Date(0).toISOString(),
    replyCount: t.snippet?.totalReplyCount ?? 0,
  };
}

// In-memory only (1h) so repeated demo recordings do not burn quota. Never persisted to disk (API ToS / privacy).
const cache = new Map<string, { at: number; comments: RawComment[] }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_VIDEOS = 60;

export function clearCommentCache() {
  cache.clear();
}

/** relevance = YouTube "Top comments" (best for repeat-commenter density); time = newest first */
export type CommentOrder = "relevance" | "time";

export type CommentsResult = { comments: RawComment[]; skipped?: "disabled" | "missing" | "forbidden" };

export async function fetchVideoComments(
  videoId: string,
  maxComments: number,
  ctx: YtContext,
  onPage?: (page: RawComment[]) => void,
  order: CommentOrder = "relevance",
): Promise<CommentsResult> {
  const ck = `${videoId}:${maxComments}:${order}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    if (onPage && hit.comments.length) onPage(hit.comments);
    return { comments: hit.comments };
  }
  const all: RawComment[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const data = await ytGet<{ items?: ThreadItem[]; nextPageToken?: string }>(
        "commentThreads",
        { part: "snippet", videoId, maxResults: 100, order, textFormat: "plainText", pageToken, fields: THREAD_FIELDS },
        ctx,
      );
      const page: RawComment[] = [];
      for (const t of data.items ?? []) {
        const c = mapThread(t, videoId);
        if (c && all.length + page.length < maxComments) page.push(c);
      }
      all.push(...page);
      if (page.length && onPage) onPage(page);
      pageToken = all.length >= maxComments ? undefined : data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof YoutubeError && !e.fatal) {
      if (e.reason === "commentsDisabled") return { comments: all, skipped: "disabled" };
      if (e.reason === "videoNotFound" || e.status === 404) return { comments: all, skipped: "missing" };
      if (e.reason === "forbidden") return { comments: all, skipped: "forbidden" };
      // Anything else (rate limits that outlast the retries, other 403s, 5xx) is NOT a skip reason: rethrow so the
      // caller records it as a failed video instead of silently dropping its comments as "disabled".
    }
    throw e;
  }
  if (cache.size >= CACHE_MAX_VIDEOS) cache.delete(cache.keys().next().value as string);
  cache.set(ck, { at: Date.now(), comments: all });
  return { comments: all };
}

// ---------------------------------------------------------------- orchestration

export interface CollectOptions {
  channel: string;
  maxVideos: number;
  maxCommentsPerVideo: number;
  concurrency?: number; // videos fetched in parallel (default 12)
  order?: CommentOrder; // default "relevance"
}
export interface CollectHandlers {
  onChannel?: (c: ResolvedChannel) => void;
  onVideos?: (v: VideoMeta[]) => void;
  /** every page of comments as it arrives; `total` is the running count across the channel */
  onComments?: (page: RawComment[], total: number) => void;
  /** a non-fatal per-video failure (video skipped, run continues) */
  onWarning?: (message: string) => void;
  /** polled before each video and page; return an Error to stop the whole run early (e.g. the classifier already failed) */
  shouldStop?: () => Error | null;
}

export interface SkippedVideo {
  videoId: string;
  reason: string;
}

export async function collectChannelComments(opts: CollectOptions, h: CollectHandlers, ctx: YtContext) {
  const ref = parseChannelInput(opts.channel);
  if (!ref) throw new YoutubeError(`That doesn't look like a YouTube channel. ${CHANNEL_HELP}`, 400, "badInput");
  const channel = await resolveChannel(ref, ctx);
  h.onChannel?.(channel);
  const videos = await listRecentVideos(channel, { maxVideos: opts.maxVideos }, ctx);
  if (videos.length === 0) throw new YoutubeError("That channel has no public videos to analyse.", 404, "noVideos");
  h.onVideos?.(videos);

  let total = 0;
  const skipped: SkippedVideo[] = [];
  const failures: YoutubeError[] = [];
  const targets = videos.filter((v) => !v.commentsDisabled && v.commentCount > 0);
  const stopIfNeeded = () => {
    const err = h.shouldStop?.();
    if (err) throw err;
  };
  await pool(targets, opts.concurrency ?? 12, async (v) => {
    stopIfNeeded();
    try {
      const r = await fetchVideoComments(v.id, opts.maxCommentsPerVideo, ctx, (page) => {
        stopIfNeeded();
        total += page.length;
        h.onComments?.(page, total);
      }, opts.order ?? "relevance");
      if (r.skipped) skipped.push({ videoId: v.id, reason: r.skipped });
    } catch (e) {
      // Fatal (quota, bad key, ...) and aborts stop the run; a flaky single video does not.
      if (!(e instanceof YoutubeError) || e.fatal) throw e;
      failures.push(e);
      skipped.push({ videoId: v.id, reason: e.reason });
      h.onWarning?.(`Skipped one video (${e.reason === "unknown" ? `HTTP ${e.status}` : e.reason}). Carrying on.`);
    }
  });
  if (targets.length > 0 && failures.length === targets.length) throw failures[0];
  return { channel, videos, total, quotaUsed: ctx.quota.used, skipped };
}
