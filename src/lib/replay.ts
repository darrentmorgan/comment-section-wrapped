import type { ProgressEvent } from "./types";

export interface TimedEvent {
  /** ms since the run started */
  t: number;
  event: ProgressEvent;
}

export function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id) && !id.includes("..");
}

export const FAST_REPLAY_MS = 18000;

/**
 * When each saved event should be sent. "real" keeps the original timing; "fast" squeezes the run into `targetMs`
 * (never stretching a run that was already shorter). Order is preserved and times never go backwards, so the final
 * `result` event is always last.
 */
export function replaySchedule(events: TimedEvent[], speed: "fast" | "real", targetMs: number = FAST_REPLAY_MS): { at: number; event: ProgressEvent }[] {
  const span = events.reduce((m, e) => Math.max(m, e.t), 0);
  const scale = speed === "fast" && span > targetMs ? targetMs / span : 1;
  let prev = 0;
  return events.map((e) => {
    prev = Math.max(prev, Math.round(e.t * scale));
    return { at: prev, event: e.event };
  });
}
