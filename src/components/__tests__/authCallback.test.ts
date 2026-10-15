import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => void)[],
  setters: [] as ReturnType<typeof vi.fn>[],
  complete: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useRef: () => ({ current: null }),
  useState: (value: unknown) => {
    const setter = vi.fn();
    hooks.setters.push(setter);
    return [value, setter];
  },
}));
vi.mock("@/lib/keystore", () => ({
  useKeys: () => ({ keys: { youtube: "yt-test" }, remember: true, setKeys: vi.fn(), setRemember: vi.fn() }),
  loadKeys: () => ({ keys: { youtube: "yt-test", scaledown: "sk-sd-test" }, remember: true }),
  saveKeys: hooks.save,
}));
vi.mock("@/lib/openrouterAuth", async (original) => ({
  ...await original<typeof import("@/lib/openrouterAuth")>(),
  completeOpenRouterSignIn: hooks.complete,
  clearPendingSignIn: hooks.clear,
}));
vi.mock("../useAnalyze", () => ({
  useAnalyze: () => ({ state: { phase: "idle" }, startReplay: vi.fn() }),
}));
vi.mock("../useShowdown", () => ({ useShowdown: () => null }));

import Home from "@/app/page";

beforeEach(() => {
  vi.clearAllMocks();
  hooks.effects.length = 0;
  hooks.setters.length = 0;
  vi.stubGlobal("window", {
    location: { search: "?code=test-code&pace=fast", href: "https://example.com/?code=test-code&pace=fast" },
    history: { replaceState: hooks.replace },
  });
});
afterEach(() => vi.unstubAllGlobals());

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("OpenRouter page callback", () => {
  it("exchanges once across effect replays, preserves keys and preference, opens the panel and removes only auth params", async () => {
    hooks.complete.mockResolvedValue({ key: "sk-or-test" });
    Home();
    const callback = hooks.effects[1];
    callback();
    callback();
    await settle();
    expect(hooks.complete).toHaveBeenCalledTimes(1);
    expect(hooks.complete).toHaveBeenCalledWith("?code=test-code&pace=fast");
    expect(hooks.save).toHaveBeenCalledWith({ youtube: "yt-test", scaledown: "sk-sd-test", openrouter: "sk-or-test" }, true);
    expect(hooks.setters[3]).toHaveBeenCalledWith(true);
    expect(hooks.replace).toHaveBeenCalledWith(null, "", "https://example.com/?pace=fast");
  });
  it("shows an inline error, cleans the URL and leaves keys alone when the exchange fails", async () => {
    hooks.complete.mockRejectedValue(new Error("OpenRouter sign-in expired, try again"));
    Home();
    hooks.effects[1]();
    await settle();
    expect(hooks.save).not.toHaveBeenCalled();
    expect(hooks.setters[3]).toHaveBeenCalledWith(true);
    expect(hooks.setters[4]).toHaveBeenCalledWith("OpenRouter sign-in expired, try again");
    expect(hooks.replace).toHaveBeenCalledWith(null, "", "https://example.com/?pace=fast");
  });
  it("does nothing without an authorization code", () => {
    window.location.search = "?replay=latest";
    Home();
    hooks.effects[1]();
    expect(hooks.clear).toHaveBeenCalledTimes(1);
    expect(hooks.complete).not.toHaveBeenCalled();
    expect(hooks.save).not.toHaveBeenCalled();
    expect(hooks.replace).not.toHaveBeenCalled();
  });
});

it("removes the code before starting an exchange that stays pending, without clearing its handshake on replay", () => {
  hooks.replace.mockImplementation(() => { window.location.search = "?pace=fast"; });
  hooks.complete.mockImplementation(() => {
    expect(hooks.replace).toHaveBeenCalledWith(null, "", "https://example.com/?pace=fast");
    return new Promise(() => {});
  });
  Home();
  hooks.effects[1]();
  hooks.effects[1]();
  expect(hooks.complete).toHaveBeenCalledTimes(1);
  expect(hooks.clear).not.toHaveBeenCalled();
});
