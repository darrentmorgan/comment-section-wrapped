"use client";

import { useEffect, useRef, useState } from "react";
import { Dashboard } from "@/components/Dashboard";
import { Hero } from "@/components/Hero";
import { Reading } from "@/components/Reading";
import { replayDateLabel } from "@/components/progress";
import { Story } from "@/components/Story";
import { StreamerProvider, StreamerToggle } from "@/components/mask";
import { replayParam } from "@/components/progress";
import { useAnalyze } from "@/components/useAnalyze";
import { loadKeys, saveKeys, useKeys } from "@/lib/keystore";
import { clearPendingSignIn, completeOpenRouterSignIn, stripAuthParams } from "@/lib/openrouterAuth";
import { useShowdown } from "@/components/useShowdown";

export default function Home() {
  const [streamer, setStreamer] = useState(true);
  // render a dark frame for one tick so a ?replay= load never flashes the hero first
  const [booted, setBooted] = useState(false);
  const [debug, setDebug] = useState(false);
  const { keys, remember, setKeys, setRemember } = useKeys();
  const [keysOpen, setKeysOpen] = useState(false);
  const [authError, setAuthError] = useState<string>();
  // Share the exchange across Strict Mode effect replays; a PKCE code is single-use.
  const auth = useRef<Promise<{ key: string } | null> | null>(null);
  const { state, last, start, startReplay, reset, goto } = useAnalyze(keys);
  const { phase, result } = state;
  const showdown = useShowdown(state.replayId, !!result);

  useEffect(() => {
    const { id, debug: dbg } = replayParam(window.location.search);
    setDebug(dbg);
    if (id) startReplay(id);
    setBooted(true);
  }, [startReplay]);

  useEffect(() => {
    const search = window.location.search;
    if (!new URLSearchParams(search).has("code")) {
      if (!auth.current) clearPendingSignIn();
      return;
    }
    window.history.replaceState(null, "", stripAuthParams(window.location.href));
    setKeysOpen(true);
    auth.current ??= completeOpenRouterSignIn(search);
    void auth.current.then((connected) => {
      if (!connected) return;
      const current = loadKeys();
      saveKeys({ ...current.keys, openrouter: connected.key }, current.remember);
      setAuthError(undefined);
    }).catch((error: unknown) => {
      setAuthError(error instanceof Error ? error.message : "OpenRouter sign-in failed, try again");
    });
  }, []);

  const setReplayParam = (id: string | null) => {
    try {
      const u = new URL(window.location.href);
      if (id) u.searchParams.set("replay", id);
      else u.searchParams.delete("replay");
      window.history.replaceState(null, "", u);
    } catch {
      /* the URL is only a convenience */
    }
  };

  if (!booted) return <div className="min-h-dvh bg-ink" />;

  return (
    <StreamerProvider value={streamer}>
      {phase === "idle" && (
        <Hero
          onRun={start}
          keys={keys}
          onKeysChange={setKeys}
          remember={remember}
          onRemember={setRemember}
          keysOpen={keysOpen}
          authError={authError}
          onReplay={(id) => {
            setReplayParam(id);
            startReplay(id);
          }}
          error={state.error}
          initialValue={state.error ? (last?.channel ?? "") : ""}
          initialDemo={state.error ? (last?.demo ?? false) : false}
          streamer={streamer}
        />
      )}
      {phase === "reading" && <Reading s={state} streamer={streamer} />}
      {phase === "story" && result && <Story result={result} showdown={showdown} replay={state.replayId ? (replayDateLabel(state.replayId) ?? undefined) : undefined} onFinish={() => goto("dashboard")} />}
      {phase === "dashboard" && result && (
        <Dashboard
          result={result}
          showdown={showdown}
          onReplay={() => goto("story")}
          onReset={() => {
            setReplayParam(null);
            reset();
          }}
        />
      )}
      <div className={`fixed right-[max(0.75rem,2vmin)] z-50 ${phase === "story" ? "top-[calc(max(0.75rem,2vmin)+14px)]" : "top-4"}`}>
        <StreamerToggle on={streamer} onChange={setStreamer} />
      </div>
      {debug && state.replayId && (
        <div className="fixed bottom-2 left-2 z-50 border border-bone/20 bg-ink px-3 py-1 text-[11px] text-mute">replay: {state.replayId}</div>
      )}
    </StreamerProvider>
  );
}
