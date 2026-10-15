"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Persona } from "@/lib/types";
import { fmtMonth } from "./format";
import { CommentText } from "./mask";
import { usePortrait } from "./usePortrait";
import { sentColor } from "./vibes";

type Pt = Persona["timeline"][number];

function geometry(tl: Pt[], W: number, H: number, padX: number, padY: number) {
  const n = tl.length;
  const xs = tl.map((_, i) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - padX * 2));
  const mid = H / 2;
  const amp = H / 2 - padY;
  const ys = tl.map((p) => mid - Math.max(-1, Math.min(1, p.sentiment)) * amp);
  // Catmull-Rom -> cubic bezier
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? i - 1 : i;
    const p3 = i + 2 < n ? i + 2 : i + 1;
    const c1x = xs[i] + (xs[i + 1] - xs[p0]) / 6;
    const c1y = ys[i] + (ys[i + 1] - ys[p0]) / 6;
    const c2x = xs[i + 1] - (xs[p3] - xs[i]) / 6;
    const c2y = ys[i + 1] - (ys[p3] - ys[i]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return { xs, ys, d, mid };
}

/** Tiny static arc for cards. */
export function MiniArc({ timeline, className = "" }: { timeline: Pt[]; className?: string }) {
  const W = 320;
  const H = 84;
  const g = geometry(timeline, W, H, 8, 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden>
      <line x1="0" x2={W} y1={g.mid} y2={g.mid} stroke="rgba(239,232,218,0.14)" />
      <path d={g.d} fill="none" stroke="rgba(239,232,218,0.55)" strokeWidth="2" strokeLinecap="round" />
      {timeline.map((p, i) => (
        <circle key={i} cx={g.xs[i]} cy={g.ys[i]} r="3.4" fill={sentColor(p.sentiment)} />
      ))}
    </svg>
  );
}

function pickIdx(n: number, want: number): number[] {
  if (n <= want) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: want }, (_, i) => Math.round((i / (want - 1)) * (n - 1)));
}

/**
 * Where the tone flips for good: the first comment that crosses into the final mood and stays there.
 * villain: first index from which the rest averages hostile; redemption: from which the rest averages warm.
 */
export function turningPoint(timeline: Pt[], kind: "villain_arc" | "redemption_arc"): number {
  const n = timeline.length;
  const sign = kind === "villain_arc" ? -1 : 1;
  for (let i = 1; i < n; i++) {
    const tail = timeline.slice(i);
    const mean = tail.reduce((a, t) => a + t.sentiment, 0) / tail.length;
    if (sign * timeline[i].sentiment >= 0.25 && sign * mean >= 0.2) return i;
  }
  return Math.floor(n / 2);
}

/** The star of the story: draws the arc, then reveals real comments along it. */
export function ArcTimeline({
  timeline,
  quotes = 4,
  drawSeconds = 3.2,
  startDelay = 0.5,
  hideQuotes = false,
  flip,
}: {
  timeline: Pt[];
  quotes?: number;
  drawSeconds?: number;
  startDelay?: number;
  hideQuotes?: boolean;
  /** marks the moment the tone flips: a dashed line and a label that pops in at `at` seconds */
  flip?: { index: number; label: string; at: number; color: string };
}) {
  const reduced = useReducedMotion();
  const portrait = usePortrait();
  const W = 1000;
  const H = portrait ? 620 : 360;
  const g = geometry(timeline, W, H, 36, portrait ? 60 : 34);
  const n = timeline.length;
  const picks = pickIdx(n, quotes);
  const at = (i: number) => startDelay + (n === 1 ? 0 : i / (n - 1)) * drawSeconds;
  const lab = portrait ? 30 : 20;
  const fl = portrait ? 40 : 22; // flip label size
  const fx = flip ? g.xs[Math.min(flip.index, n - 1)] : 0;
  const labelW = flip ? Math.min(W - 20, flip.label.length * (portrait ? 21 : 12.5) + 40) : 0;
  const labelX = Math.max(10, Math.min(W - labelW - 10, fx - labelW / 2));

  return (
    <div className="w-full">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto w-full overflow-visible" style={{ maxHeight: portrait ? "44dvh" : "34dvh" }} role="img" aria-label="Sentiment over time">
          <text x="6" y={lab + 2} fill="rgba(127,168,138,0.95)" fontSize={lab} fontWeight="600" letterSpacing="2">LOVELY</text>
          <text x="6" y={H - 8} fill="rgba(208,97,74,0.95)" fontSize={lab} fontWeight="600" letterSpacing="2">NASTY</text>
          <line x1="0" x2={W} y1={g.mid} y2={g.mid} stroke="rgba(239,232,218,0.18)" strokeDasharray="2 6" />
          <motion.path
            d={g.d}
            fill="none"
            stroke="rgba(239,232,218,0.85)"
            strokeWidth={portrait ? 5 : 3}
            strokeLinecap="round"
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: startDelay, duration: drawSeconds, ease: "easeInOut" }}
          />
          {flip && (
            <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduced ? 0 : flip.at, duration: 0.3 }}>
              <line x1={fx} x2={fx} y1={lab + 14} y2={H - lab - 12} stroke={flip.color} strokeWidth="1.5" strokeDasharray="4 6" />
              <rect x={labelX} y={H / 2 - fl * 0.95} width={labelW} height={fl * 1.9} rx="2" fill="#15130f" stroke={flip.color} strokeWidth="1.5" />
              <text x={labelX + labelW / 2} y={H / 2 + fl * 0.35} textAnchor="middle" fontSize={fl} fontWeight="600" fill={flip.color}>{flip.label}</text>
            </motion.g>
          )}
          {timeline.map((p, i) => {
            const isPick = picks.includes(i);
            return (
              <g key={i}>
                <motion.circle
                  cx={g.xs[i]}
                  cy={g.ys[i]}
                  r={isPick ? (portrait ? 16 : 11) : portrait ? 8 : 5}
                  fill={sentColor(p.sentiment)}
                  stroke="#15130f"
                  strokeWidth="3"
                  initial={{ opacity: reduced ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: at(i), duration: 0.5 }}
                />
                {isPick && !hideQuotes && (
                  <motion.text
                    x={g.xs[i]}
                    y={g.ys[i] + 5}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="600"
                    fill="#15130f"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: at(i) + 0.1 }}
                  >
                    {picks.indexOf(i) + 1}
                  </motion.text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {!hideQuotes && (
        <ol className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {picks.map((i, k) => {
            const p = timeline[i];
            const c = sentColor(p.sentiment);
            return (
              <motion.li
                key={i}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduced ? 0 : at(i) + 0.15, duration: 0.7, ease: [0.25, 0.6, 0.25, 1] }}
                className="relative border-t-2 pt-3"
                style={{ borderColor: c }}
              >
                <div className="kicker mb-2 flex items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold text-ink" style={{ background: c }}>
                    {k + 1}
                  </span>
                  {fmtMonth(p.t)}
                </div>
                <p className="font-serif text-[clamp(0.95rem,1.9vmin,1.2rem)] leading-snug text-bone">&ldquo;<CommentText text={p.text} />&rdquo;</p>
              </motion.li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
