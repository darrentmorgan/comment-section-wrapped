import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingSignIn, completeOpenRouterSignIn, createCodeChallenge, startOpenRouterSignIn, stripAuthParams } from "../openrouterAuth";

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter PKCE", () => {
  it("matches RFC 7636 appendix B", async () => {
    expect(await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("stores a random 64-character verifier and returns the auth URL", async () => {
    const url = new URL(await startOpenRouterSignIn("https://wrapped.test/path"));
    const verifier = [...data.values()][0];
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("https://wrapped.test/path");
    expect(url.searchParams.get("code_challenge")).toBe(await createCodeChallenge(verifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    await startOpenRouterSignIn("https://wrapped.test/path");
    expect([...data.values()][0]).not.toBe(verifier);
  });
  it("exchanges the code and deletes the verifier", async () => {
    await startOpenRouterSignIn("https://wrapped.test");
    const verifier = [...data.values()][0];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ key: "sk-test" }));
    expect(await completeOpenRouterSignIn("?code=auth-code", fetchImpl)).toEqual({ key: "sk-test" });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/auth/keys", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "auth-code", code_verifier: verifier, code_challenge_method: "S256" }) }));
    expect(data.size).toBe(0);
  });
  it("returns null without a code and rejects missing or expired verifiers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    expect(await completeOpenRouterSignIn("?other=1", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(completeOpenRouterSignIn("?code=x", fetchImpl)).rejects.toThrow("OpenRouter sign-in expired, try again");
    await startOpenRouterSignIn("https://wrapped.test");
    await expect(completeOpenRouterSignIn("?code=x", fetchImpl)).rejects.toThrow("OpenRouter sign-in expired, try again");
    expect(data.size).toBe(0);
  });
  it("does not echo provider errors or accept malformed keys", async () => {
    for (const response of [new Response("sk-test", { status: 500 }), Response.json({ key: 42 })]) {
      await startOpenRouterSignIn("https://wrapped.test");
      await expect(completeOpenRouterSignIn("?code=x", vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow("OpenRouter sign-in failed, try again");
      expect(data.size).toBe(0);
    }
  });
  it("fails clearly when session storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", { setItem() { throw Error("blocked"); } });
    await expect(startOpenRouterSignIn("https://wrapped.test")).rejects.toThrow("Allow session storage");
  });
  it("strips only code, preserving other query parameters and fragments", () => {
    expect(stripAuthParams("https://wrapped.test/path?code=x&demo=1#keys")).toBe("https://wrapped.test/path?demo=1#keys");
  });
});

it("clears an abandoned handshake without touching keys and tolerates blocked storage", async () => {
  await startOpenRouterSignIn("https://wrapped.test");
  data.set("comment-wrapped.keys", "sk-test");
  clearPendingSignIn();
  expect([...data.entries()]).toEqual([["comment-wrapped.keys", "sk-test"]]);
  vi.stubGlobal("sessionStorage", { removeItem() { throw Error("blocked"); } });
  expect(() => clearPendingSignIn()).not.toThrow();
});
