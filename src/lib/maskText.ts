/**
 * @jasmine42 -> @ja***42. Splits by code point (emoji and other surrogate pairs stay whole) and reveals less of short
 * handles: 2+2 characters from 8 up, 1+1 for 5-7, nothing at all below that.
 */
export function maskHandle(handle: string): string {
  const chars = Array.from(handle.replace(/^@/, ""));
  const n = chars.length;
  if (n >= 8) return `@${chars.slice(0, 2).join("")}***${chars.slice(-2).join("")}`;
  if (n >= 5) return `@${chars[0]}***${chars[n - 1]}`;
  return "@***";
}

/** Demo names reveal only the first code point, with nothing revealed for single-character names. */
export function maskHandleStrict(handle: string): string {
  const chars = Array.from(handle.replace(/^@/, ""));
  return chars.length > 1 ? `@${chars[0]}***` : "@***";
}

// @name, allowing dots inside (not a trailing one): "@Someone you are wrong." masks "@Someone" and keeps the full stop.
// A full-width ＠ (U+FF20) is the same mention to a human reader, so it is matched and masked too.
const MENTION_RE = /[@\uFF20][\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*/gu;
// A profile link names a person as surely as a handle does; watch?v= and bare youtu.be/<id> video links are left alone.
const PROFILE_URL_RE = /(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)\/(?:channel\/|c\/|user\/|@)[^\s]+/gi;

/** Masks every @mention and YouTube profile link in a comment body (other people's handles, or the commenter's own name). */
export function maskMentions(text: string): string {
  return text
    .replace(PROFILE_URL_RE, (m) => `${m.slice(0, m.indexOf("/") + 1)}***`)
    .replace(MENTION_RE, (m) => maskHandle(m.replace(/^\uFF20/, "@")));
}
