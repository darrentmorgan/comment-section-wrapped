import { isSafeRunId, replaySchedule, type TimedEvent } from "@/lib/replay";
import type { ProgressEvent } from "@/lib/types";
import type { ShowdownResponse } from "@/lib/showdown/response";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Replay aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Plays a privacy-safe recording directly from static assets. */
export async function* staticReplay(id: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): AsyncGenerator<ProgressEvent> {
  if (signal.aborted) return;
  if (!isSafeRunId(id)) {
    yield { type: "error", message: "Invalid recorded run id." };
    return;
  }
  try {
    const res = await fetchImpl(`/demo/${id}/events.json`, { signal });
    if (signal.aborted) return;
    if (res.status === 404) {
      yield { type: "error", message: `No recorded run called "${id}".` };
      return;
    }
    if (!res.ok) throw new Error(`Could not load recorded run (${res.status}).`);
    const events = (await res.json()) as TimedEvent[];
    const start = Date.now();
    for (const item of replaySchedule(events, "fast")) {
      if (signal.aborted) return;
      const delay = item.at - (Date.now() - start);
      if (delay > 0) await sleep(delay, signal);
      if (signal.aborted) return;
      yield item.event;
    }
  } catch (e) {
    if (!signal.aborted) throw e;
  }
}

/** "latest" is the first entry of the exported index (newest first). */
export async function resolveDemoId(idOrLatest: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (signal?.aborted) return null;
  if (idOrLatest !== "latest") return isSafeRunId(idOrLatest) ? idOrLatest : null;
  try {
    const res = await fetchImpl("/demo/index.json", { signal });
    if (!res.ok || signal?.aborted) return null;
    const body = (await res.json()) as { runs?: { id?: string }[] };
    const id = body.runs?.[0]?.id;
    return typeof id === "string" && isSafeRunId(id) ? id : null;
  } catch {
    return null;
  }
}

export async function fetchDemoShowdown(id: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ShowdownResponse | null> {
  if (!isSafeRunId(id) || signal?.aborted) return null;
  try {
    const res = await fetchImpl(`/demo/${id}/showdown.json`, { signal });
    return res.ok && !signal?.aborted ? (await res.json()) as ShowdownResponse : null;
  } catch {
    return null;
  }
}
