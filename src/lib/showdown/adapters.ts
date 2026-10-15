// Showdown readers. Every reader answers the same two questions (vibe + toxic) for one comment.
//   decisions: ScaleDown classify-1 and Jev share one request/response shape (POST state + questions).
//   batch:     ScaleDown batched classify (chat route), 50 comments per request.
//   llm:       OpenRouter chat completions with strict JSON output (small models, and the referees).
//   baseline:  free rules.
import type { ShowdownReader, Vibe } from "../types";
import { VIBES } from "../vibes";
import { classifyBatch, newUsage, normalizeBaseUrl, type ScaledownConfig } from "../scaledown";
import { alwaysSupportive, rulesReader } from "./baselines";
import { ProviderError, postJson, scrubSecrets, type HttpCtx, type HttpResult } from "./http";
import { TOXIC_THRESHOLD, decisionsQuestions, llmJsonSchema, llmSystemPrompt, openaiQuestions, prepText } from "./questions";

export interface ReadOut {
  vibe: Vibe;
  toxic: boolean;
  toxicP?: number;
  probs?: Partial<Record<Vibe, number>>;
  confidence?: number;
  costUsd: number;
  costSource: "api" | "computed" | "free";
  inputTokens?: number;
  /** "model | provider" as the API reported it (OpenRouter can route to a different provider than expected) */
  served?: string;
}
export interface ReadResult {
  out: ReadOut;
  attempts: number;
  ms: number;
  totalMs: number;
  /** batch lanes: shared id of the request this comment travelled in */
  batch?: string;
}

export type ReaderNeeds = "scaledown" | "openrouter" | "openai" | null;

export interface ReaderDef {
  info: Omit<ShowdownReader, "enabled" | "note" | "status">;
  needs: ReaderNeeds;
  concurrency: { start: number; max: number };
  /** everything besides the questions that changes what a record means; hashed into the lane fingerprint. Never holds keys. */
  config?: Record<string, unknown>;
  read?(text: string, ctx: HttpCtx): Promise<ReadResult>;
  /** batch lanes: one call for up to `batchSize` comments. Failures come back per item. */
  readBatch?(items: { id: string; text: string }[], ctx: HttpCtx): Promise<Map<string, ReadResult | ProviderError>>;
  batchSize?: number;
  /** true for referee lanes: run on the referee subset only */
  refereeOnly?: boolean;
}

const asNum = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const computedCost = (tokens: number | undefined, perM: number) => ((tokens ?? 0) * perM) / 1_000_000;

/** One identical concurrency for every per-comment lane, so throughput and loaded latency compare like with like. */
export const PER_COMMENT_CONCURRENCY = { start: 16, max: 16 } as const;
export const BATCH_CONCURRENCY = { start: 8, max: 8 } as const;

function servedBy(json: Record<string, unknown>): string | undefined {
  const model = typeof json.model === "string" ? json.model : undefined;
  const provider = typeof json.provider === "string" ? json.provider : undefined;
  return model || provider ? [model, provider].filter(Boolean).join(" | ") : undefined;
}

// ------------------------------------------------------------------ decisions (ScaleDown classify-1, Jev)

function parseProbs(raw: unknown): Partial<Record<Vibe, number>> | undefined {
  const out: Partial<Record<Vibe, number>> = {};
  if (Array.isArray(raw)) {
    for (const r of raw as { label?: string; choice?: string; value?: string; probability?: number; p?: number }[]) {
      const k = r?.label ?? r?.choice ?? r?.value;
      const v = asNum(r?.probability ?? r?.p);
      if (k && (VIBES as string[]).includes(k) && v !== undefined) out[k as Vibe] = v;
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if ((VIBES as string[]).includes(k) && asNum(v) !== undefined) out[k as Vibe] = v as number;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseDecisions(json: Record<string, unknown>, pricePerMInput: number): ReadOut {
  const answers = json.answers as Record<string, Record<string, unknown>> | undefined;
  const v = answers?.vibe;
  const choice = typeof v?.choice === "string" ? v.choice : undefined;
  if (!choice || !(VIBES as string[]).includes(choice)) throw new ProviderError(`invalid vibe answer (${String(choice).slice(0, 30)})`, 200);
  const t = answers?.toxic;
  const toxicP = asNum(t?.noul) ?? asNum(t?.probability) ?? asNum(t?.score);
  const probs = parseProbs(v?.probabilities);
  const usage = json.usage as Record<string, unknown> | undefined;
  const inputTokens = asNum(usage?.input_tokens);
  const apiCost = asNum(usage?.cost);
  return {
    vibe: choice as Vibe,
    toxic: (toxicP ?? 0) >= TOXIC_THRESHOLD,
    toxicP,
    probs,
    confidence: asNum(v?.confidence) ?? (probs ? probs[choice as Vibe] : undefined),
    costUsd: apiCost ?? computedCost(inputTokens, pricePerMInput),
    costSource: apiCost !== undefined ? "api" : "computed",
    inputTokens,
    served: servedBy(json),
  };
}

function wrap(r: HttpResult, out: ReadOut): ReadResult {
  return { out, attempts: r.attempts, ms: r.ms, totalMs: r.totalMs };
}

interface DecisionsOpts {
  id: string;
  label: string;
  url: string;
  headers: Record<string, string>;
  model: string;
  pricePerMInput: number;
  priceNote: string;
  needs: ReaderNeeds;
  key: string;
  concurrency: { start: number; max: number };
}
function decisionsReader(o: DecisionsOpts): ReaderDef {
  return {
    info: { id: o.id, label: o.label, kind: "decisions", modelId: o.model, priceNote: o.priceNote },
    needs: o.needs,
    concurrency: o.concurrency,
    config: { model: o.model, url: o.url, pricePerMInput: o.pricePerMInput },
    async read(text, ctx) {
      const r = await postJson(o.url, o.headers, { model: o.model, state: { text: prepText(text) }, questions: decisionsQuestions() }, ctx, [o.key]);
      return wrap(r, parseDecisions(r.json, o.pricePerMInput));
    },
  };
}

export function scaledownDecisionsReader(key: string, baseUrl?: string): ReaderDef {
  return decisionsReader({
    id: "scaledown",
    label: "ScaleDown classify-1",
    url: `${normalizeBaseUrl(baseUrl)}/v1/scaledown`,
    headers: { "x-api-key": key },
    model: "classify-1",
    pricePerMInput: 0.05,
    priceNote: "$0.05 per M input tokens, output free",
    needs: "scaledown",
    key,
    concurrency: PER_COMMENT_CONCURRENCY,
  });
}

export const JEV_MODEL = "typesafe/jev-1.13";
export function jevReader(key: string): ReaderDef {
  return decisionsReader({
    id: "jev",
    label: "Jev 1.13",
    url: "https://openrouter.ai/api/alpha/decisions",
    headers: { authorization: `Bearer ${key}` },
    model: JEV_MODEL,
    pricePerMInput: 0.042,
    priceNote: "$0.042 per M input tokens, output free (via OpenRouter)",
    needs: "openrouter",
    key,
    concurrency: PER_COMMENT_CONCURRENCY,
  });
}

// ------------------------------------------------------------------ OpenAI decisions (gpt-6-luna, direct)

/** OpenAI answers come back as a named array; usage has input tokens but no cost, so cost is tokens x list price. */
export function parseOpenAIDecisions(json: Record<string, unknown>, pricePerMInput: number): ReadOut {
  const list = Array.isArray(json.answers) ? (json.answers as Record<string, unknown>[]) : [];
  const byName = Object.fromEntries(list.map((a) => [String(a?.name), a] as const));
  if (byName.vibe?.type === "refusal") throw new ProviderError("refused to answer the vibe question", 200);
  return parseDecisions({ ...json, answers: { vibe: byName.vibe, toxic: byName.toxic } }, pricePerMInput);
}

export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
export function openaiDecisionsReader(key: string, baseUrl = "https://api.openai.com"): ReaderDef {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/decisions`;
  const pricePerMInput = 0.1;
  const questions = openaiQuestions();
  return {
    info: { id: "openai-decisions", label: "OpenAI Decisions (gpt-6-luna)", kind: "decisions", modelId: OPENAI_DECISIONS_MODEL, priceNote: "$0.10 per M input tokens, output free (OpenAI direct)" },
    needs: "openai",
    concurrency: PER_COMMENT_CONCURRENCY,
    config: { model: OPENAI_DECISIONS_MODEL, url, pricePerMInput, questions },
    async read(text, ctx) {
      const r = await postJson(url, { authorization: `Bearer ${key}` }, { model: OPENAI_DECISIONS_MODEL, input: prepText(text), questions }, ctx, [key]);
      return wrap(r, parseOpenAIDecisions(r.json, pricePerMInput));
    },
  };
}

// ------------------------------------------------------------------ batch (ScaleDown classify, chat route)

export function scaledownBatchReader(key: string, baseUrl?: string): ReaderDef {
  return {
    info: {
      id: "scaledown-batch",
      label: "ScaleDown batch classify",
      kind: "batch",
      modelId: "classify",
      priceNote: "$0.05 per M input tokens, 50 comments per request, vibe only, the app's own tuned prompt",
      mode: "batch",
    },
    needs: "scaledown",
    concurrency: BATCH_CONCURRENCY,
    config: { route: "chat", baseUrl: baseUrl ?? "default", batchSize: 50 },
    batchSize: 50,
    async readBatch(items, ctx) {
      const cfg: ScaledownConfig = {
        apiKey: key,
        baseUrl,
        route: "chat",
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        random: ctx.random,
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
      };
      const usage = newUsage();
      let backoffs = 0; // each backoff is one retried attempt inside classifyBatch
      cfg.onBackoff = () => {
        backoffs++;
      };
      const t0 = Date.now();
      const res = await classifyBatch(items, cfg, usage);
      const ms = Date.now() - t0;
      const batchId = `b:${items[0]?.id ?? "empty"}`;
      const perItemCost = items.length ? usage.costUsd / items.length : 0;
      const perItemTokens = items.length ? usage.inputTokens / items.length : 0;
      const out = new Map<string, ReadResult | ProviderError>();
      for (const it of items) {
        const o = res.outcomes.get(it.id);
        if (!o) {
          out.set(it.id, new ProviderError("unclassified by batch", 200));
          continue;
        }
        out.set(it.id, {
          out: {
            vibe: o.vibe,
            toxic: o.vibe === "toxic",
            probs: o.scores,
            confidence: o.scores[o.vibe],
            costUsd: perItemCost,
            costSource: usage.estimated ? "computed" : "api",
            inputTokens: perItemTokens,
          },
          attempts: 1 + backoffs,
          ms, // the whole batch request (retries and backoff included): every comment in it waited this long
          totalMs: ms,
          batch: batchId,
        });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ llm (OpenRouter chat, JSON output)

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

function extractJson(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  const m = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const j = JSON.parse(m);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    const a = m.indexOf("{");
    const b = m.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(m.slice(a, b + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

export function parseChat(json: Record<string, unknown>, price: { inPerM: number; outPerM: number }): ReadOut {
  const choices = json.choices as { message?: { content?: unknown } }[] | undefined;
  const obj = extractJson(choices?.[0]?.message?.content);
  const vibe = obj?.vibe;
  if (typeof vibe !== "string" || !(VIBES as string[]).includes(vibe)) throw new ProviderError(`invalid vibe answer (${String(vibe).slice(0, 30)})`, 200);
  const t = obj?.toxic;
  const toxic = typeof t === "boolean" ? t : t === "true" ? true : t === "false" ? false : undefined;
  if (toxic === undefined) throw new ProviderError("invalid toxic answer", 200);
  const usage = json.usage as Record<string, unknown> | undefined;
  const inTok = asNum(usage?.prompt_tokens);
  const outTok = asNum(usage?.completion_tokens);
  const apiCost = asNum(usage?.cost);
  return {
    vibe: vibe as Vibe,
    toxic,
    costUsd: apiCost ?? computedCost(inTok, price.inPerM) + computedCost(outTok, price.outPerM),
    costSource: apiCost !== undefined ? "api" : "computed",
    inputTokens: inTok,
    served: servedBy(json),
  };
}

export interface LlmOpts {
  id: string;
  label: string;
  model: string;
  inPerM: number;
  outPerM: number;
  key: string;
  kind?: "llm" | "referee";
  concurrency?: { start: number; max: number };
  /** token budget for the answer. Referees must reason (cannot be disabled), so they need room. */
  maxTokens?: number;
  /** first rung of the reasoning ladder (0 none, 1 low, 2 omit) */
  startRung?: number;
}

/** Reasoning effort ladder: "none", then "low", then the parameter omitted. Advances on a 400 that mentions it. */
const REASONING_LADDER: (Record<string, unknown> | undefined)[] = [{ effort: "none" }, { effort: "low" }, undefined];

export function llmReader(o: LlmOpts): ReaderDef {
  let rung = o.startRung ?? 0;
  const system = llmSystemPrompt();
  const kind = o.kind ?? "llm";
  return {
    info: {
      id: o.id,
      label: o.label,
      kind,
      modelId: o.model,
      priceNote: `$${o.inPerM} in / $${o.outPerM} out per M tokens (via OpenRouter)`,
    },
    needs: "openrouter",
    concurrency: o.concurrency ?? (kind === "referee" ? { start: 6, max: 6 } : PER_COMMENT_CONCURRENCY),
    config: { model: o.model, inPerM: o.inPerM, outPerM: o.outPerM, maxTokens: o.maxTokens ?? 300, startRung: o.startRung ?? 0 },
    refereeOnly: kind === "referee",
    async read(text, ctx) {
      for (;;) {
        const reasoning = REASONING_LADDER[rung];
        const body: Record<string, unknown> = {
          model: o.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prepText(text) },
          ],
          temperature: 0,
          max_tokens: o.maxTokens ?? 300,
          response_format: { type: "json_schema", json_schema: { name: "read", strict: true, schema: llmJsonSchema() } },
          usage: { include: true },
        };
        if (reasoning) body.reasoning = reasoning;
        try {
          const r = await postJson(OPENROUTER_CHAT_URL, { authorization: `Bearer ${o.key}` }, body, ctx, [o.key]);
          return wrap(r, parseChat(r.json, { inPerM: o.inPerM, outPerM: o.outPerM }));
        } catch (e) {
          if (e instanceof ProviderError && e.status === 400 && /reasoning|effort/i.test(e.message) && rung < REASONING_LADDER.length - 1) {
            rung++;
            continue;
          }
          throw e;
        }
      }
    },
  };
}

// ------------------------------------------------------------------ baselines

function baselineReader(id: string, label: string, note: string, fn: (text: string) => { vibe: Vibe; toxic: boolean }): ReaderDef {
  return {
    info: { id, label, kind: "baseline", priceNote: note },
    needs: null,
    concurrency: { start: 64, max: 64 },
    async read(text) {
      const t0 = performance.now();
      const a = fn(text);
      const ms = performance.now() - t0;
      return { out: { ...a, costUsd: 0, costSource: "free" }, attempts: 1, ms, totalMs: ms };
    },
  };
}

// ------------------------------------------------------------------ roster

export interface Roster {
  /** lanes that can run, in display order */
  readers: ReaderDef[];
  /** lanes that cannot run, with why. They still show up in the UI as "waiting for a key". */
  skipped: { info: ReaderDef["info"]; reason: string }[];
}

/** All readers for the showdown. Missing keys do not remove a lane; they mark it skipped. Keys are never returned. */
export function buildRoster(env: Record<string, string | undefined> = process.env): Roster {
  const sd = env.SCALEDOWN_API_KEY?.trim();
  const or = env.OPENROUTER_API_KEY?.trim();
  const oa = env.OPENAI_API_KEY?.trim();
  const k = (s: string | undefined) => s ?? "";
  const defs: ReaderDef[] = [
    scaledownDecisionsReader(k(sd), env.SCALEDOWN_API_BASE),
    scaledownBatchReader(k(sd), env.SCALEDOWN_API_BASE),
    jevReader(k(or)),
    openaiDecisionsReader(k(oa), env.OPENAI_API_BASE),
    llmReader({ id: "haiku", label: "Claude Haiku 5.5", model: "anthropic/claude-haiku-5.5", inPerM: 0.1, outPerM: 0.5, key: k(or) }),
    llmReader({ id: "gemma", label: "Gemma 4 26B", model: "google/gemma-4-26b-a4b-it", inPerM: 0.09, outPerM: 0.3, key: k(or) }),
    llmReader({ id: "luna", label: "GPT-5.6 Luna", model: "openai/gpt-5.6-luna", inPerM: 0.2, outPerM: 1.2, key: k(or) }),
    baselineReader("always-supportive", "Always supportive", "free: guesses the majority class", () => alwaysSupportive()),
    baselineReader("rules", "Keyword rules", "free: regex and keyword rules", rulesReader),
    llmReader({ id: "referee-sonnet", label: "Claude Sonnet 5.5 (referee)", model: "anthropic/claude-sonnet-5.5", inPerM: 2, outPerM: 10, key: k(or), kind: "referee", maxTokens: 2000, startRung: 1 }),
    llmReader({ id: "referee-opus", label: "Claude Opus 5.5 (referee)", model: "anthropic/claude-opus-5.5", inPerM: 4, outPerM: 20, key: k(or), kind: "referee", maxTokens: 2000, startRung: 1 }),
  ];
  const readers: ReaderDef[] = [];
  const skipped: Roster["skipped"] = [];
  for (const d of defs) {
    const keyFor = { scaledown: sd, openrouter: or, openai: oa } as const;
    const envName = { scaledown: "SCALEDOWN_API_KEY", openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY" } as const;
    if (d.needs === null || keyFor[d.needs]) readers.push(d);
    else skipped.push({ info: d.info, reason: `skipped: no ${envName[d.needs]}` });
  }
  return { readers, skipped };
}

export { scrubSecrets };
