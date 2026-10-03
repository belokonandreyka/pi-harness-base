/**
 * Copilot credit pace: how fast this period's credits are going against what
 * keeps them until the reset. Pure functions; index.ts fetches and injects.
 */

export const DAY_MS = 86_400_000;

export type PaceLevel = "ok" | "high-today" | "over" | "critical";

export interface DayStart {
	/** Local calendar date, YYYY-MM-DD. */
	date: string;
	/** When the baseline was observed (the last reading before this day began). */
	at: number;
	used: number;
}

export interface PaceState {
	last?: { at: number; used: number; resetIso: string };
	dayStart?: DayStart;
}

export interface Pace {
	used: number;
	total: number;
	remaining: number;
	daysLeft: number;
	elapsedDays: number;
	/** Credits per day that last exactly until the reset. */
	budgetPerDay: number;
	/** Average credits per day since the period began. */
	avgPerDay: number;
	today: number;
	todaySince: number;
	/** Days until the quota is gone at the average pace; Infinity when nothing is spent. */
	runOutDays: number;
	level: PaceLevel;
}

export function localDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The period runs one calendar month up to the reset (GitHub resets monthly). */
export function periodStart(resetMs: number): number {
	const d = new Date(resetMs);
	d.setUTCMonth(d.getUTCMonth() - 1);
	return d.getTime();
}

/**
 * Record a reading. The day's baseline is the last reading taken before the day
 * began, so usage between that reading and midnight counts as today: a slight
 * over-count after a night off, never an under-count.
 */
export function recordReading(state: PaceState, used: number, resetIso: string, now: number): PaceState {
	const today = localDate(now);
	const samePeriod = state.last?.resetIso === resetIso;
	let dayStart = samePeriod ? state.dayStart : undefined;
	if (!dayStart || dayStart.date !== today) {
		if (samePeriod && state.last) dayStart = { date: today, at: state.last.at, used: state.last.used };
		else {
			const start = periodStart(Date.parse(resetIso));
			dayStart = localDate(start) === today ? { date: today, at: start, used: 0 } : { date: today, at: now, used };
		}
	}
	return { last: { at: now, used, resetIso }, dayStart };
}

export function computePace(used: number, total: number, resetIso: string, now: number, dayStart?: DayStart): Pace | undefined {
	const reset = Date.parse(resetIso);
	if (!(total > 0) || Number.isNaN(reset)) return undefined;
	const remaining = Math.max(0, total - used);
	const daysLeft = Math.max((reset - now) / DAY_MS, 1 / 24);
	// A floor of one day keeps the first hours of a period from reading as a runaway.
	const elapsedDays = Math.max((now - periodStart(reset)) / DAY_MS, 1);
	const budgetPerDay = remaining / daysLeft;
	const avgPerDay = used / elapsedDays;
	const today = dayStart && dayStart.date === localDate(now) ? Math.max(0, used - dayStart.used) : 0;
	const runOutDays = avgPerDay > 0 ? remaining / avgPerDay : Number.POSITIVE_INFINITY;
	let level: PaceLevel = "ok";
	if (remaining <= total * 0.05 || runOutDays < 3) level = "critical";
	else if (runOutDays < daysLeft) level = "over";
	else if (today > 2 * budgetPerDay) level = "high-today";
	return {
		used,
		total,
		remaining,
		daysLeft,
		elapsedDays,
		budgetPerDay,
		avgPerDay,
		today,
		todaySince: dayStart?.at ?? now,
		runOutDays,
		level,
	};
}

export function fmtCredits(n: number): string {
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

function hhmm(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One line of numbers, the same for every level. */
export function paceLine(p: Pace, now: number): string {
	const day = localDate(p.todaySince);
	const since = day === localDate(now) ? `since ${hhmm(p.todaySince)}` : `since ${day.slice(5)} ${hhmm(p.todaySince)}`;
	const parts = [
		`Copilot credits: ${fmtCredits(p.used)} of ${fmtCredits(p.total)} used, reset in ${Math.ceil(p.daysLeft)}d`,
		`${fmtCredits(p.budgetPerDay)}/day lasts until the reset`,
		`average so far ${fmtCredits(p.avgPerDay)}/day, today ${fmtCredits(p.today)} (${since})`,
	];
	if (p.level === "over" || p.level === "critical") parts.push(`at the average pace the quota is gone in ~${Math.max(0, Math.floor(p.runOutDays))}d`);
	return `${parts.join("; ")}.`;
}

export type PaceRules = Record<Exclude<PaceLevel, "ok">, string>;

/** Generic wording; a profile names its own subagent types via `rules` in copilot-pace.json. */
export const DEFAULT_RULES: PaceRules = {
	"high-today":
		"Today runs at more than twice the daily budget. Keep implementation on the default worker type and reviews per batch; mention the pace to the user when you report.",
	over:
		"Over pace. Implementation only on the default worker type (the strongest model only for a task that already failed on it), one review per batch, browser verification only when the user asked for it. Say so to the user once.",
	critical:
		"Critical: the quota runs out within days. Apply the over-pace rules and move reviews to the other provider while its budget has room. Tell the user now and ask before any large spend on this quota.",
};

/** The note the coordinator gets at the start of a turn when the level changes. */
export function paceNote(p: Pace, now: number, previous?: PaceLevel, rules: PaceRules = DEFAULT_RULES): string {
	const line = paceLine(p, now);
	if (p.level === "ok") return `${line} Back on pace${previous ? ` (was ${previous})` : ""}: normal routing.`;
	return `${line} ${rules[p.level]}`;
}
