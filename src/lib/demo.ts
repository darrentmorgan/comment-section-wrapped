// Deterministic synthetic data for DEMO MODE. Fictional creator ("Pixel & Pine"), fictional commenters.
// Same seed => byte-identical output, so recordings are repeatable.
import type { ClassifiedComment, VideoInfo, Vibe, WrappedResult } from "./types";
import { VIBES, sentimentFromScores } from "./vibes";
import {
  BAD_DAY_APOLOGY,
  BAD_DAY_LINES,
  COMEDIANS,
  EXTRA_TOPICS,
  GENERIC,
  HATER_LINES,
  REDEMPTION_EARLY,
  REDEMPTION_LATE,
  REDEMPTION_MID,
  RHONDA_LINES,
  SUFFIXES,
  SUPERFAN_LINES,
  VILLAIN_EARLY,
  VILLAIN_LATE,
  VILLAIN_MID,
  VILLAIN_SIGNATURES,
  WARM_LINES,
  WENDELL_LINES,
} from "./demo-text";

export const DEMO_SEED = 20261014;
export const DEMO_VIDEO_COUNT = 30;

export interface DemoOptions {
  seed?: number;
  maxVideos?: number;
  /** Demo simulates a big channel; caps >= 500 are ignored. Smaller caps are honoured for quick runs, floored at 10 like live mode. */
  maxCommentsPerVideo?: number;
}

export interface DemoData {
  channel: WrappedResult["channel"];
  videos: VideoInfo[]; // newest first
  comments: ClassifiedComment[]; // oldest first
}

// ------------------------------------------------------------------ rng
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T,>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function shuffle<T>(r: Rng, a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
function weighted<T extends string>(r: Rng, w: Record<T, number>): T {
  const keys = Object.keys(w) as T[];
  let total = 0;
  for (const k of keys) total += w[k];
  let x = r() * total;
  for (const k of keys) {
    x -= w[k];
    if (x <= 0) return k;
  }
  return keys[keys.length - 1];
}

// ------------------------------------------------------------------ channel + videos
interface VideoDef {
  title: string;
  topic: string;
  heat: number; // extra negativity in this video's comment section
  pop: number; // relative popularity
}
const VIDEO_DEFS: VideoDef[] = [
  { title: "I Built a Desk Setup Under $500", topic: "this desk setup", heat: 0.04, pop: 1.0 },
  { title: "The Minimalist Phone Challenge (30 Days)", topic: "the minimalist phone", heat: 0.04, pop: 0.9 },
  { title: "Honest Review: The $1,200 Mechanical Keyboard", topic: "this keyboard", heat: 0.1, pop: 1.2 },
  { title: "I Lived in a Van for a Week (Never Again)", topic: "the van", heat: 0.05, pop: 1.3 },
  { title: "My Morning Routine Is a Lie", topic: "your morning routine", heat: 0.08, pop: 1.0 },
  { title: "Testing Viral Kitchen Gadgets So You Don't Have To", topic: "these gadgets", heat: 0.05, pop: 1.1 },
  { title: "Why I Quit Social Media for 60 Days", topic: "the social media detox", heat: 0.06, pop: 1.0 },
  { title: "The Ultimate Cable Management Guide", topic: "cable management", heat: 0.03, pop: 0.8 },
  { title: "I Tried Every Note-Taking App", topic: "note apps", heat: 0.05, pop: 0.9 },
  { title: "Smart Home Disasters (Compilation)", topic: "the smart home", heat: 0.04, pop: 1.3 },
  { title: "Rating Strangers' Desk Setups", topic: "these desk setups", heat: 0.08, pop: 1.1 },
  { title: "Budget Camera vs Cinema Camera", topic: "the cheap camera", heat: 0.07, pop: 1.0 },
  { title: "I Gave My Apartment a $0 Makeover", topic: "the zero-dollar makeover", heat: 0.05, pop: 1.0 },
  { title: "The Standing Desk Lie", topic: "the standing desk", heat: 0.22, pop: 1.4 },
  { title: "Cooking With Only Airport Food", topic: "airport cooking", heat: 0.05, pop: 1.2 },
  { title: "My Productivity System (V7)", topic: "this productivity system", heat: 0.09, pop: 1.0 },
  { title: "AI Gadgets That Should Not Exist", topic: "these AI gadgets", heat: 0.12, pop: 1.5 },
  { title: "Switching to Linux for 30 Days", topic: "Linux", heat: 0.1, pop: 1.1 },
  { title: "Building the Perfect Backpack", topic: "the perfect backpack", heat: 0.05, pop: 0.9 },
  { title: "Reacting to My First Ever Video", topic: "my first video", heat: 0.04, pop: 1.3 },
  { title: "Sponsored: This VPN Changed My Life (Not Really)", topic: "the VPN", heat: 0.45, pop: 1.6 },
  { title: "Q&A: Your Weirdest Questions", topic: "the Q&A", heat: 0.06, pop: 1.0 },
  { title: "I Spent $5,000 on Desk Lamps", topic: "the lamps", heat: 0.12, pop: 1.2 },
  { title: "Trying the Strangest Vending Machines", topic: "the vending machines", heat: 0.04, pop: 1.3 },
  { title: "The Truth About My Channel Growth", topic: "the channel growth", heat: 0.28, pop: 1.5 },
  { title: "Retro Tech Tier List", topic: "retro tech", heat: 0.12, pop: 1.4 },
  { title: "I Fixed My Sleep In 14 Days", topic: "the sleep fix", heat: 0.06, pop: 1.1 },
  { title: "Home Office Tour 2026", topic: "this home office", heat: 0.08, pop: 1.3 },
  { title: "Why I Haven't Uploaded (Update)", topic: "the hiatus", heat: 0.4, pop: 1.5 },
  { title: "The Setup I Always Wanted", topic: "this dream setup", heat: 0.07, pop: 1.6 },
];

const BASE_DATE = Date.UTC(2026, 9, 2, 14, 0, 0); // newest upload
const DAY = 86_400_000;
const videoDate = (idx: number) => BASE_DATE - (VIDEO_DEFS.length - 1 - idx) * 7 * DAY; // idx 0 = oldest

function svgUri(svg: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function avatarFor(hue: number) {
  return svgUri(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue},85%,62%)'/><stop offset='1' stop-color='hsl(${(hue + 50) % 360},80%,42%)'/></linearGradient></defs><rect width='64' height='64' fill='url(#g)'/><circle cx='32' cy='25' r='11' fill='white' fill-opacity='.88'/><ellipse cx='32' cy='60' rx='21' ry='17' fill='white' fill-opacity='.88'/></svg>`,
  );
}
const AVATARS = Array.from({ length: 36 }, (_, i) => avatarFor(i * 10));

function thumbnailFor(idx: number, title: string) {
  const h = (idx * 37) % 360;
  const words = title.replace(/[^\w\s$'&-]/g, "").split(/\s+/).slice(0, 3).join(" ").toUpperCase();
  return svgUri(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},80%,52%)'/><stop offset='1' stop-color='hsl(${(h + 70) % 360},75%,28%)'/></linearGradient></defs><rect width='320' height='180' fill='url(#g)'/><circle cx='250' cy='60' r='58' fill='white' fill-opacity='.12'/><text x='16' y='112' font-family='Impact,Arial Black,sans-serif' font-size='34' fill='white' stroke='black' stroke-width='1.5'>${esc(words)}</text><text x='16' y='160' font-family='Arial,sans-serif' font-size='14' fill='white' fill-opacity='.8'>PIXEL &amp; PINE</text></svg>`,
  );
}

const CHANNEL: WrappedResult["channel"] = {
  id: "UCdemoPixelAndPine0001xx",
  title: "Pixel & Pine",
  handle: "@pixelandpine",
  avatar: svgUri(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#34d399'/><stop offset='1' stop-color='#6366f1'/></linearGradient></defs><rect width='64' height='64' fill='url(#g)'/><text x='32' y='41' text-anchor='middle' font-family='Arial Black,sans-serif' font-size='24' fill='white'>P+P</text></svg>`,
  ),
  subscriberCount: 1_240_000,
};

// ------------------------------------------------------------------ text
const SIGN_PUNCT = [".", "!", ""];
function fillSlots(r: Rng, tpl: string, topic: string): string {
  return tpl
    .replace(/\{t\}/g, topic)
    .replace(/\{ts\}/g, () => `${int(r, 0, 14)}:${String(int(r, 0, 59)).padStart(2, "0")}`)
    .replace(/\{x\}/g, () => pick(r, EXTRA_TOPICS));
}
/** Make a template read like a human typed it on a phone. */
function humanize(r: Rng, s: string, vibe: Vibe): string {
  let out = s;
  const x = r();
  if (x < 0.14) out = out.charAt(0).toLowerCase() + out.slice(1);
  if (r() < 0.22 && vibe !== "spam") out = out.replace(/[.!]$/, "");
  if (r() < 0.05 && vibe !== "spam") out = out.toLowerCase();
  if (r() < 0.04) out = out.replace(/\s+/g, " ").replace(/ you /g, " u ");
  if (r() < 0.45 && /[a-z0-9)]$/i.test(out) && vibe !== "spam") out += pick(r, SIGN_PUNCT);
  if (vibe !== "toxic" && vibe !== "critical" && vibe !== "spam") out += pick(r, SUFFIXES);
  return out;
}
function genericText(r: Rng, vibe: Vibe, topic: string): string {
  return humanize(r, fillSlots(r, pick(r, GENERIC[vibe]), topic), vibe);
}

// ------------------------------------------------------------------ scores
const ADJ: Record<Vibe, Partial<Record<Vibe, number>>> = {
  toxic: { critical: 0.5, funny: 0.15, spam: 0.1, question: 0.05, supportive: 0.02 },
  critical: { toxic: 0.3, question: 0.3, supportive: 0.2, funny: 0.1, spam: 0.05 },
  supportive: { funny: 0.35, question: 0.2, critical: 0.1, spam: 0.05, toxic: 0.02 },
  funny: { supportive: 0.35, toxic: 0.15, critical: 0.15, question: 0.1, spam: 0.05 },
  question: { critical: 0.3, supportive: 0.25, funny: 0.1, spam: 0.2, toxic: 0.02 },
  spam: { question: 0.3, supportive: 0.3, funny: 0.1, critical: 0.1, toxic: 0.05 },
};
function synthScores(r: Rng, vibe: Vibe): Record<Vibe, number> {
  const top = 0.98 - 0.45 * Math.pow(r(), 2.2); // mostly confident, a few mushy
  const rest = 1 - top;
  const out = {} as Record<Vibe, number>;
  let wsum = 0;
  const w = {} as Record<Vibe, number>;
  for (const v of VIBES) {
    if (v === vibe) continue;
    w[v] = (ADJ[vibe][v] ?? 0.05) * (0.3 + r());
    wsum += w[v];
  }
  for (const v of VIBES) out[v] = v === vibe ? top : Math.round((rest * w[v]) / wsum * 10000) / 10000;
  out[vibe] = Math.round((1 - VIBES.filter((v) => v !== vibe).reduce((a, v) => a + out[v], 0)) * 10000) / 10000;
  return out;
}

// ------------------------------------------------------------------ cast
interface Draft {
  authorKey: string; // index into authors
  videoIdx: number;
  vibe: Vibe;
  text: string;
  likes: number;
  offsetH: number;
}
interface Author {
  id: string;
  name: string;
  hue: number;
}

const ADJECTIVES = ["quiet", "sleepy", "toasted", "cosmic", "salty", "lucky", "wobbly", "sunny", "frosty", "dizzy", "mellow", "fuzzy", "rusty", "spicy", "gentle", "crispy", "lazy", "bouncy", "grumpy", "velvet", "neon", "mossy", "jolly", "tiny", "turbo", "sneaky", "pixel", "analog", "cheeky", "humble", "electric", "dusty", "bubbly", "clumsy", "breezy", "cranky", "midnight", "marble", "patient", "stormy"];
const NOUNS = ["pigeon", "waffle", "otter", "turnip", "badger", "pickle", "walrus", "muffin", "kettle", "gecko", "noodle", "cactus", "penguin", "biscuit", "llama", "lantern", "pretzel", "hedgehog", "toaster", "marmot", "pancake", "owl", "sparrow", "teapot", "mango", "beetle", "falcon", "donut", "yeti", "carrot", "raccoon", "meerkat", "olive", "pebble", "ferret", "gadget", "comet", "puffin", "dumpling", "sprout"];

function makeHandle(r: Rng, taken: Set<string>): string {
  for (;;) {
    const a = pick(r, ADJECTIVES);
    const n = pick(r, NOUNS);
    const num = int(r, 1, 99);
    const style = int(r, 0, 7);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const h =
      style === 0 ? `@${a}${cap(n)}${num}` :
      style === 1 ? `@${a}_${n}` :
      style === 2 ? `@${n}${num}` :
      style === 3 ? `@${cap(a)}${cap(n)}` :
      style === 4 ? `@${a}.${n}${int(r, 0, 9)}` :
      style === 5 ? `@${n}_${a}_${num}` :
      style === 6 ? `@the${cap(n)}${num}` :
      `@${a}${n}${int(r, 2005, 2024) % 100}`;
    if (!taken.has(h)) {
      taken.add(h);
      return h;
    }
  }
}

type Profile = "mixed" | "warm" | "joker" | "critic" | "asker" | "grump" | "spammer";
const PROFILE_W: Record<Profile, number> = { mixed: 70, warm: 11, joker: 6, critic: 5, asker: 5, grump: 2, spammer: 1 };
const BASE_VIBE: Record<Vibe, number> = { supportive: 40, funny: 17, question: 15, critical: 11, toxic: 4, spam: 7 };
const PROFILE_BIAS: Record<Profile, Partial<Record<Vibe, number>>> = {
  mixed: {},
  warm: { supportive: 55, funny: 8, question: 8, critical: 3, toxic: 0.4, spam: 1 },
  joker: { funny: 52, supportive: 18, question: 6, critical: 6, toxic: 2, spam: 1 },
  critic: { critical: 45, question: 14, supportive: 14, funny: 8, toxic: 5, spam: 1 },
  asker: { question: 52, supportive: 18, funny: 6, critical: 8, toxic: 1, spam: 2 },
  grump: { toxic: 32, critical: 26, funny: 10, supportive: 6, question: 6, spam: 1 },
  spammer: { spam: 70, question: 10, supportive: 10, funny: 5, critical: 2, toxic: 1 },
};
const COUNT_BANDS: [number, number, number][] = [
  [0.18, 1, 1],
  [0.32, 2, 2],
  [0.44, 3, 3],
  [0.54, 4, 4],
  [0.66, 5, 6],
  [0.8, 7, 9],
  [0.95, 10, 13],
  [1, 14, 17],
];

const likesBg = (r: Rng, vibe: Vibe) => {
  let l = Math.max(0, Math.floor(Math.exp(gauss(r) * 1.5 - 0.2)) - 1);
  if (vibe === "funny") l = Math.floor(l * 2.8);
  if (vibe === "spam") l = Math.floor(l * 0.1);
  if (r() < 0.002) l += int(r, 300, 1800);
  return l;
};

export function generateDemo(opts: DemoOptions = {}): DemoData {
  const r = mulberry32(opts.seed ?? DEMO_SEED);
  const nVideos = Math.max(1, Math.min(DEMO_VIDEO_COUNT, opts.maxVideos ?? DEMO_VIDEO_COUNT));
  const firstVideo = DEMO_VIDEO_COUNT - nVideos;
  // The channel's comment sections cool off over time: base heat is toned down and a steady ramp is added, so the
  // per-video chart really trends colder from the oldest to the newest upload (spikes like the VPN video stay).
  const vids = VIDEO_DEFS.map((d, i) => ({ ...d, idx: i, heat: d.heat * 0.55 + 0.34 * Math.pow(i / (VIDEO_DEFS.length - 1), 1.35) }));
  const inRange = (i: number) => i >= firstVideo && i < DEMO_VIDEO_COUNT;

  const authors: Author[] = [];
  const taken = new Set<string>();
  const newAuthor = (name?: string): string => {
    const key = String(authors.length);
    const handle = name ?? makeHandle(r, taken);
    if (name) taken.add(name);
    authors.push({ id: `UCdemo${authors.length.toString(36).padStart(4, "0")}${Math.floor(r() * 36 ** 8).toString(36).padStart(8, "0")}`, name: handle, hue: int(r, 0, 35) });
    return key;
  };
  const drafts: Draft[] = [];

  // ---------- scripted storylines (the recordable cast)
  // Draw from a shuffled deck that persists across calls, so different characters do not reuse the same lines
  // until the whole pool has been dealt.
  const decks = new Map<readonly unknown[], unknown[]>();
  const take = <T,>(pool: readonly T[], n: number, rr: Rng): T[] => {
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      let deck = decks.get(pool) as T[] | undefined;
      if (!deck || deck.length === 0) {
        deck = shuffle(rr, [...pool]);
        decks.set(pool, deck);
      }
      out.push(deck.pop()!);
    }
    return out;
  };
  const add = (key: string, videoIdx: number, vibe: Vibe, rawText: string, likes: number, offsetH?: number) => {
    if (!inRange(videoIdx)) return;
    drafts.push({ authorKey: key, videoIdx, vibe, text: humanizeLight(r, fillSlots(r, rawText, vids[videoIdx].topic)), likes, offsetH: offsetH ?? 1 + r() * 40 });
  };
  const humanizeLight = (rr: Rng, s: string) => (rr() < 0.25 ? s.replace(/[.!]$/, "") : s);

  // Villain arcs: warm early, hostile after the sponsor video.
  const villains: { h: string; early: number[]; mid: number[]; late: number[] }[] = [
    { h: "@DesktopDave2019_demo", early: [0, 1, 3, 4, 6, 8], mid: [11, 13], late: [16, 18, 20, 21, 23, 26, 28] },
    { h: "@cozy_cathode_demo", early: [1, 2, 4, 5, 7, 9], mid: [14], late: [20, 22, 24, 25, 27, 29] },
    { h: "@NightOwlNorbert_demo", early: [0, 2, 3, 5, 8], mid: [12, 15], late: [17, 19, 21, 24, 26, 28] },
    { h: "@sunny_side_sam_demo", early: [2, 3, 4, 6, 7, 10], mid: [], late: [15, 18, 22, 23, 27, 29] },
    { h: "@LoyalLlamaLuigi_demo", early: [0, 1, 2, 4, 5], mid: [10], late: [19, 20, 24, 26, 28] },
  ];
  for (const v of villains) {
    const key = newAuthor(v.h);
    const sig = VILLAIN_SIGNATURES[v.h];
    const early = take(VILLAIN_EARLY, v.early.length, r);
    // each villain's signature lines always appear
    early[0] = sig.early[0];
    const late = take(VILLAIN_LATE, v.late.length, r);
    late[late.length - 1] = sig.late[0];
    const mid = take(VILLAIN_MID, v.mid.length, r);
    v.early.forEach((vi, i) => add(key, vi, i % 5 === 4 ? "funny" : "supportive", early[i], int(r, 12, 260)));
    v.mid.forEach((vi, i) => add(key, vi, "critical", mid[i], int(r, 3, 40)));
    v.late.forEach((vi, i) => add(key, vi, "toxic", late[i], int(r, 8, 190)));
  }

  // Redemption arcs: nasty early, wholesome late.
  const redemptions: { h: string; early: number[]; mid: number[]; late: number[] }[] = [
    { h: "@GrumpyGordon_77_demo", early: [0, 2, 3, 5, 6], mid: [9, 12], late: [16, 19, 22, 25, 28] },
    { h: "@TheDoubtingThomasina_demo", early: [1, 2, 4, 7], mid: [11], late: [14, 18, 21, 24, 27] },
    { h: "@ironic_ingrid_demo", early: [0, 3, 4, 6, 8], mid: [10, 13], late: [17, 20, 23, 26, 29] },
  ];
  for (const v of redemptions) {
    const key = newAuthor(v.h);
    take(REDEMPTION_EARLY, v.early.length, r).forEach((t, i) => add(key, v.early[i], i === 2 ? "critical" : "toxic", t, int(r, 2, 60)));
    take(REDEMPTION_MID, v.mid.length, r).forEach((t, i) => add(key, v.mid[i], "critical", t, int(r, 5, 80)));
    take(REDEMPTION_LATE, v.late.length, r).forEach((t, i) => add(key, v.late[i], "supportive", t, int(r, 20, 340)));
  }

  // Superfans: a comment on (almost) every video.
  for (const h of ["@everyvideo_eddie_demo", "@PineconePriya_demo", "@first_like_felix_demo", "@MamaBear_Maureen_demo"]) {
    const key = newAuthor(h);
    const vs = shuffle(r, Array.from({ length: DEMO_VIDEO_COUNT }, (_, i) => i)).slice(0, int(r, 20, 27)).sort((a, b) => a - b);
    const lines = take(SUPERFAN_LINES, vs.length, r);
    vs.forEach((vi, i) => add(key, vi, i % 7 === 3 ? "funny" : "supportive", lines[i], int(r, 30, 600), 0.3 + r() * 3));
  }

  // Consistent haters.
  for (const h of ["@actually_um_gary_demo", "@NegativeNancy_01_demo", "@ratio_rick_demo"]) {
    const key = newAuthor(h);
    const vs = shuffle(r, Array.from({ length: DEMO_VIDEO_COUNT }, (_, i) => i)).slice(0, int(r, 13, 19)).sort((a, b) => a - b);
    const lines = take(HATER_LINES, vs.length, r);
    vs.forEach((vi, i) => add(key, vi, i % 4 === 3 ? "critical" : "toxic", lines[i], int(r, 0, 45)));
  }

  // One bad day: lovely, then a single meltdown, then an apology.
  const badDays: { h: string; day: number }[] = [
    { h: "@sweetpea_susan_demo", day: 13 },
    { h: "@GentleGiant_Gabe_demo", day: 20 },
    { h: "@ZenDenise_demo", day: 24 },
  ];
  badDays.forEach((b, n) => {
    const key = newAuthor(b.h);
    const others = [1, 3, 4, 6, 8, 10, 12, 16, 18, 22, 26, 28].filter((v) => v !== b.day && v !== b.day + 1).slice(n, n + 8);
    take(WARM_LINES, others.length, r).forEach((t, i) => add(key, others[i], "supportive", t, int(r, 3, 70)));
    add(key, b.day, "toxic", BAD_DAY_LINES[n % BAD_DAY_LINES.length], int(r, 30, 180));
    add(key, Math.min(29, b.day + 1), "supportive", BAD_DAY_APOLOGY[n % 2], int(r, 60, 400));
  });

  // Comedians: bits everywhere.
  for (const c of COMEDIANS) {
    const key = newAuthor(c.handle);
    const vs = shuffle(r, Array.from({ length: DEMO_VIDEO_COUNT }, (_, i) => i)).slice(0, int(r, 13, 18)).sort((a, b) => a - b);
    const lines = [...shuffle(r, c.lines), ...shuffle(r, [...GENERIC.funny])];
    vs.forEach((vi, i) => add(key, vi, "funny", lines[i], int(r, 25, 900)));
  }

  // Reply guys: many comments per video, replying to everything.
  {
    const key = newAuthor("@well_actually_wendell_demo");
    let n = 0;
    // Stay within the line pool (about 1.2 uses per line at most): a pasted-everywhere account is filtered as a bot.
    for (let vi = 0; vi < 16; vi++) {
      const k = int(r, 1, 2);
      for (let j = 0; j < k; j++) {
        const line = WENDELL_LINES[n++ % WENDELL_LINES.length];
        add(key, vi, line.vibe, line.text, int(r, 0, 6), 0.2 + r() * 4 + j * 6);
      }
    }
  }
  {
    const key = newAuthor("@reply_all_rhonda_demo");
    let n = 3;
    for (let vi = 1; vi < 16; vi++) {
      const k = int(r, 1, 2);
      for (let j = 0; j < k; j++) {
        const line = RHONDA_LINES[n++ % RHONDA_LINES.length];
        add(key, vi, line.vibe, line.text, int(r, 0, 12), 0.5 + r() * 5 + j * 8);
      }
    }
  }
  const scriptedAuthors = authors.length;

  // ---------- background crowd
  const TARGET_AUTHORS = 6500;
  const popWeights = vids.map((v) => v.pop);
  for (let a = scriptedAuthors; a < TARGET_AUTHORS; a++) {
    const key = newAuthor();
    const profile = weighted(r, PROFILE_W);
    const bias = { ...BASE_VIBE, ...PROFILE_BIAS[profile] } as Record<Vibe, number>;
    const base: Record<Vibe, number> = profile === "mixed" ? { ...BASE_VIBE } : bias;
    const x = r();
    const band = COUNT_BANDS.find((b) => x <= b[0])!;
    // joined the channel at some point; later joiners only exist for later videos
    const start = r() < 0.5 ? 0 : Math.floor(Math.pow(r(), 1.3) * (DEMO_VIDEO_COUNT - 3));
    const pool = Array.from({ length: DEMO_VIDEO_COUNT - start }, (_, i) => start + i);
    let n = Math.min(int(r, band[1], band[2]), pool.length);
    // weighted sample w/o replacement by popularity
    const chosen: number[] = [];
    const bag = pool.map((vi) => ({ vi, w: popWeights[vi] * (0.4 + r()) }));
    bag.sort((p, q) => q.w - p.w);
    while (n-- > 0 && bag.length) chosen.push(bag.shift()!.vi);
    for (const vi of chosen) {
      if (!inRange(vi)) continue;
      const heat = vids[vi].heat;
      const w = { ...base };
      w.supportive *= 1 - heat * 1.3;
      w.critical *= 1 + heat * 4;
      w.toxic *= 1 + heat * 6;
      const vibe = weighted(r, w);
      drafts.push({
        authorKey: key,
        videoIdx: vi,
        vibe,
        text: genericText(r, vibe, vids[vi].topic),
        likes: likesBg(r, vibe),
        offsetH: -Math.log(1 - r() * 0.98) * 14 + 0.1, // most comments land in the first day
      });
    }
  }

  // ---------- materialise
  const cap = opts.maxCommentsPerVideo !== undefined && opts.maxCommentsPerVideo < 500 ? Math.max(10, Math.floor(opts.maxCommentsPerVideo) || 10) : Infinity;
  const perVid = new Map<number, number>();
  const ordered = drafts
    .map((d) => ({ d, t: videoDate(d.videoIdx) + d.offsetH * 3_600_000 }))
    .sort((p, q) => p.t - q.t || (p.d.authorKey < q.d.authorKey ? -1 : 1));
  const comments: ClassifiedComment[] = [];
  const shortId = (i: number) => `pp${i.toString(36).padStart(9, "0")}`;
  for (const { d, t } of ordered) {
    const used = perVid.get(d.videoIdx) ?? 0;
    if (used >= cap) continue;
    perVid.set(d.videoIdx, used + 1);
    const au = authors[Number(d.authorKey)];
    const scores = synthScores(r, d.vibe);
    comments.push({
      id: `dc_${comments.length.toString(36)}`,
      videoId: shortId(d.videoIdx),
      authorId: au.id,
      authorName: au.name,
      authorAvatar: AVATARS[au.hue],
      text: d.text,
      likes: d.likes,
      publishedAt: new Date(t).toISOString(),
      vibe: d.vibe,
      scores,
      sentiment: sentimentFromScores(scores),
    });
  }

  const videos: VideoInfo[] = [];
  for (let i = DEMO_VIDEO_COUNT - 1; i >= firstVideo; i--) {
    videos.push({
      id: shortId(i),
      title: vids[i].title,
      publishedAt: new Date(videoDate(i)).toISOString(),
      thumbnail: thumbnailFor(i, vids[i].title),
      commentCount: perVid.get(i) ?? 0,
    });
  }
  return { channel: { ...CHANNEL }, videos, comments };
}
