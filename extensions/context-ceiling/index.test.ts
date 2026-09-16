import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextCeilingExtension, { DEFAULT_RESERVE_TOKENS, loadConfig } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_ENV_CEILING = process.env.PI_CONTEXT_CEILING;
const tempDirs: string[] = [];

afterEach(() => {
  if (typeof ORIGINAL_AGENT_DIR === "string") process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  else delete process.env.PI_CODING_AGENT_DIR;
  if (typeof ORIGINAL_ENV_CEILING === "string") process.env.PI_CONTEXT_CEILING = ORIGINAL_ENV_CEILING;
  else delete process.env.PI_CONTEXT_CEILING;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(fileConfig?: Record<string, unknown>, envCeiling?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "ceiling-ext-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (envCeiling === undefined) delete process.env.PI_CONTEXT_CEILING;
  else process.env.PI_CONTEXT_CEILING = envCeiling;
  if (fileConfig) writeFileSync(join(agentDir, "context-ceiling.json"), JSON.stringify(fileConfig), "utf-8");

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  contextCeilingExtension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
  } as any);

  const notes: Array<{ text: string; level?: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const model = { provider: "github-copilot", id: "claude-opus-5", contextWindow: 1_000_000 };
  const ctx = {
    model,
    hasUI: true,
    ui: { notify: (text: string, level?: string) => notes.push({ text, level }), setStatus: (k: string, t?: string) => statuses.push([k, t]) },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 9 }),
  };
  return { agentDir, handlers, commands, ctx, model, notes, statuses };
}

describe("loadConfig", () => {
  test("is disabled without a config file", () => {
    const { agentDir } = setup();
    expect(loadConfig(agentDir, {})).toEqual({ enabled: false, ceilingTokens: 0, reserveTokens: DEFAULT_RESERVE_TOKENS });
  });

  test("reads the file and lets the env override it", () => {
    const { agentDir } = setup({ enabled: true, ceilingTokens: 120000, reserveTokens: 20000 });
    expect(loadConfig(agentDir, {})).toEqual({ enabled: true, ceilingTokens: 120000, reserveTokens: 20000 });
    expect(loadConfig(agentDir, { PI_CONTEXT_CEILING: "80000" })).toMatchObject({ enabled: true, ceilingTokens: 80000 });
    expect(loadConfig(agentDir, { PI_CONTEXT_CEILING: "off" })).toMatchObject({ enabled: false });
    expect(loadConfig(agentDir, { PI_CONTEXT_CEILING: "0" })).toMatchObject({ enabled: false });
  });

  test("refuses ceilings that are too small or malformed", () => {
    const { agentDir } = setup({ enabled: true, ceilingTokens: 5000 });
    expect(loadConfig(agentDir, {}).enabled).toBe(false);
    expect(loadConfig(agentDir, { PI_CONTEXT_CEILING: "banana" }).enabled).toBe(false);
  });
});

describe("context-ceiling wiring", () => {
  test("clamps the active model window to ceiling + reserve on the lifecycle events", () => {
    const { handlers, ctx, model, statuses } = setup({ enabled: true, ceilingTokens: 120000 });
    handlers.get("session_start")?.({}, ctx);
    expect(model.contextWindow).toBe(120000 + DEFAULT_RESERVE_TOKENS);
    expect(statuses.at(-1)).toEqual(["ceiling", "ctx≤120k"]);

    // a registry refresh may hand pi a fresh model object; re-clamp on turn_start
    const fresh = { provider: "claude-bridge", id: "claude-opus-5", contextWindow: 1_000_000 };
    handlers.get("turn_start")?.({}, { ...ctx, model: fresh });
    expect(fresh.contextWindow).toBe(120000 + DEFAULT_RESERVE_TOKENS);
  });

  test("never raises a window that is already smaller than the ceiling", () => {
    const { handlers, ctx, model } = setup({ enabled: true, ceilingTokens: 300000 });
    model.contextWindow = 200000;
    handlers.get("before_agent_start")?.({}, ctx);
    expect(model.contextWindow).toBe(200000);
  });

  test("does nothing when disabled and restores the window via /ceiling off", async () => {
    const { handlers, commands, ctx, model, notes } = setup({ enabled: false, ceilingTokens: 120000 });
    handlers.get("session_start")?.({}, ctx);
    expect(model.contextWindow).toBe(1_000_000);

    await commands.get("ceiling")?.handler("on", ctx);
    expect(model.contextWindow).toBe(120000 + DEFAULT_RESERVE_TOKENS);
    expect(notes.at(-1)?.text).toContain("enabled at 120,000");

    await commands.get("ceiling")?.handler("80k", ctx);
    expect(model.contextWindow).toBe(80000 + DEFAULT_RESERVE_TOKENS);

    await commands.get("ceiling")?.handler("off", ctx);
    expect(model.contextWindow).toBe(1_000_000);
    expect(notes.at(-1)?.text).toContain("disabled");

    await commands.get("ceiling")?.handler("500", ctx);
    expect(notes.at(-1)?.level).toBe("warning");
    expect(model.contextWindow).toBe(1_000_000);
  });

  test("env override wins over the file", () => {
    const { handlers, ctx, model } = setup({ enabled: true, ceilingTokens: 120000 }, "60000");
    handlers.get("session_start")?.({}, ctx);
    expect(model.contextWindow).toBe(60000 + DEFAULT_RESERVE_TOKENS);
  });
});
