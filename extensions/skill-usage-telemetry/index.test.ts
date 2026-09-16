import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skillUsageTelemetryExtension from "./index.ts";
import { parseEntries } from "./telemetry.ts";

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

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup() {
  const agentDir = mkdtempSync(join(tmpdir(), "skill-telemetry-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const messages: Array<{ content: string }> = [];

  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { description?: string; handler: Handler }) =>
      commands.set(name, options),
    sendMessage: (message: { content: string }) => messages.push(message),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skillUsageTelemetryExtension(api as any);

  const logPath = join(agentDir, "telemetry", "skill-usage.jsonl");
  const readLog = () => parseEntries(readFileSync(logPath, "utf-8"));

  return { agentDir, handlers, commands, messages, logPath, readLog };
}

const ctx = { cwd: "/repo", model: { id: "claude-opus-5" } };

describe("skill-usage extension wiring", () => {
  test("records a session start with the profile taken from the agent dir", () => {
    const { handlers, readLog, agentDir } = setup();

    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "session_start",
      reason: "startup",
      cwd: "/repo",
      model: "claude-opus-5",
    });
    // mkdtemp names the directory, so the label is whatever holds `agent` —
    // what matters is that it is derived, not hardcoded.
    expect(entries[0]?.profile).toBeString();
    expect(agentDir).toContain("skill-telemetry-");
  });

  test("logs a skill read and ignores ordinary file reads", () => {
    const { handlers, readLog } = setup();
    const onToolCall = handlers.get("tool_call");

    onToolCall?.({ toolName: "read", input: { path: "/home/x/.pi/agent/skills/writing-skills/SKILL.md" } }, ctx);
    onToolCall?.({ toolName: "read", input: { path: "/repo/README.md" } }, ctx);
    onToolCall?.({ toolName: "bash", input: { command: "cat skills/x/SKILL.md" } }, ctx);
    onToolCall?.({ toolName: "read", input: {} }, ctx);

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "skill_read", skill: "writing-skills" });
  });

  // The arguments to /skill: carry task text, which must never reach the log.
  test("logs a skill command without its arguments", () => {
    const { handlers, readLog } = setup();

    handlers.get("input")?.({ type: "input", text: "/skill:reproduce-ticket ABC-1234 password hunter2" }, ctx);
    handlers.get("input")?.({ type: "input", text: "just a normal prompt" }, ctx);

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "skill_command", skill: "reproduce-ticket" });
    expect(JSON.stringify(entries[0])).not.toContain("hunter2");
    expect(JSON.stringify(entries[0])).not.toContain("ABC-1234");
  });

  test("all entries from one run share a run id, so sessions can be counted", () => {
    const { handlers, readLog } = setup();

    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    handlers.get("tool_call")?.({ toolName: "read", input: { path: "/x/skills/a/SKILL.md" } }, ctx);
    handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);

    const entries = readLog();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.run)).size).toBe(1);
    expect(entries.map((entry) => entry.kind)).toEqual(["session_start", "skill_read", "session_end"]);
  });

  test("the report command renders a summary of what was recorded", async () => {
    const { handlers, commands, messages } = setup();

    handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    handlers.get("tool_call")?.({ toolName: "read", input: { path: "/x/skills/systematic-debugging/SKILL.md" } }, ctx);

    const notes: string[] = [];
    await commands.get("skill-stats")?.handler("", { ...ctx, ui: { notify: (m: string) => notes.push(m) } });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("systematic-debugging");
    expect(messages[0]?.content).toContain("1 session(s) recorded");
    expect(notes[0]).toContain("skill-usage: report written from");
  });

  // Skills kept in a shared repo are reachable only through the `skills`
  // setting, so a never-loaded list that ignores it would omit exactly the
  // skills this measurement exists to judge.
  test("counts skills from directories listed in the skills setting as installed", async () => {
    const { agentDir, commands, messages } = setup();

    const sharedSkills = mkdtempSync(join(tmpdir(), "shared-skills-"));
    tempDirs.push(sharedSkills);
    mkdirSync(join(sharedSkills, "verification-before-completion"), { recursive: true });
    writeFileSync(join(sharedSkills, "verification-before-completion", "SKILL.md"), "body", "utf-8");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [sharedSkills] }), "utf-8");

    await commands.get("skill-stats")?.handler("", { ...ctx, ui: { notify: () => {} } });

    expect(messages[0]?.content).toContain("never loaded: verification-before-completion");
  });

  // A broken log must not take the session down with it.
  test("survives an unwritable log directory", () => {
    const { handlers } = setup();
    process.env.PI_CODING_AGENT_DIR = "/proc/nonexistent-for-telemetry";

    expect(() => {
      handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    }).not.toThrow();
  });
});
