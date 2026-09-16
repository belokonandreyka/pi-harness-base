import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import toolResultOffloadExtension, { DEFAULTS, loadConfig } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_ENV = process.env.PI_OFFLOAD_THRESHOLD;
const tempDirs: string[] = [];

afterEach(() => {
  if (typeof ORIGINAL_AGENT_DIR === "string") process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  else delete process.env.PI_CODING_AGENT_DIR;
  if (typeof ORIGINAL_ENV === "string") process.env.PI_OFFLOAD_THRESHOLD = ORIGINAL_ENV;
  else delete process.env.PI_OFFLOAD_THRESHOLD;
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function setup(fileConfig?: Record<string, unknown>, envThreshold?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "offload-ext-"));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (envThreshold === undefined) delete process.env.PI_OFFLOAD_THRESHOLD;
  else process.env.PI_OFFLOAD_THRESHOLD = envThreshold;
  const dir = join(agentDir, "offload");
  writeFileSync(join(agentDir, "tool-result-offload.json"), JSON.stringify({ dir, ...(fileConfig ?? {}) }), "utf-8");
  const handlers = new Map<string, Handler>();
  toolResultOffloadExtension({ on: (e: string, h: Handler) => handlers.set(e, h) } as any);
  const fire = (toolName: string, text: string, extra: any[] = [], id = "call-1") =>
    handlers.get("tool_result")?.({ type: "tool_result", toolName, toolCallId: id, content: [{ type: "text", text }, ...extra] }, {});
  return { agentDir, dir, handlers, fire };
}

describe("loadConfig", () => {
  test("defaults and env override", () => {
    const { agentDir } = setup();
    const c = loadConfig(agentDir, {});
    expect(c.enabled).toBe(true);
    expect(c.thresholdChars).toBe(DEFAULTS.thresholdChars);
    expect(loadConfig(agentDir, { PI_OFFLOAD_THRESHOLD: "10000" }).thresholdChars).toBe(10000);
    expect(loadConfig(agentDir, { PI_OFFLOAD_THRESHOLD: "0" }).enabled).toBe(false);
    expect(loadConfig(agentDir, { PI_OFFLOAD_THRESHOLD: "off" }).enabled).toBe(false);
  });

  test("disables itself when head + tail would not shrink anything", () => {
    const { agentDir } = setup({ thresholdChars: 1000, headChars: 800, tailChars: 300 });
    expect(loadConfig(agentDir, {}).enabled).toBe(false);
  });
});

describe("tool-result-offload", () => {
  test("offloads a big bash result to a file and keeps head, marker and tail", () => {
    const { dir, fire } = setup({ thresholdChars: 2000, headChars: 300, tailChars: 100 });
    const big = Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n");
    const result = fire("bash", big, [], "abc-1");
    expect(result).toBeDefined();
    const text = result.content[0].text;
    expect(text.startsWith(big.slice(0, 300))).toBe(true);
    expect(text.endsWith(big.slice(-100))).toBe(true);
    expect(text).toContain("tool-result-offload");
    expect(text).toContain("Do not re-run");
    const path = join(dir, "bash-abc-1.txt");
    expect(text).toContain(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(big);
    expect(text.length).toBeLessThan(big.length / 3);
  });

  test("leaves small results, read results and image results untouched", () => {
    const { fire } = setup({ thresholdChars: 2000, headChars: 300, tailChars: 100 });
    const big = "y".repeat(5000);
    expect(fire("bash", "z".repeat(1999))).toBeUndefined();
    expect(fire("read", big)).toBeUndefined();
    expect(fire("bash", big, [{ type: "image", data: "abc", mimeType: "image/png" }])).toBeUndefined();
  });

  test("honours an explicit tools allowlist", () => {
    const { fire } = setup({ thresholdChars: 2000, headChars: 300, tailChars: 100, tools: ["mcp"] });
    const big = "y".repeat(5000);
    expect(fire("bash", big)).toBeUndefined();
    expect(fire("mcp", big, [], "m1")).toBeDefined();
  });

  test("does nothing at all when disabled via env", () => {
    const { handlers } = setup({ thresholdChars: 2000 }, "0");
    expect(handlers.has("tool_result")).toBe(false);
  });
});
