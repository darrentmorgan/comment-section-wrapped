"use client";

import { useLayoutEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";

export const EASE = [0.25, 0.6, 0.25, 1] as const;
/** Zoom that fits `need` px of slide content into `have` px, never below a readable floor. */
export function fitZoom(need: number, have: number, floor = 0.72): number {
  if (!need || !have || need <= have) return 1;
  return Math.max(floor, have / need);
}

/**
 * Short phones (an iPhone SE is 667px tall) cannot hold the densest slides at full size. Measure the slide's natural
 * height and, only when it overflows, zoom it down to fit, widening it by the same factor so the gutters stay put.
 */
function useFitToScreen() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const fit = () => {
      el.style.zoom = el.style.height = el.style.width = el.style.maxWidth = "";
      el.style.height = "auto";
      const next = fitZoom(el.offsetHeight, box.clientHeight);
      el.style.height = "";
      if (next < 1) {
        el.style.zoom = String(next);
        el.style.height = `${box.clientHeight / next}px`;
        el.style.width = `calc(100% / ${next})`;
        el.style.maxWidth = `calc(min(1500px, 94vw) / ${next})`;
      }
    };
    fit();
    // content can grow after mount (a quote swaps in, fonts load), so re-fit when any block changes size
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    ro.observe(box);
    for (const c of el.children) ro.observe(c);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, []);
  return ref;
}

/**
 * Slide backdrop: flat warm ink with a short accent rule at the top. `shift` crossfades that rule to another colour at
 * `at` seconds (a quiet one-shot beat, no flash). `shakeAt` is accepted for compatibility and ignored: no shaking.
 */
export function Shell({ accent, children, shift }: { accent: string; children: React.ReactNode; shift?: { color: string; at: number }; shakeAt?: number }) {
  const reduced = useReducedMotion();
  const fit = useFitToScreen();
  return (
    <div className="absolute inset-0 overflow-hidden bg-ink">
      <div className="pointer-events-none absolute left-[max(1.25rem,5vmin)] right-[max(1.25rem,5vmin)] top-[max(3.6rem,7.5vmin)] h-px bg-line" />
      <div className="pointer-events-none absolute left-[max(1.25rem,5vmin)] top-[max(3.6rem,7.5vmin)] h-[3px] w-14 -translate-y-px" style={{ background: accent }} />
      {shift && !reduced && (
        <motion.div
          className="pointer-events-none absolute left-[max(1.25rem,5vmin)] top-[max(3.6rem,7.5vmin)] h-[3px] w-14 -translate-y-px"
          style={{ background: shift.color }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: shift.at, duration: 0.8 }}
        />
      )}
      <div ref={fit} className="st-inner">{children}</div>
    </div>
  );
}

export function Title({ children, size = "huge", color }: { children: React.ReactNode; size?: "huge" | "big"; color?: string }) {
  return (
    <motion.h2
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE }}
      className={`display ${size === "huge" ? "st-huge" : "st-title"}`}
      style={{ color }}
    >
      {children}
    </motion.h2>
  );
}

export function Sub({ children, delay = 0.35, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay, duration: 0.8 }}
      className={`st-sub max-w-[40ch] leading-snug text-bone/80 ${className}`}
    >
      {children}
    </motion.p>
  );
}

