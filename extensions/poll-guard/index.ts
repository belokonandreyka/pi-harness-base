/**
 * poll-guard — stop the coordinator from sleep-polling its subagents.
 *
 * The completion of a background subagent arrives as a wake message that starts
 * a new turn; the rule "do not poll a running subagent" is in AGENTS.md, and the
 * coordinator still runs `sleep 120; echo waited` followed by
 * `agent_message tail mode:status` in a loop (seen 2026-09-10). Prompts do not
 * hold; a blocked tool call does. Two deterministic gates:
 *
 * 1. `bash` commands whose purpose is to wait — a `sleep N` with N at or above
 *    `minSleepSeconds` (default 20) anywhere in the command — are blocked.
 * 2. Status polls (`agent_message` with action `tail`/`session`/`sessions`
 *    while a run is active) are allowed once, then blocked for
 *    `pollIntervalSeconds` (default 90) per run id.
 *
 * Config: `<agentDir>/poll-guard.json` → { "minSleepSeconds": 20, "pollIntervalSeconds": 90 }
 * Env:    PI_POLL_GUARD=0/off disables the guard for a session.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PollGuardConfig {
  minSleepSeconds: number;
  pollIntervalSeconds: number;
}

export const DEFAULT_CONFIG: PollGuardConfig = { minSleepSeconds: 20, pollIntervalSeconds: 90 };
const POLL_ACTIONS = new Set(["tail", "session", "sessions"]);

export function loadConfig(agentDir?: string): PollGuardConfig {
  const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const file = join(dir, "poll-guard.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<PollGuardConfig>;
    return {
      minSleepSeconds:
        typeof raw.minSleepSeconds === "number" && raw.minSleepSeconds > 0 ? raw.minSleepSeconds : DEFAULT_CONFIG.minSleepSeconds,
      pollIntervalSeconds:
        typeof raw.pollIntervalSeconds === "number" && raw.pollIntervalSeconds > 0
          ? raw.pollIntervalSeconds
          : DEFAULT_CONFIG.pollIntervalSeconds,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Largest `sleep N` (seconds) found in a shell command, or 0 when there is none. */
export function longestSleepSeconds(command: string): number {
  let longest = 0;
  for (const m of command.matchAll(/(?:^|[;&|(\s])sleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)) {
    const n = Number(m[1]);
    const unit = m[2];
    const seconds = unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n;
    if (seconds > longest) longest = seconds;
  }
  return longest;
}

export function isDisabled(): boolean {
  const v = (process.env.PI_POLL_GUARD ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

export default function pollGuardExtension(pi: ExtensionAPI): void {
  let config = loadConfig();
  const lastPoll = new Map<string, number>();
  const now = () => Date.now();

  pi.on("session_start", () => {
    config = loadConfig();
    lastPoll.clear();
  });

  pi.on("tool_call", (event: any) => {
    if (isDisabled()) return;

    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const seconds = longestSleepSeconds(command);
      if (seconds >= config.minSleepSeconds) {
        return {
          block: true,
          reason:
            `poll-guard: \`sleep ${seconds}\` blocked. Waiting for a subagent is not done with sleep or polling — ` +
            `end your turn; the completion wake starts a new turn on its own. If you need to wait for a process you ` +
            `started (devserver, build), wait on its output or port, not on time.`,
        };
      }
      return;
    }

    if (event.toolName === "agent_message" && POLL_ACTIONS.has(event.input?.action)) {
      const input = event.input ?? {};
      const key = String(input.runId ?? input.to ?? input.action);
      const previous = lastPoll.get(key);
      const t = now();
      if (previous !== undefined && t - previous < config.pollIntervalSeconds * 1000) {
        const ago = Math.round((t - previous) / 1000);
        return {
          block: true,
          reason:
            `poll-guard: you checked "${key}" ${ago} s ago and it was still running. Do not poll — end your turn and ` +
            `wait for the completion wake (or the child's question). Next status check allowed in ` +
            `${config.pollIntervalSeconds - ago} s.`,
        };
      }
      lastPoll.set(key, t);
    }
  });
}
