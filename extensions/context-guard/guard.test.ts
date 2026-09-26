import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNote,
  compactionLimit,
  contextView,
  DEFAULT_CONFIG,
  GUIDANCE_TYPE,
  levelFor,
  loadConfig,
  NOTE_ENTRY_TYPE,
  recoverState,
  summaryInstructions,
  validateNote,
  warningText,
} from "./guard.ts";
import contextGuardExtension, { type GuardDeps } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (typeof ORIGINAL_AGENT_DIR === "string") process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  else delete process.env.PI_CODING_AGENT_DIR;
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-"));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

describe("context-guard gauge", () => {
  test("limit follows the (possibly clamped) window minus the reserve", () => {
    expect(compactionLimit(176384, 16384)).toBe(160000);
    expect(compactionLimit(0, 16384)).toBe(0);
    expect(levelFor({ tokens: 129_999, limit: 160000, warnBefore: 30000 })).toBe("ok");
    expect(levelFor({ tokens: 130_000, limit: 160000, warnBefore: 30000 })).toBe("warning");
    expect(levelFor({ tokens: null, limit: 160000, warnBefore: 30000 })).toBe("unknown");
    expect(levelFor({ tokens: 900_000, limit: 0, warnBefore: 30000 })).toBe("unknown");
  });

  test("warning carries live numbers and changes once a note is saved", () => {
    const g = { tokens: 140_000, limit: 160000, warnBefore: 30000 };
    const ask = warningText(g, false, 6000);
    expect(ask).toContain("140,000");
    expect(ask).toContain("20,000 left");
    expect(ask).toContain("handoff_note");
    expect(warningText(g, true, 6000)).toContain("Handoff note saved");
  });

  test("view reports how far the compaction is", () => {
    const v = contextView({ gauge: { tokens: 120_000, limit: 160000, warnBefore: 30000 }, contextWindow: 176384, noteChars: 0, compactions: 1 });
    expect(v.tokens_until_compaction).toBe(40000);
    expect(v.used_percent_of_limit).toBe(75);
    expect(v.warning_starts_at).toBe(130000);
    expect(v.handoff_note_saved).toBe(false);
  });

  test("notes are checked for blank and size, summary rules are templated and extended", () => {
    expect(validateNote("   ", 100).ok).toBe(false);
    expect(validateNote("x".repeat(101), 100).ok).toBe(false);
    expect(validateNote("NEXT ACTION: run tests", 100)).toEqual({ ok: true, note: "NEXT ACTION: run tests" });

    const dir = tempAgentDir();
    const plain = summaryInstructions(dir, DEFAULT_CONFIG, false);
    expect(plain).toContain("12,000 characters");
    expect(plain).toContain("Goal:");
    expect(plain).not.toContain("handoff note");
    const withNote = summaryInstructions(dir, DEFAULT_CONFIG, true, "focus on the API layer");
    expect(withNote).toContain("do not restate");
    expect(withNote).toEndWith("focus on the API layer");

    writeFileSync(join(dir, "context-guard-summary.md"), "Custom rules, cap {{maxSummaryChars}}.");
    expect(summaryInstructions(dir, { ...DEFAULT_CONFIG, maxSummaryChars: 8000 }, false)).toBe("Custom rules, cap 8,000.");
    expect(appendNote("## Goal\nship\n\n", "NEXT ACTION: deploy")).toBe("## Goal\nship\n\n## Handoff note (written by the agent before compaction, verbatim)\n\nNEXT ACTION: deploy");
  });

  test("recovers only the note that no compaction has consumed yet", () => {
    const entries = [
      { type: "custom", customType: NOTE_ENTRY_TYPE, data: { note: "old" } },
      { type: "compaction" },
      { type: "message" },
      { type: "custom", customType: NOTE_ENTRY_TYPE, data: { note: "fresh" } },
    ];
    expect(recoverState(entries)).toEqual({ note: "fresh", compactions: 1 });
    expect(recoverState(entries.slice(0, 2))).toEqual({ note: null, compactions: 1 });
    expect(recoverState([])).toEqual({ note: null, compactions: 0 });
  });

  test("config falls back per field", () => {
    const dir = tempAgentDir();
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    writeFileSync(join(dir, "context-guard.json"), JSON.stringify({ warnTokensBefore: 20000, maxNoteChars: "big", enabled: false }));
    expect(loadConfig(dir)).toEqual({ ...DEFAULT_CONFIG, warnTokensBefore: 20000, enabled: false });
  });
});

function setup(options: { tokens?: number | null; window?: number; entries?: any[]; compactionResult?: any; compactionError?: string } = {}) {
  tempAgentDir();
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const commands = new Map<string, { handler: Handler }>();
  const appended: Array<[string, any]> = [];
  const calls: Array<{ instructions: string }> = [];
  const deps: GuardDeps = {
    reserveTokens: async () => 16384,
    runCompaction: async (_event, _ctx, instructions) => {
      calls.push({ instructions });
      if (options.compactionError) throw new Error(options.compactionError);
      return options.compactionResult ?? { summary: "## Goal\nfinish\n", firstKeptEntryId: "k1", tokensBefore: 159000, usage: { input: 1 }, details: { readFiles: [] } };
    },
  };
  contextGuardExtension(
    {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def),
      appendEntry: (type: string, data: any) => appended.push([type, data]),
    } as any,
    deps,
  );
  const notes: Array<{ text: string; level?: string }> = [];
  const model = { provider: "vitu-gateway", id: "claude-opus-5", contextWindow: options.window ?? 176384 };
  let tokens: number | null = options.tokens === undefined ? 100_000 : options.tokens;
  const ctx = {
    model,
    cwd: "/tmp",
    hasUI: true,
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }) },
    getContextUsage: () => ({ tokens, contextWindow: model.contextWindow, percent: null }),
    sessionManager: { getEntries: () => options.entries ?? [] },
    setTokens: (n: number | null) => {
      tokens = n;
    },
  };
  return { handlers, tools, commands, appended, calls, ctx, notes };
}

describe("context-guard wiring", () => {
  test("injects the warning only near the limit, always as the last message", async () => {
    const { handlers, ctx } = setup({ tokens: 100_000 });
    const base = [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }];
    expect(await handlers.get("context")!({ messages: base }, ctx)).toBeUndefined();

    ctx.setTokens(135_000);
    const out = await handlers.get("context")!({ messages: [...base, { role: "custom", customType: GUIDANCE_TYPE, content: "stale" }] }, ctx);
    expect(out.messages).toHaveLength(3);
    const last = out.messages.at(-1);
    expect(last.role).toBe("custom");
    expect(last.customType).toBe(GUIDANCE_TYPE);
    expect(last.content).toContain("135,000");
    expect(last.content).toContain("25,000 left");
  });

  test("a 1M window never warns unless something clamps it", async () => {
    const { handlers, ctx } = setup({ tokens: 300_000, window: 1_000_000 });
    expect(await handlers.get("context")!({ messages: [] }, ctx)).toBeUndefined();
  });

  test("handoff_note stores, persists and validates; view_context reports it", async () => {
    const { tools, appended, ctx, handlers } = setup({ tokens: 140_000 });
    const noteTool = tools.get("handoff_note")!;
    await expect(noteTool.execute("1", { note: "  " }, undefined, undefined, ctx)).rejects.toThrow("blank");

    const result = await noteTool.execute("2", { note: "DONE: tests pass\nNEXT ACTION: commit" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("saved (36 chars)");
    expect(result.content[0].text).toContain("20k tokens left");
    expect(appended).toEqual([[NOTE_ENTRY_TYPE, expect.objectContaining({ note: "DONE: tests pass\nNEXT ACTION: commit" })]]);

    const view = JSON.parse((await tools.get("view_context")!.execute("3", {}, undefined, undefined, ctx)).content[0].text);
    expect(view.handoff_note_saved).toBe(true);
    expect(view.tokens_until_compaction).toBe(20000);
    expect(view.level).toBe("warning");

    // once a note is saved the warning turns into a short reminder
    const out = await handlers.get("context")!({ messages: [] }, ctx);
    expect(out.messages[0].content).toContain("Handoff note saved");
  });

  test("compaction runs pi's summariser with the rules and appends the note verbatim", async () => {
    const { tools, handlers, calls, ctx, notes } = setup({ tokens: 150_000 });
    await tools.get("handoff_note")!.execute("1", { note: "NEXT ACTION: run `bun test`" }, undefined, undefined, ctx);
    const out = await handlers.get("session_before_compact")!({ reason: "threshold", customInstructions: "keep the ticket key", signal: { aborted: false }, preparation: {} }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].instructions).toContain("Pending actions stay pending");
    expect(calls[0].instructions).toContain("do not restate");
    expect(calls[0].instructions).toEndWith("keep the ticket key");
    expect(out.compaction.summary).toBe("## Goal\nfinish\n\n## Handoff note (written by the agent before compaction, verbatim)\n\nNEXT ACTION: run `bun test`");
    expect(out.compaction.firstKeptEntryId).toBe("k1");
    expect(out.compaction.details.contextGuard).toEqual({ noteChars: 27, reason: "threshold" });

    await handlers.get("session_compact")!({}, ctx);
    expect(notes.at(-1)?.text).toContain("appended");
    // the note is consumed: the next compaction gets a plain summary
    const again = await handlers.get("session_before_compact")!({ reason: "manual", signal: { aborted: false }, preparation: {} }, ctx);
    expect(again.compaction.summary).toBe("## Goal\nfinish\n");
    expect(calls[1].instructions).not.toContain("do not restate");
  });

  test("falls back to pi's own compaction when the summariser fails", async () => {
    const { handlers, ctx, notes } = setup({ compactionError: "boom" });
    expect(await handlers.get("session_before_compact")!({ reason: "threshold", signal: { aborted: false }, preparation: {} }, ctx)).toBeUndefined();
    expect(notes.at(-1)?.level).toBe("warning");
    expect(notes.at(-1)?.text).toContain("boom");
  });

  test("restores a pending note from the session on start", async () => {
    const entries = [{ type: "custom", customType: NOTE_ENTRY_TYPE, data: { note: "NEXT ACTION: resume" } }];
    const { handlers, tools, ctx } = setup({ entries });
    await handlers.get("session_start")!({}, ctx);
    const view = JSON.parse((await tools.get("view_context")!.execute("1", {}, undefined, undefined, ctx)).content[0].text);
    expect(view.handoff_note_chars).toBe(19);
  });
});
