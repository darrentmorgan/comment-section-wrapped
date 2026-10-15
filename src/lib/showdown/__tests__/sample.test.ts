import { describe, expect, it } from "vitest";
import { buildSample, isEmojiHeavy, isNonLatin, normalizeText, type SampleComment } from "../sample";
import { VIBES } from "../../vibes";
import type { Vibe } from "../../types";

function fixture(n: number): SampleComment[] {
  const out: SampleComment[] = [];
  for (let i = 0; i < n; i++) {
    const vibe: Vibe = i % 20 === 0 ? "toxic" : i % 7 === 0 ? "funny" : i % 5 === 0 ? "critical" : i % 11 === 0 ? "spam" : i % 13 === 0 ? "question" : "supportive";
    const kind = i % 29 === 0 ? "nice" : i % 17 === 0 ? "ok ".repeat(120) : i % 19 === 0 ? "это очень круто видео " + i : i % 23 === 0 ? "😂😂😂🔥🔥 " + i : "comment number " + i;
    out.push({ id: `c${i}`, text: kind === "nice" ? "w" + i : kind + " " + i, vibe, topScore: i % 9 === 0 ? 0.4 : 0.9 });
  }
  return out;
}

describe("text predicates", () => {
  it("detects non-latin and emoji-heavy", () => {
    expect(isNonLatin("это очень круто")).toBe(true);
    expect(isNonLatin("plain english")).toBe(false);
    expect(isEmojiHeavy("😂😂😂🔥")).toBe(true);
    expect(isEmojiHeavy("nice 😂")).toBe(false);
    expect(normalizeText("  Hello   WORLD ")).toBe("hello world");
  });
});

describe("buildSample", () => {
  const data = fixture(3000);
  it("is deterministic per seed and differs across seeds", () => {
    const a = buildSample(data, 42, { size: 200 });
    const b = buildSample(data, 42, { size: 200 });
    const c = buildSample(data, 43, { size: 200 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items.map((i) => i.id)).not.toEqual(c.items.map((i) => i.id));
  });
  it("has no duplicate ids or duplicate normalised texts, and records strata", () => {
    const dup = [...data, { ...data[5], id: "dup1", text: data[5].text.toUpperCase() }, { id: "tiny", text: "a", vibe: "funny" as Vibe, topScore: 1 }];
    const s = buildSample(dup, 1, { size: 200 });
    expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length);
    expect(new Set(s.items.map((i) => normalizeText(i.text))).size).toBe(s.items.length);
    expect(s.items.find((i) => i.id === "tiny")).toBeUndefined();
    expect(s.items.every((i) => i.stratum.length > 0)).toBe(true);
  });
  it("oversamples the rare vibe and fills special strata", () => {
    const s = buildSample(data, 9, { size: 500 });
    const toxicInSample = s.items.filter((i) => i.stratum === "vibe:toxic").length;
    expect(toxicInSample).toBe(50);
    for (const st of ["long", "non-latin", "emoji", "low-confidence", "short"]) expect(s.items.some((i) => i.stratum === st)).toBe(true);
    expect(s.items.length).toBeLessThanOrEqual(500);
    expect(s.items.length).toBeGreaterThan(400);
  });
  it("referee subset is a proportional-size subset of the sample", () => {
    const s = buildSample(data, 3, { size: 400, refereeSize: 100 });
    expect(s.refereeIds).toHaveLength(100);
    const ids = new Set(s.items.map((i) => i.id));
    expect(s.refereeIds.every((id) => ids.has(id))).toBe(true);
  });
  it("returns natural vibe shares and per-vibe weights that sum to 1", () => {
    const s = buildSample(data, 3, { size: 400 });
    const sum = VIBES.reduce((t, v) => t + s.naturalShares[v], 0);
    expect(sum).toBeCloseTo(1);
    expect(s.weights.get(s.items[0].id)).toBeGreaterThan(0);
  });
  it("gives the special strata zero weight so only vibe strata stand for the natural mix", () => {
    const s = buildSample(data, 3, { size: 400 });
    const vibeSum = s.items.filter((i) => i.stratum.startsWith("vibe:")).reduce((t, i) => t + s.weights.get(i.id)!, 0);
    expect(vibeSum).toBeCloseTo(1);
    for (const i of s.items.filter((x) => !x.stratum.startsWith("vibe:"))) expect(s.weights.get(i.id)).toBe(0);
  });
  it("copes with a pool smaller than the quota", () => {
    const s = buildSample(fixture(30), 1, { size: 1000 });
    expect(s.items.length).toBeLessThanOrEqual(30);
    expect(s.items.length).toBeGreaterThan(0);
  });
});
