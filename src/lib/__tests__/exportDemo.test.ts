import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoLeaks, exportDemo, transformDemo } from "../../../scripts/export-demo";
import { showdownResponse } from "../showdown/response";
import { hash32 } from "../util";
import type { TimedEvent } from "../replay";
import type { WrappedResult, ShowdownCodeMiss, ClassifiedComment } from "../types";
import type { ShowdownFile } from "../showdown/store";

const author = { authorName: "@jasmine42", authorId: "private-author-id", authorAvatar: "https://private/avatar", authorUrl: "https://private/profile", profileLink: "https://private/profile", text: "hi @jasmine42" };
const result = { channel: { title: "Public channel", handle: "@PublicChannel", avatar: "https://public/avatar" }, totals: { comments: 3 }, personas: [{ ...author, verdict: "Thanks @jasmine42", headlineComment: "hey ＠jasmine42", timeline: [{ text: "@jasmine42 yay" }] }] } as unknown as WrappedResult;
const events = [{ t: 0, event: { type: "status", stage: "resolving", message: "Starting @jasmine42" } }, { t: 10, event: { type: "classified", done: 3, sample: [author, author, author] } }, { t: 20, event: { type: "result", result: { ...result, personas: [] } } }] as unknown as TimedEvent[];
const showdown = { summary: { learned: ["Thanks @jasmine42"] }, disagreements: [{ text: "hi @jasmine42" }], perItem: { secret: "not public" }, events: [] } as unknown as ShowdownFile;
let out: string | undefined;
afterEach(async () => { if (out) await rm(out, { recursive: true, force: true }); });

describe("demo export", () => {
  it("masks all free text, hashes author ids, strips commenter images and URLs, preserves public channel info, and removes samples outside the tenth classified event", () => {
    const transformed = transformDemo(events, result, showdown);
    const encoded = JSON.stringify(transformed);
    expect(encoded).not.toContain(author.authorName);
    expect(encoded).not.toContain(author.authorId);
    expect(encoded).not.toContain("https://private");
    expect(encoded).toMatch(/"authorId":"a[0-9a-f]{16}"/);
    expect(encoded).toContain('"authorName":"@j***"');
    expect(transformed.events).toHaveLength(3);
    expect(transformed.events[1].event).toMatchObject({ sample: [] });
    expect(transformed.events[2].event).toMatchObject({ result: { channel: result.channel, personas: [{ verdict: "Thanks @ja***42", headlineComment: "hey @ja***42", timeline: [{ text: "@ja***42 yay" }] }] } });
    expect(transformed.showdown).toEqual({ summary: { learned: ["Thanks @ja***42"] }, disagreements: [{ text: "hi @ja***42" }], codeMisses: [] });
    expect(result.personas[0].authorName).toBe(author.authorName);
  });
  it("keeps at most two unique samples on every tenth classified event without changing progress", () => {
    const comment = (id: string): ClassifiedComment => ({ ...author, id, videoId: "public-video" }) as unknown as ClassifiedComment;
    const recording: TimedEvent[] = Array.from({ length: 20 }, (_, i) => ({
      t: i,
      event: { type: "classified", done: i + 1, total: 20, costUsd: 0.1, elapsedMs: i, sample: i === 19 ? [comment("first"), comment("third"), comment("fourth")] : [comment("first"), comment("first"), comment("second")] },
    }));
    recording.splice(5, 0, events[0]);
    recording.push(events[2]);
    const classified = transformDemo(recording, result, showdown).events.filter((row) => row.event.type === "classified");
    classified.forEach((row, i) => {
      expect(row.event).toMatchObject({ done: i + 1, total: 20, costUsd: 0.1, elapsedMs: i });
      if (row.event.type !== "classified") throw new Error("Expected classified event");
      expect(row.event.sample).toHaveLength(i === 9 ? 2 : i === 19 ? 2 : 0);
    });
    expect(classified[9].event).toMatchObject({ sample: [{ id: `c${hash32("comment:first").toString(36)}` }, { id: `c${hash32("comment:second").toString(36)}` }] });
    expect(classified[19].event).toMatchObject({ sample: [{ id: `c${hash32("comment:third").toString(36)}` }, { id: `c${hash32("comment:fourth").toString(36)}` }] });
    expect(recording[0].event).toMatchObject({ sample: [{ id: "first" }, { id: "first" }, { id: "second" }] });
  });
  it("hashes comment ids consistently in samples, result records and showdown while preserving public ids", () => {
    const id = "UgABCDEFGHIJKLMNOPQRST";
    const comment = { ...author, id, videoId: "public-video" } as unknown as ClassifiedComment;
    const withComments = { ...result, channel: { ...result.channel, id: "public-channel" }, videos: [{ id: "public-video" }], topComments: { funniest: [comment], nastiest: [], sweetest: [] }, extraComment: { id: "other-comment", text: "public sample" } } as unknown as WrappedResult;
    const recording: TimedEvent[] = Array.from({ length: 10 }, (_, t) => ({ t, event: { type: "classified", done: t, total: 10, costUsd: 0, elapsedMs: t, sample: [comment] } }));
    recording.push(events[2]);
    const comparison = { ...showdown, disagreements: [{ commentId: id, text: "public sample" }], codeMisses: [{ commentId: id, text: "public sample" }] } as unknown as ShowdownFile;
    const transformed = transformDemo(recording, withComments, comparison);
    const hashed = `c${hash32("comment:" + id).toString(36)}`;
    expect(transformed.events[9].event).toMatchObject({ sample: [{ id: hashed, videoId: "public-video" }] });
    expect(transformed.events.at(-1)?.event).toMatchObject({ result: { channel: withComments.channel, videos: withComments.videos, topComments: { funniest: [{ id: hashed }] }, extraComment: { id: `c${hash32("comment:other-comment").toString(36)}` } } });
    expect(transformed.showdown).toMatchObject({ disagreements: [{ commentId: hashed }], codeMisses: [{ commentId: hashed }] });
    expect(JSON.stringify(transformed)).not.toMatch(/Ug[\w-]{16,}/);
  });
  it("fails closed if a raw YouTube comment id appears anywhere in output", () => {
    expect(() => assertNoLeaks(JSON.stringify({ nested: { text: "UgABCDEFGHIJKLMNOPQRST" } }), [])).toThrow(/privacy/i);
  });
  it("matches the saved showdown route body and defaults missing codeMisses", () => {
    expect(showdownResponse(showdown)).toEqual({ summary: showdown.summary, disagreements: showdown.disagreements, codeMisses: [] });
    expect(showdownResponse({ ...showdown, codeMisses: [{ text: "test" } as ShowdownCodeMiss] }).codeMisses).toEqual([{ text: "test" }]);
  });
  it("makes the channel id opaque when the channel also appears as a commenter", () => {
    const sameAuthor = { ...result, channel: { ...result.channel, id: author.authorId } };
    const channelEvent: TimedEvent = { t: 0, event: { type: "channel", channel: sameAuthor.channel } };
    const transformed = transformDemo([channelEvent, ...events], sameAuthor, showdown);
    expect(transformed.events[0].event).toMatchObject({ channel: { ...sameAuthor.channel, id: expect.stringMatching(/^a[0-9a-f]{16}$/) } });
    expect(() => assertNoLeaks(JSON.stringify(transformed), [[channelEvent, ...events], sameAuthor])).not.toThrow();
  });
  it("strips nested commenter URL metadata while preserving channel URLs", () => {
    const nested = { ...result, personas: [{ ...result.personas[0], profile: { url: "https://private/nested", label: "hi @jasmine42" } }] };
    const transformed = transformDemo(events, nested, showdown);
    expect(JSON.stringify(transformed)).not.toContain("https://private/nested");
    expect(transformed.events.at(-1)?.event).toMatchObject({ result: { channel: { avatar: result.channel.avatar }, personas: [{ profile: { label: "hi @ja***42" } }] } });
  });
  it("fails the leak check on planted names or original ids, including JSON escaping", () => {
    expect(() => assertNoLeaks('planted @jasmine42', [events, result])).toThrow(/privacy/i);
    expect(() => assertNoLeaks('private-author-id', [events, result])).toThrow(/privacy/i);
    expect(() => assertNoLeaks(JSON.stringify({ text: 'Alice "Smith"' }), [{ authorName: 'Alice "Smith"' }])).toThrow(/privacy/i);
    expect(() => assertNoLeaks(JSON.stringify(transformDemo(events, result, showdown)), [events, result])).not.toThrow();
  });
  it("reads only the four approved inputs, re-reads outputs, and writes the index metadata", async () => {
    out = await mkdtemp(path.join(tmpdir(), "export-demo-test-"));
    const inputs: Record<string, string> = { "events.jsonl": events.map((e) => JSON.stringify(e)).join("\n"), "result.json": JSON.stringify(result), "meta.json": JSON.stringify({ channelTitle: "Public channel", createdAt: "2026-10-14", comments: 3 }), "showdown.json": JSON.stringify(showdown) };
    const reader = vi.fn(async (file: string) => {
      if (file.startsWith(out!)) return readFile(file, "utf8");
      const data = inputs[path.basename(file)];
      if (data === undefined) throw new Error("Unapproved input");
      return data;
    });
    const sizes = await exportDemo({ id: "run", runsDir: "/recordings", outDir: out }, reader);
    expect(reader.mock.calls.filter(([f]) => f.startsWith("/recordings")).map(([f]) => path.basename(f)).sort()).toEqual(Object.keys(inputs).sort());
    expect(reader.mock.calls.filter(([f]) => f.startsWith(out!))).toHaveLength(3);
    expect(JSON.parse(await readFile(path.join(out, "index.json"), "utf8"))).toEqual({ runs: [{ id: "run", channelTitle: "Public channel", recordedAt: "2026-10-14", comments: 3 }] });
    expect(sizes.events).toBe((await stat(path.join(out, "run/events.json"))).size);
    expect(sizes.events).toBeLessThan(4 * 1024 * 1024);
  });
  it.each([author.authorName, "UgABCDEFGHIJKLMNOPQRST"])("deletes the written run and index if the re-read contains a planted identity or comment id (%s)", async (leak) => {
    out = await mkdtemp(path.join(tmpdir(), "export-demo-test-"));
    const reader = async (file: string) => {
      if (file.startsWith(out!)) return (await readFile(file, "utf8")) + leak;
      if (file.endsWith("events.jsonl")) return events.map((e) => JSON.stringify(e)).join("\n");
      if (file.endsWith("result.json")) return JSON.stringify(result);
      if (file.endsWith("showdown.json")) return JSON.stringify(showdown);
      return JSON.stringify({ channelTitle: "Public channel", createdAt: "2026-10-14", comments: 3 });
    };
    await expect(exportDemo({ id: "run", runsDir: "/recordings", outDir: out }, reader)).rejects.toThrow(/privacy/i);
    await expect(stat(path.join(out, "run"))).rejects.toThrow();
    await expect(stat(path.join(out, "index.json"))).rejects.toThrow();
  });
});

it("uses a fresh author salt per export and consistent ids within one export", () => {
  const sameAuthor = { ...result, channel: { ...result.channel, id: author.authorId }, topComments: { sweetest: [author] } } as unknown as WrappedResult;
  const first = transformDemo(events, sameAuthor, showdown);
  const second = transformDemo(events, sameAuthor, showdown);
  const getResult = (value: typeof first) => {
    const event = value.events.at(-1)!.event;
    if (event.type !== "result") throw Error("Expected result");
    return event.result;
  };
  const a = getResult(first);
  expect(a.personas[0].authorId).toMatch(/^a[0-9a-f]{16}$/);
  expect(a.channel.id).toBe(a.personas[0].authorId);
  expect(a.topComments.sweetest[0].authorId).toBe(a.personas[0].authorId);
  expect(a.personas[0].authorId).not.toBe(getResult(second).personas[0].authorId);
});
