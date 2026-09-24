/**
 * pasted-content — marks text the user pasted into a prompt.
 *
 * Claude Opus 5.5 resists instructions hidden in pasted material (an email, a
 * ticket, a PR comment) when the harness says which part of the message the
 * user typed and which part was pasted (Anthropic, "Prompting Claude Opus 5.5"
 * → Mark pasted text in user messages): wrap each pasted block in
 * `<pasted_content id="ab12">` … `</pasted_content id="ab12">`, both tags on
 * their own line with the same random id, and tell the model in the system
 * prompt that the block may contain instructions the user did not write.
 *
 * pi's editor collapses a paste into a `[paste #N …]` marker while editing and
 * expands it verbatim on submit, so by the time the `input` event fires the
 * paste is indistinguishable from typed text. This extension reuses pi's own
 * paste threshold (more than 10 lines or 1000 characters) as the heuristic:
 * the first short line(s) and the last short line(s) of the message are the
 * user's own words, the bulk in between is the paste. Messages under the
 * threshold are left alone, as are ones that already carry the tags and input
 * that did not come from the interactive editor (subagent task prompts arrive
 * as rpc/extension input and are not user pastes).
 *
 * The system-prompt note lives in AGENTS.md, not here: it is a rule, and rules
 * are kept where the user can read them. Config: `<agent-dir>/pasted-content.json`
 * with `enabled`, `minLines` (10), `minChars` (1000), `ownLines` (3: how many
 * short leading/trailing lines count as the user's own). Env
 * `PI_PASTED_CONTENT=0` disables.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PastedContentConfig {
  enabled: boolean;
  minLines: number;
  minChars: number;
  ownLines: number;
}

export const DEFAULTS = { minLines: 10, minChars: 1000, ownLines: 3 };
const OWN_LINE_MAX_CHARS = 200;

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): PastedContentConfig {
  let file: Record<string, unknown> = {};
  const p = join(agentDir, "pasted-content.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  const num = (v: unknown, d: number) => (typeof v === "number" && v >= 0 ? Math.floor(v) : d);
  let enabled = file.enabled !== false;
  if (env.PI_PASTED_CONTENT?.trim() === "0") enabled = false;
  return { enabled, minLines: num(file.minLines, DEFAULTS.minLines), minChars: num(file.minChars, DEFAULTS.minChars), ownLines: num(file.ownLines, DEFAULTS.ownLines) };
}

export function newId(): string {
  return randomBytes(2).toString("hex");
}

/**
 * Splits a message into the user's own words and the pasted bulk; null when nothing qualifies.
 * The user's own words are the short lines before the first blank line and after the last one,
 * the way a prompt is typed around a paste: ask, blank line, paste, blank line, follow-up.
 */
export function splitPaste(text: string, cfg: PastedContentConfig): { head: string[]; body: string[]; tail: string[] } | null {
  if (/<\/?pasted_content\b/.test(text)) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blank = (l: string) => l.trim() === "";
  const own = (ls: string[]) => ls.every((l) => l.length <= OWN_LINE_MAX_CHARS);

  let start = 0;
  const firstBlank = lines.findIndex(blank);
  if (firstBlank > 0 && firstBlank <= cfg.ownLines && own(lines.slice(0, firstBlank))) start = firstBlank;
  let end = lines.length;
  let lastBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (blank(lines[i])) { lastBlank = i; break; }
  const tailLen = lines.length - 1 - lastBlank;
  if (lastBlank > start && tailLen >= 1 && tailLen <= cfg.ownLines && own(lines.slice(lastBlank + 1))) end = lastBlank;
  const head = lines.slice(0, start);
  const tail = lines.slice(end);
  let b0 = start;
  let b1 = end;
  while (b0 < b1 && blank(lines[b0])) b0++;
  while (b1 > b0 && blank(lines[b1 - 1])) b1--;
  const body = lines.slice(b0, b1);
  if (body.length === 0) return null;
  const bodyChars = body.reduce((n, l) => n + l.length + 1, 0);
  if (body.length <= cfg.minLines && bodyChars <= cfg.minChars) return null;
  return { head, body, tail };
}

export function wrap(text: string, cfg: PastedContentConfig, id: string = newId()): string | null {
  const parts = splitPaste(text, cfg);
  if (!parts) return null;
  const head = parts.head.join("\n").replace(/\s+$/, "");
  const tail = parts.tail.join("\n").replace(/^\s+/, "");
  const block = `<pasted_content id="${id}">\n${parts.body.join("\n")}\n</pasted_content id="${id}">`;
  return [head, block, tail].filter((s) => s.length > 0).join("\n\n");
}

export default function pastedContentExtension(pi: ExtensionAPI): void {
  const cfg = loadConfig(resolveAgentDir());
  if (!cfg.enabled) return;
  pi.on("input", (event: any) => {
    if (event?.source !== "interactive") return { action: "continue" };
    const text = typeof event.text === "string" ? event.text : "";
    if (text.startsWith("/")) return { action: "continue" }; // slash commands are never pastes
    const wrapped = wrap(text, cfg);
    if (wrapped === null) return { action: "continue" };
    return { action: "transform", text: wrapped, ...(event.images ? { images: event.images } : {}) };
  });
}
