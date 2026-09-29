/**
 * secret-guard — keeps secret files and secret-printing commands out of the
 * model's tools.
 *
 * Why: on 2026-09-29 a worker that had no browser tool wrote its own Playwright
 * script and read `~/.vitu/test-secrets.env` to type the passwords itself. That
 * file exists so the playwright MCP can type secrets by name (`--secrets`) with
 * the model never seeing a value; nothing a subagent does needs it in context.
 * The same goes for pi's `auth.json`, private keys, `.netrc` and a Keychain
 * lookup that prints the value (`security find-generic-password -w`).
 *
 * Deterministic gate on `tool_call`: any tool whose input mentions a denied
 * path or command is blocked with a reason that names the sanctioned route.
 * The check is over the whole input (path arguments and shell commands alike),
 * so `cat`, `read`, `rg`, `write` and a heredoc that copies the file all hit it.
 *
 * Config: `<agent-dir>/secret-guard.json` → { "deny": [regex, ...], "allow": [regex, ...] }
 * merged with the defaults below (`allow` wins). Env: PI_SECRET_GUARD=0/off disables it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SecretGuardConfig {
  deny: RegExp[];
  allow: RegExp[];
}

export const DEFAULT_DENY: Array<[RegExp, string]> = [
  [/test-secrets\.env\b/i, "the playwright MCP types these by name (`--secrets`); the model never needs the values"],
  [/\.pi(?:-[\w-]+)?\/agent\/auth\.json\b/, "provider credentials are pi's own; nothing in a task needs them"],
  [/\.ssh\/(?:id_[a-z0-9]+|[\w.-]*_key)(?!\.pub)\b/, "private keys are never read into a model context"],
  [/\.netrc\b/, "stored credentials"],
  [/\.(?:pfx|p12|pem|key)\b/i, "certificate or key material"],
  [/security\s+find-(?:generic|internet)-password[^\n|;&]*\s-[a-z]*[wg][a-z]*\b/, "a Keychain lookup that prints the value; use the value inside `curl -u` or an env var, never in output"],
  [/\bprintenv\b|\benv\s*(?:\||$)|\bset\s*\|/, "dumping the environment prints every exported secret; read one variable by name if you must"],
];

export function loadConfig(agentDir?: string): SecretGuardConfig {
  const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const file = join(dir, "secret-guard.json");
  const cfg: SecretGuardConfig = { deny: DEFAULT_DENY.map(([re]) => re), allow: [] };
  if (!existsSync(file)) return cfg;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { deny?: string[]; allow?: string[] };
    for (const s of raw.deny ?? []) cfg.deny.push(new RegExp(s, "i"));
    for (const s of raw.allow ?? []) cfg.allow.push(new RegExp(s, "i"));
  } catch {
    // an unreadable config keeps the defaults
  }
  return cfg;
}

export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PI_SECRET_GUARD ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

/** The denied pattern the tool input hits, with its reason, or null. */
export function offending(toolName: string, input: unknown, cfg: SecretGuardConfig): { pattern: RegExp; why: string } | null {
  if (toolName === "agent_message" || toolName === "subagent") return null;
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  } catch {
    return null;
  }
  text = text.replace(/\\\//g, "/").replace(/\\n/g, "\n");
  if (cfg.allow.some((re) => re.test(text))) return null;
  for (const re of cfg.deny) {
    if (re.test(text)) {
      const why = DEFAULT_DENY.find(([d]) => d.source === re.source)?.[1] ?? "listed in secret-guard.json";
      return { pattern: re, why };
    }
  }
  return null;
}

export default function secretGuardExtension(pi: ExtensionAPI): void {
  let cfg = loadConfig();
  pi.on("session_start", () => {
    cfg = loadConfig();
  });
  pi.on("tool_call", (event: any) => {
    if (isDisabled()) return;
    const hit = offending(event.toolName, event.input, cfg);
    if (!hit) return;
    return {
      block: true,
      reason:
        `secret-guard: this ${event.toolName} call touches a secret (${hit.pattern.source}): ${hit.why}. ` +
        `Do the step without the value in your context, or ask the coordinator.`,
    };
  });
}
