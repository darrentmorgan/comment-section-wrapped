import { describe, expect, it } from "vitest";
import { generateDemo } from "../demo";
import { buildPersonas, computeTotals, perVideoStats, topComments } from "../personas";

const data = generateDemo();

describe("generateDemo", () => {
  it("is deterministic", () => {
    const again = generateDemo();
    expect(again.comments.length).toBe(data.comments.length);
    expect(again.comments[1234].text).toBe(data.comments[1234].text);
    expect(again.comments[1234].id).toBe(data.comments[1234].id);
  });

  it("is channel-sized: 30 videos, tens of thousands of comments, thousands of commenters", () => {
    expect(data.videos).toHaveLength(30);
    expect(data.comments.length).toBeGreaterThan(30000);
    expect(data.comments.length).toBeLessThan(50000);
    const t = computeTotals(data.comments);
    expect(t.commenters).toBeGreaterThan(5000);
    expect(t.commenters).toBeLessThan(8000);
  });

  it("is chronological, newest video first, scores sum to 1 and match the vibe", () => {
    for (let i = 1; i < 2000; i++) expect(data.comments[i].publishedAt >= data.comments[i - 1].publishedAt).toBe(true);
    expect(data.videos[0].publishedAt > data.videos[29].publishedAt).toBe(true);
    for (const c of data.comments.slice(0, 3000)) {
      const sum = Object.values(c.scores).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 3);
      const top = Object.entries(c.scores).sort((a, b) => b[1] - a[1])[0][0];
      expect(top).toBe(c.vibe);
      expect(c.sentiment).toBeGreaterThanOrEqual(-1);
      expect(c.sentiment).toBeLessThanOrEqual(1);
    }
  });

  it("only uses fictional handles and no real links", () => {
    expect(data.comments.every((c) => c.authorName.startsWith("@"))).toBe(true);
    expect(data.comments.some((c) => /https?:\/\//.test(c.text))).toBe(false);
  });

  it("surfaces every recordable persona kind, with villain arcs on top", () => {
    const ps = buildPersonas(data.comments);
    const kinds = new Set(ps.map((p) => p.kind));
    for (const k of ["villain_arc", "redemption_arc", "consistent_hater", "superfan", "one_bad_day", "comedian", "reply_guy"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
    const villains = ps.filter((p) => p.kind === "villain_arc");
    expect(villains.length).toBeGreaterThanOrEqual(4);
    const scripted = new Set(["@DesktopDave2019_demo", "@cozy_cathode_demo", "@NightOwlNorbert_demo", "@sunny_side_sam_demo", "@LoyalLlamaLuigi_demo"]);
    expect(villains.every((v) => scripted.has(v.authorName))).toBe(true);
    expect(ps.find((p) => p.kind === "reply_guy")!.authorName).toMatch(/wendell|rhonda/);
  });

  it("never repeats a verdict or a headline comment verbatim across personas", () => {
    const ps = buildPersonas(data.comments);
    expect(new Set(ps.map((p) => p.verdict)).size).toBe(ps.length);
    expect(new Set(ps.map((p) => p.headlineComment.toLowerCase())).size).toBe(ps.length);
  });

  it("all hand-written demo handles carry the fictional _demo marker", () => {
    const names = new Set(data.comments.map((c) => c.authorName));
    for (const n of ["@DesktopDave2019_demo", "@cozy_cathode_demo", "@well_actually_wendell_demo", "@punchline_pete_demo"]) expect(names.has(n)).toBe(true);
    expect([...names].filter((n) => /^@(cozy_cathode|ratio_rick|sunny_side_sam)$/.test(n))).toEqual([]);
  });

  it("per-video sentiment really trends colder over the channel's timeline", () => {
    const pv = perVideoStats(data.comments, [...data.videos].reverse()); // oldest first
    const xs = pv.map((p) => p.avgSentiment);
    const half = xs.length / 2;
    const avgOf = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avgOf(xs.slice(0, half)) - avgOf(xs.slice(half))).toBeGreaterThan(0.1);
  });

  it("floors tiny comment caps at 10 per video, like live mode", () => {
    const tiny = generateDemo({ maxVideos: 3, maxCommentsPerVideo: 0 });
    expect(tiny.comments.length).toBeGreaterThanOrEqual(20);
    expect(tiny.comments.length).toBeLessThanOrEqual(30);
  });

  it("has a funny, a nasty and a sweet top comment worth showing", () => {
    const t = topComments(data.comments);
    expect(t.funniest.length).toBe(5);
    expect(t.nastiest.length).toBe(5);
    expect(t.sweetest.length).toBe(5);
  });

  it("honours small caps for quick runs", () => {
    const small = generateDemo({ maxVideos: 5, maxCommentsPerVideo: 50 });
    expect(small.videos).toHaveLength(5);
    expect(small.comments.length).toBeLessThanOrEqual(250);
  });
});
