// Persistence for a showdown: .runs/<id>/showdown.json (final) and showdown.partial.jsonl (append-only, resumable).
// No author names or handles are stored. Comment text lives only in `disagreements`.
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProgressEvent, ShowdownConfig, ShowdownCodeMiss, ShowdownDisagreement, ShowdownReader, ShowdownSummary, Vibe } from "../types";
import { isSafeRunId, runsDir } from "../runs";

export interface ItemRecord {
  vibe?: Vibe;
  toxic?: boolean;
  toxicP?: number;
  confidence?: number;
  ms: number; // latency of the successful request
  totalMs: number; // including retries and backoff
  costUsd: number;
  costSource: "api" | "computed" | "free";
  inputTokens?: number;
  attempts: number;
  /** batch lanes: id of the 50-comment request this record came from (all of its comments share one latency) */
  batch?: string;
  /** "model | provider" as reported by the API, when it says */
  served?: string;
  phase: "probe" | "race" | "referee" | "extra";
  error?: string;
}

export interface LaneMeta {
  wallMs: number;
  concurrencyStart: number;
  concurrencyMax: number;
  concurrencyFinal: number;
  /** hash of everything that changes what a record means (model, prices, concurrency, questions). Resume reuses a lane only on a match. */
  fingerprint?: string;
  fatal?: string;
}

export interface ShowdownFile {
  version: 1;
  createdAt: string;
  seed: number;
  questionsHash: string;
  sample: { ids: string[]; strata: Record<string, string>; refereeIds: string[]; savedVibe: Record<string, Vibe>; probeIds?: string[] };
  config?: ShowdownConfig;
  readers: ShowdownReader[];
  lanes: Record<string, LaneMeta>;
  perItem: Record<string, Record<string, ItemRecord>>;
  summary: ShowdownSummary;
  disagreements: ShowdownDisagreement[];
  /** comments the keyword rules got wrong and the models got right (older files lack it) */
  codeMisses?: ShowdownCodeMiss[];
  /** the race as it happened, for replay (ticks carry no comment text) */
  events: { t: number; event: ProgressEvent }[];
}

export const showdownPath = (runId: string, dir: string = runsDir()) => path.join(dir, runId, "showdown.json");
export const partialPath = (runId: string, dir: string = runsDir()) => path.join(dir, runId, "showdown.partial.jsonl");

export async function readShowdown(runId: string, dir: string = runsDir()): Promise<ShowdownFile | null> {
  if (!isSafeRunId(runId)) return null;
  try {
    return JSON.parse(await readFile(showdownPath(runId, dir), "utf8")) as ShowdownFile;
  } catch {
    return null;
  }
}

/** Atomic write: temp file then rename. Never writes a simulated summary. */
export async function writeShowdown(runId: string, file: ShowdownFile, dir: string = runsDir()): Promise<void> {
  if (!isSafeRunId(runId)) throw new Error("unsafe run id");
  if (file.summary.simulated) throw new Error("refusing to write a simulated showdown");
  const dest = showdownPath(runId, dir);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, JSON.stringify(file));
  await rename(tmp, dest);
}

/** Appends finished items as they land so a crash does not repay for them. */
export class PartialWriter {
  private pending: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly fingerprintOf: (readerId: string) => string | undefined = () => undefined,
  ) {}
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
  }
  add(readerId: string, itemId: string, rec: ItemRecord) {
    this.pending.push(JSON.stringify({ r: readerId, i: itemId, rec, f: this.fingerprintOf(readerId) }));
    if (this.pending.length >= 50) this.flush();
  }
  flush(): Promise<void> {
    if (!this.pending.length) return this.chain;
    const data = this.pending.join("\n") + "\n";
    this.pending = [];
    this.chain = this.chain.then(() => appendFile(this.file, data)).catch(() => {});
    return this.chain;
  }
  async close() {
    await this.flush();
  }
}

/** Loads partial results; later lines win. Only ok records are returned (failed items are retried on resume). */
export async function loadPartial(file: string, accept: (readerId: string, fingerprint: string | undefined) => boolean = () => true): Promise<Record<string, Record<string, ItemRecord>>> {
  const out: Record<string, Record<string, ItemRecord>> = {};
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const { r, i, rec, f } = JSON.parse(line) as { r: string; i: string; rec: ItemRecord; f?: string };
      if (rec.error || !accept(r, f)) continue;
      (out[i] ??= {})[r] = rec;
    } catch {
      /* torn last line after a crash */
    }
  }
  return out;
}

export async function clearPartial(file: string) {
  await rm(file, { force: true });
}
