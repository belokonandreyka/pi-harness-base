import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WarmPolicyConfig {
  enabled: boolean;
  /** Keep the cache warm this long after the last real request while waiting for the user. */
  idleMinutes: number;
  /** Below this context size a lost cache costs cents; leave pi's own verdict alone. */
  minContextTokens: number;
  /** A "running" child record older than this is treated as a leftover from a crash. */
  childMaxAgeMinutes: number;
}

export const DEFAULT_CONFIG: WarmPolicyConfig = {
  enabled: true,
  idleMinutes: 15,
  minContextTokens: 30000,
  childMaxAgeMinutes: 180,
};

export function loadConfig(agentDir: string): WarmPolicyConfig {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "cache-warm-policy.json"), "utf-8"));
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    return {
      enabled: raw.enabled !== false,
      idleMinutes: num(raw.idleMinutes, DEFAULT_CONFIG.idleMinutes),
      minContextTokens: num(raw.minContextTokens, DEFAULT_CONFIG.minContextTokens),
      childMaxAgeMinutes: num(raw.childMaxAgeMinutes, DEFAULT_CONFIG.childMaxAgeMinutes),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export interface DecisionInput {
  idle: boolean;
  contextTokens: number | null;
  childrenRunning: number;
  secondsSinceRealRequest: number | null;
}

export interface Decision {
  action: "warm" | "stop" | undefined;
  reason: string;
}

/**
 * pi's idle mode assumes a fixed 15% chance that another request arrives before
 * the cache expires. That is wrong in two common orchestrator situations: a
 * subagent is still working (it WILL report back, the chance is ~100%), and the
 * first minutes after an answer (the user is usually still reading). Outside of
 * those, and during an active run, pi's own verdict stands (`undefined`).
 */
export function decide(input: DecisionInput, cfg: WarmPolicyConfig): Decision {
  if (!cfg.enabled) return { action: undefined, reason: "disabled" };
  if (!input.idle) return { action: undefined, reason: "active run: pi decides" };
  if (input.contextTokens !== null && input.contextTokens < cfg.minContextTokens) {
    return { action: undefined, reason: "small context: pi decides" };
  }
  if (input.childrenRunning > 0) return { action: "warm", reason: `waiting for ${input.childrenRunning} subagent(s)` };
  if (input.secondsSinceRealRequest === null) return { action: undefined, reason: "no request yet" };
  if (input.secondsSinceRealRequest <= cfg.idleMinutes * 60) {
    return { action: "warm", reason: `idle ${Math.round(input.secondsSinceRealRequest / 60)}m <= ${cfg.idleMinutes}m` };
  }
  return { action: "stop", reason: `idle past ${cfg.idleMinutes}m` };
}

/**
 * Counts subagent run records (pi-collaborating-agents `runs/*.json`) that this
 * very pi process started and that are still marked running. Matching on the
 * parent PID keeps another session's children, and leftovers of a crashed
 * session, from keeping this cache warm.
 */
export function countRunningChildren(runsDir: string, parentPid: number, maxAgeMinutes: number, now = Date.now()): number {
  if (!existsSync(runsDir)) return 0;
  let n = 0;
  try {
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(runsDir, name), "utf-8"));
        if (r.status !== "running" || r.parentPid !== parentPid) continue;
        const started = Date.parse(r.startedAt ?? "");
        if (Number.isFinite(started) && now - started > maxAgeMinutes * 60_000) continue;
        n++;
      } catch {
        // half-written record: ignore
      }
    }
  } catch {
    return 0;
  }
  return n;
}
