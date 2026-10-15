import { describe, expect, it } from "vitest";
import { resolveRunId } from "../resolveRunId";

const fake = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe("resolveRunId", () => {
  it("passes a real id straight through", async () => {
    expect(await resolveRunId("mrbeast-1", undefined, fake({}))).toBe("mrbeast-1");
  });
  it("turns latest into the newest saved run", async () => {
    expect(await resolveRunId("latest", undefined, fake({ runs: [{ id: "new" }, { id: "old" }] }))).toBe("new");
  });
  it("returns null when there are no runs or the list fails", async () => {
    expect(await resolveRunId("latest", undefined, fake({ runs: [] }))).toBeNull();
    expect(await resolveRunId("latest", undefined, (async () => { throw new Error("x"); }) as unknown as typeof fetch)).toBeNull();
  });
});
