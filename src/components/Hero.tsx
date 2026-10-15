"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AMBIENT } from "./ambient";
import { CommentWall } from "./CommentWall";
import { fmtInt } from "./format";
import { KeysPanel } from "./KeysPanel";
import { SiteFooter } from "./SiteFooter";
import type { Keys } from "@/lib/keystore";
import { estimateRun } from "@/lib/estimate";
import { DEFAULT_MAX_VIDEOS } from "@/lib/util";
import type { LiveOptions } from "./useAnalyze";

interface SavedRun {
  id: string;
  channelTitle: string;
  comments: number;
  recordedAt: string;
}

export function Hero({
  onRun, onReplay, error, streamer, initialValue = "", initialDemo = false,
  keys, onKeysChange, remember, onRemember, keysOpen = false, authError,
}: {
  onRun: (channel: string, options: LiveOptions) => void;
  onReplay?: (id: string) => void;
  error?: string;
  streamer: boolean;
  initialValue?: string;
  initialDemo?: boolean;
  keys: Keys;
  onKeysChange: (keys: Keys) => void;
  remember: boolean;
  onRemember: (remember: boolean) => void;
  keysOpen?: boolean;
  authError?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [demoChip, setDemoChip] = useState(initialDemo);
  const [expanded, setExpanded] = useState(keysOpen || !!initialValue);
  const [mock, setMock] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<"scaledown" | "openrouter">("scaledown");
  const [maxCommentsPerVideo, setMaxCommentsPerVideo] = useState(300);
  const [maxVideos, setMaxVideos] = useState(DEFAULT_MAX_VIDEOS);
  const input = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState<SavedRun | null>(null);
  const reduced = useReducedMotion();
  const hasScaleDown = !!keys.scaledown?.trim();
  const hasOpenRouter = !!keys.openrouter?.trim();
  const provider = hasScaleDown && hasOpenRouter ? selectedProvider : hasOpenRouter ? "openrouter" : "scaledown";
  const ready = !!keys.youtube?.trim() && (hasScaleDown || hasOpenRouter);
  const estimate = estimateRun({ provider, maxVideos, maxCommentsPerVideo });
  const providerLabel = provider === "scaledown" ? "ScaleDown" : "OpenRouter";

  useEffect(() => {
    if (keysOpen) setExpanded(true);
  }, [keysOpen]);

  useEffect(() => {
    setMock(new URLSearchParams(window.location.search).has("mock"));
    const ac = new AbortController();
    fetch("/demo/index.json", { signal: ac.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { runs?: SavedRun[] } | null) => { if (!ac.signal.aborted) setRecording(d?.runs?.[0] ?? null); })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const v = value.trim();
    if (!v || (!ready && !mock)) {
      input.current?.focus();
      return;
    }
    onRun(v, { provider, maxCommentsPerVideo, maxVideos, demo: mock && demoChip });
  };

  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) {
        setValue(t);
        setDemoChip(false);
      }
    } catch {
      input.current?.focus();
    }
  };

  return (
    <section className="relative isolate flex min-h-dvh flex-col overflow-hidden">
      <CommentWall
        ambient={AMBIENT}
        preseed
        streamer={streamer}
        intensity={reduced ? 0.4 : 0.55}
        className="absolute inset-0 -z-10 opacity-90"
      />
      <div className="absolute inset-0 -z-10 bg-ink/[0.9]" />

      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col justify-center px-[max(1.25rem,4vw)] pb-24 pt-28 sm:pt-24">
        <h1 className="display text-[clamp(2.8rem,9.6vmin,8.2rem)] [@media(orientation:portrait)]:text-[clamp(2.4rem,12vw,8rem)] text-bone" aria-label="I made AI read your whole comment section.">
          <span className="headline-line"><span style={{ animationDelay: "0.05s" }}>I made AI</span></span>
          <span className="headline-line"><span style={{ animationDelay: "0.17s" }}>read your whole</span></span>
          <span className="headline-line"><span style={{ animationDelay: "0.29s" }}>comment section.</span></span>
        </h1>

        <motion.p
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 0.8 }}
          className="mt-[3.2vmin] max-w-[34ch] text-[clamp(1.05rem,2.6vmin,1.6rem)] [@media(orientation:portrait)]:text-[clamp(1.0625rem,3.6vw,2rem)] leading-snug text-mute"
        >
          An experiment in how models read a comment section. Watch a recorded run, or bring your own keys to read a channel and find its moods and recurring stories.
        </motion.p>

        <div className="mt-[max(1.75rem,4vmin)] flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
          <button type="button" onClick={() => onReplay?.("latest")} className="w-full bg-bone px-6 py-4 text-[15px] font-semibold text-ink hover:opacity-85 sm:w-auto sm:text-sm">Watch the MrBeast run</button>
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="w-full border border-bone/40 px-6 py-4 text-[15px] text-bone hover:border-bone sm:w-auto sm:text-sm">Run it on any channel</button>
        </div>
        {recording && <p className="mt-3 text-sm text-mute">{recording.channelTitle} · {fmtInt(recording.comments)} comments · recorded run, no keys needed</p>}
        {error && <p role="alert" className="mt-4 border-l-2 border-toxic pl-3 text-sm text-bone">{error}</p>}

        {expanded && <>
          <div className="mt-8"><KeysPanel keys={keys} onChange={onKeysChange} remember={remember} onRemember={onRemember} callbackError={authError} /></div>
        <motion.form
          onSubmit={submit}
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.05, duration: 0.8, ease: [0.25, 0.6, 0.25, 1] }}
          className="mt-[4vmin] w-full max-w-[760px]"
        >
          <div className="flex flex-col gap-2 border-b border-bone/40 bg-ink p-1 focus-within:border-bone sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor="channel">YouTube channel URL, @handle or channel ID</label>
            <input
              id="channel"
              ref={input}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setDemoChip(false);
              }}
              onPaste={() => setDemoChip(false)}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="youtube.com/@channel, @handle or channel ID"
              className="min-w-0 flex-1 bg-transparent px-5 py-3.5 text-[clamp(1rem,2.4vmin,1.25rem)] text-bone outline-none placeholder:text-mute/70"
            />
            <div className="flex items-center gap-2 px-1 pb-1 sm:p-0 sm:pr-0.5">
              <button type="button" onClick={paste} className="px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute transition-colors hover:text-bone">
                Paste
              </button>
              <button
                type="submit"
                disabled={!ready && !mock}
                className="flex-1 bg-bone px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink transition-opacity hover:opacity-85 disabled:opacity-40 sm:flex-none"
              >
                Run
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-5 text-sm text-mute">
            {hasScaleDown && hasOpenRouter && <label>Provider
              <select aria-label="Provider" value={provider} onChange={(e) => setSelectedProvider(e.target.value as "scaledown" | "openrouter")} className="ml-3 border border-line bg-ink p-2 text-bone">
                <option value="scaledown">ScaleDown</option><option value="openrouter">OpenRouter</option>
              </select>
            </label>}
            <label>Max comments per video
              <select aria-label="Max comments per video" value={maxCommentsPerVideo} onChange={(e) => setMaxCommentsPerVideo(Number(e.target.value))} className="ml-3 border border-line bg-ink p-2 text-bone">
                {[100, 300, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label>Max videos
              <select aria-label="Max videos" value={maxVideos} onChange={(e) => setMaxVideos(Number(e.target.value))} className="ml-3 border border-line bg-ink p-2 text-bone">
                {[10, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-mute">About {fmtInt(estimate.comments)} comments, about ${estimate.usdLow.toFixed(2)} to ${estimate.usdHigh.toFixed(2)} on your {providerLabel} key, about {fmtInt(estimate.youtubeUnits)} of your 10,000 daily YouTube units.</p>
          {mock && <button type="button" onClick={() => onRun("@mangostatic", { provider, maxCommentsPerVideo, maxVideos, demo: true })} className="mt-4 border border-line px-4 py-2 text-sm">Run demo</button>}

        </motion.form>
        </>}
      </div>

      <div className="px-[max(1.25rem,4vw)]">
        <p className="text-[13px] text-mute">A side project by an independent creator. Not sponsored by, or affiliated with, any model vendor.</p>
        <SiteFooter />
      </div>
    </section>
  );
}
