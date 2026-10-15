import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDemoShowdown, resolveDemoId, staticReplay } from "../staticReplay";

const fake = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
afterEach(() => vi.useRealTimers());

describe("staticReplay", () => {
  it("fetches browser assets and yields ordered events on the fast schedule", async () => {
    vi.useFakeTimers();
    const events = [{ t: 0, event: { type: "fetched", total: 1 } }, { t: 36000, event: { type: "fetched", total: 2 } }];
    const fetcher = fake(events);
    const source = staticReplay("recorded-1", new AbortController().signal, fetcher);
    expect((await source.next()).value).toEqual(events[0].event);
    const next = source.next();
    await vi.advanceTimersByTimeAsync(17999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await next).value).toEqual(events[1].event);
    expect((await source.next()).done).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/demo/recorded-1/events.json", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("stops and clears a pending sleep on abort", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const source = staticReplay("run", ac.signal, fake([{ t: 0, event: { type: "fetched", total: 1 } }, { t: 1000, event: { type: "fetched", total: 2 } }]));
    await source.next();
    const next = source.next();
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    expect((await next).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fetch or yield when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetcher = fake([]);
    expect((await staticReplay("run", ac.signal, fetcher).next()).done).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports missing runs and rejects unsafe paths without fetching", async () => {
    const signal = new AbortController().signal;
    expect((await staticReplay("missing", signal, fake({}, 404)).next()).value).toEqual({ type: "error", message: 'No recorded run called "missing".' });
    const fetcher = fake([]);
    expect((await staticReplay("../bad", signal, fetcher).next()).value).toMatchObject({ type: "error" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates non-404 failures", async () => {
    await expect(staticReplay("run", new AbortController().signal, fake({}, 500)).next()).rejects.toThrow("500");
  });
});

describe("demo lookup", () => {
  it("resolves latest from the first index entry, validates ids and handles empty or failed indexes", async () => {
    const fetcher = fake({ runs: [{ id: "new" }, { id: "old" }] });
    expect(await resolveDemoId("latest", undefined, fetcher)).toBe("new");
    expect(fetcher).toHaveBeenCalledWith("/demo/index.json", { signal: undefined });
    expect(await resolveDemoId("run", undefined, fetcher)).toBe("run");
    expect(await resolveDemoId("../bad", undefined, fetcher)).toBeNull();
    expect(await resolveDemoId("latest", undefined, fake({ runs: [] }))).toBeNull();
    expect(await resolveDemoId("latest", undefined, fake({ runs: [{ id: "../bad" }] }))).toBeNull();
    expect(await resolveDemoId("latest", undefined, fake({}, 500))).toBeNull();
  });
  it("returns the showdown body or null", async () => {
    const body = { summary: {}, disagreements: [], codeMisses: [] };
    expect(await fetchDemoShowdown("run", undefined, fake(body))).toEqual(body);
    expect(await fetchDemoShowdown("run", undefined, fake({}, 404))).toBeNull();
    const fetcher = fake(body);
    expect(await fetchDemoShowdown("../bad", undefined, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
