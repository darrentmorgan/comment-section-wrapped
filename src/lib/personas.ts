// Pure persona / aggregate logic. No I/O, no randomness, no network.
import type { ClassifiedComment, MostLoyal, Persona, PersonaKind, VideoInfo, Vibe, WrappedResult } from "./types";
import { VIBES, emptyByVibe } from "./vibes";

export interface PersonaThresholds {
  /** villain / redemption arcs */
  arcMinComments: number;
  arcMinVideos: number;
  arcPositive: number; // half average must be >= this to count as "warm"
  arcNegative: number; // half average must be <= this to count as "hostile"
  arcMinSwing: number; // early - late must differ by at least this
  arcSoftNegative: number; // a "cool" comment for the thin-half rule: <= this counts as not-warm
  arcMinShare: number; // share of each half that must itself be warm (early) / hostile (late); labels a private person, so be strict
  arcMinHits: number; // ...and at least this many comments in the half
  arcMinSpanDays: number; // first-to-last comment must span this long, so "over time" is real drift and not one reading session
  /** superfan / hater */
  traitMinComments: number;
  traitMinVideos: number;
  superfanAvg: number;
  superfanPositiveShare: number;
  haterAvg: number;
  haterNegativeShare: number;
  /** one bad day */
  nastyThreshold: number; // a comment this negative (or lower) is "nasty"
  /** copy-paste filter for personas: distinct opening texts */
  minDistinctTexts: number;
  minDistinctShare: number;
  badDayOthersAvg: number;
  badDayOthersPositiveShare: number;
  /** comedian */
  comedianFunnyShare: number;
  /** reply guy */
  replyGuyMinComments: number;
  replyGuyPerVideo: number;
  replyGuyBreadthMinComments: number; // ...or: this many short comments spread over...
  replyGuyBreadthMinVideos: number;
  replyGuyBreadthMaxAvgLen: number; // ...with an average length below this (greetings, emoji, 'nice'), not essays
  replyGuyMinVideos: number; // must be 'everywhere', not 40 comments under one video
  /** generic bands */
  positive: number;
  negative: number;
}

export const DEFAULT_THRESHOLDS: PersonaThresholds = {
  arcMinComments: 4,
  arcMinVideos: 3,
  arcPositive: 0.25,
  arcNegative: -0.2,
  arcMinSwing: 0.5,
  arcSoftNegative: -0.1,
  arcMinShare: 0.6,
  arcMinHits: 2,
  arcMinSpanDays: 14,
  traitMinComments: 4,
  traitMinVideos: 3,
  superfanAvg: 0.4,
  superfanPositiveShare: 0.8,
  haterAvg: -0.3,
  haterNegativeShare: 0.7,
  nastyThreshold: -0.4,
  minDistinctTexts: 3,
  minDistinctShare: 0.6,
  badDayOthersAvg: 0.3,
  badDayOthersPositiveShare: 0.7,
  comedianFunnyShare: 0.6,
  replyGuyMinComments: 15,
  replyGuyPerVideo: 1.3,
  replyGuyMinVideos: 5,
  replyGuyBreadthMinComments: 20,
  replyGuyBreadthMinVideos: 15,
  replyGuyBreadthMaxAvgLen: 45,
  positive: 0.2,
  negative: -0.2,
};

/** Story order: the juiciest arcs first. */
export const KIND_ORDER: PersonaKind[] = [
  "villain_arc",
  "redemption_arc",
  "consistent_hater",
  "superfan",
  "one_bad_day",
  "comedian",
  "reply_guy",
];

/** videoId -> ISO publish date of the VIDEO. Arcs are ordered by this so "early" means early videos, not early comments. */
export type VideoDates = ReadonlyMap<string, string>;

export function videoDatesOf(videos: Pick<VideoInfo, "id" | "publishedAt">[] | undefined): VideoDates | undefined {
  if (!videos || videos.length === 0) return undefined;
  return new Map(videos.map((v) => [v.id, v.publishedAt]));
}

const cmpFor =
  (vd?: VideoDates) =>
  (a: ClassifiedComment, b: ClassifiedComment): number => {
    const va = vd?.get(a.videoId);
    const vb = vd?.get(b.videoId);
    if (va && vb && va !== vb) return va < vb ? -1 : 1;
    if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Group by stable author id; each group sorted oldest to newest. */
export function groupByAuthor(comments: ClassifiedComment[], videoDates?: VideoDates): Map<string, ClassifiedComment[]> {
  const m = new Map<string, ClassifiedComment[]>();
  for (const c of comments) {
    const g = m.get(c.authorId);
    if (g) g.push(c);
    else m.set(c.authorId, [c]);
  }
  const cmp = cmpFor(videoDates);
  for (const g of m.values()) g.sort(cmp);
  return m;
}

export interface Detection {
  kind: PersonaKind;
  /** 0..1 how clear-cut the pattern is */
  strength: number;
  early: number;
  late: number;
}

/** Decide whether one author's chronological comments form a persona. `comments` must be sorted oldest first. */
export function detectPersonaKind(input: ClassifiedComment[], th: PersonaThresholds = DEFAULT_THRESHOLDS, videoDates?: VideoDates): Detection | null {
  const comments = [...input].sort(cmpFor(videoDates));
  const n = comments.length;
  if (n < Math.min(th.arcMinComments, th.traitMinComments)) return null;
  const videos = new Set(comments.map((c) => c.videoId)).size;
  const s = comments.map((c) => c.sentiment);
  const mean = avg(s);
  const half = Math.floor(n / 2);
  const early = avg(s.slice(0, half));
  const late = avg(s.slice(n - half));
  const mk = (kind: PersonaKind, strength: number): Detection => ({ kind, strength: Math.max(0, Math.min(1, strength)), early, late });

  // Arcs: compare first half with last half. Averages alone are not enough: one outlier in a thin half must not make a
  // villain, so each half must be mostly (>= arcMinShare, and >= arcMinHits comments) warm / hostile, the final comment
  // must agree with the verdict, and the history must span real time.
  const earlyHalf = s.slice(0, half);
  const lateHalf = s.slice(n - half);
  // A half of two comments cannot reach "2 hits and 60%" on the cool side with only one hostile comment, so a thin half
  // may instead pass when every comment in it is at least cool (<= arcSoftNegative); a lone outlier next to a warm one fails.
  const share = (xs: number[], pred: (x: number) => boolean, soft?: (x: number) => boolean) => {
    const hits = xs.filter(pred).length;
    if (hits >= th.arcMinHits && hits / xs.length >= th.arcMinShare) return true;
    return !!soft && xs.length <= 2 && xs.every(soft);
  };
  // The span is real elapsed COMMENT time between the first and last comment (by video order), signed: a binge through the
  // back catalogue is not "over time", and if comment-time order contradicts video order the story is not an arc.
  const ct = comments.map((c) => Date.parse(c.publishedAt));
  const spanDays = (ct[n - 1] - ct[0]) / 86_400_000;
  const earliestIdx = ct.indexOf(Math.min(...ct));
  const latestIdx = ct.lastIndexOf(Math.max(...ct));
  const orderAgrees = earliestIdx < half && latestIdx >= n - half;
  const arcOk = n >= th.arcMinComments && videos >= th.arcMinVideos && spanDays >= th.arcMinSpanDays && orderAgrees;
  const last = s[n - 1];
  const first = s[0];
  const cool = (x: number) => x <= th.arcSoftNegative;
  if (
    arcOk &&
    early - late >= th.arcMinSwing &&
    early >= th.arcPositive &&
    late <= th.arcNegative &&
    share(earlyHalf, (x) => x >= th.arcPositive) &&
    share(lateHalf, (x) => x <= th.arcNegative, cool) &&
    first >= th.arcPositive &&
    last <= th.arcNegative
  ) {
    return mk("villain_arc", (early - late) / 2);
  }
  if (
    arcOk &&
    late - early >= th.arcMinSwing &&
    late >= th.arcPositive &&
    early <= th.arcNegative &&
    share(lateHalf, (x) => x >= th.arcPositive) &&
    share(earlyHalf, (x) => x <= th.arcNegative, cool) &&
    first <= th.arcNegative &&
    last >= th.arcPositive
  ) {
    return mk("redemption_arc", (late - early) / 2);
  }

  // One bad day: a single nasty outlier in an otherwise warm history.
  if (n >= th.traitMinComments && videos >= th.traitMinVideos) {
    // "Nasty" is a critical or toxic comment that is clearly negative; a mixed-tone question does not count.
    const nasty = comments.filter((c) => c.sentiment <= th.nastyThreshold && (c.vibe === "critical" || c.vibe === "toxic"));
    const anyNegative = comments.filter((c) => c.sentiment <= th.negative).length; // no second negative-toned comment either
    if (nasty.length === 1 && anyNegative === 1) {
      const others = comments.filter((c) => c !== nasty[0]).map((c) => c.sentiment);
      const posShare = others.filter((x) => x >= th.positive).length / others.length;
      if (avg(others) >= th.badDayOthersAvg && posShare >= th.badDayOthersPositiveShare) {
        return mk("one_bad_day", (avg(others) - nasty[0].sentiment) / 2);
      }
    }
  }

  if (n >= th.traitMinComments && videos >= th.traitMinVideos) {
    const negShare = s.filter((x) => x <= th.negative).length / n;
    const posShare = s.filter((x) => x >= th.positive).length / n;
    if (mean <= th.haterAvg && negShare >= th.haterNegativeShare) return mk("consistent_hater", -mean);
    // Mostly-funny wins over superfan: jokes read as mildly positive but the bit is the point.
    const funnyShare = comments.filter((c) => c.vibe === "funny").length / n;
    if (funnyShare >= th.comedianFunnyShare) return mk("comedian", funnyShare);
    // Everywhere with one-word comments is a reply guy, however nice: a superfan says something.
    const avgLen = avg(comments.map((c) => c.text.length));
    if (n >= th.replyGuyBreadthMinComments && videos >= th.replyGuyBreadthMinVideos && avgLen < th.replyGuyBreadthMaxAvgLen) {
      return mk("reply_guy", Math.min(1, n / 40));
    }
    if (mean >= th.superfanAvg && posShare >= th.superfanPositiveShare) return mk("superfan", mean);
  }

  // Reply guy: everywhere, repeatedly. Checked last on purpose: the strongest signal wins, so a prolific and
  // consistently nice (or nasty) commenter is a superfan (or hater), and reply_guy is for volume without a clear tone.
  if (n >= th.replyGuyMinComments && videos >= th.replyGuyMinVideos && n / videos >= th.replyGuyPerVideo) {
    return mk("reply_guy", Math.min(1, n / 40));
  }
  return null;
}

function pickHeadline(kind: PersonaKind, comments: ClassifiedComment[], used?: Set<string>): ClassifiedComment {
  const n = comments.length;
  const byLikes = (a: ClassifiedComment, b: ClassifiedComment) => b.likes - a.likes;
  const norm = (c: ClassifiedComment) => c.text.trim().toLowerCase();
  // Best-scoring comment whose text no earlier persona already uses as its headline (falls back to the best overall).
  const best = (pool: ClassifiedComment[], score: (c: ClassifiedComment) => number) => {
    const ranked = [...pool].sort((a, b) => score(b) - score(a) || byLikes(a, b));
    // The headline goes on screen: prefer a camera-safe English line, then any unused one, then the best overall.
    return ranked.find((c) => !used?.has(norm(c)) && cameraSafe(c.text)) ?? ranked.find((c) => !used?.has(norm(c))) ?? ranked[0] ?? comments[0];
  };
  const lateHalf = comments.slice(Math.floor(n / 2));
  switch (kind) {
    case "villain_arc":
    case "consistent_hater":
      return best(kind === "villain_arc" ? lateHalf : comments, (c) => -c.sentiment);
    case "redemption_arc":
      return best(lateHalf, (c) => c.sentiment);
    case "superfan":
      return best(comments, (c) => c.sentiment + 0.05 * Math.log1p(c.likes));
    case "one_bad_day":
      return best(comments, (c) => -c.sentiment);
    case "comedian":
      return best(comments, (c) => c.scores.funny + 0.05 * Math.log1p(c.likes));
    case "reply_guy":
    default:
      return best(comments, (c) => Math.log1p(c.likes) + Math.min(c.text.length, 140) / 140);
  }
}

function pickVariant(seed: string, count: number): number {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % count;
}

export interface VerdictStats {
  commentCount: number;
  videoCount: number;
  avgSentiment: number;
  early: number;
  late: number;
  /** ISO dates of the first and last comment, used for "Mar to Sep" style copy */
  firstAt?: string;
  lastAt?: string;
  /** titles of the first / last video they commented on (by video date), and of the video with their worst comment */
  firstTitle?: string;
  lastTitle?: string;
  badTitle?: string;
  /** one_bad_day: comments that are actually warm (sentiment above the positive band); never n-1 */
  warmCount?: number;
}

/** `"Title"` shortened to fit a one-liner. */
const q = (t: string | undefined, max = 40) => {
  const x = t?.replace(/["\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!x) return null;
  if (x.length <= max) return `"${x}"`;
  const cut = x.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `"${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,:;=\-–]+$/, "")}…"`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOf = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? MONTHS[new Date(t).getUTCMonth()] : null;
};

/** "Mar to Sep" when the comments span months; null when they sit in one month or the dates are unknown. */
export function spanLabel(st: Pick<VerdictStats, "firstAt" | "lastAt">): string | null {
  const a = monthOf(st.firstAt);
  const b = monthOf(st.lastAt);
  if (!a || !b || a === b) return null;
  return `${a} to ${b}`;
}

/** Deterministic, handle-free one-liners, 9 per kind. Never includes the commenter's name (streamer mode safe). */
export function verdictOptions(kind: PersonaKind, st: VerdictStats): string[] {
  const n = st.commentCount;
  const v = st.videoCount;
  const real = spanLabel(st);
  const span = real ?? `${v} videos`;
  const half = Math.max(2, Math.floor(n / 2));
  const a = q(st.firstTitle);
  const b = q(st.lastTitle);
  const bad = q(st.badTitle);
  const warm = st.warmCount ?? Math.max(1, n - 1);
  const specific: Record<PersonaKind, string[]> = {
    villain_arc: a && b ? [`Cheered on ${a}. By ${b} the cheering had stopped.`, `Fan on ${a}, critic on ${b}. A slow turn.`] : [],
    redemption_arc: a && b ? [`Came in swinging on ${a}, left ${b} a fan.`, `From grudge on ${a} to goodwill on ${b}.`] : [],
    consistent_hater: a && b ? [`Doubted ${a}. Doubted ${b}. Consistency is a virtue.`, `Found something to complain about on ${a} and again on ${b}.`] : [],
    superfan: a && b ? [`From ${a} to ${b}, still cheering.`, `Had something kind to say on ${a} and on ${b}.`] : [],
    one_bad_day: bad ? [`Warm everywhere except ${bad}, where it all went sideways.`, `${warm} warm comments, then ${bad}.`] : [],
    comedian: a && b ? [`Had a bit for ${a} and another for ${b}.`, `Open mic on ${a}, open mic on ${b}. Never stops.`] : [],
    reply_guy: a && b ? [`From ${a} to ${b} and ${Math.max(0, v - 2)} more. Lives here now.`, `Turned up on ${a}, ${b} and ${Math.max(0, v - 2)} other videos.`] : [],
  };
  const options: Record<PersonaKind, string[]> = {
    villain_arc: [
      `Gushed over the first videos, then spent the last ${half} comments burning the place down.`,
      `Went from "best channel ever" to "unsubbed" across ${v} videos. A full villain origin story.`,
      `Started as a founding fan. Ended as the comment section's final boss.`,
      `${span}: from heart emojis to hot takes. ${n} comments of slow-burn heel turn.`,
      `Every early comment was a hug. The last ${half} were a door slam.`,
      `The honeymoon lasted a few videos. The grudge has lasted ${span}.`,
      `A ${n}-comment character arc that ends with the villain monologue.`,
      `Nobody was nicer in the beginning. Nobody is nastier now. ${v} videos of proof.`,
      `Turned on the channel somewhere across ${span} and never looked back.`,
    ],
    redemption_arc: [
      `Opened with pure hostility, closed with heart emojis. ${v} videos of character development.`,
      `Arrived to start a fight and stayed for the content. The comment section's best glow-up.`,
      `Hated it, kept watching, and quietly became a fan. Redemption complete.`,
      `${span}: from "delete this" to "I was wrong". ${n} comments of growth.`,
      `The first ${half} comments were a fight. The last ${half} are a fan letter.`,
      `Came for the argument, stayed for the ${v}-video conversion.`,
      `Proof that a ${n}-comment grudge can end in an apology.`,
      `Went from loudest critic to quiet supporter across ${span}.`,
      `A heel-to-face turn in ${n} comments. The redemption arc nobody scheduled.`,
    ],
    consistent_hater: [
      `${n} comments across ${v} videos and the mood never lifted. Consistency is a virtue, technically.`,
      `Watches everything, loves nothing. Negativity as a lifestyle.`,
      `Unimpressed by the first upload, unimpressed by the latest.`,
      `${span} of dedicated disappointment. Never missed a chance to say so.`,
      `${v} videos, ${n} complaints, no change of heart.`,
      `Treats every upload like a personal inconvenience. Impressively consistent.`,
      `If there is a silver lining, this commenter has not found it in ${span}.`,
      `A subscriber in the loosest sense: always present, never pleased.`,
      `${n} comments of pure critique. The channel's most loyal opposition.`,
    ],
    superfan: [
      `${n} comments, ${v} videos, barely a bad day. Genuinely the creator's biggest fan.`,
      `Stays positive across ${v} videos and probably owns the merch.`,
      `A walking five-star review across ${v} videos.`,
      `${span} of unbroken good vibes across ${v} videos.`,
      `Has said something lovely on ${v} different videos and meant every one.`,
      `The comment section's emotional support human. ${n} comments and counting.`,
      `Rarely strayed from encouragement. ${n} comments of it.`,
      `Front row, upload after upload, since ${monthOf(st.firstAt) ?? "day one"}.`,
      `If this channel had a street team, this commenter would be running it.`,
    ],
    one_bad_day: [
      `Warm in ${warm} comments, then one very rough afternoon. We have all been there.`,
      `A sweetheart with exactly one meltdown on record.`,
      `Warm every time except once. Someone skipped their coffee.`,
      `${v} videos of kindness and a single plot twist.`,
      `One bad comment in ${n}. Statistically, a saint.`,
      `Great track record, one blip. The blip got all the attention.`,
      `Supportive since ${monthOf(st.firstAt) ?? "the start"}, with exactly one off day.`,
      `Fans are allowed one rough morning. This was theirs.`,
      `${warm} warm comments and one that does not count. Probably.`,
    ],
    comedian: [
      `Treats every comment box like an open mic. ${n} bits across ${v} videos.`,
      `Cannot resist a punchline. The creator's unofficial writers' room.`,
      `Funny first, opinions second.`,
      `${span} of one-liners. The room is still laughing.`,
      `${n} jokes, ${v} videos, no refunds.`,
      `Shows up with a bit on every upload. Some even land.`,
      `Comedy is subjective, but ${n} attempts is commitment.`,
      `Would heckle a lighthouse and make it laugh.`,
      `The comment section's resident stand-up, working the crowd since ${monthOf(st.firstAt) ?? "forever"}.`,
    ],
    reply_guy: [
      `${n} comments across just ${v} videos. Lives here now.`,
      `Has a take on a lot of videos and shares it quickly.`,
      `Turns up in thread after thread, forever.`,
      `${span} of constant commentary. Sleep is optional.`,
      `${n} comments across ${v} different videos. Sleep is optional.`,
      `Averages ${(n / Math.max(1, v)).toFixed(1)} comments per video. Quantity has a quality all its own.`,
      `If a thread exists, they are in it.`,
      `Technically a viewer, practically a co-host with ${n} contributions.`,
      `Never met a comment box they did not want to fill.`,
    ],
  };
  return [...specific[kind], ...options[kind]].filter((o) => o.length <= 140);
}

/**
 * One-liner for a persona. `used` makes verdicts unique within a result: if the preferred variant is taken, the next
 * unused one is chosen (it falls back to the preferred variant only when every variant is already used).
 */
export function templateVerdict(kind: PersonaKind, st: VerdictStats, seed = "", used?: Set<string>): string {
  const list = verdictOptions(kind, st);
  // Video-specific lines (when titles are known) come first and are preferred; generic ones are the fallback.
  const specificCount = list.length - verdictOptions(kind, { ...st, firstTitle: undefined, lastTitle: undefined, badTitle: undefined }).length;
  const start = pickVariant(seed + kind, specificCount > 0 ? specificCount : list.length);
  for (let k = 0; k < list.length; k++) {
    const text = list[(start + k) % list.length];
    if (!used || !used.has(text)) {
      used?.add(text);
      return text;
    }
  }
  return list[start];
}

/** "1. (Mar 2026, video \"Title\") comment text" lines. Numbers (not "Mar:") so the summarizer does not read a month as a name. */
export function formatTimelineForSummary(items: { t: string; text: string; videoTitle?: string }[], maxChars = 110): string {
  return items
    .map((it, i) => {
      const d = new Date(it.t);
      const when = Number.isFinite(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
      const title = it.videoTitle?.replace(/["\n]+/g, " ").trim().slice(0, 60);
      const tag = [when, title ? `video "${title}"` : ""].filter(Boolean).join(", ");
      const text = it.text.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, maxChars);
      return `${i + 1}. ${tag ? `(${tag}) ` : ""}${text}`;
    })
    .join("\n");
}

/** Name-free evidence for ScaleDown Summarize: a one-line pattern note plus a numbered, dated timeline (first and last few). */
export function personaEvidence(p: Persona, videoTitles?: ReadonlyMap<string, string>): string {
  const n = p.timeline.length;
  const pick = n <= 8 ? p.timeline : [...p.timeline.slice(0, 4), ...p.timeline.slice(n - 4)];
  const half = Math.floor(n / 2) || 1;
  const early = p.timeline.slice(0, half).reduce((a, t) => a + t.sentiment, 0) / half;
  const late = p.timeline.slice(n - half).reduce((a, t) => a + t.sentiment, 0) / half;
  const label = (x: number) => (x > 0.3 ? "warm" : x < -0.3 ? "hostile" : "mixed");
  const items = pick.map((t) => ({ t: t.t, text: t.text, videoTitle: videoTitles?.get(t.videoId) }));
  return [
    `Someone left ${p.commentCount} comments across ${p.videoCount} videos (${p.kind.replace(/_/g, " ")}). Early tone ${label(early)}, recent tone ${label(late)}.${n > 8 ? " Showing the first 4 and the last 4 comments." : ""}`,
    formatTimelineForSummary(items),
  ].join("\n");
}

const LABELS = /\b(consistent hater|hater|superfan|super fan|fans?|teas(es|ing)|reply guy|comedian|villain|redemption|persona|one bad day)\b/i;
const SECOND_PERSON = /\b(you|your|you're|you’re|yours)\b/i;
const THIRD_GENERIC = /^(this|that|the|these|those)\s+(\w+\s+)?(superfan|fan|hater|comedian|commenters?|comments?|users?|person|guy)\b/i;
const MONTH_YEAR = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,? (19|20)\d\d\b|\b20\d\d\b/i;
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|hundreds?|thousands?|twice|thrice)\b/i;
const BLAND = /\b(the|this|that) (commenter|user|person|author|individual|viewer)\b|\bsentiment\b|\bpattern of\b|\bexpress(es|ed)\b|\bcomments? (on|about|across) (the |several |multiple )?videos?\b/i;

/**
 * Accept a model-written verdict only if it is a punchy, handle-free, short sentence; null means "use the template".
 * `names` are the author's handle(s)/display name(s), checked case-insensitively with the "@" stripped.
 */
export function sanitizeVerdict(raw: string | null | undefined, names: string[], opts: { maxLen?: number; evidence?: string } = {}): string | null {
  const maxLen = opts.maxLen ?? 140;
  const text = raw?.replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "");
  if (!text || text.length < 12 || text.length > maxLen) return null;
  if (/\d/.test(text) || NUMBER_WORDS.test(text)) return null; // counts in model text are unverified
  if (/@\w/.test(text) || BLAND.test(text) || SECOND_PERSON.test(text) || LABELS.test(text) || THIRD_GENERIC.test(text) || MONTH_YEAR.test(text)) return null;
  if (!/[.!?…]$/.test(text) || text.split(" ").length < 6) return null; // a fragment is not a verdict
  if (text.split(" ").length < 5 || /^\w+,/.test(text) || /\bacross (\w+ )?videos\b/i.test(text)) return null;
  const low = text.toLowerCase();
  if (opts.evidence && !grounded(low, opts.evidence.toLowerCase())) return null;
  for (const nm of names) {
    const bare = nm.replace(/^@/, "").trim().toLowerCase();
    if (bare.length >= 3 && low.includes(bare)) return null;
  }
  return text;
}

const STOP = new Set("that this with from they them their then than have been were what when will would about into over just like very more some only also each every again still even much many".split(" "));
/** A verdict is grounded when it reuses at least one distinctive word (5+ letters) that appears in the evidence. */
function grounded(verdict: string, evidence: string): boolean {
  const norm = (x: string) => x.replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ");
  const v = norm(verdict);
  const e = norm(evidence);
  for (let i = 0; i + 24 <= v.length; i += 4) if (e.includes(v.slice(i, i + 24))) return false; // parroting a comment back
  const words = verdict.match(/[\p{L}]{5,}/gu) ?? [];
  return words.some((w) => !STOP.has(w) && evidence.includes(w.replace(/s$/, "")));
}

const COMMON_EN = new Set("the is are was were to of and in it that this you your with for not but have has had what when how why who they their there just like really very would should can will about from all been dont isnt thats im ive".split(" "));
/** Almost all Latin ASCII letters, and enough common English words. Cheap, deterministic, keeps Spanish, Turkish, Hinglish and CJK off camera. */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 8) return false;
  if (letters.filter((l) => /[A-Za-z]/.test(l)).length / letters.length < 0.97) return false;
  const words = (text.toLowerCase().replace(/['’]/g, "").match(/[a-z]+/g) ?? []).filter((w) => !/\d/.test(w));
  const hits = words.filter((w) => COMMON_EN.has(w)).length;
  return hits >= 3 && hits / Math.max(1, words.length) >= 0.25;
}
const PROFANE = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|dick\w*|cock\w*|pussy|asshole\w*|nigg\w*|fag\w*|retard\w*|slut\w*|whore\w*|bastard\w*|rape\w*|kys|kill (yourself|urself)|wtf|stfu|piss\w*|crap\w*|damn\w*|hell|ass|arse)\b/i;
/** English, no profanity, no @mention, no link: a line that can sit on screen in a recording. */
export const cameraSafe = (text: string) => looksEnglish(text) && !PROFANE.test(text) && !/[@＠]\w|https?:|www\./i.test(text);

/** The commenter who showed up on the most distinct videos (at least 3), or undefined. Copy-paste spammers are skipped. */
export function computeMostLoyal(comments: ClassifiedComment[], videos: VideoInfo[], excludeAuthorIds: string[] = []): MostLoyal | undefined {
  const skip = new Set(excludeAuthorIds);
  const by = new Map<string, ClassifiedComment[]>();
  for (const c of comments) {
    if (skip.has(c.authorId)) continue;
    const g = by.get(c.authorId);
    if (g) g.push(c);
    else by.set(c.authorId, [c]);
  }
  let best: { id: string; vids: number; list: ClassifiedComment[] } | null = null;
  for (const [id, list] of by) {
    const vids = new Set(list.map((c) => c.videoId)).size;
    if (vids < 3) continue;
    const distinct = new Set(list.map((c) => c.text.trim().toLowerCase())).size;
    if (list.length >= 6 && distinct / list.length < 0.5) continue; // same text pasted everywhere is a bot, not loyalty
    if (!eligible(dedupeTexts(list))) continue; // spam and begging are not loyalty
    if (!best || vids > best.vids || (vids === best.vids && (list.length > best.list.length || (list.length === best.list.length && id < best.id)))) {
      best = { id, vids, list };
    }
  }
  if (!best) return undefined;
  const total = Math.max(videos.length, best.vids);
  const words = (t: string) => t.trim().split(/\s+/).length;
  const decent = best.list.filter((c) => c.text.trim().length >= 8 && !isPlea(c.text));
  // A real sentence in English reads better on screen than the most-liked emoji string.
  const ranked = (decent.filter((c) => words(c.text) >= 5 && cameraSafe(c.text)).length ? decent.filter((c) => words(c.text) >= 5 && cameraSafe(c.text)) : decent).sort(
    (a, b) => b.likes - a.likes || b.text.length - a.text.length,
  );
  const head = ranked[0] ?? best.list[0];
  const withAvatar = [...best.list].reverse().find((c) => c.authorAvatar);
  const k = best.vids;
  // Be honest about HOW they showed up: a one-evening back-catalogue sweep is a binge, not a habit.
  const times = best.list.map((c) => Date.parse(c.publishedAt)).filter(Number.isFinite);
  const spanH = times.length ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : Infinity;
  const spanD = spanH / 24;
  const took = spanH < 48 ? `${Math.max(1, Math.round(spanH))} hours` : `${Math.round(spanD)} days`;
  const options =
    spanD < 7
      ? [`${k} of ${total} videos in ${took}. A binge, not a habit.`, `Worked through ${k} of ${total} videos in ${took}. Marathon, not a streak.`]
      : spanD >= 30
        ? [`${k} of ${total} videos. At this point it is a standing appointment.`, `Showed up on ${k} of the last ${total} videos. Attendance record intact.`, `Commented on ${k} of the last ${total} videos, over ${Math.round(spanD)} days. Loyalty with receipts.`]
        : [`Showed up on ${k} of the last ${total} videos. Attendance record intact.`, `Hit ${k} of ${total} uploads over ${Math.round(spanD)} days. A proper streak.`];
  return {
    authorId: best.id,
    authorName: best.list[best.list.length - 1].authorName,
    authorAvatar: withAvatar?.authorAvatar,
    videosCommented: k,
    totalVideos: total,
    commentCount: best.list.length,
    headlineComment: head.text.slice(0, 280),
    verdict: options[pickVariant(best.id, options.length)],
  };
}

export interface BuildOptions {
  perKind?: number;
  thresholds?: PersonaThresholds;
  /** When given, each author's history is ordered by VIDEO publish date, so arcs mean early videos vs recent videos. */
  videos?: Pick<VideoInfo, "id" | "publishedAt" | "title">[];
  /** Author ids to ignore, e.g. the channel's own account (a creator replying under their videos is not a fan). */
  excludeAuthorIds?: string[];
}

/** Money / help begging ("please help me", "necesito dinero"): a plea is not a personality, and roasting it on camera is unkind. */
const PLEA = /\b(please|pls|plz|kindly)\b[^.!?]{0,40}\b(help|give|send|money|dollars?)\b|\bhelp me\b|\b(need|want) (some )?(money|help|dollars?)\b|\bnecesito\b|\bdinero\b|\bgive me\b[^.!?]{0,20}\b(money|dollars?|\$)/i;
export const isPlea = (text: string) => PLEA.test(text);

/** The same text pasted again under the same video counts once (copy-paste is not volume). Keeps the first; input must be ordered. */
function dedupeTexts(group: ClassifiedComment[]): ClassifiedComment[] {
  const seen = new Set<string>();
  return group.filter((c) => {
    const k = `${c.videoId}\u0000${c.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** First ~6 normalised words: templated praise ("Your progress is a testament to...") shares one key. */
const textKey = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6).join(" ");

/**
 * Copy-paste accounts (one joke pasted under every video, template praise) are not characters: fewer than minDistinctTexts
 * distinct openings, or distinct/total below minDistinctShare. Judged on the full history, before same-video dedupe.
 */
export function botLike(group: ClassifiedComment[], th: PersonaThresholds = DEFAULT_THRESHOLDS): boolean {
  const distinct = new Set(group.map((c) => textKey(c.text))).size;
  return distinct < th.minDistinctTexts || distinct / group.length < th.minDistinctShare;
}

/** Counts shown by the bad-day slide, computed once so the headline and the verdict agree. */
export function badDayCounts(sentiments: number[], th: PersonaThresholds = DEFAULT_THRESHOLDS) {
  return { warm: sentiments.filter((x) => x > th.positive).length, rough: sentiments.filter((x) => x <= th.negative).length };
}

/** Accounts that are mostly spam or begging never become personas. */
function eligible(group: ClassifiedComment[]): boolean {
  const n = group.length;
  const spam = group.filter((c) => c.vibe === "spam").length;
  const pleas = group.filter((c) => isPlea(c.text)).length;
  return spam / n < 0.4 && pleas / n < 0.4;
}

function titlesFor(group: ClassifiedComment[], videos: Pick<VideoInfo, "id" | "title">[] | undefined) {
  if (!videos) return {};
  const t = new Map(videos.map((v) => [v.id, v.title]));
  const worst = group.reduce((m, c) => (c.sentiment < m.sentiment ? c : m), group[0]);
  const firstTitle = t.get(group[0].videoId);
  const lastTitle = t.get(group[group.length - 1].videoId);
  return { firstTitle, lastTitle: lastTitle && lastTitle !== firstTitle ? lastTitle : undefined, badTitle: t.get(worst.videoId) };
}

const minIso = (g: ClassifiedComment[]) => g.reduce((m, c) => (c.publishedAt < m ? c.publishedAt : m), g[0].publishedAt);
const maxIso = (g: ClassifiedComment[]) => g.reduce((m, c) => (c.publishedAt > m ? c.publishedAt : m), g[0].publishedAt);

export function buildPersonas(comments: ClassifiedComment[], opts: BuildOptions = {}): Persona[] {
  const th = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const perKind = opts.perKind ?? 4;
  const vd = videoDatesOf(opts.videos);
  const skip = new Set(opts.excludeAuthorIds ?? []);
  type Cand = { score: number; authorId: string; group: ClassifiedComment[]; det: Detection };
  const buckets = new Map<PersonaKind, Cand[]>();

  for (const [authorId, raw] of groupByAuthor(comments, vd)) {
    if (skip.has(authorId)) continue;
    const group = dedupeTexts(raw);
    if (!eligible(group) || botLike(raw, th)) continue;
    const det = detectPersonaKind(group, th, vd);
    if (!det) continue;
    const totalLikes = group.reduce((a, c) => a + c.likes, 0);
    const headline = pickHeadline(det.kind, group);
    // Notability: clear pattern x volume x (mildly) how much the community noticed.
    // Volume is capped so one very prolific commenter cannot bury a sharper story; the headline
    // comment's likes reward arcs the community actually noticed.
    // Superfans are ranked toward substantive comments (a long, specific compliment beats "nice"); a bad day toward the
    // nastier lapse, since the lapse is the whole story.
    const avgLen = avg(group.map((c) => Math.min(c.text.length, 120))) / 120;
    const weight = det.kind === "one_bad_day" ? 3 : 1;
    const substance = det.kind === "superfan" || det.kind === "comedian" ? 0.5 + avgLen : 1;
    const score =
      substance * (0.25 + weight * det.strength) * Math.log1p(Math.min(group.length, 30)) * (1 + 0.12 * Math.log1p(totalLikes)) * (1 + 0.2 * Math.log1p(headline.likes));
    const list = buckets.get(det.kind) ?? [];
    list.push({ score, authorId, group, det });
    buckets.set(det.kind, list);
  }

  // Headlines and verdicts are made unique across the selected personas, so no two cards repeat a line verbatim.
  const usedHeadlines = new Set<string>();
  const usedVerdicts = new Set<string>();
  const out: Persona[] = [];
  for (const kind of KIND_ORDER) {
    const list = buckets.get(kind);
    if (!list) continue;
    list.sort((a, b) => b.score - a.score || (a.authorId < b.authorId ? -1 : 1));
    for (const { authorId, group, det } of list.slice(0, perKind)) {
      const n = group.length;
      const videoCount = new Set(group.map((c) => c.videoId)).size;
      const mean = avg(group.map((c) => c.sentiment));
      const headline = pickHeadline(kind, group, usedHeadlines);
      usedHeadlines.add(headline.text.trim().toLowerCase());
      const withAvatar = [...group].reverse().find((c) => c.authorAvatar);
      out.push({
        kind,
        authorId,
        authorName: group[group.length - 1].authorName,
        authorAvatar: withAvatar?.authorAvatar,
        commentCount: n,
        videoCount,
        avgSentiment: Math.round(mean * 1000) / 1000,
        timeline: group.map((c) => ({ t: c.publishedAt, sentiment: c.sentiment, vibe: c.vibe, videoId: c.videoId, text: c.text.slice(0, 280) })),
        headlineComment: headline.text.slice(0, 280),
        verdict: templateVerdict(
          kind,
          { commentCount: n, videoCount, avgSentiment: mean, early: det.early, late: det.late, firstAt: minIso(group), lastAt: maxIso(group), ...titlesFor(group, opts.videos), warmCount: badDayCounts(group.map((c) => c.sentiment), th).warm },
          authorId,
          usedVerdicts,
        ),
      });
    }
  }
  return out;
}

export function computeTotals(comments: ClassifiedComment[]): WrappedResult["totals"] {
  const byVibe = emptyByVibe();
  const authors = new Set<string>();
  let sum = 0;
  for (const c of comments) {
    byVibe[c.vibe]++;
    authors.add(c.authorId);
    sum += c.sentiment;
  }
  return {
    comments: comments.length,
    commenters: authors.size,
    byVibe,
    avgSentiment: comments.length ? Math.round((sum / comments.length) * 1000) / 1000 : 0,
  };
}

/** Camera-safe nastiest lines: ranked by classifier confidence times a punchy length (a 30 to 140 character sentence), deduped. */
function nastiest(comments: ClassifiedComment[], n: number): ClassifiedComment[] {
  const punch = (len: number) => (len < 30 ? len / 30 : len > 140 ? Math.max(0.3, 1 - (len - 140) / 200) : 1);
  const pool = comments.filter((c) => c.vibe === "toxic" && c.text.trim().length >= 20 && c.text.length <= 280 && cameraSafe(c.text));
  const score = (c: ClassifiedComment) => c.scores.toxic * punch(c.text.trim().length) + 0.06 * Math.log1p(c.likes);
  pool.sort((a, b) => score(b) - score(a));
  const seen = new Set<string>();
  const out: ClassifiedComment[] = [];
  for (const c of pool) {
    const k = c.text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

export function topComments(comments: ClassifiedComment[], n = 5): WrappedResult["topComments"] {
  const pick = (vibe: Vibe, key: Vibe): ClassifiedComment[] => {
    const pool = comments.filter((c) => c.vibe === vibe && c.text.trim().length >= 12 && c.text.length <= 280);
    pool.sort((a, b) => b.scores[key] + 0.04 * Math.log1p(b.likes) - (a.scores[key] + 0.04 * Math.log1p(a.likes)));
    const seen = new Set<string>();
    const out: ClassifiedComment[] = [];
    for (const c of pool) {
      const k = c.text.trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
      if (out.length >= n) break;
    }
    return out;
  };
  return { funniest: pick("funny", "funny"), nastiest: nastiest(comments, n), sweetest: pick("supportive", "supportive") };
}

export function perVideoStats(comments: ClassifiedComment[], videos: VideoInfo[]): WrappedResult["perVideo"] {
  const acc = new Map<string, { sum: number; n: number; byVibe: Record<Vibe, number> }>();
  for (const c of comments) {
    let a = acc.get(c.videoId);
    if (!a) {
      a = { sum: 0, n: 0, byVibe: emptyByVibe() };
      acc.set(c.videoId, a);
    }
    a.sum += c.sentiment;
    a.n++;
    a.byVibe[c.vibe]++;
  }
  return videos.map((v) => {
    const a = acc.get(v.id);
    return { videoId: v.id, avgSentiment: a && a.n ? Math.round((a.sum / a.n) * 1000) / 1000 : 0, byVibe: a ? a.byVibe : emptyByVibe() };
  });
}

export { VIBES };
