import { describe, expect, test } from "bun:test";
import { formatStats, logPath, parseEntries, profileLabel, summarize, type CacheEntry } from "./stats.ts";

const req = (over: Partial<Extract<CacheEntry, { kind: "request" }>>): CacheEntry => ({
  ts: "2026-01-02T10:00:00.000Z", profile: "pi", run: "r1", kind: "request", provider: "gw", model: "big",
  input: 10, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, gapSec: 5, ...over,
});

describe("cache-telemetry stats", () => {
  test("labels the profile after the directory holding the agent dir", () => {
    expect(profileLabel("/home/u/.pi-sub/agent")).toBe("pi-sub");
    expect(logPath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/telemetry/cache-usage.jsonl");
  });

  test("skips torn and foreign lines", () => {
    const text = `${JSON.stringify(req({}))}\n{"kind":"other"}\n{broken\n\n`;
    expect(parseEntries(text)).toHaveLength(1);
  });

  test("separates caches kept across a long pause from caches lost", () => {
    const stats = summarize([
      req({ gapSec: null, cacheWrite: 20000 }), // first request: never counted as a miss
      req({ gapSec: 400, cacheRead: 20000, cacheWrite: 300 }), // pause survived
      req({ gapSec: 600, cacheRead: 0, cacheWrite: 20500 }), // cache lost
      req({ gapSec: 12, cacheRead: 0, cacheWrite: 21000 }), // prefix changed mid-run
      req({ gapSec: 900, cacheRead: 0, cacheWrite: 900 }), // tiny prompt: ignored
    ]);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.requests).toBe(5);
    expect(s.longGapHits).toBe(1);
    expect(s.longGapMisses).toBe(1);
    expect(s.longGapMissTokens).toBe(20510);
    expect(s.shortGapMisses).toBe(1);
  });

  test("adds up warming decisions and honours the time window", () => {
    const warm = (action: "warm" | "stop", ts: string): CacheEntry => ({
      ts, profile: "pi", run: "r1", kind: "warm_decision", provider: "gw", model: "big", action, warmCost: 0.01, missCost: 0.08, probability: 1,
    });
    const entries = [warm("warm", "2026-01-02T10:00:00Z"), warm("warm", "2026-01-02T11:00:00Z"), warm("stop", "2026-01-02T12:00:00Z"), warm("warm", "2025-12-01T00:00:00Z")];
    const s = summarize(entries, Date.parse("2026-01-01T00:00:00Z"))[0];
    expect(s.warmCount).toBe(2);
    expect(s.stopCount).toBe(1);
    expect(s.warmCost).toBeCloseTo(0.02);
    expect(s.avoidedMissCost).toBeCloseTo(0.16);
  });

  test("a policy override moves a decision from stop to warm", () => {
    const at = "2026-01-02T10:00:00Z";
    const entries: CacheEntry[] = [
      { ts: at, profile: "pi", run: "r1", kind: "warm_decision", provider: "gw", model: "big", action: "stop", warmCost: 0.05, missCost: 0.6, probability: 0.15 },
      { ts: at, profile: "pi", run: "policy", kind: "warm_override", provider: "gw", model: "big", pi: "stop", final: "warm", reason: "waiting for 1 subagent(s)", warmCost: 0.05, missCost: 0.6 },
    ];
    const s = summarize(entries)[0];
    expect(s.warmCount).toBe(1);
    expect(s.stopCount).toBe(0);
    expect(s.policyWarms).toBe(1);
    expect(s.warmCost).toBeCloseTo(0.05);
    expect(formatStats([s], 1)).toContain("1 of the refreshes forced by policy");
  });

  test("groups by profile and model, most expensive first, and renders a report", () => {
    const stats = summarize([req({ cost: 0.5, cacheRead: 9000, input: 1000 }), req({ profile: "pi-sub", model: "small", cost: 2 })]);
    expect(stats.map((s) => s.key)).toEqual(["pi-sub · gw/small", "pi · gw/big"]);
    const text = formatStats(stats, 3);
    expect(text).toContain("last 3 day(s)");
    expect(text).toContain("from cache 90%");
    expect(formatStats([], 7)).toContain("no requests recorded");
  });
});

describe("cache-telemetry stats: gateway-warmer and pi-warmer rows", () => {
  test("counts refreshes, misses, skips, errors, pi replays and missing-refresh alarms", () => {
    const rows = [
      { ts: "2026-09-24T10:00:00Z", profile: "pi", run: "gateway-warmer", kind: "warm", provider: "gw", model: "m", input: 2, output: 1, cacheRead: 80000, cacheWrite: 0, cost: 0.045, reason: "idle 4m <= 15m" },
      { ts: "2026-09-24T10:04:00Z", profile: "pi", run: "gateway-warmer", kind: "warm", provider: "gw", model: "m", input: 2, output: 1, cacheRead: 0, cacheWrite: 80000, cost: 0.55, reason: "idle 8m <= 15m" },
      { ts: "2026-09-24T10:08:00Z", profile: "pi", run: "gateway-warmer", kind: "warm_skip", provider: "gw", model: "m", reason: "idle past 15m" },
      { ts: "2026-09-24T10:09:00Z", profile: "pi", run: "gateway-warmer", kind: "warm_error", provider: "gw", model: "m", status: 502 },
      { ts: "2026-09-24T10:10:00Z", profile: "pi", run: "r", kind: "warm_attempt", provider: "gw", model: "m" },
      { ts: "2026-09-24T10:10:01Z", profile: "pi", run: "r", kind: "warm_result", provider: "gw", model: "m", status: 200 },
      { ts: "2026-09-24T10:14:00Z", profile: "pi", run: "r", kind: "warm_attempt", provider: "gw", model: "m" },
      { ts: "2026-09-24T10:14:01Z", profile: "pi", run: "r", kind: "warm_result", provider: "gw", model: "m", status: 500 },
      { ts: "2026-09-24T10:20:00Z", profile: "pi", run: "r", kind: "warm_missing", provider: "gw", model: "m", reason: "idle 4m" },
    ].map((r) => JSON.stringify(r)).join("\n");
    const [s] = summarize(parseEntries(rows));
    expect(s.gwWarms).toBe(2);
    expect(s.gwWarmMisses).toBe(1);
    expect(s.gwWarmCost).toBeCloseTo(0.595, 6);
    expect(s.gwSkips).toBe(1);
    expect(s.gwErrors).toBe(1);
    expect(s.piWarmAttempts).toBe(2);
    expect(s.piWarmFailures).toBe(1);
    expect(s.warmMissing).toBe(1);
    const report = formatStats([s], 1);
    expect(report).toContain("gateway-warmer: 2 refreshes for $0.595 (1 found the cache already gone), 1 skipped, 1 errors");
    expect(report).toContain("pi warmer: 2 replays sent, 1 failed at the gateway · 1 idle stretches with no refresh at all");
  });
});
