import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure helpers behind the durable-context extension, kept free of the pi API so
 * the loading and placement rules can be tested without a running agent.
 */

export const MARKER = "<!-- durable-context -->";

/** Roughly a thousand tokens; past this the cost of repeating it every call is worth flagging. */
export const SIZE_WARN_CHARS = 4000;

export interface LoadedContext {
  text: string;
  sources: string[];
  oversized: boolean;
}

export interface ContextSource {
  path: string;
  mtimeMs: number | null;
}

/**
 * Global rules live in the profile's agent dir; a repository can add its own on
 * top. Project rules come second so they read as amendments to the global ones.
 */
export function contextPaths(agentDir: string, cwd: string): string[] {
  return [join(agentDir, "durable-context.md"), join(cwd, ".pi", "durable-context.md")];
}

export function readSources(paths: string[]): ContextSource[] {
  return paths.map((path) => {
    try {
      return { path, mtimeMs: existsSync(path) ? statSync(path).mtimeMs : null };
    } catch {
      return { path, mtimeMs: null };
    }
  });
}

/** Cheap fingerprint so an edited rules file takes effect on the next call. */
export function sourcesFingerprint(sources: ContextSource[]): string {
  return sources.map((source) => `${source.path}:${source.mtimeMs ?? "-"}`).join("|");
}

export function loadContext(paths: string[]): LoadedContext | null {
  const chunks: string[] = [];
  const sources: string[] = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    let contents: string;
    try {
      contents = readFileSync(path, "utf-8").trim();
    } catch {
      continue;
    }
    if (contents.length === 0) continue;
    chunks.push(contents);
    sources.push(path);
  }

  if (chunks.length === 0) return null;

  const text = chunks.join("\n\n");
  return { text, sources, oversized: text.length > SIZE_WARN_CHARS };
}

export function buildContextText(loaded: LoadedContext): string {
  return `${MARKER}\nStanding instructions for this profile. They survive compaction, so treat them as active for the whole session, not as a one-time notice.\n\n${loaded.text}`;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/**
 * Places the block after any leading compaction summaries so it sits at a fixed
 * offset from the top. A stable position keeps the request prefix identical
 * between calls, which is what makes it cacheable.
 */
export function insertionIndex(messages: MessageLike[]): number {
  let index = 0;
  while (messages[index]?.role === "compactionSummary") index += 1;
  return index;
}

/**
 * Pi hands each call a fresh copy of the session, so the block normally has to
 * be re-added every time. This guards the case where it is already present —
 * another extension, or a future pi that persists context edits.
 */
export function alreadyPresent(messages: MessageLike[]): boolean {
  return messages.some((message) => {
    const content = message?.content;
    if (typeof content === "string") return content.includes(MARKER);
    if (!Array.isArray(content)) return false;
    return content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string" &&
        (part as { text: string }).text.includes(MARKER),
    );
  });
}
