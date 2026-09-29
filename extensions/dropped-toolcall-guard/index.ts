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
 * A second shape, seen 2026-09-29 on the same route: the request hung for 182 s
 * and came back as HTTP 200 with an empty message — `stop`, no content, zero
 * usage. Nothing marks it as an error, so no fallback fires and the agent just
 * stops mid-task without a word. An empty reply is handled the same way, with
 * its own message and a counter that resets once a turn ends normally.
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

export const EMPTY_REPLY_MESSAGE =
  "Your previous reply arrived empty: the provider returned no text and no tool call. Nothing was executed and nothing " +
  "was lost. Continue the task from where you stopped.";

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

/**
 * True when the last assistant message ended normally and carries nothing: no
 * text, no tool call (a lone thinking block counts as nothing). An aborted or
 * failed turn is not an empty reply — the user or the provider ended it.
 */
export function emptyReply(messages: any[]): boolean {
  const m = messages[messages.length - 1];
  if (m?.role !== "assistant") return false;
  if (m.stopReason !== "stop" || m.errorMessage) return false;
  const content = Array.isArray(m.content) ? m.content : [];
  return !content.some((b: any) => b?.type === "toolCall" || (b?.type === "text" && String(b.text ?? "").trim() !== ""));
}

export default function droppedToolCallGuard(pi: ExtensionAPI, defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0)): void {
  const config = loadConfig(resolveAgentDir());
  if (!config.enabled) return;
  let retries = 0;
  let emptyInARow = 0;

  pi.on("agent_end", (event: any, ctx: any) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    if (emptyReply(messages)) {
      if (emptyInARow >= config.maxRetries) {
        ctx?.ui?.notify?.(`dropped-toolcall-guard: the provider returned an empty reply again (${emptyInARow} retries used); not retrying`, "warning");
        return;
      }
      emptyInARow += 1;
      ctx?.ui?.notify?.(`dropped-toolcall-guard: empty reply from the provider, asking the model to continue (${emptyInARow}/${config.maxRetries})`, "warning");
      defer(() => pi.sendUserMessage(EMPTY_REPLY_MESSAGE));
      return;
    }
    emptyInARow = 0;
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
