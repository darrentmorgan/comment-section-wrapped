import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearKeys, keysToEnv, loadKeys, saveKeys } from "../keystore";

const hooks = vi.hoisted(() => ({ notify: vi.fn(), unsubscribe: undefined as (() => void) | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => {
    hooks.unsubscribe = subscribe(hooks.notify);
    return snapshot();
  },
}));

function storage() {
  const data = new Map<string, string>();
  return { getItem: vi.fn((k: string) => data.get(k) ?? null), setItem: vi.fn((k: string, v: string) => data.set(k, v)), removeItem: vi.fn((k: string) => data.delete(k)), data };
}

let session: ReturnType<typeof storage>;
let local: ReturnType<typeof storage>;
beforeEach(() => {
  session = storage();
  local = storage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
  clearKeys();
});
afterEach(() => { hooks.unsubscribe?.(); clearKeys(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("key storage", () => {
  it("trims keys and defaults to session storage", () => {
    saveKeys({ scaledown: " sk-test ", youtube: "  " });
    expect(loadKeys()).toEqual({ keys: { scaledown: "sk-test" }, remember: false });
    expect(session.data.size).toBe(1);
    expect(local.data.size).toBe(0);
  });
  it("moves keys when remember is toggled, removing persistent copies", () => {
    saveKeys({ openrouter: "sk-test" }, true);
    expect(loadKeys()).toEqual({ keys: { openrouter: "sk-test" }, remember: true });
    expect(local.data.size).toBe(1);
    expect(session.data.size).toBe(0);
    saveKeys(loadKeys().keys, false);
    expect(local.data.size).toBe(0);
    expect(session.data.size).toBe(1);
    clearKeys();
    expect(loadKeys()).toEqual({ keys: {}, remember: false });
    expect(session.data.size + local.data.size).toBe(0);
  });
  it("survives storage access throwing using memory", () => {
    for (const name of ["sessionStorage", "localStorage"]) {
      vi.stubGlobal(name, { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } });
    }
    saveKeys({ youtube: " sk-test " }, true);
    expect(loadKeys()).toEqual({ keys: { youtube: "sk-test" }, remember: true });
    clearKeys();
    expect(loadKeys()).toEqual({ keys: {}, remember: false });
  });
  it("ignores malformed stored data and handles unavailable storage", () => {
    saveKeys({ youtube: "sk-test" });
    const slot = [...session.data.keys()][0];
    session.data.set(slot, "invalid json");
    expect(loadKeys().keys).toEqual({ youtube: "sk-test" });
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("localStorage", undefined);
    expect(loadKeys().keys).toEqual({ youtube: "sk-test" });
  });
  it("restores remembered or session keys after a module reload", async () => {
    saveKeys({ youtube: "sk-test" }, true);
    vi.resetModules();
    const persistent = await import("../keystore");
    expect(persistent.loadKeys()).toEqual({ keys: { youtube: "sk-test" }, remember: true });
    persistent.saveKeys({ youtube: "sk-session" }, false);
    vi.resetModules();
    const transient = await import("../keystore");
    expect(transient.loadKeys()).toEqual({ keys: { youtube: "sk-session" }, remember: false });
  });
  it("handles storage getters throwing and invalid data on initial load", async () => {
    saveKeys({ youtube: "sk-test" }, true);
    const slot = [...local.data.keys()][0];
    local.data.set(slot, "null");
    vi.resetModules();
    const fresh = await import("../keystore");
    expect(fresh.loadKeys()).toEqual({ keys: {}, remember: false });
    for (const name of ["sessionStorage", "localStorage"]) {
      Object.defineProperty(globalThis, name, { configurable: true, get() { throw Error("blocked"); } });
    }
    fresh.saveKeys({ youtube: "sk-memory" });
    expect(fresh.loadKeys().keys).toEqual({ youtube: "sk-memory" });
    fresh.clearKeys();
    expect(fresh.loadKeys().keys).toEqual({});
  });
  it("adapts trimmed keys for the pipeline without environment access", () => {
    expect(keysToEnv({ scaledown: " sk-test ", openrouter: "sk-or", youtube: " " })).toEqual({ SCALEDOWN_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or", YOUTUBE_API_KEY: undefined });
  });
});


it.each(["comment-wrapped.keys", null])("invalidates cached keys on a storage event for %s", async (key) => {
  const target = new EventTarget();
  const add = vi.spyOn(target, "addEventListener");
  vi.stubGlobal("window", target);
  vi.resetModules();
  const store = await import("../keystore");
  store.saveKeys({ youtube: "sk-test" }, true);
  store.useKeys();
  hooks.notify.mockClear();
  local.data.clear();
  class StorageEvent extends Event {
    constructor(type: string, readonly key: string | null) { super(type); }
  }
  target.dispatchEvent(new StorageEvent("storage", "unrelated"));
  expect(store.loadKeys().keys.youtube).toBe("sk-test");
  target.dispatchEvent(new StorageEvent("storage", key));
  expect(store.loadKeys()).toEqual({ keys: {}, remember: false });
  expect(hooks.notify).toHaveBeenCalledTimes(1);
  store.loadKeys();
  store.useKeys();
  expect(add).toHaveBeenCalledTimes(1);
});
