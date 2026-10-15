// A simulated showdown for UI work and tests (?mock=1). Every summary and event carries `simulated: true` where the type
// allows it, and nothing from here is ever written to disk. Numbers are invented, deterministic, and say so.
import type { ProgressEvent, ShowdownCodeMiss, ShowdownDisagreement, ShowdownReader, ShowdownSummary, Vibe } from "../types";
import { VIBES } from "../vibes";
import type { ItemRecord, LaneMeta } from "./store";
import { mulberry32 } from "./stats";
import { SAVED_ID, summarize } from "./summarize";

const FUNNY_TEXT = [
  "bro really said 'I'll do it for free' and then did it for a million dollars",
  "this is the 4th time I have watched this and I am still not on the list",
  "你好 from Brazil, great video!!! 😂😂😂",
  "first. no wait, second. okay I give up",
  "my dog watched this whole thing and now he wants a challenge",
  "is the ending real or did the lighting guy get a bonus",
  "😭😭😭🔥🔥🔥",
  "can we get a part 2 where nobody wins anything",
  "I came here for the money and stayed for the confusion",
  "this feels like a Tuesday",
];

const READERS: ShowdownReader[] = [
  { id: "scaledown", label: "ScaleDown classify-1", kind: "decisions", modelId: "classify-1", priceNote: "simulated", enabled: true },
  { id: "scaledown-batch", label: "ScaleDown batch classify", kind: "batch", modelId: "classify", priceNote: "simulated", enabled: true },
  { id: "jev", label: "Jev 1.13", kind: "decisions", modelId: "typesafe/jev-1.13", priceNote: "simulated", enabled: true },
  { id: "haiku", label: "Claude Haiku 5.5", kind: "llm", modelId: "anthropic/claude-haiku-5.5", priceNote: "simulated", enabled: true },
  { id: "gemma", label: "Gemma 4 26B", kind: "llm", modelId: "google/gemma-4-26b-a4b-it", priceNote: "simulated", enabled: true },
  { id: "always-supportive", label: "Always supportive", kind: "baseline", priceNote: "free", enabled: true },
  { id: "rules", label: "Keyword rules", kind: "baseline", priceNote: "free", enabled: true },
  { id: SAVED_ID, label: "ScaleDown batch (saved run)", kind: "saved", priceNote: "simulated", enabled: true },
  { id: "referee-opus", label: "Claude Opus 5.5 (referee)", kind: "referee", modelId: "anthropic/claude-opus-5.5", priceNote: "simulated", enabled: true },
];

// per reader: chance of matching the referee, mean latency (ms), cost per call (USD)
const PROFILE: Record<string, [number, number, number]> = {
  scaledown: [0.7, 1000, 0.000035],
  "scaledown-batch": [0.68, 2500, 0.000008],
  jev: [0.72, 900, 0.000032],
  haiku: [0.78, 700, 0.00011],
  gemma: [0.66, 1100, 0.00007],
  "always-supportive": [0.42, 0, 0],
  rules: [0.5, 0, 0],
  "referee-opus": [1, 2000, 0.0012],
};

export function mockShowdown(runId = "mock", sampleSize = 200): { summary: ShowdownSummary; disagreements: ShowdownDisagreement[]; codeMisses: ShowdownCodeMiss[]; events: { t: number; event: ProgressEvent }[] } {
  const rng = mulberry32(99);
  const items = Array.from({ length: sampleSize }, (_, i) => ({
    id: `m${i}`,
    text: FUNNY_TEXT[i % FUNNY_TEXT.length] + (i >= FUNNY_TEXT.length ? ` (${i})` : ""),
    savedVibe: VIBES[Math.floor(rng() * 6)] as Vibe,
    stratum: i % 10 === 2 ? "non-latin" : i % 10 === 6 ? "emoji" : `vibe:${VIBES[i % 6]}`,
  }));
  const refereeIds = items.slice(0, Math.round(sampleSize / 4)).map((i) => i.id);
  const perItem: Record<string, Record<string, ItemRecord>> = {};
  for (const it of items) {
    const truth = VIBES[Math.floor(rng() * 6)];
    perItem[it.id] = {};
    for (const [rid, [match, ms, cost]] of Object.entries(PROFILE)) {
      if (rid === "referee-opus" && !refereeIds.includes(it.id)) continue;
      const vibe = rng() < match ? truth : VIBES[Math.floor(rng() * 6)];
      perItem[it.id][rid] = {
        vibe,
        toxic: vibe === "toxic",
        confidence: ["scaledown", "jev", "scaledown-batch"].includes(rid) ? 0.4 + rng() * 0.5 : undefined,
        ms: ms * (0.7 + rng() * 0.8),
        totalMs: ms * 1.1,
        costUsd: cost,
        costSource: cost ? "api" : "free",
        inputTokens: 400,
        attempts: 1,
        phase: rid === "referee-opus" ? "referee" : "race",
      };
    }
  }
  const lanes: Record<string, LaneMeta> = Object.fromEntries(Object.keys(PROFILE).map((id) => [id, { wallMs: 20000, concurrencyStart: 12, concurrencyMax: 32, concurrencyFinal: 12 }]));
  const { summary, disagreements, codeMisses } = summarize({
    runId,
    createdAt: new Date(0).toISOString(),
    seed: 99,
    totalComments: 59751,
    items,
    refereeIds,
    weights: new Map(items.map((i) => [i.id, 1 / items.length] as const)),
    readers: READERS,
    perItem,
    lanes,
  });
  summary.simulated = true;

  const events: { t: number; event: ProgressEvent }[] = [];
  events.push({
    t: 0,
    event: { type: "showdown_start", simulated: true, total: sampleSize, readers: READERS.filter((r) => r.kind !== "saved").map((r) => ({ id: r.id, label: r.label, kind: r.kind, enabled: r.enabled })) },
  });
  const steps = 10;
  for (let s = 1; s <= steps; s++) {
    for (const r of READERS.filter((x) => x.kind !== "saved" && x.kind !== "referee")) {
      const [, ms, cost] = PROFILE[r.id];
      const done = Math.round((sampleSize * s) / steps);
      events.push({
        t: s * 1200 + (r.id.length % 5) * 40,
        event: { type: "showdown_tick", reader: r.id, done, total: sampleSize, failed: 0, costUsd: done * cost, p50Ms: ms, sample: [{ text: items[done % items.length].text, vibe: items[done % items.length].savedVibe }] },
      });
    }
  }
  events.push({ t: steps * 1200 + 500, event: { type: "showdown_done", summary } });
  return { summary, disagreements, codeMisses, events };
}
