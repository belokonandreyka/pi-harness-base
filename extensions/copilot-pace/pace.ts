/**
 * Copilot credit pace: how fast this period's credits are going against what
 * keeps them until the reset. Pure functions; index.ts fetches and injects.
 *
 * The projection runs on the typical day: one or two spike days in a period
 * (over twice the even daily share) are one-offs and left out of the rate,
 * though their credits stay spent; a third spike makes the average the rate.
 *
 * With `workDays` (e.g. Monday to Friday) every day count — days left, days
 * elapsed, the even share behind the spike threshold — counts only those days,
 * so a weekend neither stretches the budget nor dilutes the average. Credits
 * spent on another day still count as spent.
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
	/** Today's share as the day began: (remaining + today) over the days left including today. */
	dayBudget: number;
	/** Today has spent more than its share. */
	overToday: boolean;
	/** Calendar days to the reset (daysLeft counts work days only when workDays is set). */
	calendarDaysLeft: number;
	/** The days counted, 0 = Sunday; undefined = every day. */
	workDays?: number[];
	/** Average credits per day since the period began. */
	avgPerDay: number;
	today: number;
	todaySince: number;
	/** The daily rate the projection uses: the average, or the average without spike days. */
	typicalPerDay: number;
	/** Completed days of this period over the spike threshold, oldest first. */
	spikes: Array<{ date: string; credits: number }>;
	/** "average": no spikes or no daily data; "without-spikes": 1..maxSpikeDays excluded; "spike-pattern": too many to exclude. */
	basis: "average" | "without-spikes" | "spike-pattern";
	/** Days until the quota is gone at the typical pace; Infinity when nothing is spent. */
	runOutDays: number;
	level: PaceLevel;
}

export interface PaceOptions {
	/** Credits per local calendar day of this period, from request telemetry. */
	days?: Map<string, number>;
	/** A completed day over spikeFactor × (total / period days) is a spike. */
	spikeFactor?: number;
	/** Up to this many spike days in a period are treated as one-offs and left out of the rate. */
	maxSpikeDays?: number;
	/** Days of the week that count (0 = Sunday … 6 = Saturday); default every day. */
	workDays?: number[];
}

function activeWorkDays(workDays?: number[]): number[] | undefined {
	const days = [...new Set((workDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
	return days.length > 0 && days.length < 7 ? days : undefined;
}

/** Whether a local date (YYYY-MM-DD) is a counted day. */
export function isWorkDate(date: string, workDays?: number[]): boolean {
	const days = activeWorkDays(workDays);
	if (!days) return true;
	const [y, m, d] = date.split("-").map(Number);
	return days.includes(new Date(y!, m! - 1, d!, 12).getDay());
}

/** Days between two instants that fall on counted days, as a fraction (local time). */
export function workDaysBetween(from: number, to: number, workDays?: number[]): number {
	if (!(to > from)) return 0;
	const days = activeWorkDays(workDays);
	if (!days) return (to - from) / DAY_MS;
	let total = 0;
	for (let t = from; t < to; ) {
		const next = new Date(t);
		next.setHours(24, 0, 0, 0);
		const end = Math.min(next.getTime(), to);
		if (days.includes(new Date(t).getDay())) total += end - t;
		t = end;
	}
	return total / DAY_MS;
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

/** Calendar dates from the period's first local day up to yesterday. */
export function completedDates(startMs: number, now: number): string[] {
	const dates: string[] = [];
	const today = localDate(now);
	const d = new Date(startMs);
	d.setHours(12, 0, 0, 0);
	for (let date = localDate(d.getTime()); date < today; d.setDate(d.getDate() + 1), date = localDate(d.getTime())) dates.push(date);
	return dates;
}

/**
 * Credits per local day from cache-telemetry rows (`kind: "request"`,
 * `provider: "github-copilot"`, `cost` in list-price dollars).
 */
export function dailyCredits(lines: Iterable<string>, sinceMs: number, creditsPerDollar: number): Map<string, number> {
	const days = new Map<string, number>();
	for (const line of lines) {
		if (!line.includes('"github-copilot"')) continue;
		let row: any;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row?.kind !== "request" || row?.provider !== "github-copilot" || typeof row?.cost !== "number") continue;
		const ts = Date.parse(row.ts);
		if (Number.isNaN(ts) || ts < sinceMs) continue;
		const date = localDate(ts);
		days.set(date, (days.get(date) ?? 0) + row.cost * creditsPerDollar);
	}
	return days;
}

export function computePace(
	used: number,
	total: number,
	resetIso: string,
	now: number,
	dayStart?: DayStart,
	options: PaceOptions = {},
): Pace | undefined {
	const reset = Date.parse(resetIso);
	if (!(total > 0) || Number.isNaN(reset)) return undefined;
	const remaining = Math.max(0, total - used);
	const workDays = activeWorkDays(options.workDays);
	const start = periodStart(reset);
	const calendarDaysLeft = Math.max((reset - now) / DAY_MS, 1 / 24);
	const daysLeft = Math.max(workDaysBetween(now, reset, workDays), 1 / 24);
	// A floor of one day keeps the first hours of a period from reading as a runaway.
	const elapsedDays = Math.max(workDaysBetween(start, now, workDays), 1);
	const budgetPerDay = remaining / daysLeft;
	const avgPerDay = used / elapsedDays;
	const todayDate = localDate(now);
	const fromReadings = dayStart && dayStart.date === todayDate ? Math.max(0, used - dayStart.used) : 0;
	const today = Math.max(fromReadings, options.days?.get(todayDate) ?? 0);
	// Today's share is fixed as the day begins, so spending it does not shrink it.
	const midnight = new Date(now).setHours(0, 0, 0, 0);
	const dayBudget = (remaining + today) / Math.max(workDaysBetween(midnight, reset, workDays), 1);

	// One or two heavy days (a migration, an eval run) say little about the
	// rest of the month: their credits are already out of `remaining`, and the
	// projection runs on the days around them. More spikes than that are the pace.
	let typicalPerDay = avgPerDay;
	let basis: Pace["basis"] = "average";
	let spikes: Pace["spikes"] = [];
	if (options.days) {
		const periodDays = Math.max(workDaysBetween(start, reset, workDays), 1);
		const threshold = (options.spikeFactor ?? 2) * (total / periodDays);
		const completed = completedDates(start, now).filter((date) => isWorkDate(date, workDays)).map((date) => ({ date, credits: options.days!.get(date) ?? 0 }));
		spikes = completed.filter((d) => d.credits > threshold);
		const normal = completed.filter((d) => d.credits <= threshold);
		if (spikes.length > (options.maxSpikeDays ?? 2)) basis = "spike-pattern";
		else if (spikes.length > 0 && normal.length > 0) {
			basis = "without-spikes";
			typicalPerDay = normal.reduce((sum, d) => sum + d.credits, 0) / normal.length;
		}
	}
	const runOutDays = typicalPerDay > 0 ? remaining / typicalPerDay : Number.POSITIVE_INFINITY;
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
		dayBudget,
		overToday: today > dayBudget,
		calendarDaysLeft,
		workDays,
		avgPerDay,
		today,
		// Telemetry counts from midnight; a reading baseline from the last reading before it.
		todaySince: options.days ? new Date(now).setHours(0, 0, 0, 0) : (dayStart?.at ?? now),
		typicalPerDay,
		spikes,
		basis,
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
	const resetIn = p.workDays
		? `reset in ${Math.ceil(p.calendarDaysLeft)}d (${Math.ceil(p.daysLeft)} work days)`
		: `reset in ${Math.ceil(p.daysLeft)}d`;
	const unit = p.workDays ? "work day" : "day";
	const parts = [
		`Copilot credits: ${fmtCredits(p.used)} of ${fmtCredits(p.total)} used, ${resetIn}`,
		`${fmtCredits(p.budgetPerDay)}/${unit} lasts until the reset`,
		`average so far ${fmtCredits(p.avgPerDay)}/${unit}, today ${fmtCredits(p.today)} of ${fmtCredits(p.dayBudget)} (${since})`,
	];
	const spikeList = p.spikes.map((d) => `${d.date.slice(5)} ${fmtCredits(d.credits)}`).join(", ");
	if (p.basis === "without-spikes") {
		parts.push(`without ${p.spikes.length} spike day${p.spikes.length > 1 ? "s" : ""} (${spikeList}) treated as one-off: ${fmtCredits(p.typicalPerDay)}/day`);
	} else if (p.basis === "spike-pattern") {
		parts.push(`${p.spikes.length} spike days this period (${spikeList}) are a pattern, so the average stands`);
	}
	if (p.level === "over" || p.level === "critical") parts.push(`at this pace the quota is gone in ~${Math.max(0, Math.floor(p.runOutDays))}d`);
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
