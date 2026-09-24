/**
 * dropped-toolcall-guard — recovers a turn whose tool call the provider lost.
 *
 * Seen 2026-09-24 through an Anthropic-compatible gateway in front of Bedrock:
 * the model answered with a thinking block, `stop_reason: tool_use`, and 216
 * output tokens, but the `tool_use` content block never reached pi. pi's agent
 * loop treats that as a provider error ("Provider reported tool use without
 * any tool calls") and ends the run; a pane subagent then sits at its prompt
 * until the coordinator's inactivity timeout, which reports it as a crash.
 * One such turn in ~3000 assistant messages — rare, but it costs the whole run.
 *
 * On `agent_end`, when the last assistant message stopped for a tool call and
 * carries none, this sends one user message asking the model to repeat the
 * call, which starts a new turn. At most `maxRetries` (default 2) per session,
 * so a provider that keeps dropping blocks still fails loudly. Env
 * `PI_DROPPED_TOOLCALL_GUARD=0` disables; config `dropped-toolcall-guard.json`
 * takes `maxRetries`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_RETRIES = 2;

export const RETRY_MESSAGE =
  "Your previous reply ended with a tool-use stop but no tool call arrived: the provider dropped the tool_use block " +
  "in transit. Nothing was executed. Repeat the tool call you intended, then continue.";

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): { enabled: boolean; maxRetries: number } {
  let file: Record<string, unknown> = {};
  const p = join(agentDir, "dropped-toolcall-guard.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  const enabled = file.enabled !== false && env.PI_DROPPED_TOOLCALL_GUARD?.trim() !== "0";
  const maxRetries = typeof file.maxRetries === "number" && file.maxRetries >= 0 ? Math.floor(file.maxRetries) : DEFAULT_MAX_RETRIES;
  return { enabled, maxRetries };
}

/** True when the last assistant message stopped for a tool call and has no toolCall block. */
export function droppedToolCall(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (m.stopReason !== "toolUse") return false;
    const content = Array.isArray(m.content) ? m.content : [];
    return !content.some((b: any) => b?.type === "toolCall");
  }
  return false;
}

export default function droppedToolCallGuard(pi: ExtensionAPI, defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0)): void {
  const config = loadConfig(resolveAgentDir());
  if (!config.enabled) return;
  let retries = 0;

  pi.on("agent_end", (event: any, ctx: any) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    if (!droppedToolCall(messages)) return;
    if (retries >= config.maxRetries) {
      ctx?.ui?.notify?.(`dropped-toolcall-guard: the provider dropped a tool call again (${retries} retries used); not retrying`, "warning");
      return;
    }
    retries += 1;
    ctx?.ui?.notify?.(`dropped-toolcall-guard: tool call lost in transit, asking the model to repeat it (${retries}/${config.maxRetries})`, "warning");
    defer(() => pi.sendUserMessage(RETRY_MESSAGE));
  });
}
