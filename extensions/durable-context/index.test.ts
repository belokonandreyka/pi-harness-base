import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import durableContextExtension from "./index.ts";
import { MARKER, SIZE_WARN_CHARS } from "./context.ts";

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (typeof ORIGINAL_AGENT_DIR === "string") {
    process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type Handler = (event: any, ctx: any) => any;

function setup(rules?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "durable-ext-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (rules !== undefined) writeFileSync(join(agentDir, "durable-context.md"), rules, "utf-8");

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const messages: Array<{ content: string }> = [];
  const notes: Array<{ text: string; level?: string }> = [];

  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
    sendMessage: (message: { content: string }) => messages.push(message),
  };

  durableContextExtension(api as any);

  const ctx = {
    cwd: agentDir,
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }) },
  };

  return { agentDir, handlers, commands, messages, notes, ctx };
}

function textOf(message: any): string {
  return message?.content?.[0]?.text ?? "";
}

describe("durable-context wiring", () => {
  test("does nothing when no rules file exists", () => {
    const { handlers, ctx } = setup();

    const result = handlers.get("context")?.({ type: "context", messages: [{ role: "user" }] }, ctx);

    expect(result).toBeUndefined();
  });

  test("injects the rules at the top of the request", () => {
    const { handlers, ctx } = setup("Never push to main.");

    const result = handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      ctx,
    );

    expect(result.messages).toHaveLength(2);
    expect(textOf(result.messages[0])).toContain("Never push to main.");
    expect(textOf(result.messages[0])).toContain(MARKER);
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  // The whole point of the rewrite: pi discards the edit after each call, so a
  // rule only stays in force if it is re-injected every single time.
  test("injects on every call, not just the first", () => {
    const { handlers, ctx } = setup("Never push to main.");
    const onContext = handlers.get("context")!;
    const session = { type: "context", messages: [{ role: "user", content: "hi" }] };

    const first = onContext(session, ctx);
    handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
    const second = onContext(session, ctx);

    expect(textOf(first.messages[0])).toContain("Never push to main.");
    expect(textOf(second.messages[0])).toContain("Never push to main.");
  });

  test("keeps a compaction summary first", () => {
    const { handlers, ctx } = setup("Never push to main.");

    const result = handlers.get("context")?.(
      { type: "context", messages: [{ role: "compactionSummary" }, { role: "user" }] },
      ctx,
    );

    expect(result.messages[0]).toEqual({ role: "compactionSummary" });
    expect(textOf(result.messages[1])).toContain(MARKER);
  });

  test("does not add a second copy when the block is already there", () => {
    const { handlers, ctx } = setup("Never push to main.");

    const result = handlers.get("context")?.(
      { type: "context", messages: [{ role: "user", content: `${MARKER} already here` }] },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  // Edits should land without restarting pi.
  test("picks up an edited rules file", () => {
    const { handlers, ctx, agentDir } = setup("first rule");
    const onContext = handlers.get("context")!;

    expect(textOf(onContext({ type: "context", messages: [] }, ctx).messages[0])).toContain("first rule");

    const file = join(agentDir, "durable-context.md");
    const future = new Date(Date.now() + 5_000);
    writeFileSync(file, "second rule", "utf-8");
    require("node:fs").utimesSync(file, future, future);

    const after = textOf(onContext({ type: "context", messages: [] }, ctx).messages[0]);
    expect(after).toContain("second rule");
    expect(after).not.toContain("first rule");
  });

  test("warns once when the rules are large enough to repeat expensively", () => {
    const { handlers, ctx, notes } = setup("x".repeat(SIZE_WARN_CHARS + 1));

    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]?.level).toBe("warning");
    expect(notes[0]?.text).toContain("every model call");
  });

  test("the command reports what is loaded", async () => {
    const { commands, messages, ctx } = setup("Never push to main.");

    await commands.get("durable-context")?.handler("", ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Never push to main.");
    expect(messages[0]?.content).toContain("Sources:");
  });

  test("the command says so when there is nothing to show", async () => {
    const { commands, notes, ctx } = setup();

    await commands.get("durable-context")?.handler("", ctx);

    expect(notes[0]?.text).toContain("nothing loaded");
  });
});
