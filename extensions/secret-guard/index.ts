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
 * A model often wants only the NAMES (which secrets exist, to pass one to a
 * tool by name). With `nameFiles` configured the extension registers the
 * `secret_names` tool: it reads those env-style files itself and returns the
 * variable names, never a value. The block reason points to it.
 *
 * Config: `<agent-dir>/secret-guard.json` → { "deny": [regex | { "pattern", "why" }, ...],
 * "allow": [regex, ...], "nameFiles": [path, ...] } merged with the defaults below
 * (`allow` wins). A deny entry's `why` names the sanctioned route in the block reason.
 * Env: PI_SECRET_GUARD=0/off disables it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SecretGuardConfig {
  deny: RegExp[];
  allow: RegExp[];
  nameFiles: string[];
  why: Map<string, string>;
}

export const NAMES_TOOL = "secret_names";

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
  const cfg: SecretGuardConfig = {
    deny: DEFAULT_DENY.map(([re]) => re),
    allow: [],
    nameFiles: [],
    why: new Map(DEFAULT_DENY.map(([re, why]) => [re.source, why])),
  };
  if (!existsSync(file)) return cfg;
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as {
      deny?: Array<string | { pattern: string; why?: string }>;
      allow?: string[];
      nameFiles?: string[];
    };
    for (const f of raw.nameFiles ?? []) if (typeof f === "string" && f.trim()) cfg.nameFiles.push(expandHome(f.trim()));
    for (const d of raw.deny ?? []) {
      const pattern = typeof d === "string" ? d : d?.pattern;
      if (typeof pattern !== "string" || !pattern) continue;
      const re = new RegExp(pattern, "i");
      cfg.deny.push(re);
      cfg.why.set(re.source, typeof d === "object" && d.why ? d.why : "listed in secret-guard.json");
    }
    for (const s of raw.allow ?? []) cfg.allow.push(new RegExp(s, "i"));
  } catch {
    // an unreadable config keeps the defaults
  }
  return cfg;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(process.env.HOME?.trim() || homedir(), p.slice(1)) : p;
}

/** Variable names of an env-style file (`NAME=value`, optional `export`), values dropped. */
export function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function secretNames(files: string[]): Array<{ file: string; names: string[]; error?: string }> {
  return files.map((file) => {
    try {
      return { file, names: namesIn(readFileSync(file, "utf-8")) };
    } catch {
      return { file, names: [], error: "unreadable" };
    }
  });
}

export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PI_SECRET_GUARD ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

/** The denied pattern the tool input hits, with its reason, or null. */
export function offending(toolName: string, input: unknown, cfg: SecretGuardConfig): { pattern: RegExp; why: string } | null {
  if (toolName === "agent_message" || toolName === "subagent" || toolName === NAMES_TOOL) return null;
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
      const why = cfg.why.get(re.source) ?? "listed in secret-guard.json";
      return { pattern: re, why };
    }
  }
  return null;
}

function resolveAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function configStamp(agentDir: string): number {
  try {
    return statSync(join(agentDir, "secret-guard.json")).mtimeMs;
  } catch {
    return -1;
  }
}

export default function secretGuardExtension(pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();
  let cfg = loadConfig(agentDir);
  let stamp = configStamp(agentDir);
  // Reload when secret-guard.json changes, so a rule edit applies to the
  // running session instead of waiting for a restart. One stat per tool call.
  const current = (): SecretGuardConfig => {
    const now = configStamp(agentDir);
    if (now !== stamp) {
      stamp = now;
      cfg = loadConfig(agentDir);
    }
    return cfg;
  };
  pi.on("session_start", () => {
    stamp = configStamp(agentDir);
    cfg = loadConfig(agentDir);
  });
  const hasNamesTool = cfg.nameFiles.length > 0 && typeof (pi as any).registerTool === "function";
  if (hasNamesTool) {
    (pi as any).registerTool({
      name: NAMES_TOOL,
      label: "Secret names",
      description:
        "Names of the secrets available to tools that take a secret by name (for example the browser MCP typing a password). " +
        "Returns variable names only, never a value. Use it instead of reading a secrets file.",
      promptSnippet: "List the names of the available secrets (names only, never values)",
      parameters: { type: "object", properties: {}, additionalProperties: false } as any,
      async execute() {
        const listed = secretNames(current().nameFiles);
        return { content: [{ type: "text", text: JSON.stringify(listed, null, 2) }], details: listed };
      },
    } as any);
  }
  pi.on("tool_call", (event: any) => {
    if (isDisabled()) return;
    const hit = offending(event.toolName, event.input, current());
    if (!hit) return;
    return {
      block: true,
      reason:
        `secret-guard: this ${event.toolName} call touches a secret (${hit.pattern.source}): ${hit.why}. ` +
        (hasNamesTool ? `For the names alone call \`${NAMES_TOOL}\`. ` : "") +
        `Do the step without the value in your context, or ask the coordinator.`,
    };
  });
}
