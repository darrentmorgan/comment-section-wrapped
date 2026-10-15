// One source of truth for what every showdown reader is asked. Decisions-style readers (ScaleDown, Jev) get these as-is;
// LLM readers get the same text compiled into one system prompt plus a strict JSON schema.
import type { Vibe } from "../types";
import { VIBES } from "../vibes";
import { hash32 } from "../util";

export const MAX_TEXT_CHARS = 500;

/** The app's current rubric, trimmed. Terse on purpose: criteria length is most of the input cost. */
export const VIBE_CRITERIA: Record<Vibe, string> = {
  toxic: "real nastiness toward a person",
  critical: "complaint or disagreement",
  supportive: "love, praise, thanks, greeting, wants to be in videos",
  funny: "joke, meme, roast, quip",
  question: "genuine question seeking an answer",
  spam: "bot, link, scam, self-promo",
};
export const VIBE_INSTRUCTION = "Pick the single best vibe of `text`.";
export const TOXIC_INSTRUCTION = "Is `text` genuinely hateful, threatening or abusive toward a person or group?";
/** Jev requires `instructions` plus a true/false criteria object on a noul question (verified live); ScaleDown accepts the same. */
export const TOXIC_CRITERIA = { true: "hateful, threatening or abusive", false: "anything else, including rude, critical or joking" };
export const TOXIC_THRESHOLD = 0.5;

export interface DecisionsQuestions {
  vibe: { type: "choice"; instructions: string; criteria: Record<Vibe, string> };
  toxic: { type: "noul"; instructions: string; criteria: { true: string; false: string } };
}

export function decisionsQuestions(): DecisionsQuestions {
  return {
    vibe: { type: "choice", instructions: VIBE_INSTRUCTION, criteria: { ...VIBE_CRITERIA } },
    toxic: { type: "noul", instructions: TOXIC_INSTRUCTION, criteria: { ...TOXIC_CRITERIA } },
  };
}

/**
 * The same rubric in OpenAI's /v1/decisions shape: `input` is the comment itself and questions are a named array.
 * "`text`" becomes "the comment", and the toxic predicate folds its true/false criteria into the instruction
 * (predicates take no criteria object). Not part of QUESTIONS_HASH so existing lanes keep their saved answers;
 * the OpenAI lane's own fingerprint carries this text instead.
 */
export function openaiQuestions() {
  return [
    { type: "choice" as const, name: "vibe", instructions: VIBE_INSTRUCTION.replace("`text`", "the comment"), choices: VIBES.map((v) => ({ value: v, description: VIBE_CRITERIA[v] })) },
    { type: "predicate" as const, name: "toxic", instructions: `${TOXIC_INSTRUCTION.replace("`text`", "the comment")} True only if ${TOXIC_CRITERIA.true}; false for ${TOXIC_CRITERIA.false}.` },
  ];
}

/** Collapse whitespace and cap length, like the app does before classifying. */
export function prepText(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  return t.length ? t : "[no text]";
}

export function llmSystemPrompt(): string {
  const lines = VIBES.map((v) => `- ${v}: ${VIBE_CRITERIA[v]}`).join("\n");
  return (
    "You label one YouTube comment. Answer with JSON only.\n" +
    `vibe: ${VIBE_INSTRUCTION.replace(/`/g, "")} Choose exactly one:\n${lines}\n` +
    `toxic: ${TOXIC_INSTRUCTION.replace(/`/g, "")} true only if ${TOXIC_CRITERIA.true}; false for ${TOXIC_CRITERIA.false}.`
  );
}

/** Strict JSON schema for OpenRouter structured outputs. */
export function llmJsonSchema() {
  return {
    type: "object",
    properties: { vibe: { type: "string", enum: [...VIBES] }, toxic: { type: "boolean" } },
    required: ["vibe", "toxic"],
    additionalProperties: false,
  } as const;
}

/** Changes whenever any question text changes, so a saved showdown can say what it asked. */
export const QUESTIONS_HASH = hash32(JSON.stringify([decisionsQuestions(), llmSystemPrompt(), MAX_TEXT_CHARS])).toString(16);
