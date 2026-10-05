/**
 * copilot-pace — tell the coordinator how fast the Copilot credits are going.
 *
 * The coordinator picks the model for every subagent, but it runs on another
 * provider and never sees the Copilot quota; on 2026-10-01 it spent a quarter of
 * the month's credits in one day without knowing it. This extension reads the
 * quota (same endpoint and Keychain token as copilot-usage), keeps the day's
 * baseline in `<agentDir>/state/copilot-pace.json`, and grades the pace:
 *
 *   ok          the average pace lasts until the reset
 *   high-today  today is above twice the daily budget
 *   over        at the average pace the quota is gone before the reset
 *   critical    gone within 3 days, or under 5% left
 *
 * The coordinator hears about it twice, both cheap for the prompt cache: a
 * note at the start of a turn whenever the level changes (and once a day while
 * it is not ok), appended after the history; and one line at the end of every
 * `subagent` result while the level is not ok, where the next routing choice
 * is made. Subagents (PI_COLLAB_SUBAGENT_DEPTH > 0) get nothing.
 *
 * Config `<agentDir>/copilot-pace.json`:
 *   { "enabled": true, "refreshMinutes": 15,
 *     "rules": { "high-today": "...", "over": "...", "critical": "..." } }
 * `rules` replaces the generic routing advice per level with the profile's own
 * subagent type names. `telemetryFiles` (default `<agentDir>/telemetry/cache-usage.jsonl`,
 * `~/` expanded) are the cache-telemetry logs whose Copilot rows give credits per
 * day (`creditsPerDollar`, default 100); with them, up to `maxSpikeDays` (2)
 * days over `spikeFactor` (2) × the even daily share count as one-offs and the
 * projection runs on the other days. Without them the average is the rate.
 * Command: /copilot-pace — refresh and show the numbers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchUsage, pickSnapshot, readTokenFromKeychain } from "../copilot-usage/quota.ts";
import { computePace, dailyCredits, DEFAULT_RULES, localDate, periodStart, paceLine, paceNote, recordReading, type Pace, type PaceLevel, type PaceRules, type PaceState } from "./pace.ts";

export const CUSTOM_TYPE = "copilot-pace";

interface Config {
	enabled: boolean;
	refreshMinutes: number;
	rules: PaceRules;
	/** cache-telemetry logs whose Copilot rows give the per-day breakdown. */
	telemetryFiles: string[];
	creditsPerDollar: number;
	spikeFactor: number;
	maxSpikeDays: number;
}

function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function loadConfig(dir: string): Config {
	const cfg: Config = {
		enabled: true,
		refreshMinutes: 15,
		rules: { ...DEFAULT_RULES },
		telemetryFiles: [join(dir, "telemetry", "cache-usage.jsonl")],
		creditsPerDollar: 100,
		spikeFactor: 2,
		maxSpikeDays: 2,
	};
	const file = join(dir, "copilot-pace.json");
	if (!existsSync(file)) return cfg;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<Config>;
		if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
		if (typeof raw.refreshMinutes === "number" && raw.refreshMinutes > 0) cfg.refreshMinutes = raw.refreshMinutes;
		if (Array.isArray(raw.telemetryFiles)) cfg.telemetryFiles = raw.telemetryFiles.filter((f): f is string => typeof f === "string").map(expandHome);
		for (const key of ["creditsPerDollar", "spikeFactor"] as const) {
			if (typeof raw[key] === "number" && raw[key]! > 0) cfg[key] = raw[key]!;
		}
		if (typeof raw.maxSpikeDays === "number" && raw.maxSpikeDays >= 0) cfg.maxSpikeDays = raw.maxSpikeDays;
		for (const [level, text] of Object.entries(raw.rules ?? {})) {
			if (level in cfg.rules && typeof text === "string" && text.trim()) cfg.rules[level as keyof PaceRules] = text.trim();
		}
	} catch {
		// keep the defaults
	}
	return cfg;
}

function readState(file: string): PaceState {
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as PaceState;
	} catch {
		return {};
	}
}

function writeState(file: string, state: PaceState): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state)}\n`, "utf-8");
	} catch {
		// a lost baseline only makes "today" start later
	}
}

/** Per-day credits from the telemetry logs, or undefined when none is readable. */
function readDays(config: Config, sinceMs: number): Map<string, number> | undefined {
	const lines: string[] = [];
	for (const file of config.telemetryFiles) {
		try {
			lines.push(...readFileSync(file, "utf-8").split("\n"));
		} catch {
			// a profile without telemetry adds nothing
		}
	}
	return lines.length > 0 ? dailyCredits(lines, sinceMs, config.creditsPerDollar) : undefined;
}

export default function copilotPace(pi: ExtensionAPI): void {
	const dir = agentDir();
	const config = loadConfig(dir);
	const isSubagent = Number(process.env.PI_COLLAB_SUBAGENT_DEPTH ?? "0") > 0;
	if (!config.enabled || isSubagent) return;

	const stateFile = join(dir, "state", "copilot-pace.json");
	let token: string | undefined;
	let pace: Pace | undefined;
	let fetchedAt = 0;
	let lastError: string | undefined;
	let notified: { level: PaceLevel; date: string } | undefined;

	async function refresh(force = false): Promise<void> {
		const now = Date.now();
		if (!force && now - fetchedAt < config.refreshMinutes * 60_000) return;
		fetchedAt = now;
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), 8000);
		try {
			token ??= await readTokenFromKeychain(pi, ctl.signal);
			if (!token) {
				lastError = "no token in Keychain (or no GUI session)";
				return;
			}
			const resp = await fetchUsage(token, ctl.signal);
			const snap = pickSnapshot(resp);
			const resetIso = resp.quota_reset_date_utc ?? resp.quota_reset_date;
			if (!snap || snap.unlimited || !resetIso) {
				pace = undefined;
				lastError = snap?.unlimited ? "unlimited" : "no quota in the response";
				return;
			}
			const total = snap.entitlement ?? 0;
			const used = Math.max(0, total - (snap.remaining ?? total));
			const state = recordReading(readState(stateFile), used, resetIso, now);
			writeState(stateFile, state);
			pace = computePace(used, total, resetIso, now, state.dayStart, {
				days: readDays(config, periodStart(Date.parse(resetIso))),
				spikeFactor: config.spikeFactor,
				maxSpikeDays: config.maxSpikeDays,
			});
			lastError = undefined;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/HTTP 40[13]/.test(msg)) token = undefined;
			lastError = msg;
		} finally {
			clearTimeout(timer);
		}
	}

	pi.on("session_start", () => {
		void refresh(true);
	});

	pi.on("before_agent_start", async () => {
		await refresh();
		if (!pace) return;
		const now = Date.now();
		const today = localDate(now);
		const changed = notified ? notified.level !== pace.level : pace.level !== "ok";
		const dailyReminder = pace.level !== "ok" && notified?.date !== today;
		if (!changed && !dailyReminder) return;
		const previous = notified?.level;
		notified = { level: pace.level, date: today };
		return {
			message: {
				customType: CUSTOM_TYPE,
				content: paceNote(pace, now, previous, config.rules),
				display: true,
				details: { level: pace.level, used: pace.used, total: pace.total },
			},
		};
	});

	pi.on("tool_result", (event: any) => {
		if (event?.toolName !== "subagent" || !pace || pace.level === "ok") return;
		const content = Array.isArray(event?.content) ? event.content : null;
		if (!content) return;
		return { content: [...content, { type: "text", text: `[copilot-pace: ${pace.level}] ${paceLine(pace, Date.now())}` }] };
	});

	pi.registerCommand("copilot-pace", {
		description: "Refresh and show the Copilot credit pace",
		handler: async (_args, ctx) => {
			await refresh(true);
			ctx.ui.notify(
				pace ? `[${pace.level}] ${paceLine(pace, Date.now())}` : `copilot-pace: ${lastError ?? "no data"}`,
				pace ? (pace.level === "ok" ? "info" : "warning") : "warning",
			);
		},
	});
}
