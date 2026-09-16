import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readGuardExtension, { BIG_FILE_LINES, DEFAULT_WINDOW_LINES, countLines } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "read-guard-"));
  tempDirs.push(dir);
  const handlers = new Map<string, Handler>();
  readGuardExtension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);
  const ctx = { cwd: dir };
  const fire = (event: string, payload: any) => handlers.get(event)?.(payload, ctx);
  const read = (input: { path: string; offset?: number; limit?: number }, id = "call-1") =>
    fire("tool_call", { type: "tool_call", toolName: "read", toolCallId: id, input });
  return { dir, fire, read };
}

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
}

describe("read-guard", () => {
  test("blocks reading a file that is already in the system prompt", () => {
    const { dir, fire, read } = setup();
    const agents = join(dir, "AGENTS.md");
    writeFileSync(agents, "# rules\n");
    fire("before_agent_start", { systemPromptOptions: { contextFiles: [{ path: agents, content: "# rules" }] } });

    expect(read({ path: "AGENTS.md" })).toMatchObject({ block: true });
    fire("before_agent_start", { systemPromptOptions: { contextFiles: [agents] } });
    expect(read({ path: agents }).reason).toContain("system prompt");
    expect(read({ path: "other.md" })).toBeUndefined();
  });

  test("blocks a second whole read of an unchanged file, allows ranged reads and changed files", () => {
    const { dir, read } = setup();
    const file = join(dir, "small.ts");
    writeFileSync(file, lines(20));

    expect(read({ path: "small.ts" })).toBeUndefined();
    expect(read({ path: "small.ts" })).toMatchObject({ block: true });
    expect(read({ path: "small.ts", offset: 5, limit: 3 })).toBeUndefined();

    writeFileSync(file, lines(21));
    const later = Date.now() / 1000 + 5;
    utimesSync(file, later, later);
    expect(read({ path: "small.ts" })).toBeUndefined();
  });

  test("resets the seen set on session start and compaction", () => {
    const { dir, fire, read } = setup();
    writeFileSync(join(dir, "a.ts"), lines(3));
    expect(read({ path: "a.ts" })).toBeUndefined();
    fire("session_compact", {});
    expect(read({ path: "a.ts" })).toBeUndefined();
    fire("session_start", {});
    expect(read({ path: "a.ts" })).toBeUndefined();
    expect(read({ path: "a.ts" })).toMatchObject({ block: true });
  });

  test("windows a long text file and annotates the result", () => {
    const { dir, fire, read } = setup();
    writeFileSync(join(dir, "big.ts"), lines(BIG_FILE_LINES + 100));
    const input = { path: "big.ts" } as { path: string; limit?: number };

    expect(read(input, "call-9")).toBeUndefined();
    expect(input.limit).toBe(DEFAULT_WINDOW_LINES);

    const result = fire("tool_result", {
      type: "tool_result",
      toolName: "read",
      toolCallId: "call-9",
      isError: false,
      content: [{ type: "text", text: "line 1\n...\n[250 more lines in file. Use offset=251 to continue.]" }],
    });
    expect(result.content[0].text).toContain(`has ${BIG_FILE_LINES + 100} lines`);
    expect(result.content[0].text).toContain("rg");

    // repeating the identical windowed read is blocked; a ranged read is fine
    expect(read({ path: "big.ts" }, "call-11")).toMatchObject({ block: true });
    expect(read({ path: "big.ts" }, "call-11").reason).toContain("first 250 lines");
    expect(read({ path: "big.ts", offset: 300, limit: 50 }, "call-10")).toBeUndefined();
    expect(fire("tool_result", { toolName: "read", toolCallId: "call-10", content: [{ type: "text", text: "x" }] })).toBeUndefined();
  });

  test("leaves short files, binaries and missing files alone", () => {
    const { dir, read } = setup();
    writeFileSync(join(dir, "short.ts"), lines(BIG_FILE_LINES));
    writeFileSync(join(dir, "pic.png"), lines(BIG_FILE_LINES + 100));
    const short = { path: "short.ts" } as { path: string; limit?: number };
    const png = { path: "pic.png" } as { path: string; limit?: number };
    expect(read(short)).toBeUndefined();
    expect(short.limit).toBeUndefined();
    expect(read(png)).toBeUndefined();
    expect(png.limit).toBeUndefined();
    expect(read({ path: "missing.ts" })).toBeUndefined();
  });

  test("countLines matches wc -l semantics", () => {
    const { dir } = setup();
    const f = join(dir, "c.txt");
    writeFileSync(f, "a\nb\nc\n");
    expect(countLines(f, 6)).toBe(3);
    writeFileSync(f, "a\nb");
    expect(countLines(f, 3)).toBe(2);
    writeFileSync(f, "");
    expect(countLines(f, 0)).toBe(0);
  });
});
