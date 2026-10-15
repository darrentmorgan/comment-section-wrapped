import { describe, expect, it } from "vitest";
import { alwaysSupportive, rulesReader } from "../baselines";
import { QUESTIONS_HASH, decisionsQuestions, llmJsonSchema, llmSystemPrompt, prepText, VIBE_CRITERIA } from "../questions";
import { VIBES } from "../../vibes";

describe("questions", () => {
  it("covers every vibe exactly once, in both the decisions and LLM forms", () => {
    const q = decisionsQuestions();
    expect(Object.keys(q.vibe.criteria).sort()).toEqual([...VIBES].sort());
    expect(llmJsonSchema().properties.vibe.enum).toEqual([...VIBES]);
    const sys = llmSystemPrompt();
    for (const v of VIBES) expect(sys).toContain(`- ${v}: ${VIBE_CRITERIA[v]}`);
  });
  it("hash is stable and prepText caps and normalises", () => {
    expect(QUESTIONS_HASH).toMatch(/^[0-9a-f]+$/);
    expect(prepText("  a \n\n b ")).toBe("a b");
    expect(prepText("x".repeat(900)).length).toBe(500);
    expect(prepText("   ")).toBe("[no text]");
  });
});

describe("baselines", () => {
  it("always-supportive never says toxic", () => expect(alwaysSupportive()).toEqual({ vibe: "supportive", toxic: false }));
  it("rules reader hits each branch", () => {
    expect(rulesReader("check out my channel www.x.com").vibe).toBe("spam");
    expect(rulesReader("you are a complete idiot").toxic).toBe(true);
    expect(rulesReader("lol this is gold").vibe).toBe("funny");
    expect(rulesReader("how do I enter the next one?").vibe).toBe("question");
    expect(rulesReader("this is so scripted").vibe).toBe("critical");
    expect(rulesReader("love you man").vibe).toBe("supportive");
  });
});
