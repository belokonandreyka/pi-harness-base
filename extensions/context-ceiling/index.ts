/**
 * context-ceiling — an absolute compaction threshold, independent of the
 * model's context window.
 *
 * Why: pi's auto-compaction fires at `contextWindow - reserveTokens`. Every
 * subagent model in use here (Opus 5, Opus 4.7, GPT-5.6 Sol, Gemini 3.7 Flash)
 * advertises a 1M window, so the built-in threshold sits near 984k and never
 * triggers: 381 subagent sessions between 2026-08-19 and 09-05 compacted zero
 * times while averaging 74k tokens per call. Tokens shipped above 120k per call
 * were 121M in that window (10% of everything).
 *
 * How: pi only compacts *inside* a running agent loop through its own threshold
 * check (`_checkCompaction`), which reads `model.contextWindow` live. The manual
 * `ctx.compact()` aborts the run and never resumes it, so it is useless for a
 * subagent mid-task. This extension therefore clamps the active model's
 * `contextWindow` to `ceiling + reserveTokens`; pi's own threshold path then
 * compacts at `ceiling` and continues the loop. `reserveTokens` must match
 * `compaction.reserveTokens` in that profile's settings.json (pi default 16384).
 *
 * Precedence: env `PI_CONTEXT_CEILING` (tokens; `0`/`off` disables) >
 * `<agent-dir>/context-ceiling.json` > disabled. `/ceiling` shows or changes it
 * for the running session.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_RESERVE_TOKENS = 16384;
export const MIN_CEILING_TOKENS = 20000;

export interface CeilingConfig {
  enabled: boolean;
  ceilingTokens: number;
  reserveTokens: number;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): CeilingConfig {
  let file: Record<string, unknown> = {};
  const path = join(agentDir, "context-ceiling.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {
      file = {};
    }
  }
  const reserveTokens = positiveInt(file.reserveTokens) ?? DEFAULT_RESERVE_TOKENS;
  let enabled = file.enabled === true;
  let ceilingTokens = positiveInt(file.ceilingTokens) ?? 0;

  const raw = env.PI_CONTEXT_CEILING?.trim().toLowerCase();
  if (raw !== undefined && raw !== "") {
    if (raw === "0" || raw === "off" || raw === "false") {
      enabled = false;
    } else {
      const n = positiveInt(raw);
      if (n !== undefined) {
        enabled = true;
        ceilingTokens = n;
      }
    }
  }
  if (enabled && ceilingTokens < MIN_CEILING_TOKENS) enabled = false;
  return { enabled, ceilingTokens, reserveTokens };
}

type ModelLike = { provider?: string; id?: string; contextWindow?: number } | undefined;

export default function contextCeilingExtension(pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();
  let config = loadConfig(agentDir);
  // Original windows by model object, so a later /ceiling off restores them.
  const originals = new WeakMap<object, number>();
  let lastStatus = "";

  function effectiveWindow(): number {
    return config.ceilingTokens + config.reserveTokens;
  }

  function apply(ctx: any): void {
    const model: ModelLike = ctx?.model;
    if (!model || typeof model !== "object") return;
    const current = typeof model.contextWindow === "number" ? model.contextWindow : 0;
    if (current <= 0) return;
    if (!originals.has(model)) originals.set(model, current);
    const original = originals.get(model) ?? current;
    const target = config.enabled ? Math.min(original, effectiveWindow()) : original;
    if (model.contextWindow !== target) model.contextWindow = target;
    updateStatus(ctx);
  }

  function updateStatus(ctx: any): void {
    if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
    const text = config.enabled ? `ctx≤${Math.round(config.ceilingTokens / 1000)}k` : undefined;
    const key = text ?? "";
    if (key === lastStatus) return;
    lastStatus = key;
    ctx.ui.setStatus("ceiling", text);
  }

  for (const event of ["session_start", "before_agent_start", "turn_start", "model_select"]) {
    pi.on(event as any, (_event: any, ctx: any) => {
      apply(ctx);
    });
  }

  pi.on("session_compact", (_event: any, ctx: any) => {
    if (config.enabled && ctx?.hasUI) {
      ctx.ui.notify(`context-ceiling: compacted at the ${Math.round(config.ceilingTokens / 1000)}k ceiling`, "info");
    }
  });

  pi.registerCommand("ceiling", {
    description: "Show or set the absolute compaction ceiling: /ceiling [tokens|on|off|status]",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "off") {
        config = { ...config, enabled: false };
      } else if (arg === "on") {
        const tokens = config.ceilingTokens >= MIN_CEILING_TOKENS ? config.ceilingTokens : 120000;
        config = { ...config, enabled: true, ceilingTokens: tokens };
      } else if (arg && arg !== "status") {
        const n = positiveInt(arg.replace(/k$/, "000"));
        if (n === undefined || n < MIN_CEILING_TOKENS) {
          ctx.ui.notify(`context-ceiling: give a token count ≥ ${MIN_CEILING_TOKENS} (e.g. 120000 or 120k), on, off or status`, "warning");
          return;
        }
        config = { ...config, enabled: true, ceilingTokens: n };
      }
      apply(ctx);
      const usage = ctx.getContextUsage?.();
      const now = usage?.tokens != null ? `, current context ${usage.tokens.toLocaleString()} tokens` : "";
      const state = config.enabled
        ? `enabled at ${config.ceilingTokens.toLocaleString()} tokens (effective window ${effectiveWindow().toLocaleString()}, reserve ${config.reserveTokens.toLocaleString()})`
        : "disabled";
      ctx.ui.notify(`context-ceiling: ${state}${now}`, "info");
    },
  });
}
