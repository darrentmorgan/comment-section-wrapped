import type React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentText, StreamerProvider } from "../mask";
import { SHOWDOWN_FIXTURE } from "../showdownFixture";
import { CardsSlide, DisagreeSlide, EdgeSlide, RaceSlide, VerdictSlide } from "../ShowdownSlides";
import { type ShowdownView, edgeOf, finishOrder, laneProgress, pickDisagreements, readerColor, tally, toShowdownView, verdict } from "../showdown";

const clone = (): ShowdownView => structuredClone(SHOWDOWN_FIXTURE);

describe("verdict", () => {
  it("names no winner when ranges overlap and gaps are small", () => {
    const v = clone();
    v.readers.forEach((r) => {
      if (r.kind === "decision" || r.kind === "llm") {
        r.costPer1k = 0.05;
        r.p50Ms = 900;
      }
    });
    const out = verdict(v);
    expect(out.lopsided).toBe(false);
    expect(out.headline).toBe("No runaway winner.");
    expect(out.tiles.find((t) => t.label === "Closest to the referee")!.sub).toContain("not accuracy");
  });
  it("states a factual gap when cost differs 3x or more", () => {
    const v = clone();
    v.readers.find((r) => r.id === "llm1")!.costPer1k = 0.2;
    const out = verdict(v);
    expect(out.lopsided).toBe(true);
    expect(out.lines[0].text).toMatch(/cheapest/);
  });
  it("ranks only per-comment readers: a cheaper batch lane is never named cheapest or fastest", () => {
    const v = clone();
    const out = verdict(v);
    const text = out.lines.map((l) => l.text).join(" ") + out.tiles.map((t) => t.reader).join(" ");
    expect(text).not.toMatch(/batch/i);
    expect(out.tiles.map((t) => t.label)).toEqual(["Cheapest", "Fastest alone", "Closest to the referee"]);
  });
  it("ranks speed one request at a time when every reader has it, and says so", () => {
    const v = clone();
    v.readers.find((r) => r.id === "sd")!.serialP50Ms = 100;
    v.readers.find((r) => r.id === "jev")!.serialP50Ms = 900;
    v.readers.find((r) => r.id === "llm1")!.serialP50Ms = 950;
    const out = verdict(v);
    const fast = out.tiles.find((t) => t.label === "Fastest alone")!;
    expect(fast.reader).toBe("Decisions model A");
    expect(out.lines.map((l) => l.text).join(" ")).toMatch(/asked one at a time/);
  });
  it("never uses vendor marketing words", () => {
    const text = verdict(clone()).lines.map((l) => l.text).join(" ");
    expect(text).not.toMatch(/powered by|200x|467x|cheaper \(est/i);
  });
});

describe("pickDisagreements (watchable only)", () => {
  const two = [{ readerId: "x", vibe: "funny" as const }, { readerId: "y", vibe: "spam" as const }];
  it("drops two-word comments, non-Latin text and server-flagged unreadable ones", () => {
    const d = pickDisagreements([
      { id: "short", text: "Left Right", answers: two },
      { id: "ru", text: "Привет всем, это очень длинный комментарий", answers: two },
      { id: "flag", text: "this is a perfectly long comment indeed", answers: two, readable: false },
      { id: "good", text: "bro really said I will do it for free", answers: two, referee: "funny" },
    ]);
    expect(d.map((x) => x.id)).toEqual(["good"]);
  });
});

describe("finishOrder", () => {
  it("ranks per-comment readers by wall time and gives batch mode no place", () => {
    const o = finishOrder(clone());
    expect(o.sdb).toBeUndefined();
    expect(o.sd).toBe(1);
    expect(o.jev).toBe(3);
    expect(Object.keys(o)).not.toContain("base1");
  });
});

describe("readerColor", () => {
  it("gives every model reader a different hue", () => {
    const v = clone();
    const colours = v.readers.filter((r) => r.kind === "decision" || r.kind === "llm").map((r) => readerColor(v, r.id));
    expect(new Set(colours).size).toBe(colours.length);
  });
});

describe("pickDisagreements", () => {
  it("ranks by distinct answers and drops unanimous items", () => {
    const d = pickDisagreements(
      [
        { id: "a", text: "same same same same same same", answers: [{ readerId: "x", vibe: "funny" }, { readerId: "y", vibe: "funny" }] },
        { id: "b", text: "two two two two two two two", answers: [{ readerId: "x", vibe: "funny" }, { readerId: "y", vibe: "spam" }] },
        { id: "c", text: "three three three three three", answers: [{ readerId: "x", vibe: "funny" }, { readerId: "y", vibe: "spam" }, { readerId: "z", vibe: "toxic" }] },
      ],
      5,
    );
    expect(d.map((x) => x.id)).toEqual(["c", "b"]);
  });
});

describe("laneProgress", () => {
  it("finishes slow lanes last and leaves skipped lanes at zero", () => {
    const p = laneProgress(SHOWDOWN_FIXTURE, 3000, 6000);
    expect(p.llm2).toBe(0);
    expect(p.base1).toBe(1);
    expect(p.jev).toBeLessThanOrEqual(1);
    expect(p.jev).toBeLessThan(p.sd);
  });
});

describe("toShowdownView", () => {
  it("returns null for nothing and for empty readers", () => {
    expect(toShowdownView(null)).toBeNull();
    expect(toShowdownView({})).toBeNull();
  });
  it("maps the server summary and drops disagreements that are not camera-safe", () => {
    const v = toShowdownView({
      summary: {
        sampleSize: 10,
        refereeSize: 4,
        totalCostUsd: 0.01,
        refereeIds: ["ref"],
        readers: [
          { id: "a", label: "Model A", kind: "decisions", priceNote: "", enabled: true, status: "ok" },
          { id: "j", label: "Model J", kind: "decisions", priceNote: "", enabled: false, note: "waiting for a key" },
          { id: "ref", label: "Referee", kind: "referee", priceNote: "", enabled: true, status: "ok" },
        ],
        stats: {
          a: { costPer1k: 0.04, costSource: "api", p50Ms: 900, p95Ms: 1200, throughputPerSec: 12, failureRate: 0, wallMs: 5000, costUsd: 0.0004, agreementWithReferee: { rate: 0.6, lo: 0.4, hi: 0.8, n: 4 } },
        },
        matrix: { readerIds: ["a"], agreement: [[1]], ci: [], kappa: [[1]] },
      },
      disagreements: [
        { commentId: "1", text: "ok", stratum: "x", answers: [{ readerId: "a", vibe: "funny" }], distinct: 2, handPicked: false, cameraSafe: true },
        { commentId: "2", text: "nope", stratum: "x", answers: [], distinct: 2, handPicked: false, cameraSafe: false },
      ],
    } as never);
    expect(v?.readers.map((r) => [r.id, r.kind, r.enabled])).toEqual([["a", "decision", true], ["j", "decision", false], ["ref", "referee", true]]);
    expect(v?.readers[0].vsReferee).toEqual({ value: 0.6, lo: 0.4, hi: 0.8 });
    expect(v?.disagreements.map((d) => d.id)).toEqual(["1"]);
  });
});

describe("toShowdownView hygiene", () => {
  const base = {
    sampleSize: 10, refereeSize: 4, totalCostUsd: 0, refereeIds: [],
    readers: [
      { id: "a", label: "Model A", kind: "decisions", priceNote: "", enabled: true, status: "ok" },
      { id: "scaledown-saved", label: "Saved run", kind: "saved", priceNote: "", enabled: true, status: "ok" },
      { id: "b", label: "Batch", kind: "batch", priceNote: "", enabled: true, status: "ok", mode: "batch" },
    ],
    stats: { a: { costPer1k: 0.04, p50Ms: 1, p95Ms: 2, p95AllMs: 9, throughputPerSec: 1, failureRate: 0, wallMs: 1000, costUsd: 0, concurrency: { start: 16, max: 16, final: 16 }, ok: 10, failed: 0, serialP50Ms: 5 }, b: { costPer1k: 0.01, p50Ms: 1, p95Ms: 2, throughputPerSec: 1, failureRate: 0, wallMs: 1, costUsd: 0, ok: 10, failed: 0 } },
    matrix: { readerIds: ["a", "scaledown-saved", "b"], agreement: [[1, 0.5, 0.6], [0.5, 1, 0.7], [0.6, 0.7, 1]], ci: [], kappa: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    caveats: ["c1"], disagreementCounts: { compared: 10, split: 4, cameraSafe: 3 },
  };
  it("drops the saved reference lane, keeps modes, prefers the failure-inclusive slow tail and carries caveats", () => {
    const v = toShowdownView({ summary: base as never, disagreements: [] })!;
    expect(v.readers.map((r) => r.id)).toEqual(["a", "b"]);
    expect(v.readers[1].mode).toBe("batch");
    expect(v.readers[0].p95Ms).toBe(9);
    expect(v.readers[0].serialP50Ms).toBe(5);
    expect(v.readers[0].inFlight).toBe(16);
    expect(v.caveats).toEqual(["c1"]);
    expect(v.split).toEqual({ compared: 10, split: 4 });
    expect(v.matrix!.ids).toEqual(["a", "b"]);
    expect(v.matrix!.agreement).toEqual([[1, 0.6], [0.6, 1]]);
  });
  it("tally finds the plurality answer", () => {
    expect(tally([{ vibe: "funny" }, { vibe: "funny" }, { vibe: "spam" }])).toEqual({ vibe: "funny", count: 2, of: 3 });
  });
});

describe("streamer mode on showdown screens", () => {
  const html = (on: boolean) =>
    renderToStaticMarkup(createElement(StreamerProvider, { value: on }, createElement(CommentText, { text: "@realhandle you are so wrong", max: 200 })));
  it("masks @mentions in a disagreement comment when streamer mode is on", () => {
    const out = html(true);
    expect(out).not.toContain("realhandle");
    expect(out).toContain("@re***le");
  });
  it("shows them when it is off", () => {
    expect(html(false)).toContain("@realhandle");
  });
  it("masks handles inside a rendered disagreement slide too", () => {
    const d = { id: "x", text: "@realhandle you are so wrong about this", answers: [{ readerId: "sd", vibe: "funny" as const }, { readerId: "jev", vibe: "spam" as const }], referee: "funny" as const };
    const out = (on: boolean) => renderToStaticMarkup(createElement(StreamerProvider, { value: on }, createElement(DisagreeSlide, { view: SHOWDOWN_FIXTURE, d, index: 0 })));
    expect(out(true)).not.toContain("realhandle");
    expect(out(false)).toContain("realhandle");
  });
  it("holds no author names in the fixture", () => {
    expect(JSON.stringify(SHOWDOWN_FIXTURE)).not.toMatch(/authorName|authorId/);
  });
});

describe("showdown slides render the honest labels", () => {
  const render = (el: React.ReactElement) => renderToStaticMarkup(createElement(StreamerProvider, { value: true }, el));
  it("race: baselines are grouped as free, batch is tagged, saved-run alias never shows as not run", () => {
    const html = render(createElement(RaceSlide, { view: SHOWDOWN_FIXTURE }));
    expect(html).toContain("Free baselines, no model");
    expect(html).toContain("batch of 50, vibe only");
    expect(html).toContain("16 requests at a time");
    expect(html).not.toContain("saved run");
  });
  it("cards: cheapest and fastest are badged among per-comment readers; batch card reports per request", () => {
    const html = render(createElement(CardsSlide, { view: SHOWDOWN_FIXTURE }));
    expect(html).toContain("Cheapest");
    expect(html).toContain("Fastest alone");
    expect(html).toContain("median per 50-comment request");
    expect(html).toContain("median, one at a time");
    expect(html).not.toMatch(/200x|467x|powered by/i);
  });
  it("verdict: three tiles, a result headline and the caveats block", () => {
    const html = render(createElement(VerdictSlide, { view: SHOWDOWN_FIXTURE }));
    expect(html).toContain("Closest to the referee");
    expect(html).toContain("Agreement is not accuracy");
    expect(html).toContain("leans toward that classifier");
    expect(html.replace(/<!-- -->/g, "")).toMatch(/across 4 AI readers, 2 free baselines/);
  });
});

describe("edgeOf (code vs models)", () => {
  it("pairs the keyword rules with the closest model and picks readable examples, at most 3", () => {
    const e = edgeOf(clone())!;
    expect(e.rules.id).toBe("base2");
    expect(e.best.id).toBe("llm1");
    expect(e.guess?.id).toBe("base1");
    expect(e.examples.map((x) => x.id)).toEqual(["m1", "m2", "m4"]);
  });
  it("is null without a keyword-rules reader or without examples", () => {
    const v = clone();
    v.readers = v.readers.filter((r) => r.id !== "base2");
    expect(edgeOf(v)).toBeNull();
    const w = clone();
    w.codeMisses = [];
    expect(edgeOf(w)).toBeNull();
  });
  it("toShowdownView maps camera-safe code misses only", () => {
    const v = toShowdownView({
      summary: { sampleSize: 1, refereeSize: 1, totalCostUsd: 0, refereeIds: [], readers: [{ id: "a", label: "A", kind: "decisions", priceNote: "", enabled: true, status: "ok" }], stats: {} } as never,
      codeMisses: [
        { commentId: "x", text: "safe one here please", rules: "supportive", referee: "funny", right: 2, of: 2, cameraSafe: true, readable: true },
        { commentId: "y", text: "not safe", rules: "supportive", referee: "toxic", right: 2, of: 2, cameraSafe: false, readable: true },
      ],
    })!;
    expect(v.codeMisses.map((m) => m.id)).toEqual(["x"]);
  });
  it("renders the gap and masks handles in streamer mode", () => {
    const html = renderToStaticMarkup(createElement(StreamerProvider, { value: true }, createElement(EdgeSlide, { view: SHOWDOWN_FIXTURE }))).replace(/<!-- -->/g, "");
    expect(html).toContain("Keyword rules");
    expect(html).toContain("46%");
    expect(html).toContain("71%");
    expect(html).not.toContain("someone_real");
  });
});

describe("referee label", () => {
  it("names the referee the agreement is scored against, not the first referee listed", () => {
    const v = toShowdownView({
      summary: {
        sampleSize: 1, refereeSize: 1, totalCostUsd: 0, refereeIds: ["referee-sonnet", "referee-opus"],
        readers: [
          { id: "a", label: "A", kind: "decisions", priceNote: "", enabled: true, status: "ok" },
          { id: "referee-sonnet", label: "Claude Sonnet 5.5 (referee)", kind: "referee", priceNote: "", enabled: true, status: "ok" },
          { id: "referee-opus", label: "Claude Opus 5.5 (referee)", kind: "referee", priceNote: "", enabled: true, status: "ok" },
        ],
        stats: {
          a: { costPer1k: 0, throughputPerSec: 1, failureRate: 0, wallMs: 1, costUsd: 0, p50Ms: 1, p95Ms: 1, agreementWithReferee: { rate: 0.5, lo: 0.4, hi: 0.6, n: 1 } },
          "referee-sonnet": { costPer1k: 1, throughputPerSec: 1, failureRate: 0, wallMs: 1, costUsd: 0, p50Ms: 1, p95Ms: 1, agreementWithReferee: { rate: 0.9, lo: 0.8, hi: 0.95, n: 1 } },
          "referee-opus": { costPer1k: 1, throughputPerSec: 1, failureRate: 0, wallMs: 1, costUsd: 0, p50Ms: 1, p95Ms: 1, agreementWithReferee: null },
        },
      } as never,
    })!;
    expect(v.refereeLabel).toContain("Opus");
  });
});
