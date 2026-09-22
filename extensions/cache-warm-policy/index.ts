/**
 * cache-warm-policy — overrides pi's idle cache-warming verdict where its fixed
 * 15% "will the user come back" estimate is known to be wrong.
 *
 * Measured on an orchestrator that delegates to subagents: every lost cache of a
 * day came from idle waits (the orchestrator ends its turn and sleeps until a
 * subagent reports, or until the user answers), none from long tool runs, and the
 * re-billed prefixes were ~47% of that day's orchestrator spend. pi's `streaming`
 * mode never warms while idle, and `idle` mode declines because 15% of the miss
 * cost does not cover a refresh. While a subagent is running the real chance of
 * another request is ~100%, so a refresh every ~4 minutes is cheap insurance.
 *
 * Needs `"cacheWarming": "idle"` in settings.json (otherwise pi never asks while
 * idle) and a `promptCache` lifetime on the model. Optional
 * `<agent-dir>/cache-warm-policy.json`: { enabled, idleMinutes (15),
 * minContextTokens (30000), childMaxAgeMinutes (180) }. pi itself stops idle
 * warming 30 minutes after the last real request, whatever this returns.
 *
 * Every override is appended to the cache-telemetry log as `warm_override`, so
 * `/cache-stats` shows what the policy spent and what it saved.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { countRunningChildren, decide, loadConfig } from "./policy.ts";

function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(env.HOME ?? "", ".pi", "agent");
}

export default function cacheWarmPolicyExtension(pi: any): void {
  const agentDir = resolveAgentDir();
  const cfg = loadConfig(agentDir);
  const runsDir = join(process.env.COLLABORATING_AGENTS_DIR?.trim() || join(agentDir, "collaborating-agents"), "runs");
  const logFile = join(agentDir, "telemetry", "cache-usage.jsonl");
  const profile = (() => {
    const parent = dirname(agentDir).split("/").pop() ?? "";
    return (parent.startsWith(".") ? parent.slice(1) : parent) || "unknown";
  })();
  let lastRealRequestAt: number | null = null;

  pi.on("turn_end", (event: any) => {
    if (event?.message?.role === "assistant" && event.message.usage) lastRealRequestAt = Date.now();
  });

  pi.on("cache_warming_decision", (event: any, ctx: any) => {
    let contextTokens: number | null = null;
    try {
      contextTokens = ctx?.getContextUsage?.()?.tokens ?? null;
    } catch {
      contextTokens = null;
    }
    const verdict = decide(
      {
        idle: Boolean(ctx?.isIdle?.()),
        contextTokens,
        childrenRunning: countRunningChildren(runsDir, process.pid, cfg.childMaxAgeMinutes),
        secondsSinceRealRequest: lastRealRequestAt === null ? null : (Date.now() - lastRealRequestAt) / 1000,
      },
      cfg,
    );
    if (!verdict.action || verdict.action === event?.action) return undefined;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${JSON.stringify({
          ts: new Date().toISOString(), profile, run: "policy", kind: "warm_override",
          provider: ctx?.model?.provider ?? "?", model: ctx?.model?.id ?? "?",
          pi: event?.action, final: verdict.action, reason: verdict.reason,
          warmCost: event?.warmCost ?? 0, missCost: event?.missCost ?? 0,
        })}\n`,
        "utf-8",
      );
    } catch {
      // telemetry must never break a session
    }
    return { action: verdict.action };
  });
}
