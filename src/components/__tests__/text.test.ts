import { describe, expect, it } from "vitest";
import { tidyComment, unwrapQuotes } from "../text";
import { videosOpened, replayParam } from "../progress";

describe("tidyComment", () => {
  it("collapses whitespace and newlines", () => {
    expect(tidyComment("  hi\n\n  there \t you ")).toBe("hi there you");
  });
  it("falls back for empty text", () => {
    expect(tidyComment("")).toBe("(no text)");
    expect(tidyComment("   \n ")).toBe("(no text)");
  });
  it("ellipsizes by code point, never splitting an emoji", () => {
    const out = tidyComment("😀".repeat(50), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.includes("�")).toBe(false);
  });
  it("cuts at a word boundary when one is near the limit", () => {
    expect(tidyComment("the quick brown fox jumps over", 20)).toBe("the quick brown…");
  });
  it("leaves short and multilingual text alone", () => {
    expect(tidyComment("これは日本語のコメントです")).toBe("これは日本語のコメントです");
  });
  it("strips zero width and control characters", () => {
    expect(tidyComment("a​b\u0007c")).toBe("abc");
  });
});

describe("videosOpened", () => {
  const vids = Array.from({ length: 10 }, (_, i) => ({ commentCount: 100, id: String(i) }));
  it("is 0 before anything is fetched", () => expect(videosOpened(0, vids)).toBe(0));
  it("tracks the fetched share", () => {
    expect(videosOpened(250, vids)).toBe(3);
    expect(videosOpened(1000, vids)).toBe(10);
    expect(videosOpened(99999, vids)).toBe(10);
  });
  it("falls back to 1000 per video when counts are unknown", () => {
    const v = [{ commentCount: 0, id: "a" }, { commentCount: 0, id: "b" }];
    expect(videosOpened(1000, v)).toBe(1);
    expect(videosOpened(2000, v)).toBe(2);
  });
  it("handles no videos", () => expect(videosOpened(50, [])).toBe(0));
});

describe("replayParam", () => {
  it("reads ?replay and ?debug", () => {
    expect(replayParam("?replay=abc-1")).toEqual({ id: "abc-1", debug: false });
    expect(replayParam("?replay=latest&debug=1")).toEqual({ id: "latest", debug: true });
    expect(replayParam("")).toEqual({ id: null, debug: false });
  });
  it("rejects unsafe ids", () => {
    expect(replayParam("?replay=../etc")).toEqual({ id: null, debug: false });
    expect(replayParam("?replay=a%2Fb").id).toBeNull();
  });
});

describe("unwrapQuotes", () => {
  it("drops one pair of quote marks wrapping the whole comment", () => {
    expect(unwrapQuotes('"Imagine this"')).toBe("Imagine this");
    expect(unwrapQuotes("\u201CImagine this\u201D \ud83d\udc80")).toBe("\u201CImagine this\u201D \ud83d\udc80");
  });
  it("keeps inner or unbalanced quotes", () => {
    expect(unwrapQuotes('He said "no" twice')).toBe('He said "no" twice');
    expect(unwrapQuotes('"only at the start')).toBe('"only at the start');
  });
});
