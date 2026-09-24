/**
 * cache-telemetry — records what the prompt cache actually did, so cache warming
 * and compaction settings can be judged on a few days of evidence instead of a
 * single test run.
 *
 * One JSONL line per provider response: token split (input / cache read / cache
 * write), cost, and the pause since the previous response in the same run. One
 * line per `cache_warming_decision` (pi >= 0.86): pi's verdict and its own cost
 * estimates. Nothing else — no prompts, no tool arguments, no file names.
 *
 * Log: `<agent-dir>/telemetry/cache-usage.jsonl`, one file per profile. Subagents
 * run as their own pi processes in their own profile, so their traffic lands in
 * that profile's log. `/cache-stats [days]` summarises every profile found under
 * the home directory (`~/.pi*\/agent`), newest `days` (default 7).
 *
 * The extension never returns a value from `cache_warming_decision`, so it
 * observes pi's decisions without changing them.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatStats, logPath, parseEntries, profileLabel, resolveAgentDir, summarize, type CacheEntry } from "./stats.ts";

const CUSTOM_TYPE = "cache-telemetry:report";

export default function cacheTelemetryExtension(pi: any): void {
  const agentDir = resolveAgentDir();
  const profile = profileLabel(agentDir);
  const file = logPath(agentDir);
  const run = randomUUID();
  let dirReady = false;
  let lastResponseAt: number | null = null;
  let lastSeen: unknown = null;

  // Telemetry must never be the reason a session breaks.
  function append(entry: Record<string, unknown>): void {
    try {
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true });
        dirReady = true;
      }
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), profile, run, ...entry })}\n`, "utf-8");
    } catch {
      // ignore
    }
  }

  function onAssistant(event: any): void {
    const m = event?.message;
    if (!m || m.role !== "assistant" || !m.usage || m === lastSeen) return;
    lastSeen = m;
    const now = Date.now();
    const u = m.usage;
    append({
      kind: "request",
      provider: m.provider ?? "?",
      model: m.model ?? "?",
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cost: u.cost?.total ?? 0,
      gapSec: lastResponseAt === null ? null : Math.round((now - lastResponseAt) / 1000),
    });
    lastResponseAt = now;
  }

  pi.on("turn_end", onAssistant);

  // pi's own cache warmer replays the last request with max_tokens 1 through the
  // same provider hooks. Its outcome is otherwise invisible: a failed replay is
  // swallowed and rescheduled (pi 0.87), so log the attempt and the HTTP status.
  let warmAttemptAt: number | null = null;
  pi.on("before_provider_request", (event: any, ctx: any) => {
    const p = event?.payload;
    if (!p || typeof p !== "object" || p.max_tokens !== 1) return;
    warmAttemptAt = Date.now();
    lastWarmActivityAt = warmAttemptAt;
    append({ kind: "warm_attempt", provider: ctx?.model?.provider ?? "?", model: ctx?.model?.id ?? "?" });
  });
  pi.on("after_provider_response", (event: any, ctx: any) => {
    if (warmAttemptAt === null || Date.now() - warmAttemptAt > 120_000) return;
    append({ kind: "warm_result", provider: ctx?.model?.provider ?? "?", model: ctx?.model?.id ?? "?", status: event?.status ?? 0 });
    warmAttemptAt = null;
  });

  // The alarm: after a run ends, if the session is still idle when the cache
  // lifetime is about to run out and neither warmer did anything, say so. The
  // gateway-warmer writes to this same log, so its rows count as activity.
  let lastWarmActivityAt: number | null = null;
  let idleCheck: ReturnType<typeof setTimeout> | null = null;
  pi.on("agent_start", () => {
    if (idleCheck) clearTimeout(idleCheck);
    idleCheck = null;
  });
  pi.on("agent_end", (_event: any, ctx: any) => {
    const ttlSec = ctx?.model?.promptCache?.short;
    if (typeof ttlSec !== "number" || ttlSec <= 30) return;
    const endedAt = Date.now();
    if (idleCheck) clearTimeout(idleCheck);
    idleCheck = setTimeout(() => {
      idleCheck = null;
      try {
        if (ctx?.isIdle && !ctx.isIdle()) return;
        if (lastWarmActivityAt !== null && lastWarmActivityAt > endedAt) return;
        if (hasWarmRowSince(file, endedAt)) return;
        append({ kind: "warm_missing", provider: ctx?.model?.provider ?? "?", model: ctx?.model?.id ?? "?", reason: `idle ${Math.round((Date.now() - endedAt) / 60_000)}m, lifetime ${ttlSec}s, no refresh by any warmer` });
        ctx?.ui?.notify?.("cache-telemetry: the prompt cache is about to expire and no warmer refreshed it", "warning");
      } catch {
        // ignore
      }
    }, Math.max(1000, ttlSec * 1000 - 20_000));
    (idleCheck as any).unref?.();
  });

  pi.on("cache_warming_decision", (event: any, ctx: any) => {
    append({
      kind: "warm_decision",
      provider: ctx?.model?.provider ?? "?",
      model: ctx?.model?.id ?? "?",
      action: event?.action,
      warmCost: event?.warmCost ?? 0,
      missCost: event?.missCost ?? 0,
      probability: event?.continuationProbability ?? 0,
    });
    // no return value: observe only
  });

  pi.registerCommand("cache-stats", {
    description: "Prompt-cache hit rate, lost caches and warming spend across profiles (arg: days, default 7)",
    handler: async (args: string, ctx: any) => {
      const days = Math.max(1, Number.parseInt((args ?? "").trim(), 10) || 7);
      const entries: CacheEntry[] = [];
      for (const dir of profileAgentDirs(agentDir)) {
        const p = logPath(dir);
        if (!existsSync(p)) continue;
        try {
          entries.push(...parseEntries(readFileSync(p, "utf-8")));
        } catch {
          // unreadable log: skip that profile
        }
      }
      const report = formatStats(summarize(entries, Date.now() - days * 86_400_000), days);
      pi.sendMessage({ customType: CUSTOM_TYPE, content: report, display: true });
      ctx?.ui?.notify?.("cache-telemetry: report ready", "info");
    },
  });
}

/** True when the log holds a `warm` or `warm_attempt` row newer than `sinceMs` (tail only; the file is append-only). */
export function hasWarmRowSince(file: string, sinceMs: number): boolean {
  try {
    if (!existsSync(file)) return false;
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n").slice(-200);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (Date.parse(e.ts) < sinceMs) return false;
        if (e.kind === "warm" || e.kind === "warm_attempt") return true;
      } catch {
        // torn line
      }
    }
  } catch {
    // unreadable log
  }
  return false;
}

/** Every `~/.pi*\/agent` directory plus the active one, so one command covers orchestrator and subagents. */
export function profileAgentDirs(active: string, home: string = homedir()): string[] {
  const dirs = new Set<string>([active]);
  try {
    for (const name of readdirSync(home)) {
      if (!name.startsWith(".pi")) continue;
      const candidate = join(home, name, "agent");
      if (existsSync(candidate)) dirs.add(candidate);
    }
  } catch {
    // ignore
  }
  return [...dirs];
}
