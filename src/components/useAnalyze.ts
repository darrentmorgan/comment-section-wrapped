"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveDemoId, staticReplay } from "./staticReplay";
import { keysToEnv, type Keys } from "@/lib/keystore";
import { runAnalysis } from "@/lib/pipeline";
import type { AnalyzeRequest, ClassifiedComment, ProgressEvent, VideoInfo, WrappedResult } from "@/lib/types";

export type Phase = "idle" | "reading" | "story" | "dashboard";
export type Stage = Extract<ProgressEvent, { type: "status" }>["stage"];

export interface AnalyzeState {
  phase: Phase;
  stage: Stage;
  message: string;
  channel?: WrappedResult["channel"];
  videos: VideoInfo[];
  fetched: number;
  /** distinct commenters among the comments pulled so far (undefined until the pipeline reports it, e.g. older saved runs) */
  commenters?: number;
  done: number;
  total: number;
  costUsd: number;
  serverElapsedMs: number;
  startedAt: number;
  finishedAt?: number;
  samples: ClassifiedComment[];
  seq: number;
  result?: WrappedResult;
  error?: string;
  /** id of the saved run being replayed (null for a live run) */
  replayId?: string | null;
  /** real recorded wall time of the run: known once the result lands (replays show this, not the compressed replay time) */
  recordedMs?: number;
}

const INITIAL: AnalyzeState = {
  phase: "idle",
  stage: "resolving",
  message: "Starting",
  videos: [],
  fetched: 0,
  done: 0,
  total: 0,
  costUsd: 0,
  serverElapsedMs: 0,
  startedAt: 0,
  samples: [],
  seq: 0,
};

function reduce(s: AnalyzeState, ev: ProgressEvent): AnalyzeState {
  switch (ev.type) {
    case "status":
      return { ...s, stage: ev.stage, message: ev.message };
    case "channel":
      return { ...s, channel: ev.channel };
    case "videos":
      return { ...s, videos: ev.videos };
    case "fetched":
      return { ...s, fetched: ev.total, commenters: ev.commenters ?? s.commenters };
    case "classified":
      return { ...s, done: ev.done, total: ev.total, costUsd: ev.costUsd, serverElapsedMs: ev.elapsedMs, samples: ev.sample, seq: s.seq + 1 };
    case "result":
      return { ...s, result: ev.result, stage: "done", finishedAt: performance.now(), recordedMs: ev.result.usage.endToEndMs ?? ev.result.usage.elapsedMs };
    case "error":
      return { ...INITIAL, error: ev.message };
    default:
      return s; // showdown_* events are handled by the showdown UI, not the analyze flow
  }
}

/** Bridge callback progress to the UI's async stream, including cancellation while idle. */
export async function* streamAnalysis(req: AnalyzeRequest, keys: Keys, signal: AbortSignal, runner: typeof runAnalysis = runAnalysis): AsyncGenerator<ProgressEvent> {
  if (signal.aborted) return;
  const queue: ProgressEvent[] = [];
  let done = false;
  let failed = false;
  let error: unknown;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  signal.addEventListener("abort", notify, { once: true });
  void Promise.resolve().then(() => runner(req, (event) => {
    if (signal.aborted) return;
    queue.push(event);
    notify();
  }, { env: keysToEnv(keys), signal })).catch((e: unknown) => {
    failed = true;
    error = e;
  }).finally(() => { done = true; notify(); });
  try {
    while (!signal.aborted) {
      if (queue.length) yield queue.shift()!;
      else if (done) {
        if (failed) throw error;
        return;
      } else await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    signal.removeEventListener("abort", notify);
  }
}

async function* streamReplay(idOrLatest: string, signal: AbortSignal): AsyncGenerator<ProgressEvent> {
  const id = await resolveDemoId(idOrLatest, signal);
  if (!id) {
    yield { type: "error", message: "Could not find the recorded demo. Please try again." };
    return;
  }
  yield* staticReplay(id, signal);
}

export interface LiveOptions {
  provider: "scaledown" | "openrouter";
  maxCommentsPerVideo: number;
  maxVideos: number;
  demo?: boolean;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function useAnalyze(keys: Keys = {}) {
  const [state, setState] = useState<AnalyzeState>(INITIAL);
  const abort = useRef<AbortController | null>(null);
  // the last live request, so the form can be refilled after an error instead of making the user retype the handle
  const [last, setLast] = useState<{ channel: string; demo: boolean } | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async (kind: { live: AnalyzeRequest } | { replay: string }, browserKeys: Keys = {}) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const replay = "replay" in kind ? kind.replay : null;
    setState({ ...INITIAL, phase: "reading", startedAt: performance.now(), replayId: replay });
    const mock = new URLSearchParams(window.location.search).has("mock");
    try {
      let source: AsyncGenerator<ProgressEvent>;
      if (replay) {
        source = streamReplay(replay, ac.signal);
      } else if (mock) {
        const { mockStream } = await import("./devMockStream");
        source = mockStream(ac.signal);
      } else {
        source = streamAnalysis((kind as { live: AnalyzeRequest }).live, browserKeys, ac.signal);
      }
      let finished = false;
      for await (const ev of source) {
        if (ac.signal.aborted) return;
        setState((s) => reduce(s, ev));
        if (ev.type === "error") return;
        if (ev.type === "result") finished = true;
      }
      if (!finished) throw new Error("The stream ended before results arrived.");
      await sleep(1700);
      if (!ac.signal.aborted) setState((s) => ({ ...s, phase: "story" }));
    } catch (e) {
      if (ac.signal.aborted) return;
      const raw = e instanceof Error ? e.message : "";
      const message = !raw || /network|fetch|failed to|load failed/i.test(raw) ? "Could not reach the provider. Check your network connection and try again." : raw;
      setState({ ...INITIAL, error: message });
    }
  }, []);

  const start = useCallback(
    (channel: string, options: LiveOptions) => {
      setLast({ channel, demo: options.demo ?? false });
      return run({ live: { channel, ...options } }, keys);
    },
    [run, keys],
  );
  const startReplay = useCallback((id: string) => run({ replay: id }), [run]);

  const reset = useCallback(() => {
    abort.current?.abort();
    setState(INITIAL);
  }, []);

  const goto = useCallback((phase: Phase) => setState((s) => ({ ...s, phase })), []);

  return { state, last, start, startReplay, reset, goto };
}
