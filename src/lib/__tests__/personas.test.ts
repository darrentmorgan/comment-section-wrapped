import { describe, expect, it } from "vitest";
import type { ClassifiedComment, Vibe } from "../types";
import { emptyByVibe, sentimentFromScores } from "../vibes";
import {
  buildPersonas,
  computeMostLoyal,
  templateVerdict,
  verdictOptions,
  computeTotals,
  formatTimelineForSummary,
  sanitizeVerdict,
  detectPersonaKind,
  groupByAuthor,
  perVideoStats,
  topComments,
  looksEnglish,
} from "../personas";

let seq = 0;
function mk(authorId: string, day: number, sentiment: number, opts: Partial<ClassifiedComment> & { vibe?: Vibe } = {}): ClassifiedComment {
  const vibe: Vibe = opts.vibe ?? (sentiment >= 0.2 ? "supportive" : sentiment <= -0.2 ? "toxic" : "question");
  const scores = emptyByVibe();
  scores[vibe] = 1;
  return {
    id: `c${seq++}`,
    videoId: opts.videoId ?? `v${day}`,
    authorId,
    authorName: `@${authorId}`,
    text: opts.text ?? `comment ${seq} sentiment ${sentiment}`,
    likes: opts.likes ?? 0,
    publishedAt: new Date(Date.UTC(2026, 0, 1 + day * 10)).toISOString(), // 10 days apart: arcs need real elapsed time
    vibe,
    scores,
    sentiment,
    ...opts,
  } as ClassifiedComment;
}
const series = (id: string, values: number[], extra: Partial<ClassifiedComment> & { vibe?: Vibe } = {}) =>
  values.map((s, i) => mk(id, i, s, extra));

describe("sentimentFromScores", () => {
  it("is clamped and signed", () => {
    const s = emptyByVibe();
    s.supportive = 1;
    expect(sentimentFromScores(s)).toBe(1);
    const t = emptyByVibe();
    t.toxic = 1;
    expect(sentimentFromScores(t)).toBe(-1);
    const f = emptyByVibe();
    f.funny = 1;
    expect(sentimentFromScores(f)).toBe(0.5);
  });
});

describe("groupByAuthor", () => {
  it("groups by authorId (not name) and sorts chronologically", () => {
    const a = mk("a", 5, 0.5);
    const b = mk("a", 1, 0.5);
    const c = { ...mk("b", 2, 0.5), authorName: "@a" };
    const g = groupByAuthor([a, b, c]);
    expect(g.size).toBe(2);
    expect(g.get("a")!.map((x) => x.publishedAt)).toEqual([b.publishedAt, a.publishedAt]);
  });
});

describe("detectPersonaKind", () => {
  it("villain_arc: warm early, hostile late", () => {
    const r = detectPersonaKind(series("v", [0.8, 0.9, 0.7, 0.8, -0.8, -0.9, -0.7, -0.8]));
    expect(r?.kind).toBe("villain_arc");
  });
  it("redemption_arc: hostile early, warm late", () => {
    const r = detectPersonaKind(series("r", [-0.8, -0.9, -0.7, -0.8, 0.8, 0.9, 0.7, 0.8]));
    expect(r?.kind).toBe("redemption_arc");
  });
  it("superfan: consistently positive across many videos", () => {
    expect(detectPersonaKind(series("s", [0.7, 0.8, 0.9, 0.6, 0.7, 0.8]))?.kind).toBe("superfan");
  });
  it("consistent_hater: consistently negative", () => {
    expect(detectPersonaKind(series("h", [-0.7, -0.8, -0.9, -0.6, -0.7]))?.kind).toBe("consistent_hater");
  });
  it("one_bad_day: positive with a single nasty outlier (any position)", () => {
    expect(detectPersonaKind(series("o", [0.7, 0.8, -0.95, 0.7, 0.8, 0.9, 0.7]))?.kind).toBe("one_bad_day");
  });
  it("comedian: mostly funny", () => {
    const c = series("c", [0.45, 0.45, 0.45, 0.45, 0.2], { vibe: "funny" });
    expect(detectPersonaKind(c)?.kind).toBe("comedian");
  });
  it("comedian needs 60% funny: two jokes and two compliments is a warm commenter", () => {
    const mixed = [...series("cm", [0.45, 0.45], { vibe: "funny" }), ...series("cm", [0.7, 0.8]).map((c, i) => ({ ...c, videoId: `x${i}` }))];
    expect(detectPersonaKind(mixed)?.kind).not.toBe("comedian");
  });
  it("reply_guy: huge volume, many comments per video", () => {
    const comments = Array.from({ length: 15 }, (_, i) => mk("g", i % 5, 0, { vibe: "question" }));
    expect(detectPersonaKind(comments)?.kind).toBe("reply_guy");
  });
  it("reply_guy needs breadth: 40 comments on one video is not 'everywhere'", () => {
    const comments = Array.from({ length: 40 }, (_, i) => mk("g", i % 2, 0, { vibe: "question" }));
    expect(detectPersonaKind(comments)?.kind).not.toBe("reply_guy");
  });
  it("a single nasty outlier in a thin late half does not make a villain", () => {
    // the reviewer's case: early [.9,.9], late [.2,-1.0] over 4 videos
    expect(detectPersonaKind(series("t", [0.9, 0.9, 0.2, -1.0]))?.kind).not.toBe("villain_arc");
    // 6 comments, one nasty in the late half: averages look like an arc, the shares do not
    const six = detectPersonaKind(series("t6", [0.9, 0.9, 0.9, 0.1, -0.1, -1.0]));
    expect(six?.kind).not.toBe("villain_arc");
    // mirrored for redemption
    expect(detectPersonaKind(series("r6", [-1.0, -0.1, 0.1, 0.9, 0.9, 0.9]))?.kind).not.toBe("redemption_arc");
  });
  it("villain needs a negative final comment; redemption a positive one", () => {
    expect(detectPersonaKind(series("f", [0.8, 0.9, 0.8, -0.8, -0.9, 0.3]))?.kind).not.toBe("villain_arc");
    expect(detectPersonaKind(series("g", [-0.8, -0.9, -0.8, 0.8, 0.9, -0.3]))?.kind).not.toBe("redemption_arc");
  });
  it("arcs need real elapsed time between first and last comment", () => {
    const burst = [0.8, 0.9, 0.8, -0.8, -0.9, -0.8].map((s, i) => ({ ...mk("b", i, s), publishedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString() }));
    expect(detectPersonaKind(burst)?.kind).not.toBe("villain_arc");
  });
  it("prolific superfans and haters keep their persona instead of becoming reply guys", () => {
    const fan = Array.from({ length: 20 }, (_, i) => mk("fan", i % 10, 0.9));
    const hater = Array.from({ length: 20 }, (_, i) => mk("hate", i % 10, -0.9));
    expect(detectPersonaKind(fan)?.kind).toBe("superfan");
    expect(detectPersonaKind(hater)?.kind).toBe("consistent_hater");
  });
  it("returns null when there is too little evidence", () => {
    expect(detectPersonaKind(series("x", [0.9, 0.9]))).toBeNull();
  });
  it("needs several distinct videos for traits", () => {
    const sameVideo = [0.8, 0.9, 0.8, 0.9, 0.8].map((s, i) => mk("y", i, s, { videoId: "only" }));
    expect(detectPersonaKind(sameVideo)).toBeNull();
  });
  it("does not call a mixed commenter anything", () => {
    expect(detectPersonaKind(series("m", [0.8, -0.8, 0.7, -0.7, 0.6, -0.6]))).toBeNull();
  });
  it("a late bad streak is a villain arc, not a bad day", () => {
    const r = detectPersonaKind(series("z", [0.8, 0.8, 0.8, 0.8, -0.8, -0.8, -0.8]));
    expect(r?.kind).toBe("villain_arc");
  });
});

describe("real-data rules (5-comment arcs, video-date order, mild bad days)", () => {
  it("redemption_arc fires on a compact 5-comment history: two cool early comments, warm finish", () => {
    expect(detectPersonaKind(series("r5", [-0.4, -0.1, 0.4, 1.0, 1.0]))?.kind).toBe("redemption_arc");
    expect(detectPersonaKind(series("v5", [1.0, 0.9, 0.4, -0.2, -0.45]))?.kind).toBe("villain_arc");
  });
  it("a lone extreme outlier in a thin half still does not make an arc at 5 comments", () => {
    expect(detectPersonaKind(series("o5", [0.9, 0.9, 0.5, 0.2, -1.0]))?.kind).not.toBe("villain_arc");
    expect(detectPersonaKind(series("o6", [-1.0, 0.2, 0.5, 0.9, 0.9]))?.kind).not.toBe("redemption_arc");
  });
  it("arcs follow VIDEO publish order, not comment time", () => {
    // Comment-time order is c0..c5 = [.8, -.8, -.9, .9, .8, .7]: no arc. The videos they sit on were published in a
    // different order (c0, c3, c4, c5, c1, c2), so by VIDEO the warm comments come first and the hostile ones last.
    const vals = [0.8, -0.8, -0.9, 0.9, 0.8, 0.7];
    const cs = vals.map((s, i) => mk("vd", i, s, { videoId: `v${i}` }));
    const order = [0, 3, 4, 5, 1, 2];
    const videoDates = new Map(order.map((ci, rank) => [`v${ci}`, new Date(Date.UTC(2025, 0, 1 + rank * 10)).toISOString()]));
    expect(detectPersonaKind(cs)).toBeNull();
    expect(detectPersonaKind(cs, undefined, videoDates)?.kind).toBe("villain_arc");
    const p = buildPersonas(cs, { videos: [...videoDates].map(([id, publishedAt]) => ({ id, title: id, publishedAt, thumbnail: "", commentCount: 1 })) })[0];
    expect(p.kind).toBe("villain_arc");
    expect(p.timeline.map((t) => t.videoId)).toEqual(order.map((i) => `v${i}`));
  });
  it("ignores an arc when comment-time order contradicts video order (they binged the catalogue newest first)", () => {
    // by video the warm comments come last (redemption), but they were POSTED in the opposite order
    const vals = [0.8, 0.9, 0.8, -0.8, -0.9, -0.8];
    const cs = vals.map((s, i) => mk("vd", i, s, { videoId: `v${i}` }));
    const videoDates = new Map(cs.map((c, i) => [c.videoId, new Date(Date.UTC(2025, 0, 1 + (5 - i) * 10)).toISOString()]));
    expect(detectPersonaKind(cs, undefined, videoDates)).toBeNull();
  });
  it("a binge through the back catalogue is not an arc: the span is measured on comment dates, not video dates", () => {
    const vals = [0.8, 0.9, 0.8, -0.8, -0.9, -0.8];
    const cs = vals.map((s, i) => ({ ...mk("binge", i, s, { videoId: `v${i}` }), publishedAt: new Date(Date.UTC(2026, 9, 12, 10, i)).toISOString() }));
    const videoDates = new Map(cs.map((c, i) => [c.videoId, new Date(Date.UTC(2026, 0, 1 + i * 40)).toISOString()]));
    expect(detectPersonaKind(cs, undefined, videoDates)).toBeNull();
  });
  it("a four-comment arc over real time counts (data: two genuine redemption arcs had 4 comments)", () => {
    expect(detectPersonaKind(series("r4", [-0.5, -0.4, 0.3, 0.8]))?.kind).toBe("redemption_arc");
    expect(detectPersonaKind(series("v4", [0.8, 0.5, -0.4, -0.5]))?.kind).toBe("villain_arc");
  });
  it("one_bad_day accepts a single clearly critical comment (-0.4 or lower) in a warm history", () => {
    const cs = series("bd", [0.6, 0.7, 0.5, 0.6, 0.7, 0.8]);
    cs[3] = mk("bd", 3, -0.45, { vibe: "critical" });
    expect(detectPersonaKind(cs)?.kind).toBe("one_bad_day");
  });
  it("one_bad_day needs a properly nasty outlier: a -0.35 critical or a mixed-tone question is not a bad day", () => {
    const mild = series("bd2", [0.6, 0.7, 0.5, 0.6, 0.7, 0.8]);
    mild[3] = mk("bd2", 3, -0.35, { vibe: "critical" });
    expect(detectPersonaKind(mild)?.kind).not.toBe("one_bad_day");
    const q = series("bd3", [0.6, 0.7, 0.5, 0.6, 0.7, 0.8]);
    q[3] = mk("bd3", 3, -0.6, { vibe: "question" });
    expect(detectPersonaKind(q)?.kind).not.toBe("one_bad_day");
  });
  it("one_bad_day allows no second negative-toned comment (a quoted joke at -0.21 muddies the story)", () => {
    const cs = series("bd4", [0.6, 0.7, 0.5, 0.6, 0.7, 0.8]);
    cs[3] = mk("bd4", 3, -0.6, { vibe: "toxic" });
    cs[1] = mk("bd4", 1, -0.21, { vibe: "toxic" });
    expect(detectPersonaKind(cs)?.kind).not.toBe("one_bad_day");
  });
  it("one_bad_day still needs a warm history (not just anything with one bad comment)", () => {
    const cs = series("nb", [0.1, 0.2, 0.1, 0.2, 0.1, 0.0]);
    cs[3] = mk("nb", 3, -0.4, { vibe: "critical" });
    expect(detectPersonaKind(cs)?.kind).not.toBe("one_bad_day");
  });
});

describe("computeMostLoyal", () => {
  const vids = ["a", "b", "c", "d"].map((id) => ({ id, title: id, publishedAt: "2026-01-01T00:00:00Z", thumbnail: "", commentCount: 0 }));
  it("returns the commenter on the most distinct videos", () => {
    const cs = [
      ...["a", "b", "c", "d"].map((v) => mk("loyal", 1, 0.5, { videoId: v, likes: 3, text: "so good" })),
      ...["a", "a", "a", "b"].map((v) => mk("loud", 1, 0.5, { videoId: v })),
    ];
    const m = computeMostLoyal(cs, vids);
    expect(m?.authorId).toBe("loyal");
    expect(m?.videosCommented).toBe(4);
    expect(m?.totalVideos).toBe(4);
    expect(m?.verdict).toMatch(/4 of (the last )?4/);
    expect(m?.verdict).not.toContain("@");
  });
  it("calls a same-day marathon a binge, not a standing appointment", () => {
    const cs = ["a", "b", "c", "d"].map((v, i) => ({ ...mk("binger", 1, 0.5, { videoId: v, text: `thoughts number ${i} on this one` }), publishedAt: `2026-03-02T0${i}:00:00Z` }));
    const m = computeMostLoyal(cs, vids);
    expect(m?.verdict).toMatch(/binge/i);
    expect(m?.verdict).not.toMatch(/standing appointment|streak|Loyalty/i);
  });
  it("prefers an English headline of at least five words over a more-liked emoji or foreign one", () => {
    const cs = [
      { ...mk("l", 1, 0.5, { videoId: "a", likes: 900, text: "❤️❤️❤️❤️" }) },
      { ...mk("l", 1, 0.5, { videoId: "b", likes: 500, text: "Muy bueno el video amigo gracias por todo" }) },
      { ...mk("l", 1, 0.5, { videoId: "c", likes: 5, text: "This is the best video you have made all year" }) },
      { ...mk("l", 1, 0.5, { videoId: "d", likes: 1, text: "nice" }) },
    ];
    expect(computeMostLoyal(cs, vids)?.headlineComment).toBe("This is the best video you have made all year");
  });
  it("is undefined when nobody comments on at least 3 videos", () => {
    expect(computeMostLoyal([mk("x", 1, 0.5, { videoId: "a" })], vids)).toBeUndefined();
  });
});

describe("persona hygiene", () => {
  it("the same text repeated under the same video counts once", () => {
    const spam = Array.from({ length: 4 }, () => mk("dup", 0, 0.6, { videoId: "only", text: "same thing again" }));
    const rest = Array.from({ length: 6 }, (_, i) => mk("dup", i + 1, 0.6, { text: `different ${i}` }));
    const p = buildPersonas([...spam, ...rest])[0];
    expect(p.commentCount).toBe(7);
    expect(p.timeline.filter((t) => t.text === "same thing again")).toHaveLength(1);
  });
  it("headline comments prefer camera-safe English over a more extreme foreign or profane line", () => {
    const cs = [
      mk("fan", 0, 0.9, { text: "Muy bueno el video amigo gracias por todo", likes: 500 }),
      mk("fan", 1, 0.9, { text: "This is honestly the best thing you have ever made", likes: 3 }),
      mk("fan", 2, 0.8, { text: "Absolutely loved this one, thank you so much" }),
      mk("fan", 3, 0.8, { text: "Please keep making videos like this one forever" }),
    ];
    const p = buildPersonas(cs)[0];
    expect(p.kind).toBe("superfan");
    expect(p.headlineComment).not.toMatch(/Muy bueno/);
  });
  it("copy-paste accounts are not personas: one joke pasted on five videos", () => {
    const jumpy = Array.from({ length: 5 }, (_, i) => mk("jumpy", i, 0.5, { vibe: "funny", text: "120-step guide to touching grass" }));
    expect(buildPersonas(jumpy)).toEqual([]);
    const echo = Array.from({ length: 5 }, (_, i) => mk("echo", i, 0.7, { text: "first!" }));
    expect(buildPersonas(echo)).toEqual([]);
  });
  it("templated praise does not make a superfan: near-identical openings count as one distinct text", () => {
    const tpl = ["Your progress is a testament to hard work and dedication, keep going", "Your progress is a testament to hard work and kindness always", "Your progress is a testament to hard work, truly inspiring", "Great content as always, loving this one", "Your progress is a testament to hard work and heart", "Your progress is a testament to hard work, wow", "Amazing video, you never miss", "Your progress is a testament to hard work and love"];
    const fan = tpl.map((t, i) => mk("tpl", i, 0.9, { text: t }));
    expect(buildPersonas(fan)).toEqual([]);
    const real = ["This was the best one yet honestly", "Needed this today, thank you", "The school build made me cry", "Please never stop doing this kind of video", "Finally someone helping people properly", "Watching with my kids again tonight"].map((t, i) => mk("real", i, 0.9, { text: t }));
    expect(buildPersonas(real)[0]?.kind).toBe("superfan");
  });
  it("money-begging pleas and spam-heavy accounts are not personas", () => {
    const plea = Array.from({ length: 20 }, (_, i) => mk("plea", i % 8, 0.5, { text: `Mr beast please help me with money ${i}` }));
    const spam = Array.from({ length: 20 }, (_, i) => mk("spam", i % 8, 0.1, { vibe: "spam", text: `check my channel ${i}` }));
    const fan = Array.from({ length: 6 }, (_, i) => mk("fan", i, 0.8, { text: `lovely ${i}` }));
    const ps = buildPersonas([...plea, ...spam, ...fan]);
    expect(ps.map((p) => p.authorId)).toEqual(["fan"]);
  });
  it("one_bad_day ranks the nastier lapse above a longer but milder one", () => {
    const mild = series("mild", [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
    mild[3] = mk("mild", 3, -0.41, { vibe: "critical" });
    const rough = series("rough", [0.6, 0.6, 0.6, 0.6]);
    rough[2] = mk("rough", 2, -0.9, { vibe: "toxic" });
    expect(buildPersonas([...mild, ...rough])[0].authorId).toBe("rough");
  });
});

describe("breadth reply guys and verdict copy", () => {
  it("someone who drops short comments on most videos is a reply_guy, not a superfan", () => {
    const cs = Array.from({ length: 24 }, (_, i) => mk("wide", i, 0.7, { videoId: `w${i}`, text: `nice ${i}` }));
    expect(detectPersonaKind(cs)?.kind).toBe("reply_guy");
    const long = Array.from({ length: 24 }, (_, i) => mk("deep", i, 0.7, { videoId: `w${i}`, text: `This one really got to me because of the way ${i} people were treated, thank you` }));
    expect(detectPersonaKind(long)?.kind).toBe("superfan");
  });
  it("verdict templates never say 'all of Oct of' or leave placeholders, whatever the span", () => {
    const base = { commentCount: 8, videoCount: 4, avgSentiment: 0.3, early: 0, late: 0 };
    for (const [firstAt, lastAt] of [["2026-10-01T00:00:00Z", "2026-10-12T00:00:00Z"], ["2026-03-01T00:00:00Z", "2026-09-12T00:00:00Z"], [undefined, undefined]] as const) {
      for (const kind of ["villain_arc", "redemption_arc", "consistent_hater", "superfan", "one_bad_day", "comedian", "reply_guy"] as const) {
        const opts = verdictOptions(kind, { ...base, firstAt, lastAt });
        expect(opts.length).toBeGreaterThanOrEqual(6);
        for (const o of opts) {
          expect(o).not.toMatch(/all of \w+ of|undefined|NaN|\u0000/);
          expect(o.length).toBeLessThanOrEqual(140);
        }
      }
    }
  });
});

describe("title-aware verdicts", () => {
  const st = { commentCount: 8, videoCount: 4, avgSentiment: 0.3, early: 0, late: 0, firstTitle: "I Built A City To Save Kids", lastTitle: "Eat Everything In A Grocery Store", badTitle: "Hit The Button, Win $1,000" };
  it("every kind gets at least one option naming a video, all within 140 chars", () => {
    for (const kind of ["villain_arc", "redemption_arc", "consistent_hater", "superfan", "one_bad_day", "comedian", "reply_guy"] as const) {
      const opts = verdictOptions(kind, st);
      expect(opts.some((o) => o.includes('"'))).toBe(true);
      for (const o of opts) expect(o.length).toBeLessThanOrEqual(140);
    }
  });
  it("prefers a video-specific line when titles are known, and long titles are shortened", () => {
    const v = templateVerdict("one_bad_day", { ...st, badTitle: "A".repeat(90) }, "seed");
    expect(v).toContain('"');
    expect(v.length).toBeLessThanOrEqual(140);
    expect(templateVerdict("one_bad_day", st, "seed")).toContain("Hit The Button");
  });
  it("stays handle-free and still works with no titles", () => {
    const v = templateVerdict("superfan", { ...st, firstTitle: undefined, lastTitle: undefined }, "x");
    expect(v).not.toContain("undefined");
  });
});

describe("channel owner exclusion", () => {
  it("the channel's own account never becomes a persona or the most loyal commenter", () => {
    const vids = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, title: id, publishedAt: "2026-01-01T00:00:00Z", thumbnail: "", commentCount: 0 }));
    const owner = vids.flatMap((v, i) => [mk("owner", i, 0.9, { videoId: v.id, text: `owner reply ${i}a` }), mk("owner", i, 0.8, { videoId: v.id, text: `owner reply ${i}b` })]);
    const fan = vids.slice(0, 5).map((v, i) => mk("fan", i, 0.8, { videoId: v.id, text: `fan thing ${i}` }));
    const ps = buildPersonas([...owner, ...fan], { excludeAuthorIds: ["owner"] });
    expect(ps.some((p) => p.authorId === "owner")).toBe(false);
    expect(ps.some((p) => p.authorId === "fan")).toBe(true);
    expect(computeMostLoyal([...owner, ...fan], vids, ["owner"])?.authorId).toBe("fan");
    expect(computeMostLoyal([...owner, ...fan], vids)?.authorId).toBe("owner");
  });
});

describe("verdict helpers", () => {
  it("formatTimelineForSummary numbers items with month, year and video title, never 'Mon:' prefixes", () => {
    const out = formatTimelineForSummary([
      { t: "2026-03-05T00:00:00Z", text: "love it", videoTitle: "I Built A City" },
      { t: "2026-08-09T00:00:00Z", text: "this is trash", videoTitle: "Survive 24h" },
    ]);
    expect(out).toBe('1. (Mar 2026, video "I Built A City") love it\n2. (Aug 2026, video "Survive 24h") this is trash');
  });
  it("sanitizeVerdict rejects bland, too long, handle-bearing or fragment output", () => {
    const base = "Cheered every upload until spring, then filed complaints on the rest.";
    expect(sanitizeVerdict(base, ["@someone"])).toBe(base);
    expect(sanitizeVerdict("x".repeat(150), [])).toBeNull();
    expect(sanitizeVerdict("The commenter expressed positive sentiment about the videos.", [])).toBeNull();
    expect(sanitizeVerdict("This user shows a pattern of negative comments.", [])).toBeNull();
    expect(sanitizeVerdict("Ok", [])).toBeNull();
    expect(sanitizeVerdict("You’re a consistent hater with a taste for farsa.", [])).toBeNull();
    expect(sanitizeVerdict("Your quote proves they are obsessed with thrillers.", [])).toBeNull();
    expect(sanitizeVerdict("This superfan cheers every upload without fail.", [])).toBeNull();
    expect(sanitizeVerdict("Treats Oct 2026 as one long applause break.", [])).toBeNull();
    expect(sanitizeVerdict("The comments show a shift from nostalgia to appreciation.", [])).toBeNull();
    expect(sanitizeVerdict("Cheers every upload, then asks what took so long.", [])).not.toBeNull();
    expect(sanitizeVerdict("Teases the fan about button videos.", [])).toBeNull();
    expect(sanitizeVerdict("Inspires with grit across nine videos", [])).toBeNull();
    expect(sanitizeVerdict("Cheers, maine subscribe", [])).toBeNull();
  });
  it("sanitizeVerdict wants a finished sentence, not a fragment", () => {
    expect(sanitizeVerdict("Cheers the chocolate river tease and more", [])).toBeNull();
    expect(sanitizeVerdict("Cheered the chocolate river tease every single time.", [])).not.toBeNull();
  });
  it("sanitizeVerdict rejects any count, digit or spelled out, since nobody verifies what the model counted", () => {
    expect(sanitizeVerdict("Left 5 warm notes and then one rough afternoon.", [])).toBeNull();
    expect(sanitizeVerdict("Seven warm notes, then a rough afternoon of grumbling.", [])).toBeNull();
    expect(sanitizeVerdict("Cheered every upload, then twice asked what took so long.", [])).toBeNull();
    expect(sanitizeVerdict("Warm for ages, then one very rough afternoon of grumbling.", [])).not.toBeNull();
  });
  it("sanitizeVerdict can require the line to be grounded in the evidence", () => {
    const evidence = '1. (Mar 2026, video "I Built A City") Ten homes for teachers and a school\n2. (Apr 2026) clean water for everyone';
    expect(sanitizeVerdict("Keeps applauding the school and the teachers' homes.", [], { evidence })).not.toBeNull();
    expect(sanitizeVerdict("Swears eternal loyalty to a vegetarian milkshake.", [], { evidence })).toBeNull();
    // parroting a comment back is not a verdict
    expect(sanitizeVerdict("Ten homes for teachers and a school.", [], { evidence })).toBeNull();
    expect(sanitizeVerdict("Jaynal kept showing up in every thread somehow.", ["@Jaynal"])).toBeNull();
    expect(sanitizeVerdict("Hated it at first. Then loved it. Then wrote a poem.", [])).toBe("Hated it at first. Then loved it. Then wrote a poem.");
  });
});

describe("buildPersonas", () => {
  const all = [
    ...series("villain", [0.8, 0.9, 0.7, 0.8, -0.8, -0.9, -0.7, -0.8]),
    ...series("fan", [0.8, 0.9, 0.7, 0.8, 0.9, 0.8]),
    ...series("hater", [-0.8, -0.9, -0.7, -0.8, -0.8]),
    ...series("lurker", [0.5]),
  ];
  it("produces ranked personas with timelines in chronological order", () => {
    const ps = buildPersonas(all);
    expect(ps.map((p) => p.kind)).toEqual(["villain_arc", "consistent_hater", "superfan"]);
    const v = ps[0];
    expect(v.authorId).toBe("villain");
    expect(v.commentCount).toBe(8);
    expect(v.videoCount).toBe(8);
    expect(v.timeline).toHaveLength(8);
    const times = v.timeline.map((t) => t.t);
    expect([...times].sort()).toEqual(times);
    expect(v.avgSentiment).toBeCloseTo(0, 1);
    expect(v.verdict.length).toBeGreaterThan(15);
    expect(v.verdict).not.toContain("@villain");
  });
  it("limits personas per kind and ranks stronger/larger first", () => {
    const many = [
      ...series("f1", [0.9, 0.9, 0.9, 0.9]),
      ...series("f2", [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      ...series("f3", [0.6, 0.6, 0.6, 0.6, 0.6]),
    ];
    const ps = buildPersonas(many, { perKind: 2 });
    expect(ps).toHaveLength(2);
    expect(ps[0].authorId).toBe("f2");
  });
  it("picks the most representative headline comment", () => {
    const villain = series("v", [0.8, 0.9, 0.7, 0.8, -0.3, -0.95, -0.7, -0.8]);
    villain[5].text = "the nastiest one";
    const p = buildPersonas(villain)[0];
    expect(p.kind).toBe("villain_arc");
    expect(p.headlineComment).toBe("the nastiest one");
  });
});

describe("aggregates", () => {
  const cs = [
    mk("a", 0, 0.8, { videoId: "v1", vibe: "supportive", text: "love it so much" }),
    mk("b", 0, -0.9, { videoId: "v1", vibe: "toxic", text: "this is garbage and you know it honestly" }),
    mk("a", 1, 0.45, { videoId: "v2", vibe: "funny", text: "lol the cat though", likes: 50 }),
    mk("c", 1, 0, { videoId: "v2", vibe: "question", text: "what mic is that?" }),
  ];
  it("computeTotals", () => {
    const t = computeTotals(cs);
    expect(t.comments).toBe(4);
    expect(t.commenters).toBe(3);
    expect(t.byVibe.toxic).toBe(1);
    expect(t.byVibe.funny).toBe(1);
    expect(t.avgSentiment).toBeCloseTo((0.8 - 0.9 + 0.45 + 0) / 4, 3);
  });
  it("computeTotals on empty input is finite", () => {
    const t = computeTotals([]);
    expect(t.avgSentiment).toBe(0);
    expect(t.comments).toBe(0);
  });
  it("topComments", () => {
    const t = topComments(cs, 3);
    expect(t.funniest[0].text).toBe("lol the cat though");
    expect(t.nastiest[0].text).toBe("this is garbage and you know it honestly");
    expect(t.sweetest[0].text).toBe("love it so much");
  });
  it("nastiest is camera-safe: English, no profanity, no @mentions, deduped, ranked by confidence and punchy length", () => {
    const tox = (text: string, conf: number, likes = 0) => {
      const c = mk(`n${seq}`, 1, -0.8, { vibe: "toxic", text, likes });
      c.scores = { ...c.scores, toxic: conf };
      return c;
    };
    const pool = [
      tox("this is such a fucking scam", 0.99),
      tox("Eres un completo fracaso, no vuelvas a subir esto", 0.99),
      tox("你真的很糟糕，别再拍了", 0.99),
      tox("@someone you are the worst thing about this video", 0.99),
      tox("Honestly the laziest video this channel has ever put out", 0.9),
      tox("Honestly the laziest video this channel has ever put out", 0.9),
      tox("This is the most boring thing I have watched in years", 0.7),
      tox("so bad", 0.99),
    ];
    const n = topComments(pool, 5).nastiest.map((c) => c.text);
    expect(n).toEqual(["Honestly the laziest video this channel has ever put out", "This is the most boring thing I have watched in years"]);
  });
  it("looksEnglish rejects Turkish, leetspeak Spanish, Hinglish and CJK but keeps plain English", () => {
    for (const t of ["Merhaba ben 10 filmleri çekmenin çünkü çok kötü size hem içi", "A mi me emput4 recontra recontra 3mput4 es ese d3sagradabl3", "Mr beast mai aapki video dekh raha hun bhai", "你真的很糟糕，别再拍了", "Pura basura falcedad"]) expect(looksEnglish(t)).toBe(false);
    for (const t of ["Rakai is a type of guy who everyone wants to avoid, but still sticks around", "This is the most boring thing I have watched in years"]) expect(looksEnglish(t)).toBe(true);
  });
  it("perVideoStats follows the video order and is NaN-free", () => {
    const pv = perVideoStats(cs, [
      { id: "v2", title: "", publishedAt: "", thumbnail: "", commentCount: 0 },
      { id: "v1", title: "", publishedAt: "", thumbnail: "", commentCount: 0 },
      { id: "v3", title: "", publishedAt: "", thumbnail: "", commentCount: 0 },
    ]);
    expect(pv.map((p) => p.videoId)).toEqual(["v2", "v1", "v3"]);
    expect(pv[1].avgSentiment).toBeCloseTo(-0.05, 3);
    expect(pv[2].avgSentiment).toBe(0);
  });
});
