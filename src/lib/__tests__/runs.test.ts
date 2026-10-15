import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunRecorder, isSafeRunId, listRuns, loadRun, makeRunId, replaySchedule, saveRun } from "../runs";
import type { ClassifiedComment, ProgressEvent, WrappedResult } from "../types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runs-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scores = { toxic: 0, critical: 0, supportive: 1, funny: 0, question: 0, spam: 0 };
const comment = (i: number): ClassifiedComment => ({
  id: `c${i}`, videoId: "v1", authorId: "u" + i, authorName: "@u" + i, text: `hi ${i}`, likes: 0, publishedAt: "2026-01-01T00:00:00Z", vibe: "supportive", scores, sentiment: 1,
});
const result = (handle = "@MrBeast"): WrappedResult =>
  ({
    channel: { id: "UC1", title: "MrBeast", handle, avatar: "" },
    videos: [], totals: { comments: 3, commenters: 3, byVibe: { toxic: 0, critical: 0, supportive: 3, funny: 0, question: 0, spam: 0 }, avgSentiment: 1 },
    personas: [], topComments: { funniest: [], nastiest: [], sweetest: [] }, perVideo: [],
    usage: { inputTokens: 1, costUsd: 0.1, elapsedMs: 1, classifyCalls: 1 }, demo: false,
  }) as WrappedResult;

describe("makeRunId", () => {
  it("is <handle>-<yyyymmdd-hhmmss> and filesystem safe", () => {
    expect(makeRunId("@MrBeast", new Date(2026, 9, 14, 9, 5, 7))).toBe("MrBeast-20261014-090507");
    expect(makeRunId("../../etc/@x y", new Date(2026, 0, 2, 3, 4, 5))).toBe("etc-x-y-20260102-030405");
    expect(makeRunId("", new Date(2026, 0, 2, 3, 4, 5))).toBe("channel-20260102-030405");
  });
  it("rejects path traversal ids", () => {
    expect(isSafeRunId("MrBeast-20261014-090507")).toBe(true);
    expect(isSafeRunId("..")).toBe(false);
    expect(isSafeRunId("a/b")).toBe(false);
    expect(isSafeRunId("")).toBe(false);
  });
});

describe("save / list / load", () => {
  it("round-trips events (with relative timestamps), result and every comment", async () => {
    let now = 1000;
    const r2 = new RunRecorder(() => now);
    const evs: ProgressEvent[] = [
      { type: "status", stage: "resolving", message: "go" },
      { type: "fetched", total: 3 },
      { type: "result", result: result() },
    ];
    for (const e of evs) {
      r2.record(e);
      now += 250;
    }
    const id = await saveRun({ events: r2.events, result: result(), comments: [comment(1), comment(2), comment(3)], now: new Date(2026, 9, 14, 9, 5, 7) }, dir);
    expect(id).toBe("MrBeast-20261014-090507");
    const lines = readFileSync(path.join(dir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.t)).toEqual([0, 250, 500]);
    expect(lines[2].event.type).toBe("result");
    expect(readFileSync(path.join(dir, id, "comments.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(JSON.parse(readFileSync(path.join(dir, id, "result.json"), "utf8")).channel.title).toBe("MrBeast");

    const list = await listRuns(dir);
    expect(list).toEqual([expect.objectContaining({ id, channelTitle: "MrBeast", comments: 3 })]);
    expect(typeof list[0].createdAt).toBe("string");

    const loaded = await loadRun(id, dir);
    expect(loaded!.events.map((e) => e.t)).toEqual([0, 250, 500]);
    expect(await loadRun("nope", dir)).toBeNull();
    expect(await loadRun("../x", dir)).toBeNull();
  });

  it("replay uses an edited result.json for the final result event (so a re-tuned run replays tuned)", async () => {
    const id = await saveRun({ events: [{ t: 0, event: { type: "fetched", total: 3 } }, { t: 10, event: { type: "result", result: result() } }], result: result(), comments: [], now: new Date(2026, 9, 14, 9, 5, 8) }, dir);
    const tuned = { ...result(), personas: [{ kind: "superfan", verdict: "tuned" }] };
    writeFileSync(path.join(dir, id, "result.json"), JSON.stringify(tuned));
    const loaded = await loadRun(id, dir);
    const last = loaded!.events[loaded!.events.length - 1].event;
    expect(last.type === "result" && last.result.personas[0].verdict).toBe("tuned");
    // a missing or corrupt result.json leaves the recorded event alone
    writeFileSync(path.join(dir, id, "result.json"), "{not json");
    const again = await loadRun(id, dir);
    const last2 = again!.events[again!.events.length - 1].event;
    expect(last2.type === "result" && last2.result.personas).toEqual([]);
  });

  it("does not collide when two runs land in the same second", async () => {
    const now = new Date(2026, 9, 14, 9, 5, 7);
    const a = await saveRun({ events: [], result: result(), comments: [], now }, dir);
    const b = await saveRun({ events: [], result: result(), comments: [], now }, dir);
    expect(a).not.toBe(b);
    expect(existsSync(path.join(dir, b))).toBe(true);
  });

  it("lists newest first and ignores folders without a result", async () => {
    await saveRun({ events: [], result: result("@a"), comments: [], now: new Date(2026, 0, 1) }, dir);
    await saveRun({ events: [], result: result("@b"), comments: [], now: new Date(2026, 5, 1) }, dir);
    await saveRun({ events: [{ t: 0, event: { type: "error", message: "boom" } }], channelHint: "@c", now: new Date(2026, 6, 1) }, dir);
    expect((await listRuns(dir)).map((r) => r.id.split("-")[0])).toEqual(["b", "a"]);
  });

  it("list on a missing directory is empty", async () => {
    expect(await listRuns(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("replaySchedule", () => {
  const ev = (t: number): { t: number; event: ProgressEvent } => ({ t, event: { type: "fetched", total: t } });
  it("compresses a long run to the target and keeps order and the last event at the end", () => {
    const events = [ev(0), ev(1000), ev(120000), ev(240000)];
    const s = replaySchedule(events, "fast", 18000);
    expect(s.map((x) => x.at)).toEqual([0, 75, 9000, 18000]);
  });
  it("never stretches a short run in fast mode", () => {
    expect(replaySchedule([ev(0), ev(4000)], "fast", 18000).map((x) => x.at)).toEqual([0, 4000]);
  });
  it("real speed keeps original timing", () => {
    expect(replaySchedule([ev(0), ev(240000)], "real", 18000).map((x) => x.at)).toEqual([0, 240000]);
  });
  it("makes timestamps monotonic", () => {
    expect(replaySchedule([ev(5), ev(3), ev(9)], "real", 18000).map((x) => x.at)).toEqual([5, 5, 9]);
  });
});
