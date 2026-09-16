/**
 * tool-result-offload — keeps big tool outputs out of the context window.
 *
 * pi truncates tool output at 50 KB / 2000 lines, but everything below that cap
 * still lands in the conversation and is re-sent on every later call. Measured
 * 2026-08-19..09-05: bash results of 4k–12k tokens were re-shipped 20M times over
 * and single `browser_snapshot` results averaged 3.3k tokens. Claude Code's
 * answer to the same problem is to persist large outputs to a file and show the
 * model only a preview plus the path; this does the same for pi.
 *
 * On `tool_result`, when the text content of a result exceeds `thresholdChars`,
 * the full text is written to `<dir>/<toolCallId>.txt` and the message content
 * becomes: head + marker (size, path, how to inspect) + tail. Results that carry
 * images and the `read` tool are left alone (read-guard already windows reads).
 *
 * Config: `<agent-dir>/tool-result-offload.json` with `thresholdChars`
 * (default 24000 ≈ 6k tokens), `headChars` (5000), `tailChars` (1500), `dir`
 * (default `$TMPDIR/pi-offload`), `tools` (names; default all except read).
 * Env `PI_OFFLOAD_THRESHOLD=<chars>` overrides the threshold, `0` disables.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface OffloadConfig {
  enabled: boolean;
  thresholdChars: number;
  headChars: number;
  tailChars: number;
  dir: string;
  tools: string[] | null;
}

export const DEFAULTS = { thresholdChars: 24000, headChars: 5000, tailChars: 1500 };
const SKIP_TOOLS = new Set(["read"]);

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

function posInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): OffloadConfig {
  let file: Record<string, unknown> = {};
  const p = join(agentDir, "tool-result-offload.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  let thresholdChars = posInt(file.thresholdChars) ?? DEFAULTS.thresholdChars;
  let enabled = file.enabled !== false;
  const raw = env.PI_OFFLOAD_THRESHOLD?.trim();
  if (raw !== undefined && raw !== "") {
    const n = posInt(raw);
    if (n === undefined) enabled = false;
    else thresholdChars = n;
  }
  const headChars = posInt(file.headChars) ?? DEFAULTS.headChars;
  const tailChars = posInt(file.tailChars) ?? DEFAULTS.tailChars;
  if (headChars + tailChars >= thresholdChars) enabled = false; // nothing to gain
  const dir = typeof file.dir === "string" && file.dir.trim() ? file.dir.trim() : join(env.TMPDIR?.trim() || tmpdir(), "pi-offload");
  const tools = Array.isArray(file.tools) ? file.tools.filter((t): t is string => typeof t === "string") : null;
  return { enabled, thresholdChars, headChars, tailChars, dir, tools };
}

export function marker(total: number, path: string, head: number, tail: number): string {
  return (
    `\n\n[tool-result-offload: output is ${total.toLocaleString()} chars (~${Math.round(total / 4).toLocaleString()} tokens); ` +
    `showing the first ${head.toLocaleString()} and last ${tail.toLocaleString()}. Full output saved to ${path}. ` +
    `Inspect it with rg, or read that file with offset/limit. Do not re-run the command to see more.]\n\n`
  );
}

export default function toolResultOffloadExtension(pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();
  const config = loadConfig(agentDir);
  if (!config.enabled) return;
  let dirReady = false;

  pi.on("tool_result", (event: any) => {
    const name: string = event?.toolName ?? "";
    if (!name || SKIP_TOOLS.has(name)) return;
    if (config.tools && !config.tools.includes(name)) return;
    const content = Array.isArray(event.content) ? event.content : null;
    if (!content || content.some((c: any) => c?.type === "image")) return;
    const texts = content.filter((c: any) => c?.type === "text" && typeof c.text === "string");
    const total = texts.reduce((n: number, c: any) => n + c.text.length, 0);
    if (total <= config.thresholdChars) return;

    const full = texts.map((c: any) => c.text).join("\n");
    const safeId = String(event.toolCallId ?? Date.now()).replace(/[^A-Za-z0-9_-]/g, "_");
    const path = join(config.dir, `${name}-${safeId}.txt`);
    try {
      if (!dirReady) {
        mkdirSync(config.dir, { recursive: true });
        dirReady = true;
      }
      writeFileSync(path, full, "utf-8");
    } catch {
      return; // could not persist: leave the result untouched rather than lose it
    }
    const head = full.slice(0, config.headChars);
    const tail = full.slice(-config.tailChars);
    const preview = head + marker(full.length, path, head.length, tail.length) + tail;
    const rest = content.filter((c: any) => !(c?.type === "text" && typeof c.text === "string"));
    return { content: [{ type: "text", text: preview }, ...rest] };
  });
}
