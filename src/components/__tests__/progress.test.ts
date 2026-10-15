import { describe, expect, it } from "vitest";
import { replayDateLabel, totalExpected, videosOpened } from "../progress";

const vids = (n: number, commentCount: number) => Array.from({ length: n }, () => ({ commentCount }));

describe("videosOpened", () => {
  it("caps each video at the per-video fetch limit, not its full YouTube comment count", () => {
    // 18,809 comments on the video, but only the first 1,000 are fetched: 1,500 pulled means the second tile is open
    expect(videosOpened(1500, vids(8, 18809))).toBe(2);
    expect(videosOpened(1, vids(8, 18809))).toBe(1);
    expect(videosOpened(1000, vids(8, 18809))).toBe(1);
    expect(videosOpened(8000, vids(8, 18809))).toBe(8);
  });
  it("uses the real count for small videos and honours a custom cap", () => {
    expect(videosOpened(130, [{ commentCount: 50 }, { commentCount: 50 }, { commentCount: 50 }])).toBe(3);
    expect(videosOpened(250, vids(5, 9999), 200)).toBe(2);
  });
  it("is zero before anything is pulled", () => {
    expect(videosOpened(0, vids(3, 100))).toBe(0);
  });
});

describe("totalExpected", () => {
  it("sums the capped counts", () => {
    expect(totalExpected(vids(3, 18809))).toBe(3000);
    expect(totalExpected([{ commentCount: 40 }, { commentCount: 18809 }])).toBe(1040);
  });
});

describe("replayDateLabel", () => {
  it("reads the date out of a run id", () => {
    expect(replayDateLabel("mrbeast-20261014-153500")).toBe("14 Oct 2026");
    expect(replayDateLabel("mrbeast-20261014-153500-2")).toBe("14 Oct 2026");
  });
  it("is null for ids without a stamp", () => {
    expect(replayDateLabel("whatever")).toBeNull();
    expect(replayDateLabel("x-20269999-000000")).toBeNull();
  });
});
