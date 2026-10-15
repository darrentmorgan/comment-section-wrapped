// Persistence for LIVE runs: every ProgressEvent (with a relative timestamp), the WrappedResult and every classified
// comment go to .runs/<id>/ so a recording can be replayed later without spending API credits.
// Server-side only. .runs/ is gitignored (it holds real commenter data).
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { isSafeRunId, type TimedEvent } from "./replay";
export { FAST_REPLAY_MS, isSafeRunId, replaySchedule, type TimedEvent } from "./replay";
import type { ClassifiedComment, ProgressEvent, WrappedResult } from "./types";

export interface RunMeta {
  id: string;
  channelTitle: string;
  channelHandle: string;
  comments: number;
  createdAt: string; // ISO
}

export function runsDir(): string {
  return process.env.RUNS_DIR?.trim() || path.join(process.cwd(), ".runs");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** <channel-handle>-<yyyymmdd-hhmmss> (local time), filesystem safe. */
export function makeRunId(handle: string, now: Date = new Date()): string {
  const slug =
    (handle || "")
      .replace(/[^A-Za-z0-9._]+/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 40) || "channel";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${slug}-${stamp}`;
}

/** Collects events with timestamps relative to construction time. */
export class RunRecorder {
  readonly events: TimedEvent[] = [];
  private readonly start: number;
  constructor(private readonly clock: () => number = Date.now) {
    this.start = clock();
  }
  record(event: ProgressEvent) {
    this.events.push({ t: Math.max(0, this.clock() - this.start), event });
  }
}

export interface SaveInput {
  events: TimedEvent[];
  /** absent for a failed run: only events.jsonl is written */
  result?: WrappedResult;
  comments?: ClassifiedComment[];
  /** used for the id when there is no result (failed run) */
  channelHint?: string;
  now?: Date;
}

async function writeLines<T>(file: string, rows: Iterable<T>, chunk = 2000) {
  const fh = await open(file, "w");
  try {
    let buf: string[] = [];
    for (const r of rows) {
      buf.push(JSON.stringify(r));
      if (buf.length >= chunk) {
        await fh.write(buf.join("\n") + "\n");
        buf = [];
      }
    }
    if (buf.length) await fh.write(buf.join("\n") + "\n");
  } finally {
    await fh.close();
  }
}

/** Writes the run folder and returns its id. Never overwrites an existing run (adds -2, -3 on a same-second clash). */
export async function saveRun(input: SaveInput, dir: string = runsDir()): Promise<string> {
  const now = input.now ?? new Date();
  const base = makeRunId(input.result?.channel.handle || input.result?.channel.title || input.channelHint || "", now);
  await mkdir(dir, { recursive: true });
  let id = base;
  for (let n = 2; ; n++) {
    try {
      await mkdir(path.join(dir, id)); // non-recursive: fails if it exists
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      id = `${base}-${n}`;
    }
  }
  const root = path.join(dir, id);
  await writeLines(path.join(root, "events.jsonl"), input.events);
  if (input.result) {
    await writeFile(path.join(root, "result.json"), JSON.stringify(input.result));
    await writeLines(path.join(root, "comments.jsonl"), input.comments ?? []);
    const meta: RunMeta = {
      id,
      channelTitle: input.result.channel.title,
      channelHandle: input.result.channel.handle,
      comments: input.result.totals.comments,
      createdAt: now.toISOString(),
    };
    await writeFile(path.join(root, "meta.json"), JSON.stringify(meta));
  }
  return id;
}

/** Completed runs (those with a result), newest first. */
export async function listRuns(dir: string = runsDir()): Promise<RunMeta[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RunMeta[] = [];
  for (const id of names) {
    if (!isSafeRunId(id)) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(dir, id, "meta.json"), "utf8")) as RunMeta);
    } catch {
      /* incomplete or failed run: not listed */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function loadRun(id: string, dir: string = runsDir()): Promise<{ meta: RunMeta | null; events: TimedEvent[] } | null> {
  if (!isSafeRunId(id)) return null;
  const root = path.join(dir, id);
  try {
    await stat(path.join(root, "events.jsonl"));
  } catch {
    return null;
  }
  const events: TimedEvent[] = [];
  const rl = createInterface({ input: createReadStream(path.join(root, "events.jsonl"), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) events.push(JSON.parse(line) as TimedEvent);
  // result.json is the editable copy (e.g. personas re-tuned offline); the replay's final result event follows it.
  try {
    const edited = JSON.parse(await readFile(path.join(root, "result.json"), "utf8")) as WrappedResult;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event.type === "result") {
        events[i] = { ...events[i], event: { type: "result", result: edited } };
        break;
      }
    }
  } catch {
    /* no result.json, or unreadable: keep the recorded event */
  }
  let meta: RunMeta | null = null;
  try {
    meta = JSON.parse(await readFile(path.join(root, "meta.json"), "utf8")) as RunMeta;
  } catch {
    /* failed run */
  }
  return { meta, events };
}
