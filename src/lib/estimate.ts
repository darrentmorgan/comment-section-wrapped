import { DEFAULT_MAX_VIDEOS, DEFAULT_COMMENTS_PER_VIDEO } from "./util";

export interface RunEstimateOptions {
  maxVideos?: number;
  maxCommentsPerVideo?: number;
  provider: "scaledown" | "openrouter";
}

export interface RunEstimate {
  comments: number;
  youtubeUnits: number;
  usdLow: number;
  usdHigh: number;
}

const count = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;

/** Budget for full pages; actual totals depend on how many comments are available. */
export function estimateRun({ maxVideos, maxCommentsPerVideo, provider }: RunEstimateOptions): RunEstimate {
  const videos = count(maxVideos, DEFAULT_MAX_VIDEOS);
  const perVideo = count(maxCommentsPerVideo, DEFAULT_COMMENTS_PER_VIDEO);
  const comments = videos * perVideo;
  const youtubeUnits = 1 + Math.ceil(videos / 50) * 2 + videos * Math.ceil(perVideo / 100);
  // ScaleDown measured run; OpenRouter Gemma classification plus verdicts.
  const usd = comments * (provider === "scaledown" ? 0.73 / 59_751 : 0.016 / 1000);
  return { comments, youtubeUnits, usdLow: usd * 0.7, usdHigh: usd * 1.5 };
}
