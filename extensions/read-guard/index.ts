/**
 * read-guard — keeps `read` from re-shipping what the model already has.
 *
 * Measured 2026-08-19..09-05 (~/.pi/agent/bin/session-cost-report.py and the
 * scratch scripts behind it): `read` results were 141M re-shipped tokens, and a
 * large share was avoidable — AGENTS.md files that already sit in the system
 * prompt were `read` 35 times, SKILL.md bodies of 28–38 KB were re-read up to
 * 20 times per window, and 1,712 of 2,290 reads had no offset/limit (442 of them
 * above 3k tokens). Rules in AGENTS.md did not hold; this enforces them.
 *
 * Three behaviours on `tool_call` for the built-in `read` tool:
 * 1. A file listed in the system prompt's project instructions is blocked.
 * 2. A file already read in full this session, unchanged on disk, is blocked
 *    (ranged reads stay allowed; the set resets on session start/compaction).
 * 3. A whole-file read of a long text file gets a default window (`limit`),
 *    and the tool result is annotated so the model reaches for rg/offset instead
 *    of paging.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BIG_FILE_LINES = 400;
export const DEFAULT_WINDOW_LINES = 250;
export const MAX_COUNT_BYTES = 8 * 1024 * 1024;
export const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|txt|html|htm|css|scss|less|yml|yaml|toml|xml|sql|py|sh|zsh|bash|cs|csv|tsv|env|log|ini|cfg|conf|graphql|vue|svelte)$/i;

type ReadInput = { path?: string; offset?: number; limit?: number };
type SeenEntry = { mtimeMs: number; size: number; mode: "whole" | "window" | "range" };
type Windowed = { path: string; lines: number };

export function normalizePath(cwd: string, p: string): string {
  const home = process.env.HOME ?? "";
  const expanded = p === "~" ? home : p.startsWith("~/") ? resolve(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function countLines(path: string, size: number): number | null {
  if (size > MAX_COUNT_BYTES) return null;
  const text = readFileSync(path, "utf-8");
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith("\n")) n--;
  return n;
}

export function windowNote(shown: string, lines: number, limit: number): string {
  return (
    `\n\n[read-guard: ${shown} has ${lines} lines; showing the first ${limit}. ` +
    `Do not page through the rest — locate what you need with rg, then read that range with offset/limit.]`
  );
}

export default function readGuardExtension(pi: ExtensionAPI): void {
  let contextFiles = new Set<string>();
  const seen = new Map<string, SeenEntry>();
  const windowed = new Map<string, Windowed>();

  const reset = () => {
    seen.clear();
    windowed.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_compact", reset);

  pi.on("before_agent_start", (event: any) => {
    // pi hands contextFiles as { path, content } objects; older builds used plain strings.
    const files: unknown[] = event?.systemPromptOptions?.contextFiles ?? [];
    contextFiles = new Set(
      files
        .map((f: any) => (typeof f === "string" ? f : typeof f?.path === "string" ? f.path : null))
        .filter((f): f is string => typeof f === "string" && f.length > 0)
        .map((f) => resolve(f)),
    );
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    if (event.toolName !== "read") return;
    const input = event.input as ReadInput | undefined;
    if (!input || typeof input.path !== "string" || input.path.length === 0) return;

    const path = normalizePath(ctx?.cwd ?? process.cwd(), input.path);
    const ranged = input.offset !== undefined || input.limit !== undefined;

    if (contextFiles.has(path)) {
      return {
        block: true,
        reason:
          `read-guard: ${input.path} is already in your context — it is loaded into the system prompt ` +
          `as project instructions. Do not read it again.`,
      };
    }

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (!st.isFile()) return;

    const prev = seen.get(path);
    const unchanged = prev !== undefined && prev.mtimeMs === st.mtimeMs && prev.size === st.size;
    if (unchanged && !ranged && prev.mode === "whole") {
      return {
        block: true,
        reason:
          `read-guard: ${input.path} was already read in full earlier in this session and has not changed ` +
          `since; its content is in your context. If you must look again, read a range with offset/limit ` +
          `or use rg for a lookup.`,
      };
    }
    if (unchanged && !ranged && prev.mode === "window") {
      return {
        block: true,
        reason:
          `read-guard: the first ${DEFAULT_WINDOW_LINES} lines of ${input.path} are already in your context ` +
          `from an earlier read and the file has not changed. Do not repeat the same read: use rg to locate ` +
          `what you need, then read that range with offset/limit.`,
      };
    }

    let mode: SeenEntry["mode"] = ranged ? "range" : "whole";
    if (!ranged && TEXT_EXT.test(path)) {
      const lines = countLines(path, st.size);
      if (lines !== null && lines > BIG_FILE_LINES) {
        input.limit = DEFAULT_WINDOW_LINES;
        mode = "window";
        windowed.set(event.toolCallId, { path: input.path, lines });
      }
    }
    if (mode !== "range") seen.set(path, { mtimeMs: st.mtimeMs, size: st.size, mode });
  });

  pi.on("tool_result", (event: any) => {
    if (event.toolName !== "read") return;
    const w = windowed.get(event.toolCallId);
    if (!w) return;
    windowed.delete(event.toolCallId);
    if (event.isError) return;
    const content = Array.isArray(event.content) ? event.content : [];
    const last = [...content].reverse().find((c: any) => c?.type === "text");
    if (!last) return;
    const note = windowNote(w.path, w.lines, DEFAULT_WINDOW_LINES);
    return {
      content: content.map((c: any) => (c === last ? { ...c, text: `${c.text}${note}` } : c)),
    };
  });
}
