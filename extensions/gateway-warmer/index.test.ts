import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gatewayWarmerExtension, { buildWarmPayload, costOf, isReplayable, refreshDelayMs, warmHeaders } from "./index.ts";

const ORIGINAL_DIR = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_DIR;
});

const model = { provider: "gateway", id: "claude-opus-5", api: "anthropic-messages", baseUrl: "https://gw.example/anthropic",
  promptCache: { short: 280 }, cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 } };

function harness(opts: { children?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw-warmer-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (opts.children) {
    mkdirSync(join(dir, "collaborating-agents", "runs"), { recursive: true });
    for (let i = 0; i < opts.children; i++) {
      writeFileSync(join(dir, "collaborating-agents", "runs", `r${i}.json`), JSON.stringify({ status: "running", parentPid: process.pid, startedAt: new Date().toISOString() }));
    }
  }
  const clock = { t: 1_000_000 };
  const timers: Array<{ fn: () => unknown; at: number }> = [];
  const calls: any[] = [];
  const handlers = new Map<string, any>();
  let response: any = { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0 } }) };
  gatewayWarmerExtension({ on: (e: string, h: any) => handlers.set(e, h) }, {
    now: () => clock.t,
    fetch: (async (url: string, init: any) => { calls.push({ url, init }); return response; }) as any,
    setTimer: (fn, ms) => { const t = { fn, at: clock.t + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as any); if (i >= 0) timers.splice(i, 1); },
  });
  const ctx = { model, getContextUsage: () => ({ tokens: 90_000 }), modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }) }, ui: { notify: () => {} } };
  const fire = async () => { const t = timers.shift(); if (!t) return null; clock.t = Math.max(clock.t, t.at); await t.fn(); return t; };
  const log = () => { const p = join(dir, "telemetry", "cache-usage.jsonl"); return existsSync(p) ? readFileSync(p, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  const realTurn = () => {
    handlers.get("agent_start")?.({}, ctx);
    handlers.get("before_provider_request")?.({ payload: { model: "claude-opus-5", max_tokens: 32000, stream: true, messages: [{ role: "user", content: "hi" }] } });
    handlers.get("before_provider_headers")?.({ headers: { "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "real" } });
    handlers.get("turn_end")?.({ message: { role: "assistant", usage: { input: 1 } } }, ctx);
    handlers.get("agent_end")?.({}, ctx);
  };
  return { clock, timers, calls, handlers, ctx, fire, log, realTurn, setResponse: (r: any) => { response = r; } };
}

describe("gateway-warmer", () => {
  test("pure helpers", () => {
    expect(buildWarmPayload({ a: 1, stream: true, max_tokens: 4096 })).toEqual({ a: 1, max_tokens: 1 });
    expect(refreshDelayMs(280_000)).toBe(252_000);
    expect(isReplayable({ messages: [] })).toBe(true);
    expect(isReplayable({ thinking: { type: "adaptive" }, output_config: { effort: "high" } })).toBe(true);
    expect(isReplayable({ thinking: { type: "enabled", budget_tokens: 1024 } })).toBe(false);
    expect(refreshDelayMs(5_000)).toBeNull();
    expect(costOf(model, { input: 0, output: 1, cacheRead: 100_000, cacheWrite: 0 })).toBeCloseTo(0.0550275, 6);
    const h = warmHeaders({ apiKey: "k", headers: {} }, { "anthropic-beta": "b1", "x-api-key": "leak" });
    expect(h["anthropic-beta"]).toBe("b1");
    expect(h["x-api-key"]).toBe("k");
    expect(h.authorization).toBe("Bearer k");
  });

  test("warms at 90% of the lifetime after a turn, non-streaming, and keeps going while idle <= 15 min", async () => {
    const h = harness();
    h.realTurn();
    expect(h.timers.length).toBe(1);
    expect(h.timers[0].at - h.clock.t).toBe(252_000);
    await h.fire();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].url).toBe("https://gw.example/anthropic/v1/messages");
    const body = JSON.parse(h.calls[0].init.body);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBeUndefined();
    expect(h.calls[0].init.headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
    const rows = h.log();
    expect(rows.at(-1).kind).toBe("warm");
    expect(rows.at(-1).cacheRead).toBe(80_000);
    expect(h.timers.length).toBe(1); // rescheduled from the warm
    await h.fire(); await h.fire(); // 3 warms = 12.6 min idle
    expect(h.calls.length).toBe(3);
    await h.fire(); // 16.8 min: policy says stop
    expect(h.calls.length).toBe(3);
    expect(h.log().at(-1).kind).toBe("warm_skip");
    expect(h.log().at(-1).reason).toContain("idle past");
  });

  test("keeps warming past 15 min while a subagent of this process runs", async () => {
    const h = harness({ children: 1 });
    h.realTurn();
    for (let i = 0; i < 6; i++) await h.fire();
    expect(h.calls.length).toBe(6);
    expect(h.log().filter((r: any) => r.kind === "warm").every((r: any) => r.reason.includes("subagent"))).toBe(true);
  });

  test("never warms during an active run, skips a refresh that would be too late, logs gateway errors", async () => {
    const h = harness();
    h.realTurn();
    h.handlers.get("agent_start")?.({}, h.ctx); // a new run cancels the timer
    expect(h.timers.length).toBe(0);
    h.handlers.get("turn_end")?.({ message: { role: "assistant", usage: { input: 1 } } }, h.ctx);
    h.handlers.get("agent_end")?.({}, h.ctx);
    h.clock.t += 400_000; // machine slept: the timer fires far too late
    await h.fire();
    expect(h.calls.length).toBe(0);
    expect(h.log().at(-1).kind).toBe("warm_skip");
    expect(h.log().at(-1).reason).toContain("too late");

    h.realTurn();
    h.setResponse({ ok: false, status: 429, json: async () => ({ error: { message: "slow down" } }) });
    await h.fire();
    expect(h.log().at(-1).kind).toBe("warm_error");
    expect(h.log().at(-1).status).toBe(429);
    expect(h.timers.length).toBe(0); // not rescheduled after an error
  });

  test("PI_GATEWAY_WARMER=0 disables", () => {
    process.env.PI_GATEWAY_WARMER = "0";
    const handlers = new Map<string, any>();
    gatewayWarmerExtension({ on: (e: string, h: any) => handlers.set(e, h) });
    delete process.env.PI_GATEWAY_WARMER;
    expect(handlers.size).toBe(0);
  });
});
