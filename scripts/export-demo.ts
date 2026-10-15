// pnpm tsx scripts/export-demo.ts --run <id> --runs-dir <absolute path> --out public/demo
// Reads only replay events, the edited result, metadata and the final showdown. Never opens comments.jsonl.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { maskHandleStrict, maskMentions } from "../src/lib/maskText";
import { isSafeRunId, type TimedEvent } from "../src/lib/replay";
import { showdownResponse, type ShowdownResponse } from "../src/lib/showdown/response";
import type { WrappedResult } from "../src/lib/types";
import { hash32 } from "../src/lib/util";

/** Recurses through free text, keeping the channel's own public identity intact. */
function maskValue(value: unknown, authorIds: ReadonlySet<string>, salt: Buffer, publicChannel = false, commenterContext = false): unknown {
  if (typeof value === "string") return publicChannel ? value : maskMentions(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, authorIds, salt, publicChannel, commenterContext));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const commenter = commenterContext || "authorId" in row || "authorName" in row;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    if (key === "authorAvatar" || (commenter && /url|uri|link|avatar|thumbnail/i.test(key))) continue;
    const privateId = key === "authorId" || (publicChannel && key === "id" && typeof item === "string" && authorIds.has(item));
    const commentId = key === "commentId" || (key === "id" && !publicChannel && ("text" in row || "authorId" in row || "authorName" in row));
    if (commentId && typeof item === "string") out[key] = `c${hash32("comment:" + item).toString(36)}`;
    else if (privateId && typeof item === "string") out[key] = `a${createHash("sha256").update(salt).update(item).digest("hex").slice(0, 16)}`;
    else if (key === "authorName" && typeof item === "string") out[key] = maskHandleStrict(item);
    else out[key] = maskValue(item, authorIds, salt, publicChannel || key === "channel", commenter);
  }
  return out;
}

export function transformDemo(events: TimedEvent[], result: WrappedResult, showdown: Parameters<typeof showdownResponse>[0]): { events: TimedEvent[]; showdown: ShowdownResponse } {
  // All recorded event types change visible progress, samples or results. Keep that sequence and thin samples only.
  let classified = 0;
  const keptIds = new Set<string>();
  const thinned = events.map((row) => {
    if (row.event.type !== "classified") return row;
    classified++;
    const sample: typeof row.event.sample = [];
    if (classified % 10 === 0) {
      for (const comment of row.event.sample) {
        if (keptIds.has(comment.id)) continue;
        keptIds.add(comment.id);
        sample.push(comment);
        if (sample.length === 2) break;
      }
    }
    return { ...row, event: { ...row.event, sample } };
  });
  const lastResult = thinned.findLastIndex((row) => row.event.type === "result");
  if (lastResult < 0) throw new Error("The recording has no result event.");
  thinned[lastResult] = { ...thinned[lastResult], event: { type: "result", result } };
  // A channel may comment on its own videos: its id must then follow the same privacy rule as its authorId.
  const authorIds = identities([events, result], new Set(), true);
  const salt = randomBytes(32);
  return { events: maskValue(thinned, authorIds, salt) as TimedEvent[], showdown: maskValue(showdownResponse(showdown), authorIds, salt) as ShowdownResponse };
}

function identities(value: unknown, out = new Set<string>(), authorIdsOnly = false): Set<string> {
  if (Array.isArray(value)) for (const item of value) identities(item, out, authorIdsOnly);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && ((!authorIdsOnly && key === "authorName" && item.length >= 3) || (key === "authorId" && item.length > 0))) out.add(item);
      else identities(item, out, authorIdsOnly);
    }
  }
  return out;
}

/** Fail closed without ever printing the leaked identity. Checks literal and JSON-escaped strings. */
export function assertNoLeaks(text: string, originals: unknown[]): void {
  if (/Ug[\w-]{16,}/.test(text)) throw new Error("Privacy check failed: an original YouTube comment id remains in the output.");
  for (const identity of identities(originals)) {
    if (text.includes(identity) || text.includes(JSON.stringify(identity).slice(1, -1))) throw new Error("Privacy check failed: an original commenter identity remains in the output.");
  }
}

interface DemoEntry {
  id: string;
  channelTitle: string;
  recordedAt: string;
  comments: number;
}

export async function exportDemo(
  options: { id: string; runsDir: string; outDir: string },
  readText: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<{ events: number; showdown: number; index: number }> {
  const { id, runsDir, outDir } = options;
  if (!isSafeRunId(id)) throw new Error("Invalid run id.");
  if (!path.isAbsolute(runsDir)) throw new Error("--runs-dir must be an absolute path.");
  const root = path.join(runsDir, id);
  const events = (await readText(path.join(root, "events.jsonl"))).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as TimedEvent);
  const result = JSON.parse(await readText(path.join(root, "result.json"))) as WrappedResult;
  const meta = JSON.parse(await readText(path.join(root, "meta.json"))) as { channelTitle: string; createdAt: string; comments: number };
  const showdown = JSON.parse(await readText(path.join(root, "showdown.json"))) as Parameters<typeof showdownResponse>[0];
  const transformed = transformDemo(events, result, showdown);
  const dest = path.join(outDir, id);
  const indexPath = path.join(outDir, "index.json");
  let previousIndex: string | undefined;
  try {
    previousIndex = await readFile(indexPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const previous = previousIndex ? (JSON.parse(previousIndex) as { runs: DemoEntry[] }).runs : [];
  const entry: DemoEntry = { id, channelTitle: meta.channelTitle, recordedAt: meta.createdAt, comments: meta.comments };
  const runs = [...previous.filter((run) => run.id !== id), entry].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const bodies = { events: JSON.stringify(transformed.events), showdown: JSON.stringify(transformed.showdown), index: JSON.stringify({ runs }) };
  if (Buffer.byteLength(bodies.events) >= 4 * 1024 * 1024) throw new Error("Exported events exceed the 4 MB budget.");
  for (const body of Object.values(bodies)) assertNoLeaks(body, [events, result]);
  await mkdir(dest, { recursive: true });
  try {
    await writeFile(path.join(dest, "events.json"), bodies.events);
    await writeFile(path.join(dest, "showdown.json"), bodies.showdown);
    await writeFile(indexPath, bodies.index);
    for (const file of [path.join(dest, "events.json"), path.join(dest, "showdown.json"), indexPath]) {
      assertNoLeaks(await readText(file), [events, result]);
    }
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    if (previousIndex === undefined) await rm(indexPath, { force: true });
    else await writeFile(indexPath, previousIndex);
    throw e;
  }
  return { events: Buffer.byteLength(bodies.events), showdown: Buffer.byteLength(bodies.showdown), index: Buffer.byteLength(bodies.index) };
}

async function main(): Promise<void> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const id = arg("run");
  const runsDir = arg("runs-dir");
  const outDir = arg("out");
  if (!id || !runsDir || !outDir) throw new Error("Usage: --run <id> --runs-dir <absolute path> --out public/demo");
  const sizes = await exportDemo({ id, runsDir, outDir });
  for (const [file, bytes] of Object.entries(sizes)) console.log(`${file}.json: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "Demo export failed.");
    process.exitCode = 1;
  });
}
