import type { PersonaKind, Vibe } from "@/lib/types";

export const VIBE_ORDER: Vibe[] = ["supportive", "funny", "question", "critical", "toxic", "spam"];

export const VIBE_META: Record<Vibe, { label: string; color: string }> = {
  supportive: { label: "friendly", color: "#7fa88a" },
  funny: { label: "funny", color: "#a98fb0" },
  question: { label: "curious", color: "#7e98b0" },
  critical: { label: "critical", color: "#d08a52" },
  toxic: { label: "toxic", color: "#d0614a" },
  spam: { label: "spam", color: "#8a8273" },
};

export const KIND_META: Record<PersonaKind, { label: string; accent: string; blurb: string }> = {
  superfan: { label: "Superfan", accent: "#7fa88a", blurb: "Kind on every single video" },
  consistent_hater: { label: "Consistent hater", accent: "#d0614a", blurb: "Nasty on every single video" },
  villain_arc: { label: "Villain arc", accent: "#b87a86", blurb: "Started as a fan, ended as a menace" },
  redemption_arc: { label: "Redemption arc", accent: "#7e98b0", blurb: "Came in swinging, left a believer" },
  one_bad_day: { label: "One bad day", accent: "#d08a52", blurb: "Lovely, except for that one comment" },
  comedian: { label: "Comedian", accent: "#a98fb0", blurb: "Here for the bit" },
  reply_guy: { label: "Reply guy", accent: "#c9a049", blurb: "Has opinions on every upload" },
};

/** -1 (nasty) .. +1 (lovely) mapped red -> amber -> green */
export function sentColor(s: number): string {
  const c = Math.max(-1, Math.min(1, s));
  const hue = Math.round(10 + ((c + 1) / 2) * 130);
  return `hsl(${hue} 38% ${c < 0 ? 52 : 55}%)`;
}

/** Stretch a set of per-video averages to the full red..green range so differences read on camera. */
export function spread(values: number[]): (v: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = hi - lo || 1;
  return (v) => ((v - lo) / range) * 1.7 - 0.85;
}
