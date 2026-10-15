"use client";

import { useEffect, useState } from "react";
import { fetchDemoShowdown, resolveDemoId } from "./staticReplay";
import { type ShowdownView, toShowdownView } from "./showdown";

/** Live browser runs have no showdown; recordings and the dev fixture are static. */
export async function loadShowdown(replayId: string | null, mock: boolean, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ShowdownView | null> {
  if (signal.aborted) return null;
  if (mock) {
    const { SHOWDOWN_FIXTURE } = await import("./showdownFixture");
    return signal.aborted ? null : SHOWDOWN_FIXTURE;
  }
  if (!replayId) return null;
  const id = await resolveDemoId(replayId, signal, fetchImpl);
  if (!id) return null;
  const response = await fetchDemoShowdown(id, signal, fetchImpl);
  return response ? toShowdownView(response) : null;
}

export function useShowdown(replayId: string | null | undefined, enabled: boolean): ShowdownView | null {
  const [loaded, setLoaded] = useState<{ id: string | null; view: ShowdownView | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    loadShowdown(replayId ?? null, new URLSearchParams(window.location.search).has("mock"), ac.signal)
      .then((view) => { if (!ac.signal.aborted) setLoaded({ id: replayId ?? null, view }); })
      .catch(() => { /* a missing recording has no showdown */ });
    return () => ac.abort();
  }, [replayId, enabled]);
  return enabled && loaded?.id === (replayId ?? null) ? loaded.view : null;
}
