/**
 * elapsed-clock — a wall-clock line at the end of every tool result.
 *
 * Claude Opus 5.5 paces its work by elapsed-time information from the harness:
 * given `elapsed 340s / 1200s` it finishes inside the budget, usually well
 * before it, and small agent teams finish sooner at comparable quality
 * (Anthropic, "Prompting Claude Opus 5.5" → Time signals for multiagent
 * harnesses). Older models ignore the line, so it is safe to leave on.
 *
 * In pi the message the harness sends back to the model is the tool result, so
 * the line is appended there: `[elapsed 340s / 1200s]` when a budget is known,
 * `[elapsed 340s]` otherwise. The budget is advisory; nothing stops the run at
 * the limit, keep your own timeout for that.
 *
 * Budget sources, first match wins: env `PI_TIME_BUDGET_S`, or the first user
 * prompt of the session carrying `time budget: 1200s` (also `20m`, `1h`). The
 * clock starts when the session starts.
 *
 * Config: `<agent-dir>/elapsed-clock.json` with `enabled` (default true),
 * `everyNth` (default 1: every tool result; 3 = every third), `tools` (names;
 * default all). Env `PI_ELAPSED_CLOCK=0` disables.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ElapsedClockConfig {
  enabled: boolean;
  everyNth: number;
  tools: string[] | null;
  budgetSeconds: number | null;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

/** `1200s`, `20m`, `1.5h`, or a bare number of seconds; null when absent or invalid. */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return Math.round(n * mult);
}

/** The budget named in a task prompt: `time budget: 1200s`, `time budget 20m`. */
export function budgetFromPrompt(prompt: string): number | null {
  const m = /time\s*budget\s*[:=]?\s*(\d+(?:\.\d+)?\s*(?:s|sec|m|min|h)?)\b/i.exec(prompt);
  return m ? parseDuration(m[1]) : null;
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): ElapsedClockConfig {
  let file: Record<string, unknown> = {};
  const p = join(agentDir, "elapsed-clock.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  let enabled = file.enabled !== false;
  if (env.PI_ELAPSED_CLOCK?.trim() === "0") enabled = false;
  const n = typeof file.everyNth === "number" && file.everyNth >= 1 ? Math.floor(file.everyNth) : 1;
  const tools = Array.isArray(file.tools) ? file.tools.filter((t): t is string => typeof t === "string") : null;
  const budgetSeconds = parseDuration(env.PI_TIME_BUDGET_S) ?? parseDuration(file.budgetSeconds) ?? null;
  return { enabled, everyNth: n, tools, budgetSeconds };
}

export function clockLine(elapsedSeconds: number, budgetSeconds: number | null): string {
  const e = Math.max(0, Math.round(elapsedSeconds));
  return budgetSeconds ? `\n\n[elapsed ${e}s / ${budgetSeconds}s]` : `\n\n[elapsed ${e}s]`;
}

export default function elapsedClockExtension(pi: ExtensionAPI, now: () => number = Date.now): void {
  const config = loadConfig(resolveAgentDir());
  if (!config.enabled) return;
  let startedAt = now();
  let budget = config.budgetSeconds;
  let count = 0;

  pi.on("session_start", () => {
    startedAt = now();
  });

  pi.on("before_agent_start", (event: any) => {
    if (budget !== null) return;
    const found = budgetFromPrompt(String(event?.prompt ?? ""));
    if (found !== null) budget = found;
  });

  pi.on("tool_result", (event: any) => {
    const name: string = event?.toolName ?? "";
    if (config.tools && !config.tools.includes(name)) return;
    count += 1;
    if (count % config.everyNth !== 0) return;
    const content = Array.isArray(event?.content) ? event.content : null;
    if (!content) return;
    const line = clockLine((now() - startedAt) / 1000, budget);
    let idx = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === "text" && typeof content[i].text === "string") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return { content: [...content, { type: "text", text: line.trimStart() }] };
    const next = content.slice();
    next[idx] = { ...next[idx], text: next[idx].text.replace(/\s+$/, "") + line };
    return { content: next };
  });
}
