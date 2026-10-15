import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShowdownTable } from "../ShowdownTable";
import { type ShowdownReader, type ShowdownView, fmtWall, toShowdownView } from "../showdown";

const reader = (r: Partial<ShowdownReader> & { id: string }): ShowdownReader => ({ label: r.id, short: r.id, kind: "llm", mode: "per-comment", enabled: true, ...r });
const view = (readers: ShowdownReader[]): ShowdownView => ({ simulated: false, sampleSize: 1000, readers, disagreements: [], codeMisses: [], totalCostUsd: 1, caveats: [], poolSize: 48038 });
const render = (v: ShowdownView) => renderToStaticMarkup(createElement(ShowdownTable, { view: v }));

describe("fmtWall", () => {
  it("keeps seconds under a minute and minutes plus seconds above", () => {
    expect(fmtWall(30.14)).toBe("30.1 s");
    expect(fmtWall(93.3)).toBe("1m 33s");
    expect(fmtWall(0)).toBe("instant");
    expect(fmtWall(0.004)).toBe("instant");
  });
});

describe("ShowdownTable", () => {
  const a = reader({ id: "a", costPer1k: 0.029, totalCostUsd: 0.0297, projectedAllUsd: 1.403, wallSec: 93.3, vsReferee: { value: 0.648, lo: 0.584, hi: 0.704 } });
  const b = reader({ id: "b", costPer1k: 0.02, totalCostUsd: 0.0204, projectedAllUsd: 0.967, wallSec: 30.1, vsReferee: { value: 0.79, lo: 0.73, hi: 0.84 } });

  it("shows run cost, whole-channel projection and total time per reader", () => {
    const html = render(view([a, b]));
    expect(html).toContain("This run");
    expect(html).toContain("Whole channel");
    expect(html).toContain("Total time");
    expect(html).toContain("$0.030");
    expect(html).toContain("$1.40");
    expect(html).toContain("1m 33s");
  });

  it("shows the agreement range so close scores are not over-read", () => {
    expect(render(view([a, b]))).toContain("58–70");
  });

  it("marks the best model reader in a column, never a baseline", () => {
    const free = reader({ id: "free", kind: "baseline", costPer1k: 0, totalCostUsd: 0, wallSec: 0, vsReferee: { value: 0.3 } });
    const html = render(view([a, b, free]));
    // b is cheapest, fastest and most in agreement among model readers
    expect(html.match(/data-best="true"/g)?.length).toBeGreaterThanOrEqual(3);
    const freeRow = html.split("<tr").find((r) => r.includes(">free<"))!;
    expect(freeRow).not.toContain('data-best="true"');
  });
});

describe("toShowdownView whole-channel projection", () => {
  it("maps projectedCostAll and the pool size", () => {
    const v = toShowdownView({
      summary: {
        sampleSize: 1000, poolSize: 48038, totalCostUsd: 1, readers: [{ id: "x", label: "X", kind: "llm", enabled: true, status: "ok" }],
        stats: { x: { ok: 1000, failed: 0, costUsd: 0.03, costPer1k: 0.029, projectedCostAll: 1.4, wallMs: 1000, p50Ms: 1, p95Ms: 1, throughputPerSec: 1 } },
      },
    } as never)!;
    expect(v.poolSize).toBe(48038);
    expect(v.readers[0].projectedAllUsd).toBe(1.4);
  });
});
