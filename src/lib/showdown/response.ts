import type { ShowdownCodeMiss, ShowdownDisagreement, ShowdownSummary } from "../types";

export interface ShowdownResponse {
  summary: ShowdownSummary;
  disagreements: ShowdownDisagreement[];
  codeMisses: ShowdownCodeMiss[];
}

/** The public JSON body of a saved showdown, without per-item records or race events. */
export function showdownResponse(file: Omit<ShowdownResponse, "codeMisses"> & { codeMisses?: ShowdownCodeMiss[] }): ShowdownResponse {
  return { summary: file.summary, disagreements: file.disagreements, codeMisses: file.codeMisses ?? [] };
}
