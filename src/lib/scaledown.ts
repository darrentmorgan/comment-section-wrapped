// ScaleDown client: Classify (batched chunks) + Summarize (persona one-liners). Server-side only.
// Spec notes: POST {base}/classify with {labels, chunks (max 50), reasoning:false}; NO `model` field.
// Route strategy: try the documented /classify first; on 403/404 fall back to the OpenAI-compatible chat route
// (model "classify", the route verified live, see docs/SCALEDOWN_NOTES.md) and cache the choice for the process.
// Correlate results by chunk id, never by order. Price: $0.05 / 1M input tokens, output free.
import type { Vibe } from "./types";
import { SCALEDOWN_USD_PER_M_INPUT, VIBES, estimateTokens, normalizeScores, topVibe } from "./vibes";
import { pool, sleep as defaultSleep } from "./util";

export const DEFAULT_BASE_URL = "https://api.scaledown.xyz";
export const CLASSIFY_BATCH_SIZE = 50;
export const MAX_COMMENT_CHARS = 500;

export type ClassifyRoute = "auto" | "native" | "chat";
export interface Throttle {
  /** epoch ms before which no worker should send a request */
  until: number;
}

export interface Label {
  name: string;
  rubric: string;
}

/**
 * One single-label (mutually exclusive) pass. Rubrics are short, positive yes/no questions.
 * Tuned on ~600 real MrBeast comments (top and newest): the earlier wording over-assigned question and spam (see docs/SCALEDOWN_NOTES.md).
 */
export const VIBE_LABELS: Label[] = [
  { name: "toxic", rubric: "Does this comment insult, mock, threaten, or hate on the creator or other people with real nastiness?" },
  { name: "critical", rubric: "Does this comment complain, disagree, or say something is bad, fake, overdone, or disappointing?" },
  {
    name: "supportive",
    rubric: "Does this comment express love, praise, thanks, excitement, encouragement, a fan reaction, a greeting, or a request to be part of the creator's videos?",
  },
  { name: "funny", rubric: "Is this comment a joke, meme, roast, pun, sarcastic quip, or playful humorous reaction?" },
  { name: "question", rubric: "Does this comment contain a real question that is looking for an answer, such as asking who, what, why, how, when, or where?" },
  {
    name: "spam",
    rubric: "Is this comment a bot-like or promotional message: a link, advert, scam, self-promotion, or copy-pasted text begging for money or prizes?",
  },
];

/** Sent as a system message on the chat route. Steers the ambiguous middle (greetings, pleas, jokes) so the mix is believable. */
export const VIBE_SYSTEM_PROMPT =
  "You label YouTube comments left on a hugely popular entertainment creator's videos. Most comments are fans reacting. Pick the single best label for how the commenter comes across. " +
  "Ordinary fan reactions, greetings, shout-outs, and requests to be in the creator's videos are supportive. Jokes, memes, and sarcastic quips are funny even when about the creator. " +
  "Only use question when the commenter genuinely asks something and expects an answer. Only use spam for bots, links, ads, scams, or self-promotion.";
// Keep the label names and Vibe in lockstep.
const _labelCheck: Vibe[] = VIBE_LABELS.map((l) => l.name as Vibe);
void _labelCheck;

export interface ScaledownConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** starting number of parallel requests (default 48). AIMD moves it between minConcurrency and maxConcurrency. */
  concurrency?: number;
  minConcurrency?: number; // default 16
  maxConcurrency?: number; // default 96
  /** system message for the classify call; pass "" to omit */
  systemPrompt?: string;
  /** observability: fires whenever the AIMD limit changes */
  onLimitChange?: (limit: number) => void;
  /** called on a 429, 5xx/504 or network/timeout failure (the classifier uses it to shrink its pool) */
  onBackoff?: () => void;
  maxRetries?: number; // default 4
  max429Retries?: number; // default 6: rate limits usually clear if we wait
  /** "auto" (default): documented /classify first, chat route on 403/404, choice cached. */
  route?: ClassifyRoute;
  /** aborts in-flight requests and skips retry sleeps (client disconnected) */
  signal?: AbortSignal;
  /** shared across all workers of one run so a 429 pauses everyone, not just the worker that saw it */
  throttle?: Throttle;
  /** called on every 429 (the classifier uses it to shrink its pool) */
  onRateLimit?: () => void;
  timeoutMs?: number; // default 60000 per call (launch-day latency is 5-15s with occasional 504s)
  batchSize?: number; // default 50 (hard max 50)
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** fixed waits (ms) per retry attempt, used instead of the exponential default (the rescue pass backs off harder) */
  backoffScheduleMs?: number[];
}

export class ScaledownError extends Error {
  constructor(
    message: string,
    public status: number,
    public fatal = false,
  ) {
    super(message);
    this.name = "ScaledownError";
  }
}

/** Strip trailing slash and a trailing /v1 so native endpoints resolve correctly. */
export function normalizeBaseUrl(url: string | undefined): string {
  let u = (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  u = u.replace(/\/v1$/, "");
  return u;
}

export function scaledownConfigFromEnv(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): ScaledownConfig | null {
  const apiKey = env.SCALEDOWN_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseUrl: env.SCALEDOWN_API_BASE };
}

/** Input tokens billed for the label profile, once per request. */
export function profileTokens(labels: Label[] = VIBE_LABELS, systemPrompt: string = VIBE_SYSTEM_PROMPT): number {
  return estimateTokens(labels.reduce((n, l) => n + l.name.length + l.rubric.length + 8, 0) + systemPrompt.length);
}

export function sanitizeText(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_COMMENT_CHARS);
  return t.length ? t : "[no text]";
}

export function usdForTokens(tokens: number): number {
  return (tokens * SCALEDOWN_USD_PER_M_INPUT) / 1_000_000;
}

export interface Usage {
  inputTokens: number;
  costUsd: number;
  calls: number;
  /** true when any part of inputTokens came from the local estimator instead of the API */
  estimated: boolean;
}
export const newUsage = (): Usage => ({ inputTokens: 0, costUsd: 0, calls: 0, estimated: false });

export interface Outcome {
  vibe: Vibe;
  scores: Record<Vibe, number>;
}

// ---------------------------------------------------------------- transport

function backoffMs(attempt: number, cfg: ScaledownConfig, retryAfter?: number): number {
  const rnd = (cfg.random ?? Math.random)();
  const sched = cfg.backoffScheduleMs;
  const base = (sched?.length ? sched[Math.min(attempt, sched.length - 1)] : Math.min(8000, 400 * 2 ** attempt)) + Math.floor(rnd * 250);
  // Honour Retry-After when it is reasonable (up to a minute) instead of retrying early into another 429.
  return retryAfter ? Math.min(60000, Math.max(base, retryAfter * 1000)) : base;
}

let loggedShape = false;

/** Throws the abort reason if the run was cancelled. */
function throwIfAborted(cfg: ScaledownConfig) {
  if (cfg.signal?.aborted) throw cfg.signal.reason ?? new DOMException("aborted", "AbortError");
}

async function post(path: string, body: unknown, cfg: ScaledownConfig): Promise<Record<string, unknown>> {
  const f = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleep ?? defaultSleep;
  const maxRetries = cfg.maxRetries ?? 4;
  const max429 = Math.max(maxRetries, cfg.max429Retries ?? 6);
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${path}`;
  let lastErr: ScaledownError | null = null;
  let rateLimited = 0;

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(cfg);
    // A 429 seen by any worker pauses all of them.
    const wait = (cfg.throttle?.until ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    throwIfAborted(cfg);

    let res: Response;
    try {
      const timeout = AbortSignal.timeout(cfg.timeoutMs ?? 60000);
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
        body: JSON.stringify(body),
        signal: cfg.signal ? AbortSignal.any([cfg.signal, timeout]) : timeout,
      });
    } catch (e) {
      if (cfg.signal?.aborted) throw e;
      lastErr = new ScaledownError(`ScaleDown network error: ${e instanceof Error ? e.message : String(e)}`, 0);
      cfg.onBackoff?.();
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt, cfg));
        continue;
      }
      throw lastErr;
    }
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      if (!loggedShape && typeof process !== "undefined" && process.env.NODE_ENV !== "production" && path === "/v1/chat/completions") {
        loggedShape = true;
        console.info("[scaledown] chat/completions response keys:", Object.keys(json));
      }
      return json;
    }
    if (res.status === 401 || res.status === 403) throw new ScaledownError(`ScaleDown rejected the key (${res.status}).`, res.status, true);
    if (res.status === 402) throw new ScaledownError("ScaleDown says the account is out of credits (402).", 402, true);
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      lastErr = new ScaledownError(`ScaleDown request failed (${res.status}). Try again in a minute.`, res.status);
      const is429 = res.status === 429;
      if (is429) rateLimited++;
      cfg.onBackoff?.();
      const limit = is429 ? max429 : maxRetries;
      if ((is429 ? rateLimited - 1 : attempt) < limit) {
        const ra = Number(res.headers.get("retry-after"));
        const delay = backoffMs(is429 ? rateLimited - 1 : attempt, cfg, Number.isFinite(ra) && ra > 0 ? ra : undefined);
        if (is429) {
          if (cfg.throttle) cfg.throttle.until = Math.max(cfg.throttle.until, Date.now() + delay);
          cfg.onRateLimit?.();
        }
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }
    throw new ScaledownError(`ScaleDown request failed (${res.status}). Try again in a minute.`, res.status);
  }
}

// ---------------------------------------------------------------- classify

interface ChunkIn {
  id: string;
  text: string;
}

function readTokens(body: Record<string, unknown>): number | null {
  const u = body.usage as Record<string, unknown> | undefined;
  const cands = [u?.input_tokens, body.input_tokens, u?.prompt_tokens];
  for (const c of cands) if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  return null;
}
function readCost(body: Record<string, unknown>): number | null {
  const u = body.usage as Record<string, unknown> | undefined;
  const c = u?.cost ?? body.cost;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
}

function parseResult(r: Record<string, unknown>): Outcome | null {
  let partial: Record<string, number> | null = null;
  if (r.scores && typeof r.scores === "object") partial = r.scores as Record<string, number>;
  else if (Array.isArray(r.labels)) {
    partial = {};
    for (const l of r.labels as { label?: string; score?: number }[]) if (l?.label) partial[l.label] = Number(l.score);
  }
  if (!partial) return null;
  const scores = normalizeScores(partial);
  const total = VIBES.reduce((a, v) => a + (Number(partial![v]) > 0 ? 1 : 0), 0);
  if (total === 0) return null;
  const top = typeof r.top_label === "string" && (VIBES as string[]).includes(r.top_label) ? (r.top_label as Vibe) : topVibe(scores);
  return { vibe: top, scores };
}

/** Chat-completions wraps the classify payload as a JSON string in choices[0].message.content. Plain bodies pass through. */
function unwrapChat(raw: Record<string, unknown>): Record<string, unknown> {
  const choices = raw.choices as { message?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") return raw;
  try {
    const inner = JSON.parse(content) as Record<string, unknown>;
    return { ...inner, usage: inner.usage ?? raw.usage };
  } catch {
    return raw;
  }
}

// Which route works for this key, learned once per process: "key|base" -> route.
const routeCache = new Map<string, "native" | "chat">();
export const resetRouteCache = () => routeCache.clear();
const routeKey = (cfg: ScaledownConfig) => `${cfg.apiKey}|${normalizeBaseUrl(cfg.baseUrl)}`;

const nativeBody = (payload: ChunkIn[]) => ({ labels: VIBE_LABELS, chunks: payload, reasoning: false });
const chatBody = (payload: ChunkIn[], cfg: ScaledownConfig) => ({
  model: "classify",
  messages: [
    ...((cfg.systemPrompt ?? VIBE_SYSTEM_PROMPT) ? [{ role: "system", content: cfg.systemPrompt ?? VIBE_SYSTEM_PROMPT }] : []),
    { role: "user", content: "classify" },
  ],
  labels: VIBE_LABELS,
  chunks: payload,
  reasoning: false,
});

const forbiddenClassify = () =>
  new ScaledownError("ScaleDown rejected the key (403).", 403, true);

/** Send one classify request using the cached or discovered route and return the unwrapped body. */
async function classifyRequest(payload: ChunkIn[], cfg: ScaledownConfig): Promise<Record<string, unknown>> {
  const mode = cfg.route ?? "auto";
  const key = routeKey(cfg);
  const first: "native" | "chat" = mode === "native" ? "native" : mode === "chat" ? "chat" : (routeCache.get(key) ?? "native");

  const viaNative = async () => post("/classify", nativeBody(payload), cfg);
  const viaChat = async () => unwrapChat(await post("/v1/chat/completions", chatBody(payload, cfg), cfg));
  const gone = (e: unknown) => e instanceof ScaledownError && (e.status === 403 || e.status === 404);

  if (first === "chat") {
    try {
      const body = await viaChat();
      if (mode === "auto") routeCache.set(key, "chat");
      return body;
    } catch (e) {
      if (e instanceof ScaledownError && e.status === 403) throw forbiddenClassify();
      throw e;
    }
  }
  try {
    const body = await viaNative();
    if (mode === "auto") routeCache.set(key, "native");
    return body;
  } catch (e) {
    if (mode !== "auto" || !gone(e)) {
      if (e instanceof ScaledownError && e.status === 403) throw forbiddenClassify();
      throw e;
    }
  }
  // Documented route refused this key (or does not exist): use the OpenAI-compatible route and remember it.
  try {
    const body = await viaChat();
    routeCache.set(key, "chat");
    return body;
  } catch (e) {
    if (e instanceof ScaledownError && e.status === 403) throw forbiddenClassify();
    throw e;
  }
}

export interface BatchResult {
  outcomes: Map<string, Outcome>;
  /** ids ScaleDown could not classify (422 on a single chunk, or missing from the response) */
  unclassified: string[];
}

/** Classify up to 50 chunks in one request. Splits and retries once on 422. Accumulates into `usage`. */
export async function classifyBatch(chunks: ChunkIn[], cfg: ScaledownConfig, usage: Usage = newUsage()): Promise<BatchResult> {
  const outcomes = new Map<string, Outcome>();
  const unclassified: string[] = [];
  if (chunks.length === 0) return { outcomes, unclassified };
  const size = Math.min(cfg.batchSize ?? CLASSIFY_BATCH_SIZE, CLASSIFY_BATCH_SIZE);
  if (chunks.length > size) throw new Error(`classifyBatch: max ${size} chunks per request`);

  const payload = chunks.map((c) => ({ id: c.id, text: sanitizeText(c.text) }));
  let body: Record<string, unknown>;
  try {
    body = await classifyRequest(payload, cfg);
  } catch (e) {
    if (e instanceof ScaledownError && e.status === 422) {
      if (chunks.length === 1) return { outcomes, unclassified: [chunks[0].id] };
      const mid = Math.ceil(chunks.length / 2);
      const [a, b] = await Promise.all([classifyBatch(chunks.slice(0, mid), cfg, usage), classifyBatch(chunks.slice(mid), cfg, usage)]);
      for (const part of [a, b]) {
        for (const [k, v] of part.outcomes) outcomes.set(k, v);
        unclassified.push(...part.unclassified);
      }
      return { outcomes, unclassified };
    }
    throw e;
  }

  // A body without a results array is a malformed/changed response, not "nothing matched". Fail loudly instead of
  // silently marking every comment unclassified (and billing for it).
  if (!Array.isArray(body.results)) {
    throw new ScaledownError(`ScaleDown classify returned an unexpected response (no results array; keys: ${Object.keys(body).slice(0, 6).join(", ") || "none"}).`, 502);
  }
  const results = body.results as Record<string, unknown>[];
  const wanted = new Set(payload.map((p) => p.id));
  for (const r of results) {
    const id = String(r.id ?? "");
    if (!wanted.has(id)) continue;
    const o = parseResult(r);
    if (o) outcomes.set(id, o);
  }
  for (const p of payload) if (!outcomes.has(p.id)) unclassified.push(p.id);

  // Usage: prefer what the API reports, else estimate (profile once per request + text chars).
  const reported = readTokens(body);
  const estimated = profileTokens(VIBE_LABELS, cfg.systemPrompt ?? VIBE_SYSTEM_PROMPT) + payload.reduce((n, p) => n + estimateTokens(p.text.length), 0);
  const tokens = reported ?? estimated;
  const cost = readCost(body) ?? usdForTokens(tokens);
  usage.inputTokens += tokens;
  usage.costUsd += cost;
  usage.calls += 1;
  if (reported === null) usage.estimated = true;
  return { outcomes, unclassified };
}

export interface Classifier<T extends ChunkIn> {
  push(items: T[]): void;
  /** Flush the partial batch and wait for every request to settle. Rejects on a run-fatal error (401/402/403 on classify). */
  drain(): Promise<void>;
  /** Non-null once the run can no longer succeed. Producers (the YouTube pool) poll this and stop early. */
  failed(): Error | null;
  usage(): Usage;
  /** Wall-clock time with at least one request in flight (honest "how fast is it"). */
  busyMs(): number;
  classifiedCount(): number;
  unclassifiedCount(): number;
  /** current effective concurrency (shrinks on 429/5xx/timeout, recovers on success) */
  concurrencyNow(): number;
}

/** After this many failed batches in a row with nothing ever classified, the run is considered dead. */
const MAX_CONSECUTIVE_BATCH_FAILURES = 5;
/** Dropped batches get a second pass at low concurrency with longer waits between attempts. */
const RESCUE_CONCURRENCY = 6;
const RESCUE_BACKOFF_MS = [2000, 5000, 10000];
/** Give up rescuing (and stop bisecting) after this many whole-batch failures with no rescue success: ScaleDown is down. */
const RESCUE_GIVE_UP_AFTER = 3;

/**
 * Streaming classifier: push comments as they arrive, batches of 50 are dispatched with bounded concurrency.
 * onBatch fires once per completed request with only the successfully classified items.
 *
 * Failure policy: only fatal errors (401, 402, 403 on classify) kill the run. A batch that exhausts its retries is set
 * aside (and warned about); after the main drain every set-aside batch gets a second pass at low concurrency with longer
 * backoff, and one that still fails is bisected so at most the single poison comment is lost. The run carries on, unless it
 * keeps failing without a single success.
 * Concurrency is AIMD (default 48, between 16 and 96): x0.6 on a 429/5xx/504/timeout (at most once per 2s; a 429 also pauses all workers), +1 after each success.
 */
export function createClassifier<T extends ChunkIn>(
  cfg: ScaledownConfig,
  onBatch: (items: T[], outcomes: Map<string, Outcome>) => void,
): Classifier<T> {
  const size = Math.min(cfg.batchSize ?? CLASSIFY_BATCH_SIZE, CLASSIFY_BATCH_SIZE);
  // An explicit `concurrency` without explicit bounds pins the ceiling (and caps the floor) at that value.
  const explicit = cfg.concurrency !== undefined;
  const minConcurrency = Math.max(1, cfg.minConcurrency ?? (explicit ? Math.min(16, cfg.concurrency!) : 16));
  const maxConcurrency = Math.max(minConcurrency, cfg.maxConcurrency ?? (explicit ? cfg.concurrency! : 96));
  let limit = Math.min(maxConcurrency, Math.max(minConcurrency, cfg.concurrency ?? 48));
  const throttle: Throttle = cfg.throttle ?? { until: 0 };
  const setLimit = (n: number) => {
    const next = Math.min(maxConcurrency, Math.max(minConcurrency, n));
    if (next !== limit) {
      limit = next;
      cfg.onLimitChange?.(limit);
    }
  };
  // Multiplicative decrease, at most once per window: when 48 requests in flight all hit a 504 together that is one
  // congestion event, not 48.
  let lastDecrease = 0;
  const DECREASE_WINDOW_MS = 2000;
  const bcfg: ScaledownConfig = {
    ...cfg,
    throttle,
    onRateLimit: () => cfg.onRateLimit?.(),
    onBackoff: () => {
      const now = Date.now();
      if (now - lastDecrease >= DECREASE_WINDOW_MS) {
        lastDecrease = now;
        setLimit(Math.floor(limit * 0.6));
      }
      cfg.onBackoff?.();
    },
  };
  const usage = newUsage();
  const queue: T[][] = [];
  let buffer: T[] = [];
  let inflight = 0;
  let failure: Error | null = null;
  let consecutiveFailures = 0;
  let busy = 0;
  let busySince = 0;
  let classified = 0;
  let unclassified = 0;
  const dropped: T[][] = [];
  let waiter: (() => void) | null = null;

  const settle = () => {
    if (waiter && inflight === 0 && (queue.length === 0 || failure)) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const pump = () => {
    while (!failure && inflight < limit && queue.length) {
      const chunk = queue.shift()!;
      if (inflight === 0) busySince = Date.now();
      inflight++;
      classifyBatch(chunk, bcfg, usage)
        .then((r) => {
          const ok = chunk.filter((c) => r.outcomes.has(c.id));
          classified += ok.length;
          unclassified += r.unclassified.length;
          consecutiveFailures = 0;
          setLimit(limit + 1);
          if (ok.length) onBatch(ok, r.outcomes);
        })
        .catch((e) => {
          const err = e instanceof Error ? e : new Error(String(e));
          const fatal = (e instanceof ScaledownError && e.fatal) || !!cfg.signal?.aborted;
          if (fatal) {
            failure ??= err;
            queue.length = 0;
            return;
          }
          // Retries exhausted (or a malformed response) for this batch only: set it aside for the second pass, keep the run alive.
          console.warn(`[scaledown] batch of ${chunk.length} dropped after retries, will retry once the main pass is done: status ${e instanceof ScaledownError ? e.status : 0}`);
          dropped.push(chunk);
          consecutiveFailures++;
          if (classified === 0 && consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
            failure ??= err;
            queue.length = 0;
          }
        })
        .finally(() => {
          inflight--;
          if (inflight === 0) busy += Date.now() - busySince;
          pump();
          settle();
        });
    }
  };

  /** Second pass for the batches the main pass set aside. Never throws; sets `failure` only on a fatal error. */
  const rescue = async () => {
    const t0 = Date.now();
    const rcfg: ScaledownConfig = { ...bcfg, maxRetries: 3, backoffScheduleMs: RESCUE_BACKOFF_MS };
    const hcfg: ScaledownConfig = { ...bcfg, maxRetries: 1, backoffScheduleMs: RESCUE_BACKOFF_MS.slice(0, 1) };
    let wholeFails = 0;
    let successes = 0;
    const tryBatch = async (chunk: T[], c: ScaledownConfig, bisect: boolean): Promise<void> => {
      if (failure || chunk.length === 0) return;
      try {
        const r = await classifyBatch(chunk, c, usage);
        const ok = chunk.filter((x) => r.outcomes.has(x.id));
        classified += ok.length;
        unclassified += r.unclassified.length;
        successes++;
        if (ok.length) onBatch(ok, r.outcomes);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if ((e instanceof ScaledownError && e.fatal) || cfg.signal?.aborted) {
          failure ??= err;
          return;
        }
        if (c === rcfg) wholeFails++;
        const hopeless = successes === 0 && wholeFails >= RESCUE_GIVE_UP_AFTER;
        if (bisect && chunk.length > 1 && !hopeless) {
          const mid = Math.ceil(chunk.length / 2);
          await tryBatch(chunk.slice(0, mid), hcfg, true);
          await tryBatch(chunk.slice(mid), hcfg, true);
          return;
        }
        unclassified += chunk.length;
        if (chunk.length === 1 || hopeless) console.warn(`[scaledown] ${chunk.length} comment(s) could not be classified: status ${e instanceof ScaledownError ? e.status : 0}`);
      }
    };
    await pool(dropped.splice(0), RESCUE_CONCURRENCY, (chunk) => tryBatch(chunk, rcfg, true));
    busy += Date.now() - t0;
  };

  return {
    push(items) {
      if (failure) return;
      for (const it of items) buffer.push(it);
      while (buffer.length >= size) queue.push(buffer.splice(0, size));
      pump();
    },
    drain() {
      if (buffer.length && !failure) {
        queue.push(buffer);
        buffer = [];
      }
      pump();
      return new Promise<void>((resolve, reject) => {
        waiter = () => {
          if (failure || dropped.length === 0) return failure ? reject(failure) : resolve();
          rescue().then(
            () => (failure ? reject(failure) : resolve()),
            reject,
          );
        };
        settle();
      });
    },
    failed: () => failure,
    usage: () => usage,
    busyMs: () => busy + (inflight > 0 ? Date.now() - busySince : 0),
    classifiedCount: () => classified,
    unclassifiedCount: () => unclassified,
    concurrencyNow: () => limit,
  };
}

/** Convenience: classify everything, returning outcomes by id. */
export async function classifyAll<T extends ChunkIn>(items: T[], cfg: ScaledownConfig) {
  const all = new Map<string, Outcome>();
  const c = createClassifier<T>(cfg, (_i, o) => {
    for (const [k, v] of o) all.set(k, v);
  });
  c.push(items);
  await c.drain();
  return { outcomes: all, usage: c.usage(), busyMs: c.busyMs(), unclassified: c.unclassifiedCount() };
}

// ---------------------------------------------------------------- summarize

/** System instruction for the Summarize call that writes one persona verdict (evidence is a numbered, dated timeline). */
export const VERDICT_SYSTEM =
  "Write ONE punchy sentence of at most 18 words that teases a YouTube fan with affection, like a Spotify Wrapped caption. " +
  "Speak ABOUT them in the third person, starting with a verb (for example Cheers, Treats, Cannot, Swears): never say you or your. " +
  "The numbered lines are their comments in order, with the month and video in brackets. Quote or name one telling detail they wrote. " +
  "Do not mention dates, numbers, names, handles, or the words comment, commenter, user, fan, hater or person.";

export interface VerdictResult {
  text: string | null;
  inputTokens: number;
  costUsd: number;
  /** true when inputTokens came from the local estimator, not from the API */
  estimated: boolean;
}

export async function summarizeVerdict(evidence: string, cfg: ScaledownConfig): Promise<VerdictResult> {
  const local = { ...cfg, maxRetries: 1, timeoutMs: 8000 };
  try {
    const body = await post(
      "/v1/chat/completions",
      {
        model: "summarize",
        max_tokens: 60,
        messages: [
          { role: "system", content: VERDICT_SYSTEM },
          { role: "user", content: evidence },
        ],
      },
      local,
    );
    const choices = body.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content;
    let text: string | null = null;
    let tokens: number | null = null;
    let finish = (body.choices as { finish_reason?: unknown }[] | undefined)?.[0]?.finish_reason;
    if (typeof content === "string") {
      try {
        const parsed = JSON.parse(content) as { summary?: string; input_tokens?: number; finish_reason?: unknown };
        text = typeof parsed.summary === "string" ? parsed.summary : null;
        if (typeof parsed.input_tokens === "number") tokens = parsed.input_tokens;
        if (parsed.finish_reason !== undefined) finish = parsed.finish_reason;
      } catch {
        text = content;
      }
    }
    text = text?.replace(/\s+/g, " ").trim() ?? null;
    if (text && (text.length < 12 || text.length > 140)) text = null;
    // Cut off by max_tokens: it would end mid-sentence, so keep the templated verdict instead.
    if (finish === "length") text = null;
    const usage = body.usage as { prompt_tokens?: number } | undefined;
    const reported = usage?.prompt_tokens ?? tokens;
    const inputTokens = reported ?? estimateTokens(evidence.length + VERDICT_SYSTEM.length);
    return { text, inputTokens, costUsd: usdForTokens(inputTokens), estimated: reported === undefined || reported === null };
  } catch (e) {
    if (e instanceof ScaledownError && e.fatal) throw e;
    if (cfg.signal?.aborted) throw e;
    return { text: null, inputTokens: 0, costUsd: 0, estimated: false };
  }
}
