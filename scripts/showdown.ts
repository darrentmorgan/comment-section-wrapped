// pnpm showdown --run <runId> [--n 1000] [--seed N] [--only a,b] [--skip a,b] [--referee-n 250] [--extra 20] [--probe 60] [--fresh] [--resummarize]
// Runs the model showdown from a saved run (.runs/<id>/comments.jsonl) and writes .runs/<id>/showdown.json.
// Reads keys from .env.local (SCALEDOWN_API_KEY, OPENROUTER_API_KEY). Lanes with no key are skipped, never fatal.
// Keys are never printed.
import { existsSync } from "node:fs";
import path from "node:path";
import { resummarizeShowdown, runShowdown } from "../src/lib/showdown/runner";
import { listRuns } from "../src/lib/runs";
import type { ProgressEvent } from "../src/lib/types";

if (process.argv.includes("--help")) {
  console.log("Usage: pnpm showdown --run <runId> [--n 1000] [--seed N] [--only a,b] [--skip a,b] [--referee-n 250] [--extra 20] [--probe 60] [--fresh] [--resummarize]");
  console.log("Local-only: reads saved comments from .runs and provider keys from .env.local. Lanes without keys are skipped.");
  process.exit(0);
}

for (const f of [".env.local", ".env"]) if (existsSync(path.join(process.cwd(), f))) process.loadEnvFile(path.join(process.cwd(), f));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v?: string) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);

async function main() {
  let runId = arg("run");
  if (!runId) {
    runId = (await listRuns())[0]?.id;
    if (!runId) throw new Error("No saved runs. Pass --run <id>.");
    console.log(`No --run given, using the newest saved run: ${runId}`);
  }
  if (flag("resummarize")) {
    // Free: recomputes the summary from saved answers, makes no API calls.
    const file = await resummarizeShowdown(runId);
    console.log(`Re-summarised ${runId}: ${file.disagreements.length} disagreements, ${file.codeMisses?.length ?? 0} code misses. No API calls.`);
    return;
  }
  const last = new Map<string, number>();
  const emit = (e: ProgressEvent) => {
    if (e.type === "showdown_start") {
      console.log(`Sample: ${e.total} comments`);
      for (const r of e.readers) console.log(`  ${r.enabled ? "run " : "skip"}  ${r.id.padEnd(18)} ${r.label}${r.note ? `  (${r.note})` : ""}`);
    } else if (e.type === "showdown_tick") {
      const pct = Math.floor((e.done / Math.max(1, e.total)) * 100);
      if (e.done >= e.total || pct >= (last.get(e.reader) ?? -25) + 25) {
        last.set(e.reader, pct);
        console.log(`  ${e.reader.padEnd(18)} ${String(e.done).padStart(5)}/${e.total}  failed ${e.failed}  $${e.costUsd.toFixed(5)}  p50 ${Math.round(e.p50Ms)}ms`);
      }
    }
  };
  const t0 = Date.now();
  const { summary, disagreements } = await runShowdown({
    runId,
    n: num(arg("n")),
    seed: num(arg("seed")),
    refereeN: num(arg("referee-n")),
    extraReferee: num(arg("extra")),
    probeN: num(arg("probe")),
    only: list(arg("only")),
    skip: list(arg("skip")),
    resume: !flag("fresh"),
    emit,
  });
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Total spend $${summary.totalCostUsd.toFixed(4)}. Saved ${runId}/showdown.json in the runs directory`);
  console.log("\nreader              ok    fail  $/1k      p50ms  p95ms  serial p50  req/s   agree-w-referee");
  for (const r of summary.readers) {
    const s = summary.stats[r.id];
    if (!s) {
      console.log(`${r.id.padEnd(19)} ${r.status}${r.note ? ` (${r.note})` : ""}`);
      continue;
    }
    const a = s.agreementWithReferee;
    console.log(
      `${r.id.padEnd(19)} ${String(s.ok).padEnd(5)} ${String(s.failed).padEnd(5)} ${s.costPer1k.toFixed(4).padEnd(9)} ${String(Math.round(s.p50Ms)).padEnd(6)} ${String(Math.round(s.p95Ms)).padEnd(6)} ${String(s.serialP50Ms ? Math.round(s.serialP50Ms) : "-").padEnd(11)} ${s.throughputPerSec.toFixed(1).padEnd(7)} ${a ? `${(a.rate * 100).toFixed(0)}% [${(a.lo * 100).toFixed(0)}-${(a.hi * 100).toFixed(0)}]` : "-"}`,
    );
  }
  console.log(`\nDisagreements kept for slides: ${disagreements.length}`);
  for (const l of summary.learned) console.log(`- ${l}`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("showdown failed:", msg.replace(/(sk-[\w-]{8,}|[A-Za-z0-9_-]{30,})/g, "***"));
  process.exit(1);
});
