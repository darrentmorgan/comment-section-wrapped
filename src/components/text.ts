/** Cleans a raw YouTube comment for display: one line of text, bounded length, never empty. */
export function tidyComment(raw: string | undefined | null, max = 220): string {
  const clean = (raw ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "(no text)";
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const head = chars.slice(0, max - 1);
  // prefer a word boundary if one sits in the last quarter
  const cut = head.lastIndexOf(" ");
  const kept = cut > max * 0.6 ? head.slice(0, cut) : head;
  return kept.join("").replace(/[\s.,;:!?-]+$/u, "") + "…";
}

/** Comments shown inside typographic quote marks: drop one pair of quotes that wrap the whole text, so they never double up. */
export function unwrapQuotes(t: string): string {
  const m = /^["“”]\s*([^"“”]+?)\s*["“”]$/u.exec(t);
  return m ? m[1] : t;
}
