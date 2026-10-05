process.env.TZ = "UTC";

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import copilotPace, { CUSTOM_TYPE } from "./index.ts";
import { completedDates, computePace, dailyCredits, DAY_MS, paceLine, paceNote, periodStart, recordReading } from "./pace.ts";

const RESET = "2026-11-01T00:00:00Z";
const at = (iso: string) => Date.parse(iso);

describe("computePace", () => {
	test("2026-10-03: 23k of 60k in under three days is over pace", () => {
		const now = at("2026-10-03T14:00:00Z");
		const p = computePace(23_000, 60_000, RESET, now, { date: "2026-10-03", at: at("2026-10-02T21:00:00Z"), used: 22_500 })!;
		expect(p.level).toBe("over");
		expect(Math.round(p.budgetPerDay)).toBe(Math.round(37_000 / ((at(RESET) - now) / DAY_MS)));
		expect(Math.round(p.avgPerDay)).toBe(Math.round(23_000 / ((now - at("2026-10-01T00:00:00Z")) / DAY_MS)));
		expect(p.today).toBe(500);
		expect(Math.floor(p.runOutDays)).toBe(4);
	});

	test("critical when the quota is gone within three days or under 5% is left", () => {
		expect(computePace(45_000, 60_000, RESET, at("2026-10-05T00:00:00Z"))!.level).toBe("critical");
		expect(computePace(57_500, 60_000, RESET, at("2026-10-29T00:00:00Z"))!.level).toBe("critical");
	});

	test("ok on an even pace, high-today when today alone is over twice the daily budget", () => {
		const now = at("2026-10-16T12:00:00Z");
		expect(computePace(20_000, 60_000, RESET, now, { date: "2026-10-16", at: now - 3600_000, used: 19_500 })!.level).toBe("ok");
		const busy = computePace(20_000, 60_000, RESET, now, { date: "2026-10-16", at: now - 3600_000, used: 13_000 })!;
		expect(busy.level).toBe("high-today");
		expect(busy.today).toBe(7_000);
	});

	test("the first hours of a period do not read as a runaway", () => {
		const p = computePace(500, 60_000, RESET, at("2026-10-01T04:00:00Z"))!;
		expect(p.avgPerDay).toBe(500);
		expect(p.level).toBe("ok");
	});

	test("no pace without a quota or a reset date", () => {
		expect(computePace(0, 0, RESET, Date.now())).toBeUndefined();
		expect(computePace(10, 100, "not a date", Date.now())).toBeUndefined();
	});
});

describe("recordReading", () => {
	test("the day's baseline is the last reading before the day began", () => {
		let s = recordReading({}, 22_000, RESET, at("2026-10-02T20:00:00Z"));
		s = recordReading(s, 22_500, RESET, at("2026-10-02T21:00:00Z"));
		s = recordReading(s, 22_800, RESET, at("2026-10-03T08:00:00Z"));
		expect(s.dayStart).toEqual({ date: "2026-10-03", at: at("2026-10-02T21:00:00Z"), used: 22_500 });
		s = recordReading(s, 23_000, RESET, at("2026-10-03T14:00:00Z"));
		expect(s.dayStart?.used).toBe(22_500);
		expect(s.last).toEqual({ at: at("2026-10-03T14:00:00Z"), used: 23_000, resetIso: RESET });
	});

	test("a new period starts from zero on its first day and from the reading on a later one", () => {
		const old = { last: { at: at("2026-09-30T20:00:00Z"), used: 59_000, resetIso: "2026-10-01T00:00:00Z" } };
		expect(recordReading(old, 300, RESET, at("2026-10-01T09:00:00Z")).dayStart).toEqual({ date: "2026-10-01", at: periodStart(at(RESET)), used: 0 });
		expect(recordReading({}, 9_000, RESET, at("2026-10-03T09:00:00Z")).dayStart).toEqual({ date: "2026-10-03", at: at("2026-10-03T09:00:00Z"), used: 9_000 });
	});
});

describe("spike days", () => {
	const october = (extra: Record<string, number> = {}) =>
		new Map(Object.entries({ "2026-10-01": 15_415, "2026-10-02": 6_792, "2026-10-03": 647, "2026-10-05": 233, ...extra }));
	const now = at("2026-10-05T12:00:00Z");

	test("2026-10-05: the two migration days are one-offs, the other days set the pace", () => {
		const p = computePace(23_285, 60_000, RESET, now, undefined, { days: october() })!;
		expect(p.basis).toBe("without-spikes");
		expect(p.spikes).toEqual([
			{ date: "2026-10-01", credits: 15_415 },
			{ date: "2026-10-02", credits: 6_792 },
		]);
		expect(p.typicalPerDay).toBe((647 + 0) / 2);
		expect(p.today).toBe(233);
		expect(p.level).toBe("ok");
		expect(paceLine(p, now)).toContain("without 2 spike days (10-01 15k, 10-02 6.8k) treated as one-off: 324/day");
		// Without daily data the same numbers read as over pace.
		expect(computePace(23_285, 60_000, RESET, now)!.level).toBe("over");
	});

	test("a third spike day makes the average the pace", () => {
		const p = computePace(28_285, 60_000, RESET, now, undefined, { days: october({ "2026-10-04": 5_000 }) })!;
		expect(p.basis).toBe("spike-pattern");
		expect(p.typicalPerDay).toBe(p.avgPerDay);
		expect(p.level).toBe("over");
		expect(paceLine(p, now)).toContain("3 spike days this period (10-01 15k, 10-02 6.8k, 10-04 5.0k) are a pattern");
	});

	test("a spike in progress still shows as high-today", () => {
		const p = computePace(28_285, 60_000, RESET, now, undefined, { days: october({ "2026-10-05": 5_233 }) })!;
		expect(p.basis).toBe("without-spikes");
		expect(p.level).toBe("high-today");
	});

	test("maxSpikeDays 0 turns the exclusion off", () => {
		expect(computePace(23_285, 60_000, RESET, now, undefined, { days: october(), maxSpikeDays: 0 })!.basis).toBe("spike-pattern");
	});

	test("dailyCredits sums Copilot request rows per local day", () => {
		const rows = [
			{ ts: "2026-09-30T23:00:00Z", kind: "request", provider: "github-copilot", cost: 1 },
			{ ts: "2026-10-01T08:00:00Z", kind: "request", provider: "github-copilot", cost: 1.5 },
			{ ts: "2026-10-01T09:00:00Z", kind: "warm", provider: "github-copilot", cost: 9 },
			{ ts: "2026-10-01T10:00:00Z", kind: "request", provider: "vitu-gateway", cost: 9 },
			{ ts: "2026-10-02T10:00:00Z", kind: "request", provider: "github-copilot", cost: 0.25 },
		].map((r) => JSON.stringify(r));
		const days = dailyCredits([...rows, "not json", ""], at("2026-10-01T00:00:00Z"), 100);
		expect([...days]).toEqual([
			["2026-10-01", 150],
			["2026-10-02", 25],
		]);
	});

	test("completedDates runs from the period's first day to yesterday", () => {
		expect(completedDates(at("2026-10-01T00:00:00Z"), now)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
		expect(completedDates(at("2026-10-01T00:00:00Z"), at("2026-10-01T05:00:00Z"))).toEqual([]);
	});
});

describe("text", () => {
	test("line and note carry the numbers and the routing rule", () => {
		const now = at("2026-10-03T14:00:00Z");
		const p = computePace(23_000, 60_000, RESET, now, { date: "2026-10-03", at: at("2026-10-02T21:00:00Z"), used: 22_500 })!;
		const line = paceLine(p, now);
		expect(line).toStartWith("Copilot credits: 23k of 60k used, reset in 29d; 1.3k/day lasts until the reset; average so far 8.9k/day, today 500 (since 10-02 21:00)");
		expect(line).toContain("gone in ~4d");
		expect(paceNote(p, now)).toContain("Implementation only on the default worker type");
		expect(paceNote(p, now, undefined, { "high-today": "a", over: "use worker", critical: "c" })).toEndWith(" use worker");
		const ok = computePace(3_000, 60_000, RESET, at("2026-10-10T00:00:00Z"))!;
		expect(paceNote(ok, at("2026-10-10T00:00:00Z"), "over")).toEndWith("Back on pace (was over): normal routing.");
	});
});

describe("extension", () => {
	const realFetch = globalThis.fetch;
	let dir = "";
	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_COLLAB_SUBAGENT_DEPTH;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function harness(remaining: number) {
		dir = mkdtempSync(join(tmpdir(), "copilot-pace-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { entitlement: 60_000, remaining } }, quota_reset_date_utc: new Date(Date.now() + 28 * DAY_MS).toISOString() }))) as typeof fetch;
		const handlers = new Map<string, (event: any, ctx?: any) => any>();
		const pi: any = {
			on: (name: string, fn: any) => handlers.set(name, fn),
			exec: async () => ({ code: 0, stdout: "test-token\n", stderr: "" }),
			registerCommand: () => {},
		};
		copilotPace(pi);
		return handlers;
	}

	test("notes the coordinator once per level change and tags subagent results", async () => {
		const h = harness(37_000);
		const first = await h.get("before_agent_start")!({});
		expect(first.message.customType).toBe(CUSTOM_TYPE);
		expect(first.message.details.level).not.toBe("ok");
		expect(await h.get("before_agent_start")!({})).toBeUndefined();
		const tagged = h.get("tool_result")!({ toolName: "subagent", content: [{ type: "text", text: "launched" }] });
		expect(tagged.content.at(-1).text).toStartWith("[copilot-pace: ");
		expect(h.get("tool_result")!({ toolName: "bash", content: [] })).toBeUndefined();
		expect(JSON.parse(readFileSync(join(dir, "state", "copilot-pace.json"), "utf-8")).last.used).toBe(23_000);
	});

	test("subagents load nothing", () => {
		process.env.PI_COLLAB_SUBAGENT_DEPTH = "1";
		expect(harness(37_000).size).toBe(0);
	});
});
