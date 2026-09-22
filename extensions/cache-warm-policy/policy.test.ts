import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countRunningChildren, decide, DEFAULT_CONFIG, loadConfig } from "./policy.ts";

const base = { idle: true, contextTokens: 100_000, childrenRunning: 0, secondsSinceRealRequest: 60 };

describe("cache-warm-policy decide", () => {
  test("leaves active runs and small contexts to pi", () => {
    expect(decide({ ...base, idle: false }, DEFAULT_CONFIG).action).toBeUndefined();
    expect(decide({ ...base, contextTokens: 12_000 }, DEFAULT_CONFIG).action).toBeUndefined();
    expect(decide(base, { ...DEFAULT_CONFIG, enabled: false }).action).toBeUndefined();
  });

  test("always warms while a subagent is running, however long the wait", () => {
    const d = decide({ ...base, childrenRunning: 2, secondsSinceRealRequest: 50 * 60 }, DEFAULT_CONFIG);
    expect(d.action).toBe("warm");
    expect(d.reason).toContain("2 subagent");
  });

  test("warms for the first 15 idle minutes, then stops", () => {
    expect(decide({ ...base, secondsSinceRealRequest: 14 * 60 }, DEFAULT_CONFIG).action).toBe("warm");
    expect(decide({ ...base, secondsSinceRealRequest: 16 * 60 }, DEFAULT_CONFIG).action).toBe("stop");
    expect(decide({ ...base, secondsSinceRealRequest: null }, DEFAULT_CONFIG).action).toBeUndefined();
  });

  test("unknown context size does not block the policy", () => {
    expect(decide({ ...base, contextTokens: null }, DEFAULT_CONFIG).action).toBe("warm");
  });
});

describe("cache-warm-policy helpers", () => {
  test("counts only fresh running children of this process", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwp-runs-"));
    const now = Date.parse("2026-01-02T12:00:00Z");
    const rec = (name: string, over: Record<string, unknown>) =>
      writeFileSync(join(dir, name), JSON.stringify({ status: "running", parentPid: 42, startedAt: "2026-01-02T11:50:00Z", ...over }));
    rec("a.json", {});
    rec("b.json", { status: "completed" });
    rec("c.json", { parentPid: 7 });
    rec("d.json", { startedAt: "2026-01-01T00:00:00Z" }); // leftover of a crashed session
    writeFileSync(join(dir, "e.json"), "{torn");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(countRunningChildren(dir, 42, 180, now)).toBe(1);
    expect(countRunningChildren(join(dir, "missing"), 42, 180, now)).toBe(0);
  });

  test("config falls back per field", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwp-cfg-"));
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    writeFileSync(join(dir, "cache-warm-policy.json"), JSON.stringify({ idleMinutes: 10, minContextTokens: "x" }));
    expect(loadConfig(dir)).toEqual({ ...DEFAULT_CONFIG, idleMinutes: 10 });
  });
});
