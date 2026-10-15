import { describe, expect, it } from "vitest";
import { fitZoom } from "../storyKit";

describe("fitZoom", () => {
  it("leaves a slide alone when its content fits", () => {
    expect(fitZoom(600, 667)).toBe(1);
    expect(fitZoom(667, 667)).toBe(1);
  });

  it("shrinks an overflowing slide just enough to fit", () => {
    expect(fitZoom(800, 640)).toBeCloseTo(0.8);
  });

  it("never shrinks below the readable floor", () => {
    expect(fitZoom(2000, 600)).toBe(0.72);
  });

  it("ignores a missing measurement", () => {
    expect(fitZoom(0, 0)).toBe(1);
  });
});
