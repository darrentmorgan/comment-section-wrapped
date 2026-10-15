import type { ClassifiedComment, Persona, PersonaKind, ProgressEvent, VideoInfo, Vibe, WrappedResult } from "@/lib/types";

// Dev/demo-only fake stream. Every name here is fictional.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const TEXTS: Record<Vibe, string[]> = {
  supportive: [
    "this is the only channel that makes my Mondays survivable",
    "the way you explain this is unreal, saved me a whole semester",
    "crying at the ending, why am I crying at a video about toasters",
    "I've watched this four times and found a new joke every time",
    "never stop making these",
    "ok but the editing deserves its own award",
    "my dad and I watch every upload together. thank you",
    "the best 14 minutes of my week",
  ],
  funny: [
    "I came for the toaster review and stayed for the emotional damage",
    "the sponsor read was longer than my last relationship",
    "who edits this?? give them a raise or at least a snack",
    "me explaining to my boss why I'm crying laughing at 3pm",
    "bro really said 'trust me' and then set the kitchen on fire",
    "the cat in the background is the real star, change my mind",
    "this video has the energy of a raccoon in a Costco",
    "plot twist: the thumbnail was the best part",
  ],
  question: [
    "what's the song at 6:42??",
    "does this work with the older model or only the 2025 one?",
    "where did you get that jacket",
    "wait is this a sequel to the one from March?",
    "can you do a version for beginners",
    "what camera are you using for the close-ups",
  ],
  critical: [
    "feels like the first half could have been cut in half tbh",
    "the audio is a bit low compared to your older stuff",
    "honestly the old format was better",
    "mid episode. the setup was cooler than the payoff",
    "too many ads lately, the vibe is shifting",
    "this felt rushed, you usually go deeper",
  ],
  toxic: [
    "this is the worst thing I've watched all year, delete the channel",
    "you have the charisma of a damp sock",
    "nobody asked for this. quit while you're ahead",
    "unsubbed. the whole team is clearly out of ideas and out of talent",
    "can't believe people actually pay you to do this",
    "cringe. just cringe. every second of it",
  ],
  spam: [
    "check my profile for free giftcards!!",
    "first",
    "SUBSCRIBE to my channel and I'll sub back 100%",
    "who's watching in 2026 drop a like",
    "make $500 a day from home, DM me",
    "nice video. visit my page for more",
  ],
};

const BASE_SENT: Record<Vibe, number> = { supportive: 0.82, funny: 0.55, question: 0.15, critical: -0.42, toxic: -0.88, spam: -0.05 };
const ADJ = ["velvet", "neon", "sleepy", "cosmic", "crispy", "lunar", "salty", "turbo", "mellow", "feral", "glitter", "paper", "quiet", "pixel", "wobbly", "mango"];
const NOUN = ["toaster", "wombat", "noodle", "pigeon", "comet", "pickle", "badger", "waffle", "goblin", "otter", "biscuit", "lantern", "muffin", "kettle", "yeti"];

const TITLES = [
  "I Tested 40 Toasters Until One Caught Fire",
  "The Cheapest Espresso Machine Is a Crime",
  "Rebuilding My Grandmother's Kitchen in 48 Hours",
  "Why Every Air Fryer Lies to You",
  "We Mailed a Brick to Strangers and Asked for Reviews",
  "The Blender That Shouldn't Exist",
  "Ranking Every Kettle by Vibes Alone",
  "Kitchen Gadgets From 2 AM Infomercials",
  "I Lived on Gas Station Sushi for a Week",
  "The Great Waffle Iron Cover-Up",
  "Can a $12 Knife Beat a $400 One?",
  "Our Studio Flooded. Here's What Survived",
  "Ice Cream Machines: A Betrayal in Four Acts",
  "Trying the World's Loudest Microwave",
  "We Asked 100 Chefs About Garlic Presses",
  "The Slow Cooker Conspiracy",
  "Unboxing a Mystery Pallet of Returns",
  "Toast Science (Please Be Normal About It)",
  "The Sponsor Segment That Went Too Far",
  "I Fixed Everything Wrong With My Oven",
  "Podcast Setup Tour: Chaos Edition",
  "Is Cast Iron a Personality Disorder?",
  "Rice Cookers, Ranked and Roasted",
  "We Quit Our Jobs for This Toaster",
  "The Smoothie That Fought Back",
  "Behind the Scenes: Why We Reshoot Everything",
  "Fridge Tour: Day 300",
  "Q&A: Yes, We Read the Comments",
  "The Last Toaster Review (For Real This Time)",
  "Everything Is a Toaster Now",
];

function makeComment(rng: () => number, id: string, vibe: Vibe, videoId: string, name: string, text: string, likes: number, publishedAt: string, sentiment?: number): ClassifiedComment {
  const scores = { toxic: 0.02, critical: 0.02, supportive: 0.02, funny: 0.02, question: 0.02, spam: 0.02 } as Record<Vibe, number>;
  const main = 0.78 + rng() * 0.18;
  scores[vibe] = main;
  const rest = (1 - main - 0.1) / 1;
  const other = (Object.keys(scores) as Vibe[])[Math.floor(rng() * 6)];
  if (other !== vibe) scores[other] += Math.max(0, rest);
  const sum = Object.values(scores).reduce((a, b) => a + b, 0);
  (Object.keys(scores) as Vibe[]).forEach((k) => (scores[k] = +(scores[k] / sum).toFixed(4)));
  return {
    id,
    videoId,
    authorId: `mock-${name}`,
    authorName: name,
    text,
    likes,
    publishedAt,
    vibe,
    scores,
    sentiment: sentiment ?? Math.max(-1, Math.min(1, BASE_SENT[vibe] + (rng() - 0.5) * 0.3)),
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function handle(rng: () => number) {
  const n = rng() < 0.4 ? String(Math.floor(rng() * 99)) : "";
  return `@${pick(rng, ADJ)}_${pick(rng, NOUN)}${n}`;
}

const MIX: [Vibe, number][] = [
  ["supportive", 0.34],
  ["funny", 0.16],
  ["question", 0.12],
  ["critical", 0.17],
  ["toxic", 0.09],
  ["spam", 0.12],
];

function pickVibe(rng: () => number, toxicBias = 0): Vibe {
  let r = rng();
  for (const [v, w] of MIX) {
    const ww = v === "toxic" ? w + toxicBias : v === "supportive" ? w - toxicBias : w;
    if (r < ww) return v;
    r -= ww;
  }
  return "supportive";
}

function sampleBatch(rng: () => number, n: number, videos: VideoInfo[], progress: number): ClassifiedComment[] {
  return Array.from({ length: n }, (_, i) => {
    const v = pickVibe(rng, progress * 0.05);
    const vid = pick(rng, videos);
    return makeComment(rng, `s${Math.floor(rng() * 1e9)}-${i}`, v, vid.id, handle(rng), pick(rng, TEXTS[v]), Math.floor(rng() ** 3 * 400), vid.publishedAt);
  });
}

type Seed = [number, number, Vibe, string]; // video idx, sentiment, vibe, text

const VILLAIN: Seed[] = [
  [1, 0.92, "supportive", "okay this is the best thing on YouTube right now, subscribed instantly"],
  [4, 0.86, "supportive", "the editing in this one?? genuinely unreal, you guys are cooking"],
  [7, 0.72, "supportive", "been rewatching the intro for ten minutes. so good"],
  [10, 0.4, "critical", "good episode but the sponsor read was a bit long ngl"],
  [14, 0.02, "critical", "idk it feels like the old videos had more heart"],
  [18, -0.32, "critical", "this is just a worse version of your own video from last year"],
  [22, -0.58, "critical", "do you even read the comments or just chase the algorithm now"],
  [26, -0.82, "toxic", "unsubscribed. this channel peaked and everyone knows it"],
  [29, -0.94, "toxic", "honestly embarrassing how far you've fallen. delete this"],
];
const REDEMPTION: Seed[] = [
  [2, -0.9, "toxic", "first video I've seen and it's trash. who is this for"],
  [6, -0.78, "toxic", "still bad. the host is insufferable"],
  [11, -0.45, "critical", "ok the kettle thing was kind of clever, doesn't change my mind though"],
  [16, -0.05, "critical", "fine. I laughed once. ONCE"],
  [21, 0.4, "funny", "the cast iron bit got me, why am I still watching this"],
  [25, 0.74, "supportive", "I can't believe I'm saying this but I look forward to these now"],
  [29, 0.93, "supportive", "ok I owe you an apology. this channel got me through a rough month"],
];
const HATER: Seed[] = [
  [0, -0.9, "toxic", "who asked for another toaster video"],
  [3, -0.85, "toxic", "this is the worst thing I've watched all year"],
  [6, -0.88, "toxic", "you have the charisma of a damp sock"],
  [10, -0.8, "toxic", "somehow worse than last week. impressive"],
  [14, -0.92, "toxic", "cringe. just cringe. every second of it"],
  [18, -0.84, "toxic", "can't believe people actually pay you to do this"],
  [23, -0.9, "toxic", "still here, still not impressed"],
  [28, -0.95, "toxic", "peak mediocrity. never change (please change)"],
];
const BAD_DAY: Seed[] = [
  [0, 0.88, "supportive", "the way you explain this is unreal"],
  [3, 0.9, "supportive", "genuinely love this channel"],
  [6, 0.8, "funny", "the cat in the background is the real star"],
  [9, 0.85, "supportive", "best 14 minutes of my week"],
  [13, -0.93, "toxic", "this is garbage and so is everyone involved. I want my time back"],
  [17, 0.86, "supportive", "sorry about my last comment, rough day. love the video"],
  [21, 0.9, "supportive", "you folks are the best"],
  [26, 0.84, "supportive", "never stop making these"],
];
const SUPERFAN: Seed[] = [
  [0, 0.95, "supportive", "day one fan. let's go"],
  [3, 0.9, "supportive", "my dad and I watch every upload together"],
  [6, 0.94, "supportive", "ok but the editing deserves its own award"],
  [9, 0.88, "supportive", "the best part of my week, every week"],
  [12, 0.92, "supportive", "I would watch you review a spoon for an hour"],
  [16, 0.96, "supportive", "crying at the ending, why am I crying at a toaster video"],
  [20, 0.9, "supportive", "never stop making these"],
  [24, 0.93, "supportive", "bought the mug. regret nothing"],
  [28, 0.97, "supportive", "three years, still the best channel I know"],
];
const COMEDIAN: Seed[] = [
  [1, 0.55, "funny", "I came for the toaster review and stayed for the emotional damage"],
  [5, 0.6, "funny", "bro really said 'trust me' and then set the kitchen on fire"],
  [9, 0.5, "funny", "the sponsor read was longer than my last relationship"],
  [13, 0.62, "funny", "this video has the energy of a raccoon in a Costco"],
  [17, 0.58, "funny", "plot twist: the thumbnail was the best part"],
  [22, 0.64, "funny", "me explaining to my boss why I'm crying laughing at 3pm"],
  [27, 0.55, "funny", "the kettle has more screen presence than most actors"],
];
const REPLY: Seed[] = [
  [2, 0.1, "question", "first. also what mic is that"],
  [5, 0.2, "supportive", "agree with the other guy. also what mic is that"],
  [8, -0.2, "critical", "replying to everyone: you are all wrong about garlic presses"],
  [12, 0.1, "question", "has anyone tried this with the 2024 model"],
  [15, 0.05, "critical", "as I said in the last 9 videos, the lighting is off"],
  [19, 0.25, "funny", "I will be in the comments until the heat death of the universe"],
  [24, 0.1, "question", "pinning this so I can reply to myself later"],
  [28, 0.15, "supportive", "ok good episode. 214th comment, I'm basically staff"],
];

function buildPersona(kind: PersonaKind, name: string, seeds: Seed[], videos: VideoInfo[], opts: { comments: number; verdict: string; headline?: number }): Persona {
  const timeline = seeds.map(([vi, sentiment, vibe, text]) => ({ t: videos[vi].publishedAt, sentiment, vibe, videoId: videos[vi].id, text }));
  const avg = timeline.reduce((a, p) => a + p.sentiment, 0) / timeline.length;
  const hl = opts.headline ?? (kind === "villain_arc" ? seeds.length - 1 : kind === "redemption_arc" ? seeds.length - 1 : 0);
  return {
    kind,
    authorId: `mock-${name}`,
    authorName: name,
    commentCount: opts.comments,
    videoCount: Math.min(videos.length, timeline.length + 3),
    avgSentiment: avg,
    timeline,
    headlineComment: timeline[hl].text,
    verdict: opts.verdict,
  };
}

function genSeeds(rng: () => number, kind: PersonaKind): Seed[] {
  const n = 8;
  const idx = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(29, Math.round((i / (n - 1)) * 29 + (rng() * 2 - 1)))));
  return idx.map((vi, i) => {
    const f = i / (n - 1);
    let s: number;
    switch (kind) {
      case "superfan": s = 0.85 + rng() * 0.12; break;
      case "consistent_hater": s = -0.8 - rng() * 0.15; break;
      case "villain_arc": s = 0.9 - f * 1.8 + (rng() - 0.5) * 0.12; break;
      case "redemption_arc": s = -0.9 + f * 1.8 + (rng() - 0.5) * 0.12; break;
      case "one_bad_day": s = i === 4 ? -0.9 : 0.8 + rng() * 0.15; break;
      case "comedian": s = 0.5 + rng() * 0.15; break;
      default: s = (rng() - 0.4) * 0.5;
    }
    const vibe: Vibe = kind === "comedian" ? "funny" : s > 0.5 ? "supportive" : s > 0 ? "question" : s > -0.6 ? "critical" : "toxic";
    const text = kind === "comedian" ? pick(rng, TEXTS.funny) : pick(rng, vibe === "question" ? TEXTS.question : TEXTS[vibe]);
    return [vi, +s.toFixed(2), vibe, text] as Seed;
  });
}

export function buildMockResult(): WrappedResult {
  const rng = mulberry32(4242);
  const now = Date.now();
  const videos: VideoInfo[] = TITLES.map((title, i) => ({
    id: `mockvid${i}`,
    title,
    publishedAt: new Date(now - (30 - i) * 15 * 86400000).toISOString(),
    thumbnail: "",
    commentCount: 1200 + Math.floor(rng() * 750),
  }));

  const personas: Persona[] = [
    buildPersona("superfan", "@captain_crumpet", SUPERFAN, videos, { comments: 412, verdict: "Never missed an upload. Never said one unkind thing. Honestly a little scary." }),
    buildPersona("superfan", "@marmalade_marie", genSeeds(rng, "superfan"), videos, { comments: 188, verdict: "Leaves a heart-eyes comment on literally everything." }),
    buildPersona("superfan", "@tin_can_tomas", genSeeds(rng, "superfan"), videos, { comments: 143, verdict: "The unofficial mod. Defends you in strangers' replies." }),
    buildPersona("villain_arc", "@glitterwombat_", VILLAIN, videos, { comments: 87, verdict: "Went from fan club president to comment section arsonist in 14 months." }),
    buildPersona("villain_arc", "@neon_pretzel7", genSeeds(rng, "villain_arc"), videos, { comments: 52, verdict: "Started with 'this is genius'. Ended with 'unsubscribed, forever'." }),
    buildPersona("villain_arc", "@paper_yeti", genSeeds(rng, "villain_arc"), videos, { comments: 41, verdict: "A slow burn. You can pinpoint the exact sponsor read it started." }),
    buildPersona("redemption_arc", "@moonpie.exe", REDEMPTION, videos, { comments: 64, verdict: "Hated you for 11 videos. Wrote an apology on the 12th." }),
    buildPersona("redemption_arc", "@sleepy_pigeon", genSeeds(rng, "redemption_arc"), videos, { comments: 33, verdict: "Came in to roast. Stayed for the bit." }),
    buildPersona("consistent_hater", "@nightmare_ned", HATER, videos, { comments: 156, verdict: "Eight videos. Eight attacks. Remarkable consistency, honestly." }),
    buildPersona("consistent_hater", "@salty_badger3", genSeeds(rng, "consistent_hater"), videos, { comments: 97, verdict: "Watches everything. Likes nothing. Respect." }),
    buildPersona("consistent_hater", "@feral_goblin", genSeeds(rng, "consistent_hater"), videos, { comments: 74, verdict: "Has never once started a comment with anything nice." }),
    buildPersona("one_bad_day", "@sunnyside_dana", BAD_DAY, videos, { comments: 58, verdict: "One nasty comment. Followed by a heartfelt apology four videos later." }),
    buildPersona("one_bad_day", "@mellow_otter", genSeeds(rng, "one_bad_day"), videos, { comments: 36, verdict: "Lovely. Except for that one Tuesday." }),
    buildPersona("comedian", "@punmaster_flex", COMEDIAN, videos, { comments: 129, verdict: "Funnier than the video. Knows it." }),
    buildPersona("comedian", "@wobbly_comet", genSeeds(rng, "comedian"), videos, { comments: 84, verdict: "A one-person writers' room." }),
    buildPersona("reply_guy", "@reply_all_rita", REPLY, videos, { comments: 214, verdict: "214 comments. Has replied to herself twice." }),
    buildPersona("reply_guy", "@crispy_otter", genSeeds(rng, "reply_guy"), videos, { comments: 171, verdict: "Always first. Always has a follow-up question." }),
  ];

  const perVideo = videos.map((v, i) => {
    const toxicShare = 0.05 + (i / 29) * 0.07 + (i === 18 ? 0.05 : 0);
    const bias = toxicShare - 0.09;
    const sup = 0.34 - bias * 1.2 + (i === 6 ? 0.06 : 0);
    const share: Record<Vibe, number> = { toxic: toxicShare, supportive: sup, funny: 0.16, question: 0.12, critical: 0.17 + bias * 0.5, spam: 0 };
    share.spam = Math.max(0.03, 1 - (share.toxic + share.supportive + share.funny + share.question + share.critical));
    const byVibe = {} as Record<Vibe, number>;
    (Object.keys(share) as Vibe[]).forEach((k) => (byVibe[k] = Math.round(share[k] * v.commentCount)));
    const avg = 0.4 - (i / 29) * 0.42 + (rng() - 0.5) * 0.14 + (i === 6 ? 0.18 : 0) - (i === 18 ? 0.2 : 0);
    return { videoId: v.id, avgSentiment: +avg.toFixed(3), byVibe };
  });
  const byVibe = { toxic: 0, critical: 0, supportive: 0, funny: 0, question: 0, spam: 0 } as Record<Vibe, number>;
  perVideo.forEach((p) => (Object.keys(byVibe) as Vibe[]).forEach((k) => (byVibe[k] += p.byVibe[k])));
  const total = Object.values(byVibe).reduce((a, b) => a + b, 0);

  const top = (vibe: Vibe, n: number, like0: number) =>
    TEXTS[vibe].slice(0, n).map((t, i) => makeComment(rng, `top-${vibe}-${i}`, vibe, videos[(i * 7 + 3) % 30].id, handle(rng), t, Math.floor(like0 / (i + 1)), videos[(i * 7 + 3) % 30].publishedAt));
  const funniest = top("funny", 3, 9400);
  const nastiest = top("toxic", 3, 5100);
  funniest[0].text = "the sponsor read was longer than my last relationship";
  nastiest[0].text = "you have the charisma of a damp sock";

  const inputTokens = Math.round(total * 36);
  const costUsd = (inputTokens / 1e6) * 0.05;
  return {
    channel: { id: "UCmock_mangostatic", title: "Mango Static", handle: "@mangostatic", avatar: "", subscriberCount: 1840000 },
    videos,
    totals: { comments: total, commenters: Math.round(total * 0.37), byVibe, avgSentiment: perVideo.reduce((a, p) => a + p.avgSentiment, 0) / perVideo.length },
    personas,
    topComments: { funniest, nastiest, sweetest: top("supportive", 3, 7200) },
    perVideo,
    usage: { inputTokens, costUsd, elapsedMs: 9300, classifyCalls: Math.ceil(total / 50) },
    demo: true,
  };
}

export async function* mockStream(signal?: AbortSignal): AsyncGenerator<ProgressEvent> {
  const rng = mulberry32(99);
  const result = buildMockResult();
  yield { type: "status", stage: "resolving", message: "Finding @mangostatic" };
  await sleep(700, signal);
  yield { type: "channel", channel: result.channel };
  yield { type: "status", stage: "videos", message: "Listing the last 30 videos" };
  await sleep(600, signal);
  yield { type: "videos", videos: result.videos };
  yield { type: "status", stage: "comments", message: "Pulling comments from 30 videos" };
  const total = result.totals.comments;
  for (let i = 1; i <= 12; i++) {
    await sleep(120, signal);
    yield { type: "fetched", total: Math.round((total * i) / 12) };
  }
  yield { type: "status", stage: "classifying", message: `Classifying ${total.toLocaleString("en-US")} comments in batches of 50` };
  const t0 = performance.now();
  let done = 0;
  while (done < total) {
    await sleep(90, signal);
    const wobble = 0.7 + rng() * 0.6;
    done = Math.min(total, done + Math.round((total / 103) * wobble));
    if (total - done < total / 200) done = total;
    const tokens = done * 36;
    yield {
      type: "classified",
      done,
      total,
      costUsd: (tokens / 1e6) * 0.05,
      elapsedMs: performance.now() - t0,
      sample: sampleBatch(rng, 6, result.videos, done / total),
    };
  }
  yield { type: "status", stage: "profiling", message: "Building commenter profiles" };
  await sleep(1100, signal);
  yield { type: "status", stage: "done", message: "Done" };
  yield { type: "result", result };
}
