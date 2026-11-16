/**
 * provider-error-alert — tell the user when a run died on a provider error.
 *
 * When the provider cannot be reached (`UND_ERR_CONNECT_TIMEOUT`, `read
 * ETIMEDOUT`, "Retry failed after 3 attempts"), pi retries, then ends the run
 * with an error message and sits at its prompt. Nothing asks for attention:
 * herdr shows the pane as idle, and a pane subagent waits for the
 * coordinator's inactivity timeout (seen 2026-11-16 on a worker pane).
 *
 * On `agent_settled` (no retry, compaction or continuation left), when the run
 * was not aborted and its last assistant message stopped with `error`, this
 * emits `herdr:blocked` after a short grace period, so herdr plays its
 * needs-input sound and baran-push sends a push. A new run, user input or
 * shutdown clears it; a fallback extension that resends within the grace
 * period cancels the alert before it fires.
 *
 * Config: `<agentDir>/provider-error-alert.json` → { "enabled": true, "graceMs": 3000 }
 * Env:    PI_PROVIDER_ERROR_ALERT=0 disables; PI_PROVIDER_ERROR_ALERT_GRACE_MS overrides graceMs.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HERDR_BLOCKED_EVENT = "herdr:blocked";
export const LABEL = "Збій провайдера";
export const DEFAULT_GRACE_MS = 3000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; graceMs: number } {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".pi", "agent");
  let file: Record<string, unknown> = {};
  const p = join(dir, "provider-error-alert.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  const flag = env.PI_PROVIDER_ERROR_ALERT?.trim().toLowerCase();
  const enabled = file.enabled !== false && flag !== "0" && flag !== "off";
  const envGrace = Number(env.PI_PROVIDER_ERROR_ALERT_GRACE_MS);
  const graceMs = Number.isFinite(envGrace) && envGrace >= 0 && env.PI_PROVIDER_ERROR_ALERT_GRACE_MS?.trim()
    ? envGrace
    : typeof file.graceMs === "number" && file.graceMs >= 0 ? file.graceMs : DEFAULT_GRACE_MS;
  return { enabled, graceMs };
}

/** The error text when the last assistant message ended with a provider error, else undefined. */
export function providerError(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (m.stopReason !== "error") return undefined;
    return String(m.errorMessage ?? "provider error").trim() || "provider error";
  }
  return undefined;
}

export default function providerErrorAlert(pi: ExtensionAPI, timers = { set: setTimeout, clear: clearTimeout }): void {
  const config = loadConfig();
  if (!config.enabled) return;
  let lastError: string | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let active = false;

  const clear = () => {
    if (pending !== undefined) {
      timers.clear(pending);
      pending = undefined;
    }
    if (active) {
      active = false;
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    }
  };

  pi.on("agent_start", () => {
    clear();
    lastError = undefined;
  });
  pi.on("input", () => {
    clear();
    return undefined as any;
  });
  pi.on("session_shutdown", () => clear());

  pi.on("agent_end", (event: any) => {
    lastError = providerError(Array.isArray(event?.messages) ? event.messages : []);
  });

  pi.on("agent_settled", (event: any, ctx: any) => {
    if (event?.aborted || !lastError || active || pending !== undefined) return;
    const error = lastError;
    pending = timers.set(() => {
      pending = undefined;
      active = true;
      ctx?.ui?.notify?.(`provider-error-alert: the run stopped on a provider error — ${error.slice(0, 200)}`, "warning");
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: LABEL });
    }, config.graceMs);
  });
}
