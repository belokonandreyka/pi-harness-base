import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cacheTelemetryExtension, { hasWarmRowSince } from "./index.ts";

const ORIGINAL_DIR = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_DIR;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cache-telemetry-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, any>();
  cacheTelemetryExtension({ on: (e: string, h: any) => handlers.set(e, h), registerCommand: () => {}, sendMessage: () => {} });
  const file = join(dir, "telemetry", "cache-usage.jsonl");
  const rows = () => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const ctx = { model: { provider: "gw", id: "m", promptCache: { short: 280 } }, isIdle: () => true, ui: { notify: () => {} } };
  return { handlers, rows, ctx, file, dir };
}

describe("cache-telemetry hooks", () => {
  test("logs pi's warm replays and their status, ignores real requests", () => {
    const t = setup();
    t.handlers.get("before_provider_request")({ payload: { max_tokens: 32000, messages: [] } }, t.ctx);
    t.handlers.get("after_provider_response")({ status: 200 }, t.ctx);
    expect(t.rows().length).toBe(0);
    t.handlers.get("before_provider_request")({ payload: { max_tokens: 1, messages: [] } }, t.ctx);
    t.handlers.get("after_provider_response")({ status: 502 }, t.ctx);
    const r = t.rows();
    expect(r.map((x: any) => x.kind)).toEqual(["warm_attempt", "warm_result"]);
    expect(r[1].status).toBe(502);
  });

  test("hasWarmRowSince reads only the tail and honours the timestamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-"));
    const f = join(dir, "log.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, [
      JSON.stringify({ ts: "2026-09-24T10:00:00Z", kind: "warm" }),
      JSON.stringify({ ts: "2026-09-24T10:05:00Z", kind: "request" }),
    ].join("\n") + "\n");
    expect(hasWarmRowSince(f, Date.parse("2026-09-24T09:59:00Z"))).toBe(true);
    expect(hasWarmRowSince(f, Date.parse("2026-09-24T10:01:00Z"))).toBe(false);
    expect(hasWarmRowSince(join(dir, "missing.jsonl"), 0)).toBe(false);
  });
});
