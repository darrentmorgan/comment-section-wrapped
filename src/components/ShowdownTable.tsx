import { fmtInt } from "./format";
import { type ShowdownReader, type ShowdownView, fmtCost1k, fmtMs, fmtPct, fmtWall } from "./showdown";

const money = (n: number | undefined, dp: number) => (n === undefined ? "n/a" : n === 0 ? "free" : `$${n.toFixed(dp)}`);

// Only per-comment model readers are ranked: the batch lane answers a different question and baselines are reference points.
const ranked = (r: ShowdownReader) => r.enabled && r.kind !== "baseline" && r.kind !== "referee" && r.mode === "per-comment";

type Col = { key: string; get: (r: ShowdownReader) => number | undefined; best: "min" | "max" };
const COLS: Col[] = [
  { key: "agree", get: (r) => r.vsReferee?.value, best: "max" },
  { key: "run", get: (r) => r.totalCostUsd, best: "min" },
  { key: "per1k", get: (r) => r.costPer1k, best: "min" },
  { key: "all", get: (r) => r.projectedAllUsd, best: "min" },
  { key: "wall", get: (r) => r.wallSec, best: "min" },
  { key: "solo", get: (r) => r.serialP50Ms, best: "min" },
  { key: "load", get: (r) => r.p50Ms, best: "min" },
  { key: "p95", get: (r) => r.p95Ms, best: "min" },
  { key: "rate", get: (r) => r.throughput, best: "max" },
];

function bestIds(readers: ShowdownReader[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const c of COLS) {
    const vals = readers.filter(ranked).map((r) => [r.id, c.get(r)] as const).filter((x): x is readonly [string, number] => x[1] !== undefined);
    if (vals.length < 2) continue;
    vals.sort((a, b) => (c.best === "min" ? a[1] - b[1] : b[1] - a[1]));
    if (vals[0][1] !== vals[1][1]) out[c.key] = vals[0][0];
  }
  return out;
}

export function ShowdownTable({ view }: { view: ShowdownView }) {
  const rows = view.readers.filter((x) => x.kind !== "referee");
  const best = bestIds(rows);
  const cell = (r: ShowdownReader, key: string, text: string, extra = "") => {
    const isBest = best[key] === r.id;
    return (
      <td data-best={isBest ? "true" : undefined} className={`whitespace-nowrap px-2 py-2 ${isBest ? "bg-supportive/15 font-semibold text-supportive" : ""} ${extra}`}>
        {text}
      </td>
    );
  };
  const group = "border-l border-bone/15";
  return (
    <>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="kicker border-b border-bone/30 !normal-case [&_th]:!tracking-[0.1em] [&_th]:uppercase">
            <tr className="text-bone/60">
              <th />
              <th className="px-2 px-2 pt-1 font-semibold">Quality</th>
              <th colSpan={3} className={`px-2 px-2 pt-1 font-semibold ${group}`}>Cost</th>
              <th colSpan={5} className={`px-2 pt-1 font-semibold ${group}`}>Speed</th>
            </tr>
            <tr>
              <th className="px-2 py-2 font-semibold">Reader</th>
              <th className="px-2 py-2 font-semibold">Agrees with referee</th>
              <th className={`px-2 py-2 font-semibold ${group}`}>This run</th>
              <th className="px-2 py-2 font-semibold">Per 1,000</th>
              <th className="px-2 py-2 font-semibold">Whole channel</th>
              <th className={`px-2 py-2 font-semibold ${group}`}>Total time</th>
              <th className="px-2 py-2 font-semibold">Median, one at a time</th>
              <th className="px-2 py-2 font-semibold">Median, under load</th>
              <th className="px-2 py-2 font-semibold">Slowest 5%</th>
              <th className="px-2 py-2 font-semibold">Per second</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((x) => (
              <tr key={x.id} className="border-t border-bone/15">
                <td className="px-2 py-2 font-sans font-semibold">
                  {x.label}
                  {x.mode === "batch" && <span className="ml-2 border border-bone/25 px-2 py-px text-xs font-normal text-mute">batch of 50, vibe only; times are per request</span>}
                  {x.enabled && x.inFlight !== undefined && x.kind !== "baseline" && <span className="ml-2 text-xs font-normal text-mute">{x.inFlight} at once</span>}
                </td>
                {x.enabled ? (
                  <>
                    <td data-best={best.agree === x.id ? "true" : undefined} className={`whitespace-nowrap px-2 py-2 ${best.agree === x.id ? "bg-supportive/15 font-semibold text-supportive" : ""}`}>
                      {x.vsReferee ? fmtPct(x.vsReferee.value) : "n/a"}
                      {x.vsReferee?.lo !== undefined && x.vsReferee.hi !== undefined && (
                        <span className="ml-1.5 text-xs font-normal text-mute">
                          {Math.round(x.vsReferee.lo * 100)}–{Math.round(x.vsReferee.hi * 100)}
                        </span>
                      )}
                      {x.failedCount ? <span className="ml-1 text-xs font-normal text-mute">({x.failedCount} failed)</span> : null}
                    </td>
                    {cell(x, "run", money(x.totalCostUsd, 3), group)}
                    {cell(x, "per1k", fmtCost1k(x))}
                    {cell(x, "all", money(x.projectedAllUsd, 2))}
                    {cell(x, "wall", x.wallSec !== undefined ? fmtWall(x.wallSec) : "n/a", group)}
                    {cell(x, "solo", x.serialP50Ms !== undefined ? fmtMs(x.serialP50Ms) : "n/a")}
                    {cell(x, "load", x.p50Ms !== undefined ? fmtMs(x.p50Ms) : "n/a")}
                    {cell(x, "p95", x.p95Ms !== undefined ? fmtMs(x.p95Ms) : "n/a")}
                    {cell(x, "rate", x.throughput !== undefined ? x.throughput.toFixed(1) : "n/a")}
                  </>
                ) : (
                  <td colSpan={9} className="px-2 py-2 font-sans text-mute">{x.note?.startsWith("waiting for") ? `not run, ${x.note}` : "not run"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-mute">
        Tinted green marks the best per-comment model in each column; the batch lane and baselines are not ranked. The small range after agreement is its 95% interval: overlapping ranges are not a clear win.
        {view.poolSize ? ` Whole channel projects each reader's cost onto all ${fmtInt(view.poolSize)} de-duplicated comments.` : ""} Total time is each reader&apos;s wall clock on the {fmtInt(view.sampleSize)}-comment sample.
      </p>
    </>
  );
}
