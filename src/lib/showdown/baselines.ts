// Free baselines that anchor the scale. They cost nothing and answer instantly.
import type { Vibe } from "../types";

export interface BaselineAnswer {
  vibe: Vibe;
  toxic: boolean;
}

/** The majority class. If a paid reader barely beats this, that is the finding. */
export function alwaysSupportive(): BaselineAnswer {
  return { vibe: "supportive", toxic: false };
}

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|me)\b|t\.me\/|wa\.me\/|telegram|whatsapp|subscribe to my|check out my|check my channel|dm me)/i;
const TOXIC_RE = /\b(kill yourself|kys|idiot|stupid|retard(ed)?|trash|garbage|loser|scum|piece of (shit|crap)|hate you|go die|fuck (you|off)|moron|disgusting)\b/i;
const FUNNY_RE = /(\blol\b|\blmao\b|\blmfao\b|\bhaha+\b|\brofl\b|😂|🤣|💀|😭|\bbruh\b|\bimagine\b|\bnot me\b)/i;
const CRITICAL_RE = /\b(fake|scripted|overrated|boring|clickbait|cringe|worst|disappointing|disappointed|ruined|sellout|sold out|greedy|unfair|misleading|waste)\b/i;
const QUESTION_RE = /\?\s*$|\b(how|why|what|when|where|who|can you|could you|do you|is it|are you)\b.*\?/i;

/** Keyword and regex rules, checked in a fixed order. Deliberately crude. */
export function rulesReader(text: string): BaselineAnswer {
  const t = text ?? "";
  if (URL_RE.test(t)) return { vibe: "spam", toxic: false };
  if (TOXIC_RE.test(t)) return { vibe: "toxic", toxic: true };
  if (FUNNY_RE.test(t)) return { vibe: "funny", toxic: false };
  if (QUESTION_RE.test(t) && t.trim().length > 12) return { vibe: "question", toxic: false };
  if (CRITICAL_RE.test(t)) return { vibe: "critical", toxic: false };
  return { vibe: "supportive", toxic: false };
}
