// FIXTURE. Placeholder numbers for building and screenshotting the Showdown screens. Only used with ?mock=1,
// always rendered with a SIMULATED label, and never written to a run. None of these figures were measured.
import type { ShowdownView } from "./showdown";

export const SHOWDOWN_FIXTURE: ShowdownView = {
  simulated: true,
  sampleSize: 1000,
  refereeN: 250,
  refereeLabel: "the referee model",
  totalCostUsd: 0.31,
  caveats: ["Agreement with the referee is not accuracy: the referee is also a model, and the vibe labels are fuzzy.", "The sample oversamples rare vibes and was partly chosen using the original batch labels, so it leans toward that classifier's view.", "Placeholder numbers: this fixture measures nothing."],
  split: { compared: 1000, split: 412 },
  readers: [
    { id: "sd", label: "Decisions model A", short: "Model A", kind: "decision", mode: "per-comment", enabled: true, costPer1k: 0.035, costSource: "api", p50Ms: 1019, p95Ms: 1308, serialP50Ms: 640, inFlight: 16, throughput: 20.2, failureRate: 0, wallSec: 49.5, totalCostUsd: 0.035, vsReferee: { value: 0.64, lo: 0.58, hi: 0.7 }, confRight: 0.71, confWrong: 0.52 },
    { id: "jev", label: "Decisions model B", short: "Model B", kind: "decision", mode: "per-comment", enabled: true, costPer1k: 0.04, costSource: "api", p50Ms: 640, p95Ms: 1250, serialP50Ms: 520, inFlight: 16, throughput: 11.6, failureRate: 0.002, wallSec: 86, totalCostUsd: 0.04, vsReferee: { value: 0.67, lo: 0.61, hi: 0.73 }, confRight: 0.74, confWrong: 0.55 },
    { id: "llm1", label: "Small LLM", short: "Small LLM", kind: "llm", mode: "per-comment", enabled: true, costPer1k: 0.09, costSource: "api", p50Ms: 780, p95Ms: 2100, serialP50Ms: 610, inFlight: 16, throughput: 14.1, failureRate: 0.004, wallSec: 71, totalCostUsd: 0.09, vsReferee: { value: 0.71, lo: 0.65, hi: 0.76 } },
    { id: "sdb", label: "Decisions model A, batch", short: "A batch", kind: "decision", mode: "batch", enabled: true, costPer1k: 0.013, costSource: "api", p50Ms: 6100, p95Ms: 9300, inFlight: 8, throughput: 49.9, failureRate: 0, wallSec: 20, totalCostUsd: 0.013, vsReferee: { value: 0.6, lo: 0.54, hi: 0.66 } },
    { id: "llm2", label: "Open LLM", short: "Open LLM", kind: "llm", mode: "per-comment", enabled: false, note: "not run" },
    { id: "base1", label: "Always friendly", short: "Always friendly", kind: "baseline", mode: "per-comment", enabled: true, costPer1k: 0, p50Ms: 0, throughput: undefined, failureRate: 0, wallSec: 0, vsReferee: { value: 0.52, lo: 0.46, hi: 0.58 } },
    { id: "base2", label: "Keyword rules", short: "Keywords", kind: "baseline", mode: "per-comment", enabled: true, costPer1k: 0, failureRate: 0, wallSec: 0, vsReferee: { value: 0.46, lo: 0.4, hi: 0.52 } },
    { id: "ref", label: "Referee", short: "Referee", kind: "referee", mode: "per-comment", enabled: true, costPer1k: 6.2, costSource: "api" },
  ],
  matrix: {
    ids: ["sd", "jev", "llm1", "base1", "base2"],
    agreement: [
      [1, 0.72, 0.66, 0.5, 0.44],
      [0.72, 1, 0.7, 0.5, 0.45],
      [0.66, 0.7, 1, 0.52, 0.47],
      [0.5, 0.5, 0.52, 1, 0.3],
      [0.44, 0.45, 0.47, 0.3, 1],
    ],
    kappa: [
      [1, 0.58, 0.5, 0, 0.21],
      [0.58, 1, 0.56, 0, 0.22],
      [0.5, 0.56, 1, 0, 0.24],
      [0, 0, 0, 1, 0],
      [0.21, 0.22, 0.24, 0, 1],
    ],
  },
  disagreements: [
    { id: "d1", text: "@someone_real ok but where do I send my invoice, I am the nephew", answers: [{ readerId: "sd", vibe: "question" }, { readerId: "jev", vibe: "funny" }, { readerId: "llm1", vibe: "spam" }, { readerId: "base1", vibe: "supportive" }, { readerId: "base2", vibe: "question" }], referee: "funny" },
    { id: "d2", text: "حب هذا الفيديو 😂😂😂 pls notice me 🙏🙏🙏🙏🙏🙏🙏🙏🙏🙏", answers: [{ readerId: "sd", vibe: "supportive" }, { readerId: "jev", vibe: "supportive" }, { readerId: "llm1", vibe: "funny" }, { readerId: "base1", vibe: "supportive" }, { readerId: "base2", vibe: "spam" }], referee: "supportive", tag: "multilingual and emoji" },
    { id: "d3", text: "the editing is so bad I want to frame it", answers: [{ readerId: "sd", vibe: "critical" }, { readerId: "jev", vibe: "funny" }, { readerId: "llm1", vibe: "toxic" }, { readerId: "base1", vibe: "supportive" }, { readerId: "base2", vibe: "critical" }], referee: "funny" },
  ],
  codeMisses: [
    { id: "m1", text: "Bro got paid to be losing, this is wild", rules: "supportive", referee: "funny", right: 3, of: 3 },
    { id: "m2", text: "Giving him that much money in the public street is dangerous", rules: "supportive", referee: "critical", right: 3, of: 3 },
    { id: "m3", text: "我现在订阅还来得及吗", rules: "supportive", referee: "question", right: 3, of: 3 },
    { id: "m4", text: "@someone_real I just needed 500,000 francs for my school fees", rules: "supportive", referee: "spam", right: 2, of: 3 },
  ],
};
