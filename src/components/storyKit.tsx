"use client";

import { motion, useReducedMotion } from "motion/react";

export const EASE = [0.25, 0.6, 0.25, 1] as const;
/**
 * Slide backdrop: flat warm ink with a short accent rule at the top. `shift` crossfades that rule to another colour at
 * `at` seconds (a quiet one-shot beat, no flash). `shakeAt` is accepted for compatibility and ignored: no shaking.
 */
export function Shell({ accent, children, shift }: { accent: string; children: React.ReactNode; shift?: { color: string; at: number }; shakeAt?: number }) {
  const reduced = useReducedMotion();
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
      <div className="st-inner">{children}</div>
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

