import { describe, expect, it, vi } from "vitest";
import { ProviderError, backoffMs, postJson, scrubSecrets } from "../http";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const st = (code: number, text = "x", headers: Record<string, string> = {}) => new Response(text, { status: code, headers });
const base = { sleep: async () => {}, random: () => 0 };

describe("postJson", () => {
  it("returns json with attempt count and timings", async () => {
    let t = 0;
    const f = vi.fn(async () => ok({ a: 1 }));
    const r = await postJson("https://x.test", { h: "1" }, { q: 1 }, { ...base, fetchImpl: f as never, now: () => (t += 10) });
    expect(r.json).toEqual({ a: 1 });
    expect(r.attempts).toBe(1);
    expect(r.ms).toBeGreaterThan(0);
    expect(r.totalMs).toBeGreaterThanOrEqual(r.ms);
  });
  it("retries 429 then 5xx, honours Retry-After, shares a throttle, and counts attempts", async () => {
    const sleeps: number[] = [];
    const calls = [st(429, "slow", { "retry-after": "3" }), st(503), ok({ done: true })];
    const throttle = { until: 0 };
    const onRateLimit = vi.fn();
    const f = vi.fn(async () => calls.shift()!);
    const r = await postJson("https://x.test", {}, {}, { ...base, sleep: async (m) => void sleeps.push(m), fetchImpl: f as never, throttle, onRateLimit });
    expect(r.attempts).toBe(3);
    expect(sleeps[0]).toBe(3000);
    expect(sleeps).toContain(2000);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(throttle.until).toBeGreaterThan(0);
  });
  it("retries network errors and gives up after maxAttempts", async () => {
    const f = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(postJson("https://x.test", {}, {}, { ...base, fetchImpl: f as never, maxAttempts: 3 })).rejects.toMatchObject({ status: 0, attempts: 3 });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("fails a 400 immediately without retry", async () => {
    const f = vi.fn(async () => st(400, "bad"));
    await expect(postJson("https://x.test", {}, {}, { ...base, fetchImpl: f as never })).rejects.toMatchObject({ status: 400, fatal: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("treats 401 and a plain 402 as fatal, but retries the in-flight-budget 402", async () => {
    await expect(postJson("https://x.test", {}, {}, { ...base, fetchImpl: (async () => st(401)) as never })).rejects.toMatchObject({ fatal: true, status: 401 });
    await expect(postJson("https://x.test", {}, {}, { ...base, fetchImpl: (async () => st(402, "insufficient credits")) as never })).rejects.toMatchObject({ fatal: true, status: 402 });
    const calls = [st(402, "in-flight budget exceeded"), ok({ fine: 1 })];
    const r = await postJson("https://x.test", {}, {}, { ...base, fetchImpl: (async () => calls.shift()!) as never });
    expect(r.attempts).toBe(2);
  });
  it("never leaks the key in an error", async () => {
    const f = async () => st(500, "upstream said Authorization: Bearer sk-or-v1-abcdef123456 and sk-or-v1-abcdef123456");
    try {
      await postJson("https://x.test", { authorization: "Bearer sk-or-v1-abcdef123456" }, {}, { ...base, fetchImpl: f as never, maxAttempts: 1 }, ["sk-or-v1-abcdef123456"]);
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).not.toContain("abcdef123456");
    }
  });
});

describe("helpers", () => {
  it("backoff doubles to a 30s cap", () => {
    expect([0, 1, 2, 3].map((a) => backoffMs(a, () => 0))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(10, () => 0)).toBe(30000);
    expect(backoffMs(0, () => 0, 120)).toBe(30000);
  });
  it("scrubs headers and literal secrets", () => {
    expect(scrubSecrets("x-api-key: abcdefgh1234")).toBe("x-api-key: ***");
    expect(scrubSecrets("token=SECRETVALUE99 ok", ["SECRETVALUE99"])).toBe("token=*** ok");
  });
});
