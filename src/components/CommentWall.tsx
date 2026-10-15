"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { ClassifiedComment } from "@/lib/types";
import { maskHandle, maskMentions } from "./mask";
import { tidyComment } from "./text";
import { VIBE_META } from "./vibes";

/**
 * Unmasked handle / comment text per card element. Kept off the DOM (no data- attributes) so that streamer mode hides the
 * real values from the Elements panel too, and restored from here when the toggle flips.
 */
const RAW = new WeakMap<HTMLElement, string>();

/**
 * A river of comments rising through lanes, each stamped with its vibe after a beat.
 * Built imperatively (DOM + CSS transforms) so hundreds of cards a second stay at 60fps.
 */
export function CommentWall({
  feed,
  seq,
  streamer,
  intensity = 1,
  ambient,
  preseed = false,
  className = "",
}: {
  feed?: ClassifiedComment[];
  seq?: number;
  streamer: boolean;
  /** 0..1, how eagerly to recycle old comments when no fresh ones are queued */
  intensity?: number;
  ambient?: ClassifiedComment[];
  /** fill the wall with cards already mid-flight on mount, so the first frame is never empty */
  preseed?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const queue = useRef<ClassifiedComment[]>([]);
  const pool = useRef<ClassifiedComment[]>(ambient ? [...ambient] : []);
  const usingAmbient = useRef(!!ambient);
  const streamerRef = useRef(streamer);
  const intensityRef = useRef(intensity);
  const reduced = useReducedMotion();
  intensityRef.current = intensity;
  streamerRef.current = streamer;

  useEffect(() => {
    if (!feed || !feed.length) return;
    // placeholder comments are only there to keep the wall alive until the channel's own comments arrive
    if (usingAmbient.current) {
      usingAmbient.current = false;
      pool.current = [];
    }
    queue.current.push(...feed);
    if (queue.current.length > 80) queue.current.splice(0, queue.current.length - 80);
    pool.current.push(...feed);
    if (pool.current.length > 240) pool.current.splice(0, pool.current.length - 240);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    for (const h of el.querySelectorAll<HTMLElement>(".h")) {
      const raw = RAW.get(h) ?? "";
      h.textContent = streamer ? maskHandle(raw) : raw;
    }
    // comment bodies can contain other people's @handles too
    for (const t of el.querySelectorAll<HTMLElement>(".t")) {
      const raw = RAW.get(t) ?? "";
      t.textContent = streamer ? maskMentions(raw) : raw;
    }
  }, [streamer]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let raf = 0;
    let H = el.clientHeight;
    let W = el.clientWidth;
    const ro = new ResizeObserver(() => {
      H = el.clientHeight;
      W = el.clientWidth;
    });
    ro.observe(el);
    const lastSpawn: number[] = [];
    let lastStill = 0;

    const build = (c: ClassifiedComment) => {
      const meta = VIBE_META[c.vibe];
      const card = document.createElement("div");
      card.className = "wcard";
      card.style.setProperty("--c", meta.color);
      const stamp = document.createElement("span");
      stamp.className = "stamp";
      stamp.textContent = meta.label;
      const h = document.createElement("span");
      h.className = "h";
      const name = c.authorName?.trim() ? tidyComment(c.authorName, 30) : "@someone";
      RAW.set(h, name);
      h.textContent = streamerRef.current ? maskHandle(name) : name;
      const t = document.createElement("span");
      t.className = "t";
      const raw = tidyComment(c.text, 140);
      RAW.set(t, raw);
      t.textContent = streamerRef.current ? maskMentions(raw) : raw;
      card.append(stamp, h, t);
      return card;
    };
    const next = () => {
      const q = queue.current;
      if (q.length) return q.shift();
      if (pool.current.length && Math.random() < intensityRef.current) return pool.current[Math.floor(Math.random() * pool.current.length)];
      return undefined;
    };

    if (preseed && !reduced && W && H) {
      const lanes0 = W >= 1100 ? 7 : W >= 700 ? 5 : 3;
      const lw0 = W / lanes0;
      const travel0 = H + 90;
      for (let i = 0; i < lanes0; i++) {
        const dur = 6.2 + (i % 3) * 1.1 + (i % 2) * 0.4;
        const per = Math.max(2, Math.round(travel0 / 190));
        for (let k = 0; k < per; k++) {
          const c = next() ?? pool.current[Math.floor(Math.random() * pool.current.length)];
          if (!c) break;
          const card = build(c);
          card.style.left = `${i * lw0 + 6}px`;
          card.style.width = `${lw0 - 12}px`;
          card.style.setProperty("--travel", `${travel0}px`);
          card.style.setProperty("--dur", `${dur}s`);
          // negative delay = already this far along its rise
          card.style.animationDelay = `-${((k + Math.random() * 0.6) / per) * dur * 0.92}s`;
          card.classList.add("s");
          card.addEventListener("animationend", (e) => {
            if ((e as AnimationEvent).animationName === "rise") card.remove();
          });
          el.appendChild(card);
        }
      }
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!W || !H) return;
      if (reduced) {
        if (now - lastStill > 450) {
          lastStill = now;
          const c = next();
          if (!c) return;
          const card = build(c);
          const lanes = W > 900 ? 4 : 2;
          const lw = W / lanes;
          card.className = "wcard still s";
          card.style.left = `${Math.floor(Math.random() * lanes) * lw + 6}px`;
          card.style.width = `${lw - 12}px`;
          card.style.setProperty("--y", `${Math.floor(Math.random() * Math.max(1, H - 70))}px`);
          el.appendChild(card);
          requestAnimationFrame(() => card.classList.add("in"));
          while (el.childElementCount > 18) el.firstElementChild?.remove();
        }
        return;
      }
      const lanes = W >= 1100 ? 7 : W >= 700 ? 5 : 3;
      const lw = W / lanes;
      const travel = H + 90;
      for (let i = 0; i < lanes; i++) {
        const dur = 6.2 + (i % 3) * 1.1 + (i % 2) * 0.4;
        const gapMs = ((66 / (travel / dur)) * 1000) * (1 + Math.random() * 0.35);
        if (now - (lastSpawn[i] ?? 0) < gapMs) continue;
        const c = next();
        if (!c) continue;
        lastSpawn[i] = now;
        if (el.childElementCount > 110) continue;
        const card = build(c);
        card.style.left = `${i * lw + 6}px`;
        card.style.width = `${lw - 12}px`;
        card.style.setProperty("--travel", `${travel}px`);
        card.style.setProperty("--dur", `${dur}s`);
        card.addEventListener("animationend", (e) => {
          if ((e as AnimationEvent).animationName === "rise") card.remove();
        });
        el.appendChild(card);
        setTimeout(() => card.classList.add("s"), 260 + Math.random() * 420);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.replaceChildren();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return <div ref={box} aria-hidden className={`pointer-events-none overflow-hidden ${className}`} />;
}
