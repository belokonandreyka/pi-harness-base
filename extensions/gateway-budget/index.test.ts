import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gatewayBudgetExtension, {
  DEFAULT_CONFIG,
  reconcileLedger,
  scanSessionSpend,
  STATUS_KEY,
  formatStatus,
  loadConfig,
  periodStarts,
  readLedger,
  sessionGatewaySpend,
  sumSince,
} from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gw-budget-"));
  dirs.push(d);
  return d;
}
const gw = (total: number, provider = "gateway") => ({ type: "message", message: { role: "assistant", provider, usage: { cost: { total } } } });

describe("gateway-budget", () => {
  test("calendar week starts on Monday", () => {
    const wed = new Date(2026, 8, 9, 15, 0); // Wed 2026-09-09
    const { week, month } = periodStarts(wed);
    expect(week.toISOString().slice(0, 10)).toBe(new Date(2026, 8, 7).toISOString().slice(0, 10));
    expect(month.getDate()).toBe(1);
    const mon = new Date(2026, 8, 7, 9, 0);
    expect(periodStarts(mon).week.getDate()).toBe(7);
  });

  test("session spend counts only the configured gateway providers", () => {
    const spend = sessionGatewaySpend([gw(1.5), gw(0.5, "gateway-openai"), gw(9, "github-copilot")], DEFAULT_CONFIG.providers);
    expect(spend).toBeCloseTo(2.0, 6);
  });

  test("records deltas per session into the shared ledger and shows week/month totals", () => {
    const dir = tmp();
    const ledger = join(dir, "ledger.jsonl");
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "gateway-budget.json"), JSON.stringify({ ledger, weeklyCap: 250, monthlyCap: 1000, reconcileDays: 0 }));
    // Another session already spent $10 this week.
    writeFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), session: "other", delta: 10 }) + "\n");

    const handlers = new Map<string, any>();
    gatewayBudgetExtension({ on: (e: string, h: any) => handlers.set(e, h), registerCommand: () => {} } as any);
    const statuses: Array<[string, string]> = [];
    const branch: any[] = [gw(2.25)];
    const ctx = {
      model: { provider: "gateway", id: "claude-opus-5" },
      sessionManager: { getSessionId: () => "sess-1", getBranch: () => branch },
      ui: { setStatus: (k: string, v: string) => statuses.push([k, v]) },
    };
    handlers.get("session_start")({}, ctx);
    handlers.get("turn_end")({}, ctx);
    branch.push(gw(0.75));
    handlers.get("turn_end")({}, ctx);
    handlers.get("turn_end")({}, ctx); // no new spend → no new entry

    const entries = readLedger(ledger);
    expect(entries.map((e) => [e.session, e.delta])).toEqual([["other", 10], ["sess-1", 2.25], ["sess-1", 0.75]]);
    expect(statuses.at(-1)).toEqual([STATUS_KEY, "gw wk $13.0/250 · mo $13.0/1000"]);
  });

  test("status flags 80% and 100% of a cap, and a cap of 0 shows a bare total", () => {
    const caps = { ...DEFAULT_CONFIG, weeklyCap: 250, monthlyCap: 1000 };
    expect(formatStatus(210, 300, caps)).toBe("gw wk $210/250 ⚠ · mo $300/1000");
    expect(formatStatus(260, 990, caps)).toBe("gw wk $260/250 ⛔ · mo $990/1000 ⚠");
    expect(formatStatus(12.3, 300, { ...caps, monthlyCap: 0 })).toBe("gw wk $12.3/250 · mo $300");
  });

  test("weekFloor moves the week start to an admin reset inside the week", () => {
    const now = new Date(2026, 8, 10, 23, 40); // Thu
    const { week } = periodStarts(now, new Date(2026, 8, 10, 23, 30).toISOString());
    expect(week.getDate()).toBe(10);
    expect(week.getHours()).toBe(23);
    // A floor before Monday or in the future is ignored.
    expect(periodStarts(now, new Date(2026, 8, 1).toISOString()).week.getDate()).toBe(7);
    expect(periodStarts(now, new Date(2026, 8, 12).toISOString()).week.getDate()).toBe(7);
  });

  test("sumSince ignores entries before the period start and torn ledger lines", () => {
    const dir = tmp();
    const ledger = join(dir, "l.jsonl");
    writeFileSync(ledger, [JSON.stringify({ ts: "2026-08-01T00:00:00Z", session: "a", delta: 5 }), "{broken", JSON.stringify({ ts: "2026-09-09T10:00:00Z", session: "b", delta: 3 })].join("\n") + "\n");
    const entries = readLedger(ledger);
    expect(entries).toHaveLength(2);
    expect(sumSince(entries, new Date("2026-09-01T00:00:00Z"))).toBe(3);
  });

  test("the timer picks up spend appended by another session", async () => {
    const dir = tmp();
    const ledger = join(dir, "ledger.jsonl");
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "gateway-budget.json"), JSON.stringify({ ledger, weeklyCap: 500, monthlyCap: 0, refreshSeconds: 0.05, reconcileDays: 0 }));
    writeFileSync(ledger, "");
    const handlers = new Map<string, any>();
    gatewayBudgetExtension({ on: (e: string, h: any) => handlers.set(e, h), registerCommand: () => {} } as any);
    const statuses: string[] = [];
    const ctx = { model: { provider: "gateway" }, sessionManager: { getSessionId: () => "me", getBranch: () => [] }, ui: { setStatus: (_k: string, v: string) => statuses.push(v) } };
    handlers.get("session_start")({}, ctx);
    expect(statuses.at(-1)).toBe("gw wk $0.0/500 · mo $0.0");
    // Another window spends while this one is idle.
    writeFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), session: "other", delta: 7.5 }) + "\n");
    await new Promise((r) => setTimeout(r, 150));
    expect(statuses.at(-1)).toBe("gw wk $7.5/500 · mo $7.5");
    handlers.get("session_shutdown")({}, ctx);
  });

  test("reconcile appends only what the ledger is missing for sessions found in session files", () => {
    const dir = tmp();
    const sessions = join(dir, "sessions", "proj");
    mkdirSync(sessions, { recursive: true });
    const line = (o: any) => JSON.stringify(o);
    const day = "2026-09-11";
    writeFileSync(
      join(sessions, "a.jsonl"),
      [
        line({ type: "session", id: "sess-a" }),
        line({ type: "message", timestamp: `${day}T08:00:00.000Z`, message: { role: "assistant", provider: "gateway", usage: { cost: { total: 1.5 } } } }),
        line({ type: "message", timestamp: `${day}T09:00:00.000Z`, message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 9 } } } }),
        line({ type: "message", timestamp: `${day}T10:00:00.000Z`, message: { role: "assistant", provider: "gateway", usage: { cost: { total: 0.5 } } } }),
      ].join("\n") + "\n",
    );
    const ledger = join(dir, "ledger.jsonl");
    // The ledger already knows $0.4 of sess-a (recorded by the live session earlier).
    writeFileSync(ledger, line({ ts: `${day}T08:30:00.000Z`, session: "sess-a", delta: 0.4 }) + "\n");
    const cfg = { ...DEFAULT_CONFIG, ledger, sessionsDir: join(dir, "sessions"), reconcileDays: 8, modelsFile: join(dir, "none.json") };

    const found = scanSessionSpend(cfg.sessionsDir, cfg.providers, 0);
    expect(found.get(`sess-a|${day}`)?.spend).toBeCloseTo(2.0, 6);

    const added = reconcileLedger(cfg, readLedger(ledger));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ session: "sess-a", delta: 1.6, source: "reconcile", ts: `${day}T10:00:00.000Z` });
    // Second pass: nothing more to add.
    expect(reconcileLedger(cfg, readLedger(ledger))).toHaveLength(0);
    expect(readLedger(ledger).reduce((s, e) => s + e.delta, 0)).toBeCloseTo(2.0, 6);
  });

  test("reconcile prices from tokens with current models.json rates, including old us.anthropic ids", () => {
    const dir = tmp();
    const sessions = join(dir, "sessions", "proj");
    mkdirSync(sessions, { recursive: true });
    const models = join(dir, "models.json");
    writeFileSync(models, JSON.stringify({ providers: { "gateway": { models: [{ id: "claude-opus-5", cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 } }] } } }));
    const line = (o: any) => JSON.stringify(o);
    writeFileSync(
      join(sessions, "old.jsonl"),
      [
        line({ type: "session", id: "sess-old" }),
        // Stored cost is the inflated pre-fix figure; tokens say $5.50 + $2.75 = $8.25 today.
        line({ type: "message", timestamp: "2026-09-04T12:00:00.000Z", message: { role: "assistant", provider: "gateway", model: "us.anthropic.claude-opus-5", usage: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, cost: { total: 22.0 } } } }),
      ].join("\n") + "\n",
    );
    const ledger = join(dir, "ledger.jsonl");
    const cfg = { ...DEFAULT_CONFIG, ledger, sessionsDir: join(dir, "sessions"), reconcileDays: 30, modelsFile: models };
    const added = reconcileLedger(cfg, [], new Date("2026-09-11T00:00:00Z"));
    expect(added).toHaveLength(1);
    expect(added[0].delta).toBeCloseTo(8.25, 6);
  });

  test("a Copilot worker keeps the ledger but hides the gateway status", () => {
    const dir = tmp();
    const ledger = join(dir, "ledger.jsonl");
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "gateway-budget.json"), JSON.stringify({ ledger, reconcileDays: 0, refreshSeconds: 0 }));
    const handlers = new Map<string, any>();
    gatewayBudgetExtension({ on: (e: string, h: any) => handlers.set(e, h), registerCommand: () => {} } as any);
    const statuses: Array<string | undefined> = [];
    const branch = [gw(1.25)]; // a gateway call earlier in this session
    const ctx: any = {
      model: { provider: "github-copilot", id: "claude-opus-5" },
      sessionManager: { getSessionId: () => "worker", getBranch: () => branch },
      ui: { setStatus: (_k: string, v: string | undefined) => statuses.push(v) },
    };
    handlers.get("session_start")({}, ctx);
    handlers.get("turn_end")({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
    expect(readLedger(ledger).map((e) => e.delta)).toEqual([1.25]); // still recorded
    // Switching to a gateway model shows it again.
    ctx.model = { provider: "gateway", id: "claude-opus-5" };
    handlers.get("model_select")({}, ctx);
    expect(statuses.at(-1)).toMatch(/^gw wk \$1\.3\/500 · mo \$1\.3$/);
  });

  test("config defaults", () => {
    expect(loadConfig("/nonexistent")).toEqual(DEFAULT_CONFIG);
    expect(readFileSync).toBeDefined();
  });
});
