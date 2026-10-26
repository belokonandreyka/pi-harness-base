/** Pure logic of the ask-user extension: no pi runtime imports, so bun can test it. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  header: string;
  question: string;
  options: QuestionOption[];
}

export interface Answer {
  header: string;
  answer: string;
  typed: boolean;
}

export interface QuestionnaireResult {
  answers: Answer[];
  cancelled: boolean;
}

export const HERDR_BLOCKED_EVENT = "herdr:blocked";
export const MAX_QUESTIONS = 4;
export const MAX_HEADER = 16;

export const DESCRIPTION = [
  "Ask the user one to four multiple-choice questions in a dialog and wait for the answers.",
  "Use it when you are blocked on a decision that is genuinely theirs to make (scope, an irreversible or outward-facing action, a choice between materially different approaches) and cannot resolve it from the request, the code or sensible defaults.",
  "Do not use it for permission to continue, for 'is my plan ready?', or for choices with a conventional default; decide those and say so.",
  "The dialog makes herdr play its needs-input sound, so asking here instead of ending the turn with a question in text is how the user hears that you need him.",
].join(" ");

/** Validates and trims the model's input; returns an error message for unusable input. */
export function normalizeQuestions(raw: unknown): Question[] | string {
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || list.length === 0) return "Error: no questions provided.";
  if (list.length > MAX_QUESTIONS) return `Error: at most ${MAX_QUESTIONS} questions per call.`;
  const questions: Question[] = [];
  for (const [i, q] of list.entries()) {
    const question = typeof q?.question === "string" ? q.question.trim() : "";
    if (!question) return `Error: question ${i + 1} has no text.`;
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: any) => ({ label: typeof o?.label === "string" ? o.label.trim() : "", description: typeof o?.description === "string" && o.description.trim() ? o.description.trim() : undefined }))
      .filter((o: QuestionOption) => o.label);
    if (options.length < 2) return `Error: question ${i + 1} needs at least 2 options.`;
    const header = (typeof q?.header === "string" && q.header.trim() ? q.header.trim() : `Q${i + 1}`).slice(0, MAX_HEADER);
    questions.push({ header, question, options });
  }
  return questions;
}

/** The label herdr shows next to the blocked pane. */
export function blockedLabel(questions: Question[]): string {
  return questions.length === 1 ? questions[0].header : `${questions[0].header} +${questions.length - 1}`;
}

export function formatAnswers(result: QuestionnaireResult): string {
  if (result.cancelled) {
    return "The user dismissed the questions without answering. Do not ask them again in this turn; stop and wait for their next message.";
  }
  return [
    "The user answered:",
    ...result.answers.map((a) => `- ${a.header}: ${a.typed ? `(typed) ${a.answer}` : a.answer}`),
  ].join("\n");
}

/** Holds herdr's blocked state for exactly as long as `run` is pending. */
export async function whileBlocked<T>(pi: Pick<ExtensionAPI, "events">, label: string, run: () => Promise<T>): Promise<T> {
  pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label });
  try {
    return await run();
  } finally {
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
  }
}

export type Ask = (ctx: ExtensionContext, questions: Question[], signal?: AbortSignal) => Promise<QuestionnaireResult>;

/** A subagent's pane is usually hidden and nobody watches it; it asks its orchestrator instead. */
export function isSubagent(env: Record<string, string | undefined> = process.env): boolean {
  return Number(env.PI_COLLAB_SUBAGENT_DEPTH ?? "0") >= 1;
}

export function createExecute(pi: Pick<ExtensionAPI, "events">, ask: Ask, env: Record<string, string | undefined> = process.env) {
  return async (_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
    const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { answers: [], cancelled: true }, isError: true });
    if (isSubagent(env)) {
      return fail("ask_user is for the top-level session. As a subagent, ask your orchestrator with agent_message, or decide, state the assumption in your reply, and continue.");
    }
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return fail("ask_user needs an interactive session and nobody can answer here. Decide yourself, state the assumption in your reply, and continue.");
    }
    const questions = normalizeQuestions(params);
    if (typeof questions === "string") return fail(questions);
    const result = await whileBlocked(pi, blockedLabel(questions), () => ask(ctx, questions, signal));
    return { content: [{ type: "text" as const, text: formatAnswers(result) }], details: result };
  };
}
