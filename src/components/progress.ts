import { DEFAULT_COMMENTS_PER_VIDEO } from "@/lib/util";

export { DEFAULT_COMMENTS_PER_VIDEO };

/** What one video contributes to the fetched count: its comments, capped at the per-video limit (an unknown count counts as a full cap). */
const share = (commentCount: number, cap: number) => Math.min(cap, commentCount > 0 ? commentCount : cap);

/** How many comments the run expects to pull from these videos: each video contributes at most `cap`. */
export function totalExpected(videos: { commentCount: number }[], cap: number = DEFAULT_COMMENTS_PER_VIDEO): number {
  return videos.reduce((a, v) => a + share(v.commentCount, cap), 0);
}

/**
 * How many videos have been "opened" given the running fetched-comment count. Videos are opened in list order. Only the
 * first `cap` comments of a video are fetched, so a video with 18,809 comments still occupies 1,000 of the count.
 */
export function videosOpened(fetched: number, videos: { commentCount: number }[], cap: number = DEFAULT_COMMENTS_PER_VIDEO): number {
  let start = 0;
  let opened = 0;
  for (const v of videos) {
    if (fetched <= start) break;
    opened++;
    start += share(v.commentCount, cap);
  }
  return opened;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct 2026" from a saved run id like mrbeast-20261014-153500, or null when the id has no date stamp. */
export function replayDateLabel(id: string | null | undefined): string | null {
  const m = /-(\d{4})(\d{2})(\d{2})-\d{6}(?:-\d+)?$/.exec(id ?? "");
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${d} ${MONTHS[mo - 1]} ${m[1]}`;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** ?replay=<runId|latest> and ?debug=1 from a location.search string. */
export function replayParam(search: string): { id: string | null; debug: boolean } {
  const p = new URLSearchParams(search);
  const raw = p.get("replay")?.trim() ?? "";
  const id = raw && SAFE_ID.test(raw) && !raw.includes("..") ? raw : null;
  return { id, debug: p.get("debug") === "1" };
}
