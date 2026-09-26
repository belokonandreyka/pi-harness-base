/**
 * context-guard — lets the model see its own context gauge, warns it before
 * pi's automatic compaction, and carries its own handoff note across the cut.
 *
 * Why: pi's compaction is silent from the model's point of view. It fires at
 * `contextWindow - reserveTokens` (the context-ceiling clamp counts), replaces
 * everything but the most recent messages with a summary written by a separate
 * request, and that summary tends to lose what the agent was about to do next;
 * the agent then re-reads files and redoes finished steps. Measured on
 * 2026-09-21: 12 of 163 subagent sessions compacted, one of them three times
 * in ten minutes, with the summary growing from 8k to 23k characters.
 *
 * What it does (idea from disler/self-compact-pi-agent, without its lock and
 * without cancelling pi's own compaction):
 * - `view_context` tool: used tokens, the compaction limit, tokens left, as JSON.
 * - From `warnTokensBefore` under the limit, every model call gets a transient
 *   message with live numbers asking for a `handoff_note` (appended last, so
 *   the cached prefix is untouched; never persisted).
 * - `handoff_note` tool stores the note (persisted as a session entry, so a
 *   restart keeps it). On compaction the extension runs pi's own summariser
 *   with a few extra rules (no invented progress, size cap, merge the previous
 *   summary) and appends the note verbatim to the summary. pi's native
 *   threshold logic still decides *when*; the extension never blocks a tool.
 *
 * Config `<agent-dir>/context-guard.json`: { enabled, warnTokensBefore (30000),
 * maxNoteChars (6000), maxSummaryChars (12000) }. Optional
 * `<agent-dir>/context-guard-summary.md` replaces the extra summary rules.
 * `/context-guard` prints the gauge.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendNote,
  compactionLimit,
  contextView,
  DEFAULT_RESERVE_TOKENS,
  GUIDANCE_TYPE,
  levelFor,
  loadConfig,
  NOTE_ENTRY_TYPE,
  NOTE_TOOL,
  recoverState,
  summaryInstructions,
  validateNote,
  VIEW_TOOL,
  warningText,
  type Gauge,
} from "./guard.ts";

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

/** The two places this extension touches pi's runtime; swapped out in tests. */
export interface GuardDeps {
  reserveTokens(ctx: any): Promise<number>;
  /** Runs pi's own summariser with our instructions and returns its CompactionResult. */
  runCompaction(event: any, ctx: any, instructions: string): Promise<{ summary: string; [k: string]: unknown }>;
}

export const defaultDeps: GuardDeps = {
  async reserveTokens(ctx) {
    try {
      const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
      return SettingsManager.create(ctx.cwd).getCompactionReserveTokens(ctx.model);
    } catch {
      return DEFAULT_RESERVE_TOKENS;
    }
  },
  async runCompaction(event, ctx, instructions) {
    const { compact, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    // The registry resolves auth per request and knows extension-registered
    // providers; going through it keeps the summary on the session's own model.
    const streamFn = (model: any, context: any, options: any) => ctx.modelRegistry.streamSimple(model, context, options);
    let retry: any;
    try {
      retry = SettingsManager.create(ctx.cwd).getRetrySettings();
    } catch {
      retry = undefined;
    }
    return compact(event.preparation, ctx.model, undefined, undefined, instructions, event.signal, ctx.thinkingLevel, streamFn, undefined, retry);
  },
};

const k = (n: number) => `${Math.round(n / 1000)}k`;

export default function contextGuardExtension(pi: ExtensionAPI, deps: GuardDeps = defaultDeps): void {
  const agentDir = resolveAgentDir();
  const cfg = loadConfig(agentDir);
  let note: string | null = null;
  let compactions = 0;
  const reserveByModel = new Map<string, number>();

  async function gauge(ctx: any): Promise<{ gauge: Gauge; contextWindow: number }> {
    const model = ctx?.model;
    const key = model ? `${model.provider}/${model.id}` : "?";
    let reserve = reserveByModel.get(key);
    if (reserve === undefined) {
      reserve = await deps.reserveTokens(ctx);
      reserveByModel.set(key, reserve);
    }
    const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : 0;
    let tokens: number | null = null;
    try {
      tokens = ctx?.getContextUsage?.()?.tokens ?? null;
    } catch {
      tokens = null;
    }
    return { gauge: { tokens, limit: compactionLimit(contextWindow, reserve), warnBefore: cfg.warnTokensBefore }, contextWindow };
  }

  function notify(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, level);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const recovered = recoverState(ctx.sessionManager.getEntries());
      note = recovered.note;
      compactions = recovered.compactions;
    } catch {
      // a session manager without entries: start clean
    }
    if (note) notify(ctx, `context-guard: restored a handoff note (${note.length} chars) for the next compaction`, "info");
  });

  pi.on("context", async (event: any, ctx: any) => {
    if (!cfg.enabled) return undefined;
    const { gauge: g } = await gauge(ctx);
    if (levelFor(g) !== "warning") return undefined;
    const messages = (event?.messages ?? []).filter((m: any) => !(m?.role === "custom" && m.customType === GUIDANCE_TYPE));
    messages.push({ role: "custom", customType: GUIDANCE_TYPE, content: warningText(g, note !== null, cfg.maxNoteChars), display: false, timestamp: Date.now() });
    return { messages };
  });

  pi.registerTool({
    name: VIEW_TOOL,
    label: "View context",
    description: `Your own context gauge as JSON: used_tokens, compaction_limit, tokens_until_compaction and whether a handoff note is saved. You cannot see these numbers any other way. Call it before a large read or when deciding whether to write a ${NOTE_TOOL}; not on every turn, a warning arrives by itself when the limit is near.`,
    promptSnippet: "Show your current context usage and how far the automatic compaction is",
    parameters: { type: "object", properties: {}, additionalProperties: false } as any,
    async execute(_id: string, _params: any, _signal: AbortSignal, _update: any, ctx: any) {
      const { gauge: g, contextWindow } = await gauge(ctx);
      const view = contextView({ gauge: g, contextWindow, noteChars: note?.length ?? 0, compactions });
      return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], details: view };
    },
  } as any);

  pi.registerTool({
    name: NOTE_TOOL,
    label: "Handoff note",
    description: `Save a note to yourself that survives the next automatic context compaction: it is appended verbatim to the compaction summary. Write what a summary written by someone else would lose: GOAL (the original task in one line, as asked, not as it has grown) first; DONE with exact paths, commands and verified results; IN PROGRESS; key decisions; and the exact NEXT ACTION as the last line (max ${cfg.maxNoteChars} chars). Calling it again replaces the note. Use it when a [context-guard] message asks for it or at a clean checkpoint when the context is high.`,
    promptSnippet: "Save a handoff note that is appended verbatim to the next compaction summary",
    promptGuidelines: [
      `After a compaction, read the "Handoff note" at the end of the summary first and continue from its NEXT ACTION; never redo work it marks as done.`,
      `Refocus after every compaction: before acting, check that NEXT ACTION still lies on the path to the Goal line. Each step can look justified on its own while the work as a whole drifts (a light for the doghouse needs a generator, the generator needs fuel …); if the current work adds something the task did not ask for, stop and say so instead of continuing.`,
    ],
    parameters: {
      type: "object",
      properties: { note: { type: "string", description: "DONE (exact paths, commands, verified results), IN PROGRESS, key decisions, and the exact NEXT ACTION as the last line." } },
      required: ["note"],
      additionalProperties: false,
    } as any,
    async execute(_id: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
      const checked = validateNote(params?.note, cfg.maxNoteChars);
      if (!checked.ok) throw new Error(checked.error);
      note = checked.note;
      try {
        pi.appendEntry(NOTE_ENTRY_TYPE, { note, savedAt: Date.now() });
      } catch {
        // an unsaved entry only matters across a restart
      }
      const { gauge: g } = await gauge(ctx);
      const left = g.tokens === null ? "unknown" : `${k(Math.max(0, g.limit - g.tokens))} tokens`;
      return {
        content: [{ type: "text", text: `Handoff note saved (${note.length} chars). It is appended verbatim to the next compaction summary; ${left} left before compaction. Keep working.` }],
        details: { noteChars: note.length, tokensLeft: g.tokens === null ? null : Math.max(0, g.limit - g.tokens) },
      };
    },
  } as any);

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!cfg.enabled || !ctx?.model) return undefined;
    const instructions = summaryInstructions(agentDir, cfg, note !== null, event?.customInstructions);
    try {
      const result = await deps.runCompaction(event, ctx, instructions);
      if (event?.signal?.aborted || !result?.summary?.trim()) return undefined;
      const summary = note ? appendNote(result.summary, note) : result.summary;
      const details = { ...((result.details as Record<string, unknown> | undefined) ?? {}), contextGuard: { noteChars: note?.length ?? 0, reason: event?.reason } };
      return { compaction: { ...result, summary, details } };
    } catch (error) {
      if (event?.signal?.aborted) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `context-guard: own summary failed (${message}); pi's default compaction runs instead`, "warning");
      return undefined;
    }
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    const delivered = note !== null;
    note = null;
    compactions++;
    if (delivered) notify(ctx, "context-guard: handoff note appended to the compaction summary", "info");
  });

  pi.registerCommand("context-guard", {
    description: "Show the context gauge: used tokens, compaction limit, warning line, saved handoff note",
    handler: async (_args: string, ctx: any) => {
      const { gauge: g, contextWindow } = await gauge(ctx);
      const v = contextView({ gauge: g, contextWindow, noteChars: note?.length ?? 0, compactions });
      const used = v.used_tokens === null ? "unknown" : k(v.used_tokens);
      notify(
        ctx,
        `context-guard: ${cfg.enabled ? "" : "disabled · "}context ${used} / limit ${k(v.compaction_limit)} (warning from ${k(v.warning_starts_at)}) · note ${v.handoff_note_saved ? `${v.handoff_note_chars} chars` : "none"} · compactions ${v.compactions_so_far}`,
        "info",
      );
    },
  });
}
