// Orchestrates a run (live or demo) and reports progress through `emit`. Always ends with `result` or `error`.
import type { AnalyzeRequest, ClassifiedComment, Persona, ProgressEvent, VideoInfo, WrappedResult } from "./types";
import type { RawComment } from "./raw";
import { buildPersonas, computeMostLoyal, computeTotals, perVideoStats, personaEvidence, sanitizeVerdict, topComments } from "./personas";
import {
  ScaledownError,
  createClassifier,
  profileTokens,
  scaledownConfigFromEnv,
  summarizeVerdict,
  usdForTokens,
  type Outcome,
  type ScaledownConfig,
} from "./scaledown";
import { createClassifier as createOpenrouterClassifier, summarizeVerdict as summarizeOpenrouterVerdict, DEFAULT_MODEL } from "./openrouter";
import { YoutubeError, collectChannelComments } from "./youtube";
import { generateDemo } from "./demo";
import { SCALEDOWN_USD_PER_M_INPUT, estimateTokens, sentimentFromScores } from "./vibes";
import { DEFAULT_COMMENTS_PER_VIDEO, DEFAULT_MAX_VIDEOS, pool, sleep as defaultSleep } from "./util";


export interface RunOptions {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total wall-clock length of a demo run. Default 12s (records well). */
  demoDurationMs?: number;
  /** live only: called once with every classified comment (incl. scores), just before the result event. Used for run persistence. */
  onClassified?: (all: ClassifiedComment[]) => void;
}

const MAX_VIDEOS = 100;
const DEFAULT_MAX_COMMENTS = DEFAULT_COMMENTS_PER_VIDEO;
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
};

function scrub(msg: string, keys: string[] = []): string {
  for (const key of keys) if (key) msg = msg.split(key).join("***");
  return msg.replace(/(Bearer\s+)[^\s"',;]+/gi, "$1***")
    .replace(/YOUTUBE_API_KEY/g, "your YouTube key")
    .replace(/SCALEDOWN_API_KEY/g, "your ScaleDown key")
    .replace(/OPENROUTER_API_KEY/g, "your OpenRouter key")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1***").replace(/(x-api-key"?:?\s*)[\w-]{8,}/gi, "$1***");
}

export function describeError(e: unknown): string {
  if (e instanceof YoutubeError) {
    if (e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded") return "The YouTube API daily quota is used up. Come back after midnight Pacific, or watch the recorded run.";
    if (e.reason === "keyInvalid" || e.reason === "accessNotConfigured") return "YouTube rejected the API key. Check your YouTube key and that YouTube Data API v3 is enabled.";
    return scrub(e.message);
  }
  if (e instanceof ScaledownError) return scrub(e.message);
  return scrub(e instanceof Error ? e.message : "Something went wrong.");
}

/** True when this request would spend real API credits (keys present and demo not forced). */
export function wouldRunLive(req: AnalyzeRequest, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return !req.demo && !!selectProvider(req, env) && !!env.YOUTUBE_API_KEY?.trim();
}

interface ProviderConfig {
  provider: "scaledown" | "openrouter";
  config: ScaledownConfig & { model?: string };
}

function selectProvider(req: AnalyzeRequest, env: Record<string, string | undefined>): ProviderConfig | null {
  const sd = scaledownConfigFromEnv(env);
  const key = env.OPENROUTER_API_KEY?.trim();
  const provider = req.provider ?? (sd ? "scaledown" : "openrouter");
  if (provider === "scaledown") return sd ? { provider, config: sd } : null;
  return key ? { provider, config: { apiKey: key, model: env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL } } : null;
}

export async function runAnalysis(req: AnalyzeRequest, emit: (e: ProgressEvent) => void, opts: RunOptions = {}): Promise<void> {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const keys = [env.YOUTUBE_API_KEY, env.SCALEDOWN_API_KEY, env.OPENROUTER_API_KEY].filter((k): k is string => !!k);
  const safeEmit = (e: ProgressEvent) => {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    emit(e.type === "error" || e.type === "status" ? { ...e, message: scrub(e.message, keys) } : e);
  };
  try {
    const selected = selectProvider(req, env);
    const ytKey = env.YOUTUBE_API_KEY?.trim();
    const live = !req.demo && !!selected && !!ytKey;
    if (live) await runLive(req, selected!, ytKey!, safeEmit, opts);
    else await runDemo(req, safeEmit, opts, req.demo ? "Demo mode" : "Demo mode (API keys not configured)");
  } catch (e) {
    if (opts.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
    emit({ type: "error", message: scrub(describeError(e), keys) });
  }
}

// ------------------------------------------------------------------ live

const YT_CONCURRENCY = 12; // videos fetched at once
const SAMPLE_PER_BATCH = 4;
const SUMMARIZE_TOP = 28;

async function runLive(req: AnalyzeRequest, selected: ProviderConfig, ytKey: string, emit: (e: ProgressEvent) => void, opts: RunOptions) {
  const maxVideos = clampInt(req.maxVideos, 1, MAX_VIDEOS, DEFAULT_MAX_VIDEOS);
  const maxComments = clampInt(req.maxCommentsPerVideo, 10, 2000, DEFAULT_MAX_COMMENTS);
  const { provider, config } = selected;
  const label = provider === "openrouter" ? "OpenRouter" : "ScaleDown";
  const cfg = { ...config, fetchImpl: opts.fetchImpl ?? config.fetchImpl, sleep: opts.sleep ?? config.sleep, signal: opts.signal };
  const makeClassifier = provider === "openrouter" ? createOpenrouterClassifier : createClassifier;
  const summarize = provider === "openrouter" ? summarizeOpenrouterVerdict : summarizeVerdict;
  const ctx = { key: ytKey, fetchImpl: opts.fetchImpl, sleep: opts.sleep, signal: opts.signal, quota: { used: 0 } };

  const classified: ClassifiedComment[] = [];
  let fetched = 0;
  const authors = new Set<string>(); // distinct commenters among the fetched comments, streamed as a real running count
  let expected = 0;
  let fetchDone = false;
  let videos: VideoInfo[] = [];
  let channel: WrappedResult["channel"] | null = null;

  const t0 = Date.now();
  const classifier = makeClassifier<RawComment>(cfg, (items, outcomes) => {
    for (const it of items) classified.push(toClassified(it, outcomes.get(it.id)!));
    const sample = items
      .filter((c) => c.text.trim().length >= 8)
      .slice(0, SAMPLE_PER_BATCH)
      .map((c) => toClassified(c, outcomes.get(c.id)!));
    emit({
      type: "classified",
      done: classified.length,
      total: Math.max(classified.length, fetchDone ? fetched : expected),
      costUsd: classifier.usage().costUsd,
      elapsedMs: classifier.busyMs(),
      sample,
    });
  });

  emit({ type: "status", stage: "resolving", message: "Finding the channel…" });
  const got = await collectChannelComments(
    { channel: req.channel, maxVideos, maxCommentsPerVideo: maxComments, concurrency: YT_CONCURRENCY, order: req.order === "time" ? "time" : "relevance" },
    {
      onChannel: (c) => {
        channel = { id: c.id, title: c.title, handle: c.handle, avatar: c.avatar, subscriberCount: c.subscriberCount };
        emit({ type: "channel", channel });
        emit({ type: "status", stage: "videos", message: "Listing recent videos…" });
      },
      onVideos: (v) => {
        // commentCount is what this run will fetch (capped), not YouTube's full count: the Reading strip advances by it.
        videos = v.map((x) => ({
          id: x.id,
          title: x.title,
          publishedAt: x.publishedAt,
          thumbnail: x.thumbnail,
          commentCount: x.commentsDisabled ? 0 : Math.min(maxComments, x.commentCount),
        }));
        expected = v.reduce((a, x) => a + (x.commentsDisabled ? 0 : Math.min(maxComments, x.commentCount)), 0);
        emit({ type: "videos", videos });
        emit({ type: "status", stage: "comments", message: `Reading comments from ${v.length} videos…` });
      },
      onComments: (page, total) => {
        fetched = total;
        for (const c of page) authors.add(c.authorId);
        emit({ type: "fetched", total, commenters: authors.size });
        classifier.push(page);
      },
      onWarning: (message) => emit({ type: "status", stage: "comments", message }),
      // If the classifier is already dead (no credits, bad key) stop spending YouTube quota and fail now, not after the last page.
      shouldStop: () => classifier.failed(),
    },
    ctx,
  );
  fetchDone = true;
  emit({ type: "fetched", total: fetched, commenters: authors.size });
  emit({ type: "status", stage: "classifying", message: `Classifying ${fetched.toLocaleString("en-US")} comments with ${label}…` });
  await classifier.drain();

  const unclassified = Math.max(0, fetched - classified.length);
  if (unclassified > 0) console.warn(`[pipeline] ${unclassified} of ${fetched} comments could not be classified and are left out of the totals.`);
  // Close the progress at 100% of what was actually classified, so the bar never ends short of "total".
  emit({ type: "classified", done: classified.length, total: classified.length, costUsd: classifier.usage().costUsd, elapsedMs: classifier.busyMs(), sample: [] });

  if (classified.length === 0) {
    throw new Error(
      fetched > 0
        ? `${label} could not classify any of the comments. Try again in a minute, or watch the recorded run.`
        : "No comments could be read from that channel (comments may be disabled).",
    );
  }

  emit({ type: "status", stage: "profiling", message: "Profiling commenters…" });
  classified.sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0));
  const owner = channel ?? got.channel;
  // Arcs follow VIDEO publish order; the channel's own account (a creator replying under their videos) is not a fan.
  const personas = buildPersonas(classified, { videos, excludeAuthorIds: [owner.id] });
  const mostLoyal = computeMostLoyal(classified, videos, [owner.id]);
  const extra = { tokens: 0, cost: 0, calls: 0, estimated: false };
  if (!opts.signal?.aborted) await upgradeVerdicts(personas, cfg, extra, new Map(videos.map((v) => [v.id, v.title])), summarize);

  const usage = classifier.usage();
  const inputTokens = usage.inputTokens + extra.tokens;
  const providerUsage = { provider, model: provider === "openrouter" ? cfg.model ?? DEFAULT_MODEL : "classify" };
  const counts = new Map<string, number>();
  for (const c of classified) counts.set(c.videoId, (counts.get(c.videoId) ?? 0) + 1);
  const result: WrappedResult = {
    channel: channel ?? got.channel,
    videos: videos.map((v) => ({ ...v, commentCount: counts.get(v.id) ?? 0 })),
    totals: computeTotals(classified),
    personas,
    ...(mostLoyal ? { mostLoyal } : {}),
    topComments: topComments(classified),
    perVideo: perVideoStats(classified, videos),
    usage: {
      ...providerUsage,
      inputTokens,
      costUsd: usage.costUsd + extra.cost,
      elapsedMs: classifier.busyMs(), // classification time only (requests in flight)
      endToEndMs: Date.now() - t0, // includes YouTube fetching
      classifyCalls: usage.calls,
      unclassified,
      estimated: usage.estimated || extra.estimated,
    },
    demo: false,
  };
  opts.onClassified?.(classified);
  emit({ type: "result", result });
  emit({ type: "status", stage: "done", message: "Done." });
}

function toClassified(c: RawComment, o: Outcome): ClassifiedComment {
  return {
    id: c.id,
    videoId: c.videoId,
    authorId: c.authorId,
    authorName: c.authorName,
    authorAvatar: c.authorAvatar,
    text: c.text.slice(0, 600),
    likes: c.likes,
    publishedAt: c.publishedAt,
    vibe: o.vibe,
    scores: o.scores,
    sentiment: sentimentFromScores(o.scores),
  };
}

/** Replace templated verdicts with provider one-liners for the featured personas. Never throws. */
export async function upgradeVerdicts(
  personas: Persona[],
  cfg: ScaledownConfig,
  extra: { tokens: number; cost: number; calls: number; estimated: boolean },
  videoTitles?: ReadonlyMap<string, string>,
  summarize: typeof summarizeVerdict = summarizeVerdict,
) {
  const perKindSeen = new Map<string, number>();
  const featured: Persona[] = [];
  for (const p of personas) {
    if (p.kind === "one_bad_day") continue; // its template counts are computed from data; a model's counts are not verified
    const n = perKindSeen.get(p.kind) ?? 0;
    if (n < 4 && featured.length < SUMMARIZE_TOP) {
      featured.push(p);
      perKindSeen.set(p.kind, n + 1);
    }
  }
  let dead = false;
  await pool(featured, 8, async (p) => {
    if (dead || cfg.signal?.aborted) return;
    try {
      const evidence = personaEvidence(p, videoTitles);
      const r = await summarize(evidence, cfg);
      extra.tokens += r.inputTokens;
      extra.cost += r.costUsd;
      if (r.inputTokens > 0) extra.calls++;
      if (r.estimated) extra.estimated = true;
      // Bland, over-long or handle-bearing output falls back to the template already on the persona.
      const clean = sanitizeVerdict(r.text, [p.authorName], { evidence: evidence.split("\n").slice(1).join("\n") });
      if (clean) p.verdict = clean;
    } catch {
      dead = true; // fatal (bad key / no credits) or aborted: keep templated verdicts
    }
  });
}

// ------------------------------------------------------------------ demo

const smooth = (x: number) => Math.min(1, Math.max(0, x));
/** Slightly bursty progress curve, still monotonic enough after max() with the previous value. */
const curve = (x: number) => smooth(x + 0.035 * Math.sin(x * Math.PI * 9) * (1 - x));

async function runDemo(req: AnalyzeRequest, emit: (e: ProgressEvent) => void, opts: RunOptions, banner: string) {
  const sleep = opts.sleep ?? defaultSleep;
  const D = Math.max(50, opts.demoDurationMs ?? 12000);
  const data = generateDemo({ maxVideos: req.maxVideos, maxCommentsPerVideo: req.maxCommentsPerVideo });

  // YouTube returns newest video first, newest comment first.
  const vidRank = new Map(data.videos.map((v, i) => [v.id, i]));
  const order = [...data.comments].sort((a, b) => (vidRank.get(a.videoId)! - vidRank.get(b.videoId)!) || (a.publishedAt < b.publishedAt ? 1 : -1));
  const total = order.length;

  emit({ type: "status", stage: "resolving", message: `${banner}. Finding the channel…` });
  await sleep(D * 0.05);
  emit({ type: "channel", channel: data.channel });
  emit({ type: "status", stage: "videos", message: "Listing recent videos…" });
  await sleep(D * 0.04);
  emit({ type: "videos", videos: data.videos });
  emit({ type: "status", stage: "comments", message: `Reading comments from ${data.videos.length} videos…` });

  const mainMs = D * 0.8;
  const tick = Math.max(10, Math.round(D / 150));
  const classifyStart = 0.12; // classification begins shortly after the first comments land
  const fetchEnd = 0.55; // fetching finishes at this fraction of the main phase
  const t0 = Date.now();
  let fetchedN = 0;
  let doneN = 0;
  let tokens = 0;
  let calls = 0;
  let announcedClassify = false;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const profile = profileTokens();

  while (true) {
    const elapsed = Date.now() - t0;
    const x = Math.min(1, elapsed / mainMs);
    const targetFetched = Math.round(total * curve(Math.min(1, x / fetchEnd)));
    const targetDone = Math.min(targetFetched, Math.round(total * curve(Math.max(0, (x - classifyStart) / (1 - classifyStart)))));
    const finalTick = x >= 1;
    if (targetFetched > fetchedN || finalTick) {
      fetchedN = finalTick ? total : Math.max(fetchedN, targetFetched);
      emit({ type: "fetched", total: fetchedN });
    }
    if (!announcedClassify && fetchedN > 0 && x >= classifyStart) {
      announcedClassify = true;
      emit({ type: "status", stage: "classifying", message: `Classifying ${total.toLocaleString("en-US")} comments with ScaleDown…` });
    }
    const goal = finalTick ? total : targetDone;
    if (goal > doneN) {
      // Batches of 50, like the real client: bill the label profile once per batch.
      for (let i = doneN; i < goal; i += 50) {
        const end = Math.min(goal, i + 50);
        let t = profile;
        for (let j = i; j < end; j++) t += estimateTokens(order[j].text.length);
        tokens += t;
        calls++;
      }
      const picks: ClassifiedComment[] = [];
      for (let k = 0; k < 14 && picks.length < SAMPLE_PER_BATCH; k++) {
        const c = order[doneN + Math.floor(rnd() * (goal - doneN))];
        if (c.text.length >= 18 && c.text.length <= 120 && !picks.includes(c)) picks.push(c);
      }
      doneN = goal;
      emit({
        type: "classified",
        done: doneN,
        total,
        costUsd: usdForTokens(tokens),
        elapsedMs: Math.max(0, elapsed - mainMs * classifyStart),
        sample: picks,
      });
    }
    if (finalTick && doneN >= total) break;
    await sleep(tick);
  }
  const classifyMs = Math.max(1, Date.now() - t0 - mainMs * classifyStart);

  emit({ type: "status", stage: "profiling", message: "Profiling commenters…" });
  await sleep(D * 0.06);
  const personas = buildPersonas(data.comments);
  const result: WrappedResult = {
    channel: data.channel,
    videos: data.videos,
    totals: computeTotals(data.comments),
    personas,
    topComments: topComments(data.comments),
    perVideo: perVideoStats(data.comments, data.videos),
    usage: {
      inputTokens: tokens,
      // SIMULATED: same math as the live path (tokens x $0.05/M), applied to synthetic comments.
      costUsd: (tokens * SCALEDOWN_USD_PER_M_INPUT) / 1_000_000,
      elapsedMs: Math.round(classifyMs),
      classifyCalls: calls,
    },
    demo: true,
  };
  await sleep(D * 0.04);
  emit({ type: "result", result });
  emit({ type: "status", stage: "done", message: "Done." });
}
