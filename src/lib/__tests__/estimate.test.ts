import { describe, expect, it } from "vitest";
import { estimateRun } from "../estimate";
import { DEFAULT_MAX_VIDEOS } from "../util";
import { DEFAULT_COMMENTS_PER_VIDEO } from "../util";

describe("run estimate", () => {
  it("uses pipeline defaults and real ScaleDown calibration", () => {
    const result = estimateRun({ provider: "scaledown" });
    expect(result.comments).toBe(DEFAULT_MAX_VIDEOS * DEFAULT_COMMENTS_PER_VIDEO);
    expect(result.youtubeUnits).toBe(605);
    expect(result.usdLow).toBeCloseTo(60_000 * 0.73 / 59_751 * 0.7);
    expect(result.usdHigh).toBeCloseTo(60_000 * 0.73 / 59_751 * 1.5);
  });
  it("counts partial playlist, video and per-video comment pages", () => {
    const result = estimateRun({ maxVideos: 51, maxCommentsPerVideo: 101, provider: "openrouter" });
    expect(result.comments).toBe(5151);
    expect(result.youtubeUnits).toBe(1 + 2 + 2 + 51 * 2);
    expect(result.usdLow).toBeCloseTo(5151 * 0.016 / 1000 * 0.7);
    expect(result.usdHigh).toBeCloseTo(5151 * 0.016 / 1000 * 1.5);
  });
  it("handles empty and fractional counts without negative costs", () => {
    expect(estimateRun({ maxVideos: 0, maxCommentsPerVideo: 100, provider: "scaledown" })).toEqual({ comments: 0, youtubeUnits: 1, usdLow: 0, usdHigh: 0 });
    expect(estimateRun({ maxVideos: 1.9, maxCommentsPerVideo: -1, provider: "scaledown" }).comments).toBe(0);
  });
});
