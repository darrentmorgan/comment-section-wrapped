// Runs the showdown from a saved run: sample, probe (serial), race (parallel lanes), referee, summarise, save.
// Missing keys never fail the run: those lanes are marked skipped and light up on a later run once the key exists.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProgressEvent, ShowdownConfig, ShowdownLaneInfo, ShowdownReader, ShowdownSummary, ShowdownDisagreement, ShowdownCodeMiss, Vibe } from "../types";
import { runsDir } from "../runs";
import { buildRoster, type ReadResult, type ReaderDef, type Roster } from "./adapters";
import { ProviderError, scrubSecrets, type HttpCtx } from "./http";
import { MAX_TEXT_CHARS, QUESTIONS_HASH, TOXIC_THRESHOLD } from "./questions";
import { buildSample, readSampleComments } from "./sample";
import { mulberry32, percentile, shuffled } from "./stats";
import { PartialWriter, clearPartial, loadPartial, partialPath, readShowdown, writeShowdown, type ItemRecord, type LaneMeta, type ShowdownFile } from "./store";
import { SAVED_ID, summarize } from "./summarize";

/** Additive-increase / multiplicative-decrease concurrency: +4 after 100 clean calls, halve on a 429 (at most once per 2s). */
export class Limiter {
  limit: number;
  private inflight = 0;
  private waiters: (() => void)[] = [];
  private clean = 0;
  private lastCut = -Infinity;
  constructor(
    start: number,
    readonly max: number,
    readonly min = 1,
    private readonly now: () => number = Date.now,
  ) {
    this.limit = Math.min(max, Math.max(min, start));
  }
  async acquire(): Promise<void> {
    if (this.inflight < this.limit) {
      this.inflight++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release() {
    this.inflight--;
    while (this.waiters.length && this.inflight < this.limit) {
      this.inflight++;
      this.waiters.shift()!();
    }
  }
  success() {
    if (++this.clean >= 100) {
      this.clean = 0;
      this.limit = Math.min(this.max, this.limit + 4);
      this.release0();
    }
  }
  rateLimited() {
    this.clean = 0;
    const t = this.now();
    if (t - this.lastCut >= 2000) {
      this.lastCut = t;
      this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    }
  }
  private release0() {
    while (this.waiters.length && this.inflight < this.limit) {
      this.inflight++;
      this.waiters.shift()!();
    }
  }
}

export interface RunShowdownOptions {
  runId: string;
  dir?: string; // runs directory
  n?: number; // sample size, default 1000
  refereeN?: number; // referee subset size, default 25% of n
  seed?: number;
  probeN?: number; // serial probe size per reader, default 60
  extraReferee?: number; // top disagreements to referee for slide captions, default 20
  only?: string[]; // reader ids to run
  skip?: string[]; // reader ids to skip
  resume?: boolean; // default true
  save?: boolean; // default true
  env?: Record<string, string | undefined>;
  roster?: Roster; // tests
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  emit?: (e: ProgressEvent) => void;
}

export const DEFAULT_SEED = 20261014;

const SAVED_READER: ShowdownReader = {
  id: SAVED_ID,
  label: "ScaleDown batch (saved run)",
  kind: "saved",
  priceNote: "already paid for during the original run",
  enabled: true,
};

/** Hash of everything that changes what one saved record means. A lane is resumed only when its fingerprint matches. */
export function laneFingerprint(def: ReaderDef, seed: number): string {
  return createHash("sha1")
    .update(JSON.stringify({ questions: QUESTIONS_HASH, seed, toxic: TOXIC_THRESHOLD, maxText: MAX_TEXT_CHARS, id: def.info.id, model: def.info.modelId, price: def.info.priceNote, concurrency: def.concurrency, config: def.config ?? null }))
    .digest("hex")
    .slice(0, 16);
}

function gitSha(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

const toInfo = (info: ReaderDef["info"], enabled: boolean, note?: string): ShowdownReader => ({ ...info, enabled, note });

export async function runShowdown(opts: RunShowdownOptions): Promise<{ summary: ShowdownSummary; disagreements: ShowdownDisagreement[]; codeMisses: ShowdownCodeMiss[]; file: ShowdownFile }> {
  const dir = opts.dir ?? runsDir();
  const env = opts.env ?? process.env;
  const emit = opts.emit ?? (() => {});
  const seed = opts.seed ?? DEFAULT_SEED;
  const n = opts.n ?? 1000;
  const probeN = opts.probeN ?? 60;
  const started = Date.now();
  const events: { t: number; event: ProgressEvent }[] = [];
  const record = (event: ProgressEvent, keep = true) => {
    if (keep) events.push({ t: Date.now() - started, event: event.type === "showdown_tick" ? { ...event, sample: undefined } : event });
    emit(event);
  };

  const comments = await readSampleComments(path.join(dir, opts.runId, "comments.jsonl"));
  if (!comments.length) throw new Error("No comments.jsonl for this run.");
  const sample = buildSample(comments, seed, { size: n, refereeSize: opts.refereeN });
  const items = sample.items;
  const textById = new Map(items.map((i) => [i.id, i.text] as const));

  // ---- roster
  const roster = opts.roster ?? buildRoster(env);
  const want = (id: string) => (!opts.only || opts.only.includes(id)) && !(opts.skip ?? []).includes(id);
  const active = roster.readers.filter((r) => want(r.info.id));
  const readersInfo: ShowdownReader[] = [
    SAVED_READER,
    ...roster.readers.map((r) => toInfo(r.info, want(r.info.id), want(r.info.id) ? undefined : "not selected for this run")),
    ...roster.skipped.map((s) => toInfo(s.info, false, s.reason.replace("skipped: no ", "waiting for ").replace("_API_KEY", "_API_KEY"))),
  ];
  const laneInfo: ShowdownLaneInfo[] = readersInfo
    .filter((r) => r.kind !== "saved")
    .map((r) => ({ id: r.id, label: r.label, kind: r.kind, note: r.note, enabled: r.enabled }));
  record({ type: "showdown_start", readers: laneInfo, total: items.length });

  // ---- state
  const partialFile = partialPath(opts.runId, dir);
  // Resume from an interrupted run (partial file) and from a finished one (showdown.json) when it asked the same questions
  // with the same seed, so growing the referee set or adding a newly keyed lane only pays for what is new.
  const fingerprints: Record<string, string> = Object.fromEntries(roster.readers.map((d) => [d.info.id, laneFingerprint(d, seed)] as const));
  const lanes: Record<string, LaneMeta> = {};
  const perItem: Record<string, Record<string, ItemRecord>> = {};
  if (opts.resume === false) await clearPartial(partialFile);
  else {
    const prior = await readShowdown(opts.runId, dir);
    // A lane is reused only if its fingerprint (questions, seed, model, price, concurrency, threshold, base URL) is unchanged.
    // Files from before fingerprints existed are never reused: their records cannot be proven to match the current setup.
    const fresh = (rid: string) => !!active.find((d) => d.info.id === rid) && !!prior?.lanes?.[rid]?.fingerprint && prior.lanes[rid].fingerprint === fingerprints[rid];
    if (prior && prior.questionsHash === QUESTIONS_HASH && prior.seed === seed) {
      for (const [rid, meta] of Object.entries(prior.lanes ?? {})) if (fresh(rid)) lanes[rid] = meta;
      for (const [itemId, byReader] of Object.entries(prior.perItem)) for (const [r, rec] of Object.entries(byReader)) if (!rec.error && fresh(r)) (perItem[itemId] ??= {})[r] = rec;
    }
    for (const [itemId, byReader] of Object.entries(await loadPartial(partialFile, (r, f) => !!f && f === fingerprints[r]))) Object.assign((perItem[itemId] ??= {}), byReader);
  }
  const writer = new PartialWriter(partialFile, (r) => fingerprints[r]);
  await writer.init();
  const counters = new Map<string, { done: number; failed: number; cost: number; lat: number[] }>();
  const secrets = [env.OPENROUTER_API_KEY ?? "", env.SCALEDOWN_API_KEY ?? ""];

  const counter = (id: string, phase: ItemRecord["phase"]) => {
    const key = phase === "extra" ? `${id}:extra` : id;
    let c = counters.get(key);
    if (!c) {
      c = { done: 0, failed: 0, cost: 0, lat: [] };
      for (const it of items) {
        const r = perItem[it.id]?.[id];
        if (r && !r.error) {
          c.done++;
          c.cost += r.costUsd;
          c.lat.push(r.ms);
        }
      }
      counters.set(key, c);
    }
    return c;
  };

  const tick = (readerId: string, total: number, force = false, text?: string, vibe?: Vibe) => {
    const c = counters.get(readerId);
    if (!c) return; // the hand-picked referee pass has no lane in the UI
    if (!force && (c.done + c.failed) % 10 !== 0) return;
    record({
      type: "showdown_tick",
      reader: readerId,
      done: c.done + c.failed,
      total,
      failed: c.failed,
      costUsd: c.cost,
      p50Ms: percentile(c.lat, 50),
      sample: text && vibe ? [{ text: text.slice(0, 160), vibe }] : undefined,
    });
  };

  const store = (readerId: string, id: string, rec: ItemRecord, persist = true) => {
    (perItem[id] ??= {})[readerId] = rec;
    if (persist) writer.add(readerId, id, rec);
  };

  /** `elapsedMs` = how long the request ran before giving up, so slow failures show up in the latency tail. */
  const failRec = (e: unknown, phase: ItemRecord["phase"], elapsedMs = 0): ItemRecord => ({
    ms: elapsedMs,
    totalMs: elapsedMs,
    costUsd: 0,
    costSource: "api",
    attempts: e instanceof ProviderError ? e.attempts : 1,
    phase,
    error: scrubSecrets(e instanceof Error ? e.message : String(e), secrets).slice(0, 200),
  });
  const okRec = (r: ReadResult, phase: ItemRecord["phase"]): ItemRecord => ({
    vibe: r.out.vibe,
    toxic: r.out.toxic,
    toxicP: r.out.toxicP,
    confidence: r.out.confidence,
    ms: r.ms,
    totalMs: r.totalMs,
    costUsd: r.out.costUsd,
    costSource: r.out.costSource,
    inputTokens: r.out.inputTokens,
    attempts: r.attempts,
    batch: r.batch,
    served: r.out.served,
    phase,
  });

  const httpFor = (limiter: Limiter): HttpCtx => ({
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    signal: opts.signal,
    throttle: { until: 0 },
    onRateLimit: () => limiter.rateLimited(),
  });

  /** Runs one reader over `ids`, skipping those already done. Per-item reads for `read` readers, 50-chunks for batch readers. */
  async function runLane(def: ReaderDef, ids: string[], phase: ItemRecord["phase"], serial: boolean, totalForTick: number): Promise<void> {
    const id = def.info.id;
    const c = counter(id, phase);
    const todo = ids.filter((i) => !perItem[i]?.[id] || perItem[i][id].error);
    const limiter = new Limiter(serial ? 1 : def.concurrency.start, serial ? 1 : def.concurrency.max, 1);
    const ctx = httpFor(limiter);
    const t0 = Date.now();
    let fatal: string | undefined;
    let streak = 0; // consecutive failures: a lane that fails 20 times running is misconfigured, stop paying for retries
    const noteResult = (good: boolean) => {
      streak = good ? 0 : streak + 1;
      if (streak >= 20 && !fatal) fatal = "20 requests in a row failed";
    };
    const one = async (itemId: string) => {
      if (opts.signal?.aborted) return;
      if (fatal) {
        store(id, itemId, { ...failRec(new Error(`lane stopped: ${fatal}`), phase) }, false);
        c.failed++;
        return;
      }
      const startedAt = Date.now();
      try {
        const r = await def.read!(textById.get(itemId) ?? "", ctx);
        const rec = okRec(r, phase);
        store(id, itemId, rec);
        c.done++;
        c.cost += rec.costUsd;
        c.lat.push(rec.ms);
        limiter.success();
        noteResult(true);
        tick(id, totalForTick, false, textById.get(itemId), rec.vibe);
      } catch (e) {
        if (opts.signal?.aborted) return;
        if (e instanceof ProviderError && e.fatal) fatal = e.message;
        store(id, itemId, failRec(e, phase, Date.now() - startedAt), false);
        c.failed++;
        noteResult(false);
        tick(id, totalForTick);
      }
    };
    const oneBatch = async (chunk: string[]) => {
      if (opts.signal?.aborted) return;
      const startedAt = Date.now();
      try {
        const res = await def.readBatch!(chunk.map((i) => ({ id: i, text: textById.get(i) ?? "" })), ctx);
        for (const itemId of chunk) {
          const r = res.get(itemId);
          if (r && !(r instanceof ProviderError)) {
            const rec = okRec(r, phase);
            store(id, itemId, rec);
            c.done++;
            c.cost += rec.costUsd;
          } else {
            store(id, itemId, failRec(r ?? new Error("missing"), phase, Date.now() - startedAt), false);
            c.failed++;
          }
        }
        const first = res.get(chunk[0]);
        if (first && !(first instanceof ProviderError)) c.lat.push(first.ms); // one latency per request, not per comment
        limiter.success();
      } catch (e) {
        if (opts.signal?.aborted) return;
        for (const itemId of chunk) {
          store(id, itemId, failRec(e, phase, Date.now() - startedAt), false);
          c.failed++;
        }
      }
      tick(id, totalForTick, true, textById.get(chunk[0]), perItem[chunk[0]]?.[id]?.vibe);
    };

    if (def.readBatch) {
      const size = def.batchSize ?? 50;
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < todo.length; i += size) {
        await limiter.acquire();
        jobs.push(oneBatch(todo.slice(i, i + size)).finally(() => limiter.release()));
      }
      await Promise.all(jobs);
    } else if (serial) {
      for (const itemId of todo) await one(itemId);
    } else {
      const jobs: Promise<void>[] = [];
      for (const itemId of todo) {
        await limiter.acquire();
        jobs.push(one(itemId).finally(() => limiter.release()));
      }
      await Promise.all(jobs);
    }
    await writer.flush();
    tick(id, totalForTick, true);
    const prev = lanes[id];
    lanes[id] = {
      wallMs: (prev?.wallMs ?? 0) + (serial || phase === "extra" ? 0 : Date.now() - t0),
      concurrencyStart: def.concurrency.start,
      concurrencyMax: def.concurrency.max,
      concurrencyFinal: serial ? (prev?.concurrencyFinal ?? def.concurrency.start) : limiter.limit,
      fingerprint: fingerprints[id],
      fatal,
    };
  }

  const allIds = items.map((i) => i.id);
  const racers = active.filter((d) => !d.refereeOnly);
  const referees = active.filter((d) => d.refereeOnly);

  // Phase 0: serial probe, per-item readers only (decisions + llm). Different providers probe at the same time.
  // A seeded random subset of the whole sample (the sample itself is grouped by stratum, so slicing the front would probe one stratum).
  const probeIds = shuffled(allIds, mulberry32(seed + 2)).slice(0, Math.min(probeN, allIds.length));
  await Promise.all(racers.filter((d) => d.read && ["decisions", "llm"].includes(d.info.kind)).map((d) => runLane(d, probeIds, "probe", true, allIds.length)));

  // Phase 1: the race, all lanes at once.
  await Promise.all(racers.map((d) => runLane(d, allIds, "race", false, allIds.length)));

  // Phase 2: referees on the referee subset.
  await Promise.all(referees.map((d) => runLane(d, sample.refereeIds, "referee", false, sample.refereeIds.length)));

  // Phase 2b: referee the top disagreements (primary referee only) so slide captions have a "referee says".
  const handPickedIds: string[] = [];
  const primary = referees.find((d) => d.info.id === "referee-opus") ?? referees[0];
  const extraN = opts.extraReferee ?? 20;
  const baseInput = () => ({
    runId: opts.runId,
    createdAt: new Date().toISOString(),
    seed,
    totalComments: comments.length,
    poolSize: sample.poolSize,
    items,
    refereeIds: sample.refereeIds,
    weights: sample.weights,
    readers: readersInfo,
    perItem,
    lanes,
  });
  if (primary && extraN > 0) {
    const pre = summarize(baseInput());
    const extra = pre.disagreements.map((d) => d.commentId).filter((i) => !sample.refereeIds.includes(i)).slice(0, extraN);
    handPickedIds.push(...extra);
    if (extra.length) {
      await runLane(primary, extra, "extra", false, extra.length);
      // an extra pass must not count as the referee lane's racing wall time or its throughput
    }
  }

  // Phase 3
  if (opts.signal?.aborted) {
    await writer.close();
    throw new Error("showdown aborted; finished items are kept for resume");
  }
  const { summary, disagreements, codeMisses } = summarize({ ...baseInput(), handPickedIds });
  await writer.close();

  const config: ShowdownConfig = {
    n,
    refereeN: sample.refereeIds.length,
    probeN,
    toxicThreshold: TOXIC_THRESHOLD,
    maxTextChars: MAX_TEXT_CHARS,
    appSha: gitSha(),
    readers: Object.fromEntries(roster.readers.map((d) => [d.info.id, { modelId: d.info.modelId, priceNote: d.info.priceNote, concurrency: d.concurrency, fingerprint: fingerprints[d.info.id] }] as const)),
  };
  const file: ShowdownFile = {
    version: 1,
    createdAt: summary.createdAt,
    seed,
    questionsHash: QUESTIONS_HASH,
    sample: {
      ids: allIds,
      strata: Object.fromEntries(items.map((i) => [i.id, i.stratum])),
      refereeIds: sample.refereeIds,
      savedVibe: Object.fromEntries(items.map((i) => [i.id, i.savedVibe])),
      probeIds,
    },
    config,
    readers: summary.readers,
    lanes,
    perItem,
    summary,
    disagreements,
    codeMisses,
    events,
  };
  record({ type: "showdown_done", summary }, false);
  if (opts.save !== false) {
    await writeShowdown(opts.runId, file, dir);
    await clearPartial(partialFile);
  }
  return { summary, disagreements, codeMisses, file };
}

/**
 * Re-run only the summary over a saved showdown.json: no API calls, no spend. Used when the summary code learns something new
 * (e.g. code misses) and the saved run should pick it up. The sample is rebuilt from the same seed and must match exactly.
 */
export async function resummarizeShowdown(runId: string, dir: string = runsDir()): Promise<ShowdownFile> {
  const file = await readShowdown(runId, dir);
  if (!file) throw new Error(`No showdown.json for ${runId}.`);
  const comments = await readSampleComments(path.join(dir, runId, "comments.jsonl"));
  const sample = buildSample(comments, file.seed, { size: file.sample.ids.length, refereeSize: file.sample.refereeIds.length });
  const ids = sample.items.map((i) => i.id);
  if (ids.length !== file.sample.ids.length || ids.some((id, i) => id !== file.sample.ids[i])) throw new Error("Rebuilt sample does not match the saved one; refusing to re-summarise.");
  const out = summarize({
    runId,
    createdAt: file.summary.createdAt,
    seed: file.seed,
    totalComments: file.summary.totalComments,
    poolSize: sample.poolSize,
    items: sample.items,
    refereeIds: file.sample.refereeIds,
    weights: sample.weights,
    readers: file.readers,
    perItem: file.perItem,
    lanes: file.lanes,
    handPickedIds: file.disagreements.filter((d) => d.handPicked).map((d) => d.commentId),
  });
  const next: ShowdownFile = { ...file, readers: out.summary.readers, summary: out.summary, disagreements: out.disagreements, codeMisses: out.codeMisses };
  await writeShowdown(runId, next, dir);
  return next;
}
