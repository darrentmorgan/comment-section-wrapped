"use client";

import { createContext, useContext } from "react";
import { maskHandle, maskMentions } from "@/lib/maskText";
export { maskHandle, maskMentions } from "@/lib/maskText";
import { tidyComment, unwrapQuotes } from "./text";

const StreamerCtx = createContext(true);
export const StreamerProvider = StreamerCtx.Provider;
export const useStreamer = () => useContext(StreamerCtx);

/** A comment body that follows streamer mode: @mentions are masked when it is on. */
export function CommentText({ text, className, max = 220 }: { text: string; className?: string; max?: number }) {
  const streamer = useStreamer();
  const t = unwrapQuotes(tidyComment(text, max));
  return <span className={`[overflow-wrap:anywhere] ${className ?? ""}`}>{streamer ? maskMentions(t) : t}</span>;
}

export function Handle({ name, className }: { name: string; className?: string }) {
  const streamer = useStreamer();
  const n = name?.trim() ? tidyComment(name, 40) : "@someone";
  return <span className={className}>{streamer ? maskHandle(n) : n}</span>;
}

function hue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({
  name,
  src,
  size = 56,
  className = "",
  alwaysShow = false,
}: {
  name: string;
  src?: string;
  size?: number;
  className?: string;
  /** channel avatars are public: never blur */
  alwaysShow?: boolean;
}) {
  const streamer = useStreamer() && !alwaysShow;
  const h = hue(name);
  const initial = name.replace(/^@/, "").charAt(0).toUpperCase();
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full ${className}`}
      style={{ width: size, height: size, background: `hsl(${h} 22% 36%)` }}
      aria-hidden
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img referrerPolicy="no-referrer" src={src} alt="" className="h-full w-full object-cover" style={streamer ? { filter: `blur(${Math.max(6, size / 5)}px)`, transform: "scale(1.5)" } : undefined} />
      ) : (
        <span className="display-soft text-bone/90" style={{ fontSize: size * 0.46, filter: streamer ? `blur(${size / 9}px)` : undefined }}>
          {initial}
        </span>
      )}
    </span>
  );
}

export function StreamerToggle({ on, onChange, className = "" }: { on: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <button
      type="button"
      data-nonav
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`group flex items-center gap-2.5 border border-bone/25 bg-ink py-1.5 pl-3 pr-2 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors hover:border-bone/50 ${className}`}
    >
      <span className="text-mute group-aria-checked:text-bone">Streamer<span className="max-sm:hidden"> mode</span></span>
      {/* A light knob on a coloured track reads as "on" at a glance; the dark knob on a light track read backwards. */}
      {/* left-0 matters: without it the knob's static position sits 20px in, so "off" looked like "on". */}
      <span className={`relative block h-5 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-supportive" : "bg-bone/15"}`}>
        <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform ${on ? "bg-bone translate-x-[22px]" : "bg-bone/60 translate-x-0.5"}`} />
      </span>
      <span className="w-6 text-left text-mute group-aria-checked:text-bone">{on ? "On" : "Off"}</span>
    </button>
  );
}
