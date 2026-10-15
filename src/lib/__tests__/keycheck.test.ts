import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOpenRouterKey, checkScaleDownKey, checkYouTubeKey } from "../keycheck";

const reply = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
afterEach(() => vi.useRealTimers());

describe("test my keys", () => {
  it("checks YouTube with a one-unit videos request", async () => {
    const fetchImpl = reply({ items: [] });
    expect((await checkYouTubeKey(" sk-test ", fetchImpl)).ok).toBe(true);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe("/youtube/v3/videos");
    expect(Object.fromEntries(url.searchParams)).toEqual({ part: "id", id: "dQw4w9WgXcQ", key: "sk-test" });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    [400, "keyInvalid", "invalid"],
    [403, "accessNotConfigured", "enable YouTube Data API v3"],
    [403, "quotaExceeded", "quota"],
    [403, "ipRefererBlocked", "website restrictions"],
    [403, "API_KEY_HTTP_REFERRER_BLOCKED", "website restrictions"],
  ])("maps YouTube %s %s without exposing the key", async (status, reason, message) => {
    const result = await checkYouTubeKey("sk-test", reply({ error: { message: "sk-test", errors: [{ reason }] } }, status));
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
    expect(result.message).not.toContain("sk-test");
  });
  it("handles Google's structured referrer rejection", async () => {
    const result = await checkYouTubeKey("sk-test", reply({ error: { details: [{ reason: "API_KEY_HTTP_REFERRER_BLOCKED" }] } }, 403));
    expect(result.message).toContain("website restrictions");
  });
  it("checks OpenRouter using Bearer and reports remaining credit", async () => {
    const fetchImpl = reply({ data: { limit: 10, usage: 2.5 } });
    expect(await checkOpenRouterKey("sk-test", fetchImpl)).toEqual({ ok: true, message: "OpenRouter key works. $7.50 remaining of $10.00 limit." });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ headers: { Authorization: "Bearer sk-test" } }));
    expect((await checkOpenRouterKey("sk-test", reply({ data: { limit: null } }))).message).toContain("works");
  });
  it("uses the ScaleDown chat request shape", async () => {
    const fetchImpl = reply({ choices: [] });
    expect((await checkScaleDownKey("sk-test", fetchImpl)).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.scaledown.xyz/v1/chat/completions", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "sk-test" }, body: JSON.stringify({ model: "classify", messages: [{ role: "user", content: "test" }] }) }));
  });
  it.each([401, 403])("maps rejected keys at %s without echoing provider messages", async (status) => {
    expect(await checkScaleDownKey("sk-test", reply({ message: "sk-test" }, status))).toEqual({ ok: false, message: "ScaleDown rejected the key" });
    const result = await checkOpenRouterKey("sk-test", reply({ message: "sk-test" }, status));
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("sk-test");
  });
  it("contains network errors and times out after ten seconds", async () => {
    const badFetch = vi.fn<typeof fetch>().mockRejectedValue(Error("sk-test"));
    expect((await checkScaleDownKey("sk-test", badFetch)).message).not.toContain("sk-test");
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("sk-test", "AbortError")));
    }));
    const result = checkScaleDownKey("sk-test", fetchImpl);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ ok: false, message: "Key check timed out. Try again." });
  });
});
