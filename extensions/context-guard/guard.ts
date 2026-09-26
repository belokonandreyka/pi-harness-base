import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GuardConfig {
  enabled: boolean;
  /** Start warning the model when this many tokens remain before pi's compaction threshold. */
  warnTokensBefore: number;
  /** Upper bound for a handoff note; it is appended to the summary verbatim and re-sent on every later call. */
  maxNoteChars: number;
  /** Size the summariser is asked to stay under; each compaction re-summarises the previous summary, so an unbounded one grows every cycle. */
  maxSummaryChars: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  warnTokensBefore: 30000,
  maxNoteChars: 6000,
  maxSummaryChars: 12000,
};

/** pi's default `compaction.reserveTokens`, used when the settings cannot be read. */
export const DEFAULT_RESERVE_TOKENS = 16384;
export const NOTE_ENTRY_TYPE = "context-guard:note";
export const GUIDANCE_TYPE = "context-guard:guidance";
export const NOTE_TOOL = "handoff_note";
export const VIEW_TOOL = "view_context";
export const SUMMARY_FILE = "context-guard-summary.md";

export function loadConfig(agentDir: string): GuardConfig {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "context-guard.json"), "utf-8"));
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
    return {
      enabled: raw.enabled !== false,
      warnTokensBefore: num(raw.warnTokensBefore, DEFAULT_CONFIG.warnTokensBefore),
      maxNoteChars: num(raw.maxNoteChars, DEFAULT_CONFIG.maxNoteChars),
      maxSummaryChars: num(raw.maxSummaryChars, DEFAULT_CONFIG.maxSummaryChars),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** pi compacts at `contextWindow - reserveTokens`; context-ceiling clamps the window, so this follows the ceiling too. */
export function compactionLimit(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, contextWindow - reserveTokens);
}

export interface Gauge {
  tokens: number | null;
  limit: number;
  warnBefore: number;
}

export type Level = "unknown" | "ok" | "warning";

export function levelFor(g: Gauge): Level {
  if (g.tokens === null || g.limit <= 0) return "unknown";
  return g.tokens >= g.limit - g.warnBefore ? "warning" : "ok";
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function warningText(g: Gauge, noteSaved: boolean, maxNoteChars: number): string {
  const tokens = g.tokens ?? 0;
  const left = Math.max(0, g.limit - tokens);
  if (noteSaved) {
    return `[context-guard] Handoff note saved. Context is at ${fmt(tokens)} of the ${fmt(g.limit)}-token compaction limit (${fmt(left)} left); pi compacts automatically at the limit and your note comes back verbatim after it. Keep working; call ${NOTE_TOOL} again only if the next action changes.`;
  }
  return `[context-guard] Context is at ${fmt(tokens)} of the ${fmt(g.limit)}-token compaction limit (${fmt(left)} left). At the limit pi replaces everything but the most recent messages with a summary written by another model, which tends to lose what you were about to do. Finish the current atomic step, then call ${NOTE_TOOL} with what that summary would lose: DONE (exact paths, commands, verified results), IN PROGRESS, key decisions, and the exact NEXT ACTION as the last line (max ${fmt(maxNoteChars)} chars). The note is appended to the summary verbatim. Avoid large reads until then; ${VIEW_TOOL} shows the live numbers.`;
}

export interface ViewInput {
  gauge: Gauge;
  contextWindow: number;
  noteChars: number;
  compactions: number;
}

export function contextView(v: ViewInput) {
  const tokens = v.gauge.tokens;
  return {
    used_tokens: tokens,
    context_window: v.contextWindow,
    compaction_limit: v.gauge.limit,
    tokens_until_compaction: tokens === null ? null : Math.max(0, v.gauge.limit - tokens),
    used_percent_of_limit: tokens === null || v.gauge.limit <= 0 ? null : Number(((100 * tokens) / v.gauge.limit).toFixed(1)),
    level: levelFor(v.gauge),
    warning_starts_at: Math.max(0, v.gauge.limit - v.gauge.warnBefore),
    handoff_note_saved: v.noteChars > 0,
    handoff_note_chars: v.noteChars,
    compactions_so_far: v.compactions,
  };
}

export function validateNote(raw: unknown, maxChars: number): { ok: true; note: string } | { ok: false; error: string } {
  const note = typeof raw === "string" ? raw : "";
  if (note.trim().length === 0) {
    return { ok: false, error: `note must not be blank: write DONE, IN PROGRESS, key decisions and the exact NEXT ACTION last.` };
  }
  if (note.length > maxChars) {
    return { ok: false, error: `note is ${fmt(note.length)} chars, the limit is ${fmt(maxChars)}. Shorten it and call ${NOTE_TOOL} again.` };
  }
  return { ok: true, note };
}

/**
 * pi's own summary prompt already has the Goal / Progress / Decisions / Next
 * Steps structure. These rules are what it lacks: no invented progress, no
 * unbounded growth across cycles, and no restating of the agent's note.
 */
export const DEFAULT_SUMMARY_INSTRUCTIONS = `Rules for this checkpoint summary:
- Mark work as Done only when a tool result in the conversation confirms it; call a result verified only when a test, command or check actually showed it. Pending actions stay pending, never described as finished.
- Keep exact file paths, commands, error messages and numbers; they are what the next steps depend on.
- When a previous summary is provided, merge it: move finished items to Done, drop what is no longer relevant, and keep the whole summary under about {{maxSummaryChars}} characters.
- Keep the original task wording and constraints from the first user message where they matter.
- Open with a "Goal:" line: the original task in one sentence, as the first user message stated it (ticket key and acceptance criteria when there are any). Every later step is measured against this line, so it must not drift toward what the work has grown into.`;

export function summaryInstructions(agentDir: string, cfg: GuardConfig, noteSaved: boolean, custom?: string): string {
  let text = DEFAULT_SUMMARY_INSTRUCTIONS;
  const file = join(agentDir, SUMMARY_FILE);
  if (existsSync(file)) {
    try {
      const fromFile = readFileSync(file, "utf-8").trim();
      if (fromFile) text = fromFile;
    } catch {
      // unreadable override: fall back to the default rules
    }
  }
  text = text.replaceAll("{{maxSummaryChars}}", fmt(cfg.maxSummaryChars));
  if (noteSaved) text += `\n- The agent's own handoff note is appended after this summary verbatim; do not restate or paraphrase it.`;
  if (custom?.trim()) text += `\n\n${custom.trim()}`;
  return text;
}

export function appendNote(summary: string, note: string): string {
  return `${summary.trimEnd()}\n\n## Handoff note (written by the agent before compaction, verbatim)\n\n${note}`;
}

/**
 * The note that still has to be delivered: the newest note entry with no
 * compaction after it. Notes before the last compaction were already appended
 * to that compaction's summary.
 */
export function recoverState(entries: Array<{ type?: string; customType?: string; data?: unknown }>): { note: string | null; compactions: number } {
  let note: string | null = null;
  let compactions = 0;
  for (const e of entries) {
    if (e.type === "compaction") {
      compactions++;
      note = null;
    } else if (e.type === "custom" && e.customType === NOTE_ENTRY_TYPE) {
      const n = (e.data as { note?: unknown } | undefined)?.note;
      note = typeof n === "string" && n.trim() ? n : null;
    }
  }
  return { note, compactions };
}
