// Turns raw per-item records into the numbers the UI shows. Pure: no I/O, deterministic given the seed.
import type { ShowdownClassScore, ShowdownCodeMiss, ShowdownDisagreement, ShowdownReader, ShowdownReaderStats, ShowdownSummary, Vibe } from "../types";
import { VIBES } from "../vibes";
import { QUESTIONS_HASH } from "./questions";
import type { ItemRecord, LaneMeta } from "./store";
import { isNonLatin, SPECIAL_QUOTA, SPECIALS } from "./sample";
import { agreementMatrix, bootstrapCi, mean, mulberry32, pairedDiffCi, percentile, prf, weightedMean, weightedPercentile } from "./stats";

export interface SummaryInput {
  runId: string;
  createdAt: string;
  seed: number;
  totalComments: number;
  /** de-duplicated comments the sample was drawn from; projections use this, not the raw comment count */
  poolSize?: number;
  items: { id: string; text: string; savedVibe: Vibe; stratum: string }[];
  refereeIds: string[];
  weights: Map<string, number>;
  readers: ShowdownReader[]; // every lane, enabled or not
  perItem: Record<string, Record<string, ItemRecord>>;
  lanes: Record<string, LaneMeta>;
  handPickedIds?: string[];
}

export const SAVED_ID = "scaledown-saved";
const PRIMARY_REFEREE = "referee-opus";
const SECOND_REFEREE = "referee-sonnet";

const ok = (r?: ItemRecord): r is ItemRecord & { vibe: Vibe } => !!r && !r.error && !!r.vibe;

const BAD_WORDS = /\b(fuck\w*|shit\w*|bitch\w*|nigg\w*|fag\w*|cunt\w*|retard\w*|rape\w*|kill\w*|suicide|kys|whore|slut)\b/i;
export function isCameraSafe(text: string, anyToxic: boolean): boolean {
  const t = text.trim();
  return !anyToxic && t.length >= 3 && t.length <= 220 && !BAD_WORDS.test(t);
}

const FAILED = (readerId: string) => `__failed:${readerId}`;

/** A comment is worth putting on screen if a viewer can see why it is contested. */
export function isReadable(text: string): boolean {
  const t = text.trim();
  return t.length >= 20 && t.split(/\s+/).length >= 3 && !isNonLatin(t);
}

export function summarize(input: SummaryInput): { summary: ShowdownSummary; disagreements: ShowdownDisagreement[]; codeMisses: ShowdownCodeMiss[] } {
  const { items, perItem, readers, lanes } = input;
  const rng = mulberry32(input.seed + 7);
  const savedById = new Map(items.map((i) => [i.id, i.savedVibe] as const));
  const statusOf = new Map<string, ShowdownReader["status"]>();
  const get = (reader: string, id: string): ItemRecord | undefined => (reader === SAVED_ID ? undefined : perItem[id]?.[reader]);
  const poolSize = input.poolSize ?? input.totalComments;
  const hasWeights = [...input.weights.values()].some((w) => w > 0);

  const refereeId = readers.some((r) => r.id === PRIMARY_REFEREE) && input.refereeIds.some((id) => ok(get(PRIMARY_REFEREE, id))) ? PRIMARY_REFEREE : input.refereeIds.some((id) => ok(get(SECOND_REFEREE, id))) ? SECOND_REFEREE : null;
  const refVibe = (id: string): Vibe | undefined => (refereeId ? (ok(get(refereeId, id)) ? get(refereeId, id)!.vibe : undefined) : undefined);
  const vibeOf = (reader: string, id: string): Vibe | undefined => {
    if (reader === SAVED_ID) return savedById.get(id);
    const r = get(reader, id);
    return ok(r) ? r.vibe : undefined;
  };

  const stats: Record<string, ShowdownReaderStats> = {};
  const perClassVsReferee: ShowdownSummary["perClassVsReferee"] = {};
  const refFlags = new Map<string, Map<string, boolean>>(); // reader -> item -> matched the referee (failures = false)

  for (const rd of readers) {
    if (rd.kind === "saved") {
      statusOf.set(rd.id, "ok");
      continue;
    }
    const recs: { id: string; r: ItemRecord }[] = [];
    for (const it of items) {
      const r = perItem[it.id]?.[rd.id];
      if (r) recs.push({ id: it.id, r });
    }
    for (const [id, byReader] of Object.entries(perItem)) if (byReader[rd.id] && !recs.find((x) => x.id === id)) recs.push({ id, r: byReader[rd.id] }); // extra (hand-picked) items
    if (recs.length === 0) {
      statusOf.set(rd.id, rd.enabled ? "failed" : "skipped");
      continue;
    }
    const good = recs.filter((x) => ok(x.r));
    const failed = recs.length - good.length;
    statusOf.set(rd.id, good.length === 0 ? "failed" : failed > 0 ? "partial" : "ok");
    const raced = (x: { r: ItemRecord }) => x.r.phase === "race" || x.r.phase === "referee";
    const race = good.filter(raced);
    const probe = good.filter((x) => x.r.phase === "probe");
    const pool = race.length ? race : good;
    const isBatch = rd.kind === "batch";
    // Batch lanes: every comment of a 50-comment request shares one latency, so count each request once.
    const latRecs = isBatch ? [...new Map(pool.map((x) => [x.r.batch ?? x.id, x] as const)).values()] : pool;
    const latencies = latRecs.map((x) => x.r.ms);
    const sources = new Set(good.map((x) => x.r.costSource));
    const costUsd = recs.reduce((t, x) => t + x.r.costUsd, 0);
    const lane = lanes[rd.id];
    // Cost per 1,000: weighted to the channel's natural vibe mix using the vibe strata only. The sample oversamples long,
    // rare and emoji comments, and cost scales with text length, so a plain mean overstates a typical comment.
    const costPer1kSample = good.length ? (costUsd / good.length) * 1000 : 0;
    const weighted = hasWeights ? good.filter((x) => (input.weights.get(x.id) ?? 0) > 0) : [];
    const costPer1k = weighted.length ? weightedMean(weighted.map((x) => x.r.costUsd), weighted.map((x) => input.weights.get(x.id) ?? 0)) * 1000 : costPer1kSample;
    const tokens = good.map((x) => x.r.inputTokens).filter((t): t is number => typeof t === "number");
    const wLat = !isBatch && hasWeights ? latRecs.filter((x) => (input.weights.get(x.id) ?? 0) > 0) : [];
    const useW = wLat.length >= 20;
    const wv = wLat.map((x) => x.r.ms);
    const ww = wLat.map((x) => input.weights.get(x.id) ?? 0);
    const allLat = recs.filter(raced).map((x) => x.r.ms);
    const served: Record<string, number> = {};
    for (const x of good) if (x.r.served) served[x.r.served] = (served[x.r.served] ?? 0) + 1;
    const st: ShowdownReaderStats = {
      readerId: rd.id,
      ok: good.length,
      failed,
      failureRate: recs.length ? failed / recs.length : 0,
      retries: recs.reduce((t, x) => t + Math.max(0, x.r.attempts - 1), 0),
      costUsd,
      costPer1k,
      costPer1kSample,
      projectedCostAll: good.length ? (costPer1k / 1000) * poolSize : null,
      requests: latencies.length,
      costSource: sources.size === 0 || (sources.size === 1 && sources.has("free")) ? "free" : sources.size === 1 ? ([...sources][0] as "api" | "computed") : "mixed",
      meanInputTokens: tokens.length ? mean(tokens) : undefined,
      p50Ms: useW ? weightedPercentile(wv, ww, 50) : percentile(latencies, 50),
      p95Ms: useW ? weightedPercentile(wv, ww, 95) : percentile(latencies, 95),
      p95AllMs: percentile(allLat.length ? allLat : latencies, 95),
      maxMs: latencies.length ? Math.max(...latencies) : 0,
      p95TotalMs: percentile(pool.map((x) => x.r.totalMs), 95),
      serialP50Ms: probe.length ? percentile(probe.map((x) => x.r.ms), 50) : undefined,
      serialP95Ms: probe.length ? percentile(probe.map((x) => x.r.ms), 95) : undefined,
      throughputPerSec: lane && lane.wallMs > 0 ? race.length / (lane.wallMs / 1000) : 0,
      agreementWithReferee: null,
      concurrency: { start: lane?.concurrencyStart ?? 1, max: lane?.concurrencyMax ?? 1, final: lane?.concurrencyFinal ?? 1 },
      wallMs: lane?.wallMs ?? 0,
      ...(Object.keys(served).length ? { servedBy: served } : {}),
    };

    // Agreement with the referee, on the referee subset only (hand-picked slide items are excluded on purpose).
    // A failed answer counts as a disagreement, so a flaky reader cannot look better by dropping its hard items.
    const isJudged = (rd.kind !== "referee" && rd.id !== refereeId) || (refereeId === PRIMARY_REFEREE && rd.id === SECOND_REFEREE);
    if (refereeId && isJudged) {
      const asked = input.refereeIds.filter((id) => refVibe(id) !== undefined && !!get(rd.id, id));
      if (asked.length) {
        const flags = asked.map((id) => vibeOf(rd.id, id) !== undefined && vibeOf(rd.id, id) === refVibe(id));
        refFlags.set(rd.id, new Map(asked.map((id, i) => [id, flags[i]] as const)));
        const rate = flags.filter(Boolean).length / flags.length;
        const [lo, hi] = bootstrapCi(flags, rng, 1000);
        st.agreementWithReferee = { rate, lo, hi, n: asked.length };
        const ids = asked.filter((id) => vibeOf(rd.id, id) !== undefined);
        if (ids.length) st.agreementAnsweredOnly = { rate: ids.filter((id) => vibeOf(rd.id, id) === refVibe(id)).length / ids.length, n: ids.length };
        let w = 0, wa = 0;
        asked.forEach((id, i) => {
          const wt = input.weights.get(id) ?? 0;
          w += wt;
          if (flags[i]) wa += wt;
        });
        if (w > 0) st.agreementWithRefereeNatural = wa / w;
        const tIds = ids.filter((id) => typeof get(rd.id, id)?.toxic === "boolean" && typeof get(refereeId!, id)?.toxic === "boolean");
        if (tIds.length) {
          const p = prf(tIds.map((id) => get(rd.id, id)!.toxic!), tIds.map((id) => get(refereeId!, id)!.toxic!));
          st.toxicVsReferee = { precision: p.precision, recall: p.recall, f1: p.f1, n: p.n, positives: p.positives };
        }
        const right = ids.filter((id) => vibeOf(rd.id, id) === refVibe(id)).map((id) => get(rd.id, id)?.confidence).filter((c): c is number => typeof c === "number");
        const wrong = ids.filter((id) => vibeOf(rd.id, id) !== refVibe(id)).map((id) => get(rd.id, id)?.confidence).filter((c): c is number => typeof c === "number");
        if (right.length) st.meanConfidenceRight = mean(right);
        if (wrong.length) st.meanConfidenceWrong = mean(wrong);
        const cls: Partial<Record<Vibe, ShowdownClassScore>> = {};
        for (const v of VIBES) {
          const predV = ids.filter((id) => vibeOf(rd.id, id) === v);
          const refV = asked.filter((id) => refVibe(id) === v);
          const both = predV.filter((id) => refVibe(id) === v).length;
          if (refV.length || predV.length) cls[v] = { precision: predV.length ? both / predV.length : 0, recall: refV.length ? both / refV.length : 0, n: refV.length };
        }
        perClassVsReferee[rd.id] = cls;
      }
    }
    stats[rd.id] = st;
  }

  // Pairwise matrix over the per-comment readers (same questions) that produced answers. Batch mode answers a different question
  // set and the saved labels are what the sample was partly drawn from, so neither is a fair participant. Failures count as disagreements.
  const matrixReaders = readers.filter((r) => ["decisions", "llm", "baseline"].includes(r.kind) && stats[r.id] && stats[r.id].ok > 0);
  const matrixLabel = (readerId: string, id: string): string | undefined => {
    const v = vibeOf(readerId, id);
    if (v) return v;
    return get(readerId, id) ? FAILED(readerId) : undefined;
  };
  const matrix = agreementMatrix(
    matrixReaders.map((r) => ({ id: r.id, labels: items.map((it) => matrixLabel(r.id, it.id)) })),
    rng,
    1000,
  );

  // "Statistically tied with the top reader" uses a PAIRED bootstrap on the items both were asked about.
  const modelIds = readers.filter((r) => ["decisions", "llm"].includes(r.kind) && stats[r.id]?.agreementWithReferee).map((r) => r.id);
  const topId = [...modelIds].sort((a, b) => stats[b].agreementWithReferee!.rate - stats[a].agreementWithReferee!.rate)[0];
  const tiedWithTop: string[] = [];
  if (topId) {
    for (const id of modelIds) {
      if (id === topId) continue;
      const shared = [...refFlags.get(topId)!.keys()].filter((i) => refFlags.get(id)!.has(i));
      const [lo, hi] = pairedDiffCi(shared.map((i) => refFlags.get(topId)!.get(i)!), shared.map((i) => refFlags.get(id)!.get(i)!), rng, 1000);
      if (lo <= 0 && hi >= 0) tiedWithTop.push(id);
    }
  }

  // Disagreements: per-comment model readers only (baselines always disagree; batch mode answered different questions).
  const modelReaders = readers.filter((r) => ["decisions", "llm"].includes(r.kind) && stats[r.id]?.ok);
  const refs = readers.filter((r) => r.kind === "referee");
  const handPicked = new Set(input.handPickedIds ?? []);
  const cands: (ShowdownDisagreement & { score: number })[] = [];
  const candidateIds = new Set([...items.map((i) => i.id), ...Object.keys(perItem)]);
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  let compared = 0;
  for (const id of candidateIds) {
    const it = itemById.get(id);
    if (!it) continue;
    const answers = modelReaders.flatMap((r) => {
      const rec = get(r.id, id);
      return ok(rec) ? [{ readerId: r.id, vibe: rec.vibe, confidence: rec.confidence }] : [];
    });
    if (answers.length < 2) continue;
    compared++;
    const refReader = refs.find((r) => ok(get(r.id, id)));
    const distinct = new Set(answers.map((a) => a.vibe)).size;
    if (distinct < 2) continue;
    const anyToxic = [...modelReaders, ...refs].some((r) => get(r.id, id)?.toxic);
    const confs = answers.map((a) => a.confidence).filter((c): c is number => typeof c === "number");
    const readable = isReadable(it.text);
    const len = it.text.trim().length;
    cands.push({
      commentId: id,
      text: it.text,
      stratum: it.stratum,
      answers,
      referee: refReader ? { readerId: refReader.id, vibe: get(refReader.id, id)!.vibe! } : undefined,
      distinct,
      handPicked: handPicked.has(id) && !input.refereeIds.includes(id),
      cameraSafe: isCameraSafe(it.text, anyToxic),
      readable,
      // Spread first, then what makes it watchable: readable, a referee verdict, short enough to read in a glance.
      score: distinct * 10 + (confs.length ? mean(confs) : 0) + (readable ? 12 : -20) + (refReader ? 6 : 0) + (len >= 25 && len <= 140 ? 4 : 0),
    });
  }
  cands.sort((a, b) => b.score - a.score || (a.commentId < b.commentId ? -1 : 1));
  const safe = cands.filter((c) => c.cameraSafe);
  const disagreements = safe.slice(0, 20).map((c) => {
    const { score, ...d } = c;
    void score;
    return d;
  });

  // Code misses: the keyword rules disagreed with the referee and at least 3 in 4 model readers agreed with it.
  // This is the one job the models do that plain code cannot, so the slide shows real examples rather than a claim.
  const RULES_ID = "rules";
  const codeMisses: ShowdownCodeMiss[] = [];
  if (stats[RULES_ID]?.ok) {
    for (const it of items) {
      const ref = refVibe(it.id);
      const rules = vibeOf(RULES_ID, it.id);
      if (!ref || !rules || rules === ref) continue;
      const answered = modelReaders.map((r) => vibeOf(r.id, it.id)).filter((v): v is Vibe => !!v);
      const right = answered.filter((v) => v === ref).length;
      if (answered.length < 2 || right * 4 < answered.length * 3) continue;
      const anyToxic = [...modelReaders, ...refs].some((r) => get(r.id, it.id)?.toxic);
      codeMisses.push({ commentId: it.id, text: it.text, rules, referee: ref, right, of: answered.length, cameraSafe: isCameraSafe(it.text, anyToxic), readable: isReadable(it.text) });
    }
    const len = (m: ShowdownCodeMiss) => m.text.trim().length;
    const watch = (m: ShowdownCodeMiss) => (m.readable ? 10 : 0) + (len(m) >= 20 && len(m) <= 140 ? 4 : 0) + (m.right === m.of ? 3 : 0);
    codeMisses.sort((a, b) => watch(b) - watch(a) || (a.commentId < b.commentId ? -1 : 1));
  }

  const totalCostUsd = Object.values(stats).reduce((t, s) => t + s.costUsd, 0);
  const readersOut = readers.map((r) => ({ ...r, mode: r.mode ?? (r.kind === "batch" ? "batch" : "per-comment"), status: statusOf.get(r.id) ?? (r.enabled ? "failed" : "skipped") }) as ShowdownReader);
  const summary: ShowdownSummary = {
    version: 1,
    runId: input.runId,
    createdAt: input.createdAt,
    seed: input.seed,
    sampleSize: items.length,
    refereeSize: input.refereeIds.length,
    totalComments: input.totalComments,
    poolSize,
    questionsHash: QUESTIONS_HASH,
    readers: readersOut,
    stats,
    matrix,
    perClassVsReferee,
    totalCostUsd,
    refereeIds: refs.filter((r) => stats[r.id]?.ok).map((r) => r.id),
    learned: [],
    disagreementCounts: { compared, split: cands.length, cameraSafe: safe.length },
    caveats: [],
  };
  summary.learned = learnedLines(summary, refereeId, tiedWithTop);
  summary.caveats = caveatLines(summary, refereeId);
  return { summary, disagreements, codeMisses: codeMisses.filter((m) => m.cameraSafe).slice(0, 20) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => (x < 0.1 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`);

/** Plain statements built from measured numbers only. No vendor claims, no assumed prices. */
export function learnedLines(s: ShowdownSummary, refereeId: string | null, tiedWithTop: string[] = []): string[] {
  const label = (id: string) => s.readers.find((r) => r.id === id)?.label ?? id;
  const kindOf = (id: string) => s.readers.find((r) => r.id === id)?.kind;
  const out: string[] = [];
  const all = Object.values(s.stats).filter((x) => x.ok > 0 && !["baseline", "referee"].includes(kindOf(x.readerId) ?? ""));
  // Per-comment readers answer identical questions, so only they are ranked against each other.
  const model = all.filter((x) => kindOf(x.readerId) !== "batch");
  const batch = all.filter((x) => kindOf(x.readerId) === "batch");
  const paid = model.filter((x) => x.costUsd > 0);
  if (paid.length >= 2) {
    const cheap = [...paid].sort((a, b) => a.costPer1k - b.costPer1k)[0];
    const dear = [...paid].sort((a, b) => b.costPer1k - a.costPer1k)[0];
    out.push(`Cheapest reader: ${label(cheap.readerId)} at ${usd(cheap.costPer1k)} per 1,000 comments (${cheap.costSource === "api" ? "reported by the API" : "computed from list price"}). Most expensive: ${label(dear.readerId)} at ${usd(dear.costPer1k)}.`);
  } else if (paid.length === 1) {
    out.push(`${label(paid[0].readerId)} cost ${usd(paid[0].costPer1k)} per 1,000 comments.`);
  }
  if (model.length >= 2) {
    // Latency is ranked on the serial probe (one request at a time, identical for every lane). Race latency includes queueing at each lane's own load.
    const serial = model.every((x) => x.serialP50Ms !== undefined);
    const ranked = [...model].sort((a, b) => (serial ? a.serialP50Ms! - b.serialP50Ms! : a.p50Ms - b.p50Ms));
    const fast = ranked[0];
    out.push(
      serial
        ? `Fastest median response when asked alone, one request at a time: ${label(fast.readerId)} at ${Math.round(fast.serialP50Ms!)} ms.`
        : `Fastest median response under load (${fast.concurrency.final} requests at once): ${label(fast.readerId)} at ${Math.round(fast.p50Ms)} ms. Not an unloaded comparison.`,
    );
  }
  for (const b of batch) out.push(`${label(b.readerId)} (batch mode: 50 comments per request, vibe only, the app's tuned prompt) cost ${usd(b.costPer1k)} per 1,000 and took a median ${Math.round(b.p50Ms)} ms per 50-comment request. It is not ranked against the others because it was asked different questions.`);
  if (refereeId) {
    const ranked = model.filter((x) => x.agreementWithReferee).sort((a, b) => b.agreementWithReferee!.rate - a.agreementWithReferee!.rate);
    if (ranked.length) {
      const top = ranked[0];
      const tied = tiedWithTop.filter((id) => ranked.some((x) => x.readerId === id));
      out.push(
        `Closest to the referee (${label(refereeId).replace(/ \(referee\)$/, "")}): ${label(top.readerId)} at ${pct(top.agreementWithReferee!.rate)} agreement` +
          (tied.length ? `, not clearly different from ${tied.map(label).join(", ")} on the same comments (paired test).` : ", clear of the others on a paired test."),
      );
    }
    const base = s.stats["always-supportive"];
    if (base?.agreementWithReferee) {
      const nat = base.agreementWithRefereeNatural;
      out.push(
        `Always guessing "supportive" agreed with the referee ${pct(base.agreementWithReferee.rate)} of the time on this sample` +
          (nat !== undefined ? ` (about ${pct(nat)} reweighted to the channel's mix, approximate: the mix comes from the original batch labels)` : "") +
          `, so that is the bar to beat.`,
      );
    }
    const ceiling = s.stats[SECOND_REFEREE]?.agreementWithReferee;
    if (refereeId === PRIMARY_REFEREE && ceiling) out.push(`The two referees agreed with each other ${pct(ceiling.rate)} of the time, which is a practical ceiling for this task.`);
  }
  const notRun = s.readers.filter((r) => r.status === "skipped");
  const waiting = new Map<string, string[]>();
  const unselected: string[] = [];
  for (const r of notRun) {
    if (r.note?.startsWith("waiting for")) waiting.set(r.note, [...(waiting.get(r.note) ?? []), r.label]);
    else unselected.push(r.label);
  }
  for (const [note, labels] of waiting) out.push(`${labels.join(", ")} did not run (${note}).`);
  if (unselected.length) out.push(`${unselected.join(", ")} ${unselected.length === 1 ? "was" : "were"} not selected for this run.`);
  return out;
}

export function caveatLines(s: ShowdownSummary, refereeId: string | null = null): string[] {
  const toxicN = Math.max(0, ...Object.values(s.stats).map((x) => x.toxicVsReferee?.positives ?? 0));
  const extra = Object.values(s.stats).some((x) => x.toxicVsReferee) && toxicN < 10 ? [`Only ${toxicN} comment${toxicN === 1 ? " was" : "s were"} judged hateful in the referee set, so the toxic comparison is anecdotal, not a measurement.`] : [];
  const special = Math.round((SPECIALS.length * SPECIAL_QUOTA) / 1000 * 100);
  const claude = s.readers.some((r) => r.kind === "llm" && /claude/i.test(`${r.label} ${r.modelId ?? ""}`));
  return [
    ...extra,
    "Agreement with the referee is not accuracy: the referee is also a model, and the vibe labels are fuzzy. A reader that fails to answer counts as disagreeing.",
    ...(claude && refereeId ? ["The referee is a Claude model and one of the readers is a Claude model too, so it may be favoured. Compare it with how the two referees agree with each other."] : []),
    `The sample (${s.sampleSize} comments) oversamples rare vibes and was partly chosen using the original ScaleDown batch labels, so it leans toward that classifier's view. About ${special === 25 ? "a quarter" : `${special}%`} of it is label-independent (long, non-English, emoji, short, low-confidence).`,
    "The label rubric the original run used was tuned on ScaleDown's output. The showdown asks every per-comment reader a shared, shorter version of it, which no reader was tuned on.",
    "LLM readers return one hard label, not probabilities, so calibration and confidence only compare the two decision models.",
    `Cost per 1,000 is weighted to the channel's natural mix of comment types. Projections multiply it by the ${(s.poolSize ?? s.totalComments).toLocaleString("en-US")} de-duplicated comments. Cost counts successful responses only; retried or failed calls that were billed are not included.`,
    "Latency percentiles are on this stratified sample. Racing lanes shared the machine's network, so ranking uses the one-at-a-time probe.",
    "Differences between two readers are judged with a paired test on the same comments. Overlapping error bars alone do not make a tie.",
  ];
}
