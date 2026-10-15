// Shared contract between the server pipeline (src/lib/*, src/app/api/*) and the UI (src/components/*, src/app/page.tsx).

export type Vibe = "toxic" | "critical" | "supportive" | "funny" | "question" | "spam";

export interface ClassifiedComment {
  id: string;
  videoId: string;
  authorId: string; // YouTube authorChannelId (or synthetic id in demo mode)
  authorName: string; // display handle, e.g. "@someone"
  authorAvatar?: string;
  text: string;
  likes: number;
  publishedAt: string; // ISO
  vibe: Vibe;
  scores: Record<Vibe, number>; // calibrated probabilities from ScaleDown /classify, sum to 1
  sentiment: number; // -1 (nasty) .. +1 (lovely), derived from scores
}

export interface VideoInfo {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  commentCount: number;
}

export type PersonaKind =
  | "superfan" // consistently positive across many videos
  | "consistent_hater" // consistently negative across many videos
  | "villain_arc" // started positive, turned negative over time
  | "redemption_arc" // started negative, turned positive
  | "one_bad_day" // mostly positive with a single nasty outlier
  | "comedian" // mostly funny
  | "reply_guy"; // extremely high comment volume

export interface Persona {
  kind: PersonaKind;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  commentCount: number;
  videoCount: number;
  avgSentiment: number;
  // Chronological sentiment points for the arc chart
  timeline: { t: string; sentiment: number; vibe: Vibe; videoId: string; text: string }[];
  headlineComment: string; // the most representative comment
  verdict: string; // one-line roast / summary (from ScaleDown /summarize when available, else templated)
}

export interface MostLoyal {
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  /** distinct videos this commenter commented on */
  videosCommented: number;
  /** videos analysed in this run */
  totalVideos: number;
  commentCount: number;
  /** a representative (most-liked) comment, trimmed */
  headlineComment: string;
  /** punchy one-liner without the commenter's handle, e.g. "Commented on 58 of 60 videos." */
  verdict: string;
}

export interface WrappedResult {
  channel: { id: string; title: string; handle: string; avatar: string; subscriberCount?: number };
  videos: VideoInfo[];
  totals: {
    comments: number;
    commenters: number;
    byVibe: Record<Vibe, number>;
    avgSentiment: number;
  };
  personas: Persona[]; // ranked, a few per kind
  /** Optional: the commenter who showed up on the most videos (absent on older saved runs and in demo data). */
  mostLoyal?: MostLoyal;
  topComments: { funniest: ClassifiedComment[]; nastiest: ClassifiedComment[]; sweetest: ClassifiedComment[] };
  perVideo: { videoId: string; avgSentiment: number; byVibe: Record<Vibe, number> }[];
  usage: {
    inputTokens: number;
    costUsd: number; // actual ScaleDown cost
    elapsedMs: number; // live: time ScaleDown classify requests were in flight (NOT end-to-end). demo: simulated
    endToEndMs?: number; // live only: whole run including YouTube fetching
    classifyCalls: number;
    /** comments fetched but not classified (a batch ScaleDown kept failing on); absent on older saved runs */
    unclassified?: number;
    estimated?: boolean; // true when some token counts came from a local estimator, not the API
    /** which classifier backend and model ran; absent on older saved runs */
    provider?: "scaledown" | "openrouter";
    model?: string;
  };
  demo: boolean;
  /** Optional: summary of the model showdown (absent on older saved runs). Summary only, never per-comment data. */
  showdown?: ShowdownSummary;
}

// ---------------------------------------------------------------- model showdown (server: src/lib/showdown/*, UI reads these)
// Everything here is backwards compatible: old runs and result.json files have none of it.
// Wording rule for the UI: say "agreement with the referee", never "accuracy". Labels are not ground truth.
// No author names or handles are stored anywhere in showdown data. Comment text only appears in ShowdownDisagreement.text
// (render it through CommentText so @mentions are masked in streamer mode).

export type ShowdownReaderKind =
  | "decisions" // per-comment Decisions API (ScaleDown classify-1, Jev): probabilities available
  | "batch" // ScaleDown batched classify (chat route)
  | "llm" // OpenRouter chat model with JSON output: hard label + boolean, no probabilities
  | "baseline" // free rule readers (always-supportive, keyword rules)
  | "saved" // labels already saved in the run (the original batched classification), free
  | "referee"; // strong model, run on the referee subset only

export type ShowdownReaderStatus = "ok" | "skipped" | "partial" | "failed";

export interface ShowdownReader {
  id: string; // stable, e.g. "scaledown", "jev", "haiku", "gemma", "always-supportive"
  label: string; // display name, e.g. "ScaleDown classify-1"
  kind: ShowdownReaderKind;
  modelId?: string;
  priceNote: string; // list price in words, e.g. "$0.05 per M input tokens"
  /** false when the lane cannot run (no key). `note` then says why, e.g. "waiting for OPENROUTER_API_KEY". */
  enabled: boolean;
  note?: string;
  status?: ShowdownReaderStatus; // on the saved summary
  /** "batch" = 50 comments per request, vibe only, the app's own tuned prompt: not the same questions as the other readers */
  mode?: "per-comment" | "batch";
}

export interface ShowdownCi {
  rate: number; // 0..1
  lo: number;
  hi: number;
  n: number; // referee items the reader was asked about; a failed answer counts as a disagreement
}

export interface ShowdownReaderStats {
  readerId: string;
  ok: number;
  failed: number;
  failureRate: number; // 0..1
  retries: number; // total extra attempts across the lane
  costUsd: number; // summed over the lane
  /** USD per 1,000 comments, weighted to the channel's natural vibe mix (vibe strata only). Equals costPer1kSample when no weights exist. */
  costPer1k: number;
  costPer1kSample: number; // plain mean over the stratified sample (oversamples long, rare and emoji comments)
  projectedCostAll: number | null; // USD for the de-duplicated pool, label as "projected"
  requests: number; // requests behind the latency numbers (batch lanes: one per 50-comment request)
  /** "api" = usage.cost from the provider, "computed" = tokens x list price, "free" = no spend, "mixed" = both */
  costSource: "api" | "computed" | "free" | "mixed";
  meanInputTokens?: number;
  p50Ms: number; // latency of the successful request, lane run in parallel (loaded: see concurrency)
  p95Ms: number;
  p95AllMs: number; // slowest 5% when failed requests are counted at the time they took to give up
  maxMs: number;
  p95TotalMs: number; // including retries and backoff
  serialP50Ms?: number; // phase 0 probe, concurrency 1
  serialP95Ms?: number;
  throughputPerSec: number; // ok items / lane wall seconds
  /** agreement with the referee on the referee subset (rate + 95% CI). Failures count as disagreements. null when no referee ran. */
  agreementWithReferee: ShowdownCi | null;
  /** same, over only the items the reader answered (secondary; flatters a flaky reader) */
  agreementAnsweredOnly?: { rate: number; n: number };
  /** which model/provider OpenRouter says actually served the answers (count by "model | provider") */
  servedBy?: Record<string, number>;
  /** same, reweighted to the natural vibe mix of the whole run */
  agreementWithRefereeNatural?: number;
  /** vs referee on the toxic yes/no question */
  toxicVsReferee?: { precision: number; recall: number; f1: number; n: number; positives: number };
  meanConfidenceRight?: number; // decision readers only
  meanConfidenceWrong?: number;
  concurrency: { start: number; max: number; final: number };
  wallMs: number;
}

export interface ShowdownMatrix {
  readerIds: string[];
  agreement: number[][]; // 0..1, diagonal 1
  ci: [number, number][][]; // bootstrap 95%
  kappa: number[][]; // Cohen's kappa
}

export interface ShowdownClassScore {
  precision: number;
  recall: number;
  n: number; // referee items of this class
}

export interface ShowdownConfig {
  n: number;
  refereeN: number;
  probeN: number;
  toxicThreshold: number;
  maxTextChars: number;
  appSha?: string;
  readers: Record<string, { modelId?: string; priceNote: string; concurrency: { start: number; max: number }; fingerprint: string }>;
}

export interface ShowdownDisagreement {
  commentId: string;
  text: string; // the only place comment text lives. Render with CommentText.
  stratum: string;
  answers: { readerId: string; vibe: Vibe; confidence?: number }[];
  referee?: { readerId: string; vibe: Vibe };
  distinct: number; // distinct vibes among readers
  handPicked: boolean; // true when only included for the slides, not part of the accuracy set
  /** server's camera-safe judgement: not hateful, no slurs, short enough to show */
  cameraSafe: boolean;
  /** long enough, mostly Latin script and a few words: a viewer can see why it is contested */
  readable?: boolean;
}

/** A comment the keyword rules got wrong and most model readers got right (vs the referee). Text lives here, never in the summary. */
export interface ShowdownCodeMiss {
  commentId: string;
  text: string; // render with CommentText
  rules: Vibe;
  referee: Vibe;
  /** model readers that matched the referee, out of `of` that answered */
  right: number;
  of: number;
  cameraSafe: boolean;
  readable: boolean;
}

export interface ShowdownSummary {
  version: 1;
  runId: string;
  createdAt: string;
  seed: number;
  sampleSize: number;
  refereeSize: number;
  totalComments: number; // in the whole run
  poolSize?: number; // de-duplicated comments projections are based on
  questionsHash: string;
  readers: ShowdownReader[];
  stats: Record<string, ShowdownReaderStats>; // by reader id
  matrix: ShowdownMatrix; // all non-referee readers on the full sample
  perClassVsReferee: Record<string, Partial<Record<Vibe, ShowdownClassScore>>>;
  totalCostUsd: number; // everything the showdown spent
  refereeIds: string[];
  /** Plain statements generated from measured numbers. No vendor claims. */
  learned: string[];
  /** how many comments split the model readers, so the picked examples can be read as a sample */
  disagreementCounts: { compared: number; split: number; cameraSafe: number };
  /** Honest caveats the UI should show (sample is biased, agreement is not accuracy, ...). */
  caveats: string[];
  simulated?: boolean; // true only for the mock stream; never written to disk
}

export interface ShowdownLaneInfo {
  id: string;
  label: string;
  kind: ShowdownReaderKind;
  note?: string;
  enabled: boolean;
}

// Server-Sent Events streamed from POST /api/analyze (one JSON object per `data:` line)
export type ProgressEvent =
  | { type: "status"; stage: "resolving" | "videos" | "comments" | "classifying" | "profiling" | "done"; message: string }
  | { type: "channel"; channel: WrappedResult["channel"] }
  | { type: "videos"; videos: VideoInfo[] }
  | { type: "fetched"; total: number; commenters?: number } // running count of comments fetched, and of distinct commenters among them
  | { type: "classified"; done: number; total: number; costUsd: number; elapsedMs: number; sample: ClassifiedComment[] } // sample = a few just-classified comments for the live ticker
  | { type: "result"; result: WrappedResult }
  // Showdown stream (POST|GET /api/runs/[id]/showdown). Old consumers ignore unknown types.
  | { type: "showdown_start"; readers: ShowdownLaneInfo[]; total: number; simulated?: boolean }
  | {
      type: "showdown_tick";
      reader: string;
      done: number;
      total: number;
      failed: number;
      costUsd: number;
      p50Ms: number;
      /** a couple of just-read comments for the live ticker. No handles. */
      sample?: { text: string; vibe: Vibe }[];
    }
  | { type: "showdown_done"; summary: ShowdownSummary }
  | { type: "error"; message: string };

export interface AnalyzeRequest {
  provider?: "scaledown" | "openrouter"; // default ScaleDown when both keys are available
  channel: string; // URL, @handle, or channel id
  maxVideos?: number; // live default 60 (max 100); demo unchanged
  maxCommentsPerVideo?: number; // live default 1000 (max 2000)
  order?: "relevance" | "time"; // live comment order, default "relevance" (top comments)
  demo?: boolean; // force demo mode
}
