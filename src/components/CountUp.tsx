"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Writes a formatted number into `el`. Commas and decimal points go in a narrow box: in the mono `.num` font they
 * are a full digit wide and read as a gap ("35 , 476"). The text only ever comes from our number formatters.
 */
export function setNum(el: HTMLElement, text: string) {
  if (/[<>&]/.test(text)) {
    el.textContent = text;
    return;
  }
  el.innerHTML = text.replace(/[,.]/g, '<i class="np">$&</i>');
}

/** Eases toward `value` every frame, writing straight to the DOM (no re-renders). For live counters. */
export function LiveNumber({
  value,
  format,
  className,
  rate = 7,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  rate?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const target = useRef(value);
  const shown = useRef(value);
  const reduced = useReducedMotion();
  const fmt = useRef(format);
  fmt.current = format;
  target.current = value;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const diff = target.current - shown.current;
      shown.current = reduced || Math.abs(diff) < 1e-9 ? target.current : shown.current + diff * (1 - Math.exp(-rate * dt));
      if (ref.current) setNum(ref.current, fmt.current(shown.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rate, reduced]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}

/** One-shot dramatic count from 0 to `to` after `delay` seconds. */
export function CountUp({
  to,
  format,
  duration = 1.8,
  delay = 0,
  className,
}: {
  to: number;
  format: (n: number) => string;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const fmt = useRef(format);
  fmt.current = format;

  useEffect(() => {
    if (reduced) {
      if (ref.current) setNum(ref.current, fmt.current(to));
      return;
    }
    let raf = 0;
    const t0 = performance.now() + delay * 1000;
    const tick = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / (duration * 1000)));
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p); // expo out
      if (ref.current) setNum(ref.current, fmt.current(to * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    if (ref.current) setNum(ref.current, fmt.current(0));
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, duration, delay, reduced]);

  return (
    <span ref={ref} className={className}>
      {format(0)}
    </span>
  );
}

/** Wall clock in seconds with 1 decimal, frozen when `endAt` is set. */
export function Clock({ startedAt, endAt, className }: { startedAt: number; endAt?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const t = ((endAt ?? now) - startedAt) / 1000;
      if (ref.current) setNum(ref.current, Math.max(0, t).toFixed(1));
      if (endAt === undefined) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [startedAt, endAt]);
  return (
    <span ref={ref} className={className}>
      0.0
    </span>
  );
}
