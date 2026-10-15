import { describe, expect, it, vi } from "vitest";
import { buildRoster, jevReader, llmReader, openaiDecisionsReader, parseChat, parseDecisions, parseOpenAIDecisions, scaledownBatchReader, scaledownDecisionsReader } from "../adapters";
import { ProviderError } from "../http";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const ctx = (f: unknown) => ({ fetchImpl: f as typeof fetch, sleep: async () => {}, random: () => 0 });

// shape captured from a live ScaleDown call
const LIVE = {
  model: "classify-1",
  answers: {
    vibe: { type: "choice", choice: "funny", probabilities: { toxic: 0.209, funny: 0.489, supportive: 0.301 }, confidence: 0.489 },
    toxic: { type: "noul", noul: 0.1436 },
  },
  usage: { input_tokens: 452, output_tokens: 2, cost: 2.26e-5 },
};

describe("parseDecisions", () => {
  it("parses a live-shaped response", () => {
    const o = parseDecisions(LIVE, 0.05);
    expect(o).toMatchObject({ vibe: "funny", toxic: false, toxicP: 0.1436, confidence: 0.489, costUsd: 2.26e-5, costSource: "api", inputTokens: 452 });
    expect(o.probs?.supportive).toBeCloseTo(0.301);
  });
  it("flags toxic at the threshold and computes cost when usage.cost is absent", () => {
    const j = { answers: { vibe: { choice: "toxic" }, toxic: { noul: 0.8 } }, usage: { input_tokens: 1000, output_tokens: 0 } };
    const o = parseDecisions(j, 0.042);
    expect(o.toxic).toBe(true);
    expect(o.costSource).toBe("computed");
    expect(o.costUsd).toBeCloseTo(0.000042);
  });
  it("accepts array-shaped probabilities and rejects an off-enum choice", () => {
    const j = { answers: { vibe: { choice: "spam", probabilities: [{ label: "spam", probability: 0.7 }, { label: "funny", probability: 0.3 }] }, toxic: { noul: 0 } } };
    expect(parseDecisions(j, 0.05).confidence).toBeCloseTo(0.7);
    expect(() => parseDecisions({ answers: { vibe: { choice: "meh" } } }, 0.05)).toThrow(ProviderError);
    expect(() => parseDecisions({}, 0.05)).toThrow(/invalid vibe/);
  });
});

describe("decisions readers", () => {
  it("ScaleDown: right url, x-api-key header, model and questions in the body", async () => {
    const f = vi.fn(async () => ok(LIVE));
    const r = await scaledownDecisionsReader("sd-key-123456").read!("hello   world", ctx(f));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.scaledown.xyz/v1/scaledown");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sd-key-123456");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("classify-1");
    expect(body.state).toEqual({ text: "hello world" });
    expect(body.questions.vibe.type).toBe("choice");
    expect(body.questions.toxic).toMatchObject({ type: "noul", instructions: expect.any(String), criteria: { true: expect.any(String), false: expect.any(String) } });
    expect(r.out.vibe).toBe("funny");
    expect(r.attempts).toBe(1);
  });
  it("Jev: OpenRouter alpha decisions url, bearer header, same body shape", async () => {
    const f = vi.fn(async () => ok(LIVE));
    await jevReader("or-key-123456").read!("hi", ctx(f));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-key-123456");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
  });
});

// shape captured from a live OpenAI /v1/decisions call (gpt-6-luna)
const OAI_LIVE = {
  model: "gpt-6-luna",
  answers: [
    { type: "choice", name: "vibe", choice: "funny", probabilities: [{ value: "toxic", probability: 0.01 }, { value: "funny", probability: 0.99 }], confidence: 0.99 },
    { type: "predicate", name: "toxic", probability: 0.09 },
  ],
  usage: { input_tokens: 362, output_tokens: 0, total_tokens: 362 },
};

describe("OpenAI decisions reader", () => {
  it("parses the answers array by name and computes cost from input tokens at $0.10/M", () => {
    const o = parseOpenAIDecisions(OAI_LIVE, 0.1);
    expect(o).toMatchObject({ vibe: "funny", toxic: false, toxicP: 0.09, confidence: 0.99, costSource: "computed", inputTokens: 362 });
    expect(o.costUsd).toBeCloseTo(362 * 0.1e-6);
    expect(o.probs?.funny).toBeCloseTo(0.99);
    expect(() => parseOpenAIDecisions({ answers: [{ name: "vibe", choice: "meh" }] }, 0.1)).toThrow(ProviderError);
  });
  it("names a refusal as a refusal (seen live on very short comments)", () => {
    expect(() => parseOpenAIDecisions({ answers: [{ type: "refusal", name: "vibe" }, { type: "predicate", name: "toxic", probability: 0 }] }, 0.1)).toThrow(/refused/);
  });
  it("posts input + a questions array with the same rubric to api.openai.com/v1/decisions", async () => {
    const f = vi.fn(async () => ok(OAI_LIVE));
    await openaiDecisionsReader("oa-key-123456").read!("hi", ctx(f));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer oa-key-123456");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["input", "model", "questions"]);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toBe("hi");
    const vibe = body.questions.find((q: { name: string }) => q.name === "vibe");
    expect(vibe.type).toBe("choice");
    expect(vibe.choices.map((c: { value: string }) => c.value).sort()).toEqual(["critical", "funny", "question", "spam", "supportive", "toxic"]);
    expect(body.questions.find((q: { name: string }) => q.name === "toxic").type).toBe("predicate");
  });
});

describe("llm reader", () => {
  const chat = (content: string, usage: Record<string, unknown> = { prompt_tokens: 200, completion_tokens: 10, cost: 0.00003 }) => ok({ choices: [{ message: { content } }], usage });
  const haiku = () => llmReader({ id: "haiku", label: "H", model: "anthropic/claude-haiku-5.5", inPerM: 0.1, outPerM: 0.5, key: "or-key-123456" });

  it("sends strict json schema and temperature 0", async () => {
    const f = vi.fn(async () => chat('{"vibe":"critical","toxic":false}'));
    const r = await haiku().read!("meh video", ctx(f));
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("anthropic/claude-haiku-5.5");
    expect(body.temperature).toBe(0);
    expect(body.provider).toBeUndefined(); // require_parameters 404s for Anthropic and OpenAI models on OpenRouter (verified live)
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(r.out).toMatchObject({ vibe: "critical", toxic: false, costUsd: 0.00003, costSource: "api" });
  });
  it("falls back down the reasoning ladder when the model rejects it, and remembers", async () => {
    const calls: Record<string, unknown>[] = [];
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      calls.push(b);
      if (b.reasoning?.effort === "none") return new Response("reasoning effort none not supported", { status: 400 });
      return chat('{"vibe":"funny","toxic":false}');
    });
    const rd = haiku();
    await rd.read!("x", ctx(f));
    expect(calls.map((c) => (c.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["none", "low"]);
    calls.length = 0;
    await rd.read!("y", ctx(f));
    expect(calls).toHaveLength(1);
    expect((calls[0].reasoning as { effort: string }).effort).toBe("low");
  });
  it("parses fenced JSON, computes cost when absent, rejects off-enum", () => {
    const j = { choices: [{ message: { content: '```json\n{"vibe":"spam","toxic":"true"}\n```' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    const o = parseChat(j, { inPerM: 0.1, outPerM: 0.5 });
    expect(o).toMatchObject({ vibe: "spam", toxic: true, costSource: "computed" });
    expect(o.costUsd).toBeCloseTo(0.0001 + 0.00005);
    expect(() => parseChat({ choices: [{ message: { content: '{"vibe":"love","toxic":false}' } }] }, { inPerM: 1, outPerM: 1 })).toThrow(/invalid vibe/);
    expect(() => parseChat({ choices: [{ message: { content: "not json" } }] }, { inPerM: 1, outPerM: 1 })).toThrow(ProviderError);
  });
});

describe("batch reader", () => {
  it("maps batch outcomes to items and splits cost; unclassified becomes an error", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const ids: string[] = JSON.parse(String(init!.body)).chunks.map((c: { id: string }) => c.id);
      const results = ids.slice(0, 2).map((id) => ({ id, top_label: "funny", scores: { toxic: 0.01, critical: 0.01, supportive: 0.1, funny: 0.85, question: 0.02, spam: 0.01 } }));
      return ok({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { prompt_tokens: 300, cost: 0.000015 } });
    });
    const out = await scaledownBatchReader("k-123456789").readBatch!([{ id: "a", text: "one" }, { id: "b", text: "two" }, { id: "c", text: "three" }], ctx(f));
    expect((out.get("a") as { out: { vibe: string; costUsd: number } }).out.vibe).toBe("funny");
    expect((out.get("a") as { out: { costUsd: number } }).out.costUsd).toBeCloseTo(0.000005);
    expect(out.get("c")).toBeInstanceOf(ProviderError);
  });
});

describe("roster", () => {
  it("without OPENROUTER_API_KEY, Jev, LLMs and referees are skipped; ScaleDown and baselines run", () => {
    const r = buildRoster({ SCALEDOWN_API_KEY: "sd-key-123456" });
    expect(r.readers.map((d) => d.info.id)).toEqual(["scaledown", "scaledown-batch", "always-supportive", "rules"]);
    const ids = r.skipped.map((s) => s.info.id);
    expect(ids).toEqual(expect.arrayContaining(["jev", "haiku", "gemma", "luna", "referee-opus", "referee-sonnet"]));
    expect(r.skipped[0].reason).toBe("skipped: no OPENROUTER_API_KEY");
  });
  it("without OPENAI_API_KEY only the OpenAI decisions lane is skipped", () => {
    const r = buildRoster({ SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" });
    expect(r.skipped.map((s) => [s.info.id, s.reason])).toEqual([["openai-decisions", "skipped: no OPENAI_API_KEY"]]);
  });
  it("lights everything up once the key exists, and never exposes it", () => {
    const r = buildRoster({ SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456", OPENAI_API_KEY: "oa-key-123456" });
    expect(r.skipped).toHaveLength(0);
    expect(JSON.stringify(r.readers.map((d) => d.info))).not.toContain("123456");
  });
});

describe("referee reader", () => {
  it("starts at reasoning effort low with a roomy token budget", async () => {
    const f = vi.fn(async () => ok({ choices: [{ message: { content: '{"vibe":"funny","toxic":false}' } }], usage: { prompt_tokens: 300, completion_tokens: 18, cost: 0.0017 } }));
    const ref = buildRoster({ SCALEDOWN_API_KEY: "sd-key-123456", OPENROUTER_API_KEY: "or-key-123456" }).readers.find((r) => r.info.id === "referee-opus")!;
    await ref.read!("x", ctx(f));
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(2000);
  });
});
