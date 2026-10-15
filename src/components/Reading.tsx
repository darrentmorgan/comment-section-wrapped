"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Vibe } from "@/lib/types";
import { AnalyzeState, Stage } from "./useAnalyze";
import { Clock, LiveNumber } from "./CountUp";
import { CommentWall } from "./CommentWall";
import { fmtInt } from "./format";
import { VIBE_META, VIBE_ORDER } from "./vibes";
import { Avatar } from "./mask";
import { AMBIENT } from "./ambient";
import { replayDateLabel, videosOpened } from "./progress";

const STEPS: { id: Stage; label: string }[] = [
  { id: "resolving", label: "Find channel" },
  { id: "videos", label: "List videos" },
  { id: "comments", label: "Pull comments" },
  { id: "classifying", label: "Read the comments" },
  { id: "profiling", label: "Profile commenters" },
];

const money6 = (n: number) => `$${n.toFixed(6)}`;

export function Reading({ s, streamer }: { s: AnalyzeState; streamer: boolean }) {
  const classifying = s.stage === "classifying" || s.stage === "profiling" || s.stage === "done";
  const finished = !!s.result;
  // One monotonic headline: comments pulled from YouTube. It never runs backwards (classification trails the pull, so
  // switching to the classified count would drop it to 0 for the 5 to 40s ScaleDown takes to answer the first batch).
  // The classified progress is shown under it, and the total snaps to the final count when the result lands.
  const peak = useRef(0);
  peak.current = finished ? s.result!.totals.comments : Math.max(peak.current, s.fetched);
  const big = peak.current;
  const readFrac = s.total > 0 ? Math.min(1, s.done / s.total) : 0;
  const replayDate = s.replayId ? replayDateLabel(s.replayId) : null;

  // live vibe tally from the stream of samples
  const tally = useRef<Record<Vibe, number>>({ toxic: 0, critical: 0, supportive: 0, funny: 0, question: 0, spam: 0 });
  const [mix, setMix] = useState<Record<Vibe, number>>(tally.current);
  useEffect(() => {
    if (!s.samples.length) return;
    for (const c of s.samples) tally.current[c.vibe]++;
    setMix({ ...tally.current });
  }, [s.seq, s.samples]);
  const mixTotal = VIBE_ORDER.reduce((a, v) => a + mix[v], 0) || 1;

  // throughput (comments / second over a ~1.5s window)
  const hist = useRef<{ t: number; d: number }[]>([]);
  const [rate, setRate] = useState(0);
  const [spark, setSpark] = useState<number[]>([]);
  const peakRate = useRef(1);
  useEffect(() => {
    // a replay is squeezed into ~18s, so measure speed against the recorded classify clock, not the wall clock
    const now = s.replayId ? s.serverElapsedMs : performance.now();
    hist.current.push({ t: now, d: s.done });
    hist.current = hist.current.filter((h) => now - h.t < 1800);
    const a = hist.current[0];
    const dt = (now - a.t) / 1000;
    if (dt > 0.2) {
      const r = (s.done - a.d) / dt;
      setRate(r);
      peakRate.current = Math.max(peakRate.current, r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.done]);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  useEffect(() => {
    const id = setInterval(() => setSpark((p) => [...p.slice(-47), rateRef.current]), 220);
    return () => clearInterval(id);
  }, []);

  // a real running count from the server; absent on saved runs that predate it
  const commenters = s.result ? s.result.totals.commenters : s.commenters;
  const activeIdx = STEPS.findIndex((x) => x.id === s.stage);
  const intensity = Math.min(1, 0.45 + rate / 2500);
  // Once classification starts the pull is over, so every video has been opened (even ones that returned fewer comments than listed).
  const opened = classifying ? s.videos.length : videosOpened(s.fetched, s.videos);
  const openingTitle = !classifying ? s.videos[Math.max(0, opened - 1)]?.title : undefined;

  return (
    <section className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-ink">
      <CommentWall feed={s.samples} seq={s.seq} streamer={streamer} intensity={intensity} ambient={AMBIENT} preseed className="absolute inset-0 -z-10" />
      <div className="absolute inset-0 -z-10 bg-ink/[0.86] max-sm:bg-ink/[0.93]" />

      {/* stage rail */}
      <header className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-[max(1.25rem,4vw)] pt-[4.25rem]">
        <div className="flex items-center gap-3">
          {s.channel && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2.5 rounded-[3px] border border-bone/15 bg-ink py-1 pl-1 pr-4">
              <Avatar name={s.channel.title} src={s.channel.avatar || undefined} size={32} alwaysShow />
              <span className="display-soft max-w-[22ch] truncate text-[15px]">{s.channel.title}</span>
              <span className="max-w-[18ch] truncate text-[13px] text-mute">{s.channel.handle}</span>
            </motion.div>
          )}
          {s.replayId && (
            <span className="border border-bone/15 bg-ink px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
              {replayDate ? `Replay of a live run, ${replayDate}` : "Replay of a live run"}
            </span>
          )}
        </div>
        <ol className="flex w-fit max-w-full flex-wrap gap-x-1 gap-y-1.5 border-y border-bone/15 bg-ink py-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
          {STEPS.map((st, i) => {
            const state = finished || i < activeIdx ? "done" : i === activeIdx ? "on" : "off";
            return (
              <li key={st.id} className="flex items-center gap-1">
                <span
                  className={`flex items-center gap-2 px-3 py-1 transition-colors ${
                    state === "on" ? "text-bone shadow-[inset_0_-2px_0_var(--bone)]" : state === "done" ? "text-bone/75" : "text-mute/60"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${state === "on" ? "bg-bone [animation:pulse-dot_1.6s_ease-in-out_infinite]" : state === "done" ? "bg-supportive" : "bg-mute/40"}`}
                  />
                  {st.label}
                </span>
              </li>
            );
          })}
        </ol>
      </header>

      {/* money shot */}
      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col items-center justify-center px-[max(1.25rem,4vw)] py-4 text-center">
        <div className="display tabular-nums text-[clamp(3.4rem,12.5vmin,11rem)] leading-[0.9] text-bone">
          <LiveNumber value={big} format={fmtInt} rate={9} />
        </div>
        <p className="kicker mt-3 text-[clamp(0.8rem,1.8vmin,1rem)]">{finished ? "comments read" : "comments pulled"}</p>
        <p className="mt-2 h-6 max-w-full truncate text-[15px] text-mute/80">{s.message}</p>
        <ReadMeter done={s.done} frac={readFrac} show={classifying || s.done > 0} finished={finished} />

        <dl className="mt-[3vmin] grid w-full max-w-[1000px] grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          <Stat label="commenters">
            {commenters === undefined ? <span className="text-mute">&mdash;</span> : <LiveNumber value={commenters} format={fmtInt} rate={9} />}
          </Stat>
          <Stat label={s.replayId ? "seconds in the real run" : "seconds elapsed"}>
            {s.replayId ? (
              <LiveNumber value={(s.recordedMs ?? s.serverElapsedMs) / 1000} format={(n) => n.toFixed(1)} rate={9} />
            ) : (
              <Clock startedAt={s.startedAt} endAt={s.finishedAt} />
            )}
          </Stat>
          <Stat label="spent so far" accent="#7fa88a">
            <LiveNumber value={s.result ? s.result.usage.costUsd : s.costUsd} format={money6} rate={9} />
          </Stat>
          <Stat label="comments per second">
            <LiveNumber value={finished ? 0 : rate} format={fmtInt} rate={5} />
          </Stat>
        </dl>

        <VideoStrip videos={s.videos} opened={opened} title={openingTitle} done={finished || classifying} />

        {/* throughput meter */}
        <div className="mt-[2.5vmin] w-full max-w-[1000px]">
          <Sparkline values={spark} peak={peakRate.current} />
          <div className="mt-5 flex h-2.5 w-full overflow-hidden bg-bone/10">
            {VIBE_ORDER.map((v) => (
              <div key={v} style={{ width: `${(mix[v] / mixTotal) * 100}%`, background: VIBE_META[v].color }} className="h-full transition-[width] duration-300" />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[13px]">
            {VIBE_ORDER.map((v) => (
              <li key={v} className="flex items-center gap-1.5 text-mute">
                <span className="h-2 w-2" style={{ background: VIBE_META[v].color }} />
                {VIBE_META[v].label}
                <span className="num text-bone/90">{Math.round((mix[v] / mixTotal) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </main>

      <AnimatePresence>
        {finished && (
          <motion.div
            key="done"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="absolute inset-0 z-20 grid place-items-center bg-ink/80"
          >
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.25, 0.6, 0.25, 1], delay: 0.15 }}
              className="display text-[clamp(3rem,15vmin,12rem)] text-bone"
            >
              Wrapped.
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** How much of the pulled comments ScaleDown has read so far, so the headline never has to count down to show it. */
function ReadMeter({ done, frac, show, finished }: { done: number; frac: number; show: boolean; finished: boolean }) {
  if (!show || finished) return <div className="mt-3 h-[34px]" aria-hidden />;
  return (
    <div className="mt-3 flex h-[34px] w-full max-w-[420px] flex-col items-center gap-1.5">
      <div className="h-[3px] w-full overflow-hidden bg-bone/15">
        <div className="h-full origin-left bg-bone transition-transform duration-500" style={{ transform: `scaleX(${frac})` }} />
      </div>
      <p className="flex items-center gap-2 text-[13px] text-mute">
        {done > 0 ? (
          <>
            <span className="num text-bone/90">{fmtInt(done)}</span> read so far
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-bone [animation:pulse-dot_1.6s_ease-in-out_infinite]" />
            waiting on the first batch
          </>
        )}
      </p>
    </div>
  );
}

/** Every video as a tiny tile that lights up as its comments are pulled, with the current title ticking underneath. */
function VideoStrip({ videos, opened, title, done }: { videos: AnalyzeState["videos"]; opened: number; title?: string; done: boolean }) {
  if (!videos.length) return <div className="mt-[2.5vmin] h-[calc(clamp(24px,4vmin,44px)+4.2rem)]" aria-hidden />;
  return (
    <div className="mt-[2.5vmin] w-full max-w-[1000px] border-y border-bone/15 px-3 py-3">
      <ul className="flex flex-wrap justify-center gap-[3px]" aria-label={`${opened} of ${videos.length} videos opened`}>
        {videos.map((v, i) => {
          const on = i < opened;
          const current = i === opened - 1 && !done;
          return (
            <li
              key={v.id}
              className={`relative aspect-video w-[clamp(24px,4vmin,44px)] overflow-hidden bg-bone/10 transition-[opacity,box-shadow] duration-500 ${
                on ? "opacity-100" : "opacity-35"
              } ${current ? "z-10 shadow-[0_0_0_2px_#efe8da]" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img referrerPolicy="no-referrer"
                src={thumbSmall(v.thumbnail)}
                alt=""
                loading="eager"
                decoding="async"
                className={`h-full w-full object-cover transition-[filter] duration-500 ${on ? "" : "grayscale brightness-50"}`}
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
            </li>
          );
        })}
      </ul>
      <p className="mt-3 h-5 truncate text-[13px] text-mute">
        {done ? (
          <>All {videos.length} videos opened</>
        ) : title ? (
          <>
            Opening <span className="text-bone/90">{tidyTitle(title)}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** maxresdefault is huge and sometimes missing; mqdefault always exists and is plenty for a 48px tile. */
function thumbSmall(url: string) {
  return url.replace(/\/(maxresdefault|sddefault|hqdefault)\.jpg/, "/mqdefault.jpg");
}

function tidyTitle(t: string) {
  const c = Array.from(t.replace(/\s+/g, " ").trim());
  return c.length > 70 ? c.slice(0, 69).join("") + "…" : c.join("");
}

function Stat({ label, children, accent }: { label: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 border-t border-bone/20 px-3 pt-4">
      <dd className="display-soft order-1 whitespace-nowrap text-[clamp(1.4rem,min(5vmin,3.8vw),3.4rem)] leading-none" style={{ color: accent }}>
        {children}
      </dd>
      <dt className="kicker order-2">{label}</dt>
    </div>
  );
}

function Sparkline({ values, peak }: { values: number[]; peak: number }) {
  const W = 480;
  const H = 56;
  const n = 48;
  const pts = values.map((v, i) => `${((i + (n - values.length)) / (n - 1)) * W},${H - 4 - (v / Math.max(peak, 1)) * (H - 10)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="sp" x1="0" x2="1">
          <stop offset="0" stopColor="#efe8da" stopOpacity="0" />
          <stop offset="0.5" stopColor="#efe8da" stopOpacity="0.7" />
          <stop offset="1" stopColor="#efe8da" />
        </linearGradient>
      </defs>
      {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke="url(#sp)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="rgba(239,232,218,0.1)" />
    </svg>
  );
}
