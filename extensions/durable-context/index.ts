import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveAgentDir } from "../skill-usage-telemetry/telemetry.ts";
import {
  alreadyPresent,
  buildContextText,
  contextPaths,
  insertionIndex,
  loadContext,
  readSources,
  SIZE_WARN_CHARS,
  sourcesFingerprint,
  type LoadedContext,
} from "./context.ts";

/**
 * Keeps a profile's standing instructions in front of the model for the whole
 * session, including after compaction.
 *
 * Pi hands the `context` hook a deep copy of the session and discards the edit
 * once the call is made, so anything injected here is transient by design. That
 * makes re-injection on every call the only way a rule stays in force — which
 * is also why the block is placed at a fixed offset from the top: an identical
 * request prefix stays cacheable.
 *
 * Rules are read from `<agent-dir>/durable-context.md`, with an optional
 * `.pi/durable-context.md` in the working directory appended after it. With
 * neither file present the extension does nothing at all.
 */
export default function durableContextExtension(pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();

  let cachedFingerprint: string | null = null;
  let cached: LoadedContext | null = null;
  let warnedFor: string | null = null;

  function currentContext(cwd: string): LoadedContext | null {
    const paths = contextPaths(agentDir, cwd);
    const fingerprint = sourcesFingerprint(readSources(paths));

    // Re-reading on an mtime change means editing the rules file takes effect on
    // the next call, with no restart.
    if (fingerprint !== cachedFingerprint) {
      cachedFingerprint = fingerprint;
      cached = loadContext(paths);
    }

    return cached;
  }

  pi.on("session_start", (_event, ctx) => {
    const loaded = currentContext(ctx.cwd);
    if (!loaded) return;

    if (loaded.oversized && warnedFor !== cachedFingerprint) {
      warnedFor = cachedFingerprint;
      ctx.ui.notify(
        `durable-context: ${loaded.text.length} chars are being repeated on every model call (soft limit ${SIZE_WARN_CHARS}) — consider trimming ${loaded.sources.join(", ")}`,
        "warning",
      );
    }
  });

  pi.on("context", (event, ctx) => {
    const loaded = currentContext(ctx.cwd);
    if (!loaded) return;
    if (alreadyPresent(event.messages)) return;

    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: buildContextText(loaded) }],
      timestamp: Date.now(),
    };

    const at = insertionIndex(event.messages);
    return {
      messages: [...event.messages.slice(0, at), message, ...event.messages.slice(at)],
    };
  });

  pi.registerCommand("durable-context", {
    description: "Show the standing instructions injected into every model call",
    handler: async (_args, ctx) => {
      const loaded = currentContext(ctx.cwd);
      if (!loaded) {
        ctx.ui.notify(
          `durable-context: nothing loaded — create ${contextPaths(agentDir, ctx.cwd)[0]}`,
          "info",
        );
        return;
      }

      pi.sendMessage({
        customType: "durable-context:report",
        content: `Standing instructions (${loaded.text.length} chars)\nSources: ${loaded.sources.join(", ")}\n\n${loaded.text}`,
        display: true,
      });
    },
  });
}
