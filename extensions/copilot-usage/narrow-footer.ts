/**
 * Narrow footer layout, used when the terminal is narrower than
 * `NARROW_FOOTER_COLS` (a phone client over mosh is ~50 columns). The full
 * footer then wraps into noise: a long path, cache-read totals, a context
 * percentage that repeats the ceiling, peer and budget statuses.
 *
 *   line 1  ../site/Scripts (branch)                       orchestrator
 *   line 2  ●●●●◐○○○○○ 44% 70k/160k                          CH96.2%
 *   line 3  $1.503 · wk $26.7                  (g) opus-5.5 · mid
 *
 * Line 2 is the context against the compaction limit (the context-ceiling
 * status when that extension runs, the model window otherwise): ten dots, the
 * percentage and used/limit; the cache-hit rate of the last request sits on the
 * right, aligned with the model below it, and goes first when space runs out.
 * Line 3 adds the week's gateway spend (from the gateway-budget status, only
 * while the session model is on a gateway) and prefixes the model with a
 * one-letter provider: (g) gateway, (c) Copilot. On Copilot the cost is in
 * credits ($ × 100) followed by the period's used/entitlement, `100 cr · 22/60k`.
 * When it does not fit, the
 * thinking level goes first, then the provider, then the model. The role sits
 * on the right of line 1 and shortens to orch/sub before it goes. The model and thinking level sit on the right of
 * line 3 and never move; on a very narrow screen the level goes first, then
 * the model.
 *
 * Colours are theme tokens, so they follow the terminal's light or dark theme,
 * and each one says something: the cache-hit rate and the context fill turn
 * warning/error (the fill at pi's own 70/90% thresholds), the role and the
 * branch take the accent, and the thinking level takes the same colour as the
 * editor border at that level.
 *
 * Every line is cut to the width: pi-tui aborts the process on a line wider
 * than the terminal (see the 2026-09-17 narrow-pane crash).
 */
export const NARROW_FOOTER_COLS = 100;

export function narrowThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.PI_FOOTER_NARROW_COLS);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NARROW_FOOTER_COLS;
}

/** `~/VITU/vitu-portal/site/Scripts` → `../site/Scripts`; short paths stay as they are. */
export function shortPath(pwd: string): string {
	const rooted = pwd.startsWith("~/") ? "~" : pwd.startsWith("/") ? "" : null;
	const rest = rooted === null ? pwd : pwd.slice(rooted.length + 1);
	const parts = rest.split("/").filter(Boolean);
	if (parts.length <= 2) return pwd;
	return `../${parts.slice(-2).join("/")}`;
}

export function agentRole(env: NodeJS.ProcessEnv = process.env): "orchestrator" | "subagent" {
	const depth = Number(env.PI_COLLAB_SUBAGENT_DEPTH ?? "0");
	return Number.isFinite(depth) && depth > 0 ? "subagent" : "orchestrator";
}

/** `claude-opus-5-5` → `opus-5.5`, `gpt-6.1-sol` → `sol-6.1`, `gemini-3.8-flash` → `flash-3.8`. */
export function shortModel(id: string): string {
	let m = id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
	const variant = /^(?:gpt|gemini)-([\d.]+)-([a-z]+)$/.exec(m);
	if (variant) m = `${variant[2]}-${variant[1]}`;
	return m;
}

const THINKING_COLOR: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Cache-hit colour: a cold cache is what costs money. */
export function hitColor(percent: number): string {
	return percent >= 90 ? "success" : percent >= 70 ? "warning" : "error";
}

/**
 * Context-fill colour at pi's own 70/90% thresholds: green, then yellow near
 * the compaction, then red. These are the terminal's own ANSI colours, not
 * theme tokens: the dark theme's "warning" is orange (256-colour 172), and the
 * bar should read as a traffic light in whatever palette the terminal has.
 */
export const ANSI_COLORS: Record<string, string> = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };

export function fillColor(fill: number): string {
	return fill > 0.9 ? "red" : fill > 0.7 ? "yellow" : "green";
}

/** theme.fg for theme tokens, raw ANSI for the three traffic-light colours. */
export function colorize(themeFg: (token: string, s: string) => string): (token: string, s: string) => string {
	return (token, s) => (ANSI_COLORS[token] ? `${ANSI_COLORS[token]}${s}\x1b[39m` : themeFg(token, s));
}

/** "ctx 70k/160k" from the context-ceiling extension → tokens. */
export function parseCeiling(status: string | undefined): { used: number | null; limit: number } | null {
	const m = /ctx\s+(?:\?|(\d+)k)\/(\d+)k/.exec(status ?? "");
	if (!m || Number(m[2]) <= 0) return null;
	return { used: m[1] === undefined ? null : Number(m[1]) * 1000, limit: Number(m[2]) * 1000 };
}

export const BAR_DOTS = 10;

/**
 * The dots of the context bar, in quarter steps: ○ ◔ ◐ ◕ ●. JetBrains Mono has
 * no ◐; the patched "JetBrains Mono Herdr" (scripts/patch-terminal-font.py)
 * adds it from the font's own ring, so it matches ○ ● in Ghostty and, once the
 * same .ttf is imported, in Moshi. Without the patched font ◐ comes from a
 * fallback font and looks larger.
 */
export function barDots(fill: number, dots = BAR_DOTS): { filled: string; empty: string } {
	const x = Math.min(1, Math.max(0, fill)) * dots;
	let full = Math.floor(x);
	const frac = x - full;
	let partial = "";
	if (frac >= 0.875) full += 1;
	else if (frac >= 0.625) partial = "◕";
	else if (frac >= 0.375) partial = "◐";
	else if (frac >= 0.125) partial = "◔";
	full = Math.min(full, dots);
	const used = full + (partial ? 1 : 0);
	return { filled: "●".repeat(full) + partial, empty: "○".repeat(Math.max(0, dots - used)) };
}

const PROVIDER_LETTER: Record<string, string> = {
	"vitu-gateway": "g",
	"github-copilot": "c",
	"claude-bridge": "b",
	"openai-codex": "x",
	openrouter: "r",
	anthropic: "a",
	openai: "o",
};

/** `vitu-gateway` → `g`, `github-copilot` → `c`; any other provider by its first letter. */
export function providerLetter(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	if (PROVIDER_LETTER[provider]) return PROVIDER_LETTER[provider];
	if (/gateway/i.test(provider)) return "g";
	return provider.replace(/[^a-z]/gi, "").slice(0, 1).toLowerCase() || undefined;
}

/** "gw wk $26.7/500 ⚠ · mo $894" from gateway-budget → the week's spend and its warning level. */
export function parseWeekly(status: string | undefined): { amount: string; level: "ok" | "near" | "over" } | null {
	const m = /\bwk\s+\$([\d.]+)(?:\/\d+)?(\s*⛔|\s*⚠)?/.exec(status ?? "");
	if (!m) return null;
	return { amount: m[1], level: m[2]?.includes("⛔") ? "over" : m[2]?.includes("⚠") ? "near" : "ok" };
}

/** 22000/60000 → "22/60k": the unit once, on the limit. */
export function quotaText(used: number, total: number): string {
	if (total >= 1000) {
		const k = (n: number) => (n >= 10_000 || n === 0 ? `${Math.round(n / 1000)}` : (n / 1000).toFixed(1).replace(/\.0$/, ""));
		return `${k(used)}/${k(total)}k`;
	}
	return `${Math.round(used)}/${Math.round(total)}`;
}

/** Share of the Copilot entitlement used: muted, then yellow from 80%, red from 95%. */
export function quotaColor(used: number, total: number): string {
	const share = total > 0 ? used / total : 0;
	return share >= 0.95 ? "red" : share >= 0.8 ? "yellow" : "muted";
}

const THINKING: Record<string, string> = { off: "off", minimal: "min", low: "low", medium: "mid", high: "hi", xhigh: "xhi", max: "max" };

/** Thinking level in at most three characters: medium → mid, xhigh → xhi. */
export function shortThinking(level: string | undefined): string | undefined {
	if (!level) return undefined;
	return THINKING[level] ?? level.slice(0, 3);
}

export interface NarrowInput {
	pwd: string;
	branch: string | null;
	/** Context tokens in use (null right after a compaction) and the limit they are measured against. */
	contextTokens: number | null;
	contextLimit: number;
	cacheHitPercent: number | null;
	cost: number;
	role: string;
	/** Current model id and thinking level (omit the level for a model without reasoning). */
	model?: string;
	provider?: string;
	/** The gateway-budget status text; its week is shown only when the provider is a gateway. */
	budgetStatus?: string;
	/** Copilot credits used this period and the entitlement, from the copilot-usage snapshot. */
	copilotQuota?: { used: number; total: number };
	thinking?: string;
	fmtTokens: (n: number) => string;
	/** theme.fg: colour a string with a theme token. */
	fg: (token: string, s: string) => string;
	/** pi-tui's truncateToWidth (host-provided, so it is passed in rather than imported). */
	truncate: (s: string, width: number, ellipsis: string) => string;
	/** pi-tui's visibleWidth. */
	measure: (s: string) => number;
}

const MIN_GAP = 2;

export function narrowLines(v: NarrowInput, width: number): string[] {
	const cut = (s: string) => v.truncate(s, Math.max(0, width), "…");
	const dim = (t: string) => v.fg("dim", t);
	const path = shortPath(v.pwd);
	let line1 = v.fg("muted", path) + (v.branch ? dim(" (") + v.fg("accent", v.branch) + dim(")") : "");
	const roleColor = v.role === "orchestrator" ? "accent" : "muted";
	const roleShort = v.role === "orchestrator" ? "orch" : v.role === "subagent" ? "sub" : v.role;
	for (const role of roleShort !== v.role ? [v.role, roleShort] : [v.role]) {
		const pad = width - v.measure(line1) - v.measure(role);
		if (pad >= MIN_GAP) {
			line1 = line1 + " ".repeat(pad) + v.fg(roleColor, role);
			break;
		}
	}

	const parts2: string[] = [];
	if (v.contextLimit > 0 && v.contextTokens !== null) {
		const fill = Math.min(1, Math.max(0, v.contextTokens / v.contextLimit));
		const bar = barDots(fill);
		const color = fillColor(fill);
		parts2.push(v.fg(color, bar.filled) + dim(bar.empty), v.fg(color, `${Math.round(fill * 100)}%`));
	} else {
		parts2.push(dim("○".repeat(BAR_DOTS)), dim("?%"));
	}
	if (v.contextLimit > 0) {
		const used = v.contextTokens === null ? "?" : v.fmtTokens(v.contextTokens);
		parts2.push(dim(`${used}/${v.fmtTokens(v.contextLimit)}`));
	}
	let line2 = parts2.join(" ");
	if (v.cacheHitPercent !== null) {
		const hit = v.fg(hitColor(v.cacheHitPercent), `CH${v.cacheHitPercent.toFixed(1)}%`);
		const pad = width - v.measure(line2) - v.measure(hit);
		if (pad >= MIN_GAP) line2 = line2 + " ".repeat(pad) + hit;
	}

	const money: string[] = [];
	const letter = providerLetter(v.provider);
	if (letter === "c") {
		money.push(v.fg("text", `${Math.round(v.cost * 100)} cr`));
		if (v.copilotQuota && v.copilotQuota.total > 0) {
			const q = v.copilotQuota;
			money.push(v.fg(quotaColor(q.used, q.total), quotaText(q.used, q.total)));
		}
	} else if (v.cost) money.push(v.fg("text", `$${v.cost.toFixed(3)}`));
	const weekly = letter === "g" ? parseWeekly(v.budgetStatus) : null;
	if (weekly) money.push(v.fg(weekly.level === "over" ? "red" : weekly.level === "near" ? "yellow" : "muted", `wk $${weekly.amount}`));
	const left3 = money.join(dim(" · "));

	const rights: string[] = [];
	if (v.model) {
		const name = v.fg("text", shortModel(v.model));
		const prov = letter ? dim(`(${letter}) `) : "";
		const level = shortThinking(v.thinking);
		const levelPart = level ? dim(" · ") + v.fg(THINKING_COLOR[v.thinking ?? ""] ?? "muted", level) : "";
		if (level) rights.push(prov + name + levelPart);
		if (prov) rights.push(prov + name);
		rights.push(name);
	}
	let line3 = left3;
	for (const right of rights) {
		const pad = width - v.measure(left3) - v.measure(right);
		if (pad >= (left3 ? MIN_GAP : 0)) {
			line3 = left3 + " ".repeat(pad) + right;
			break;
		}
	}
	return [cut(line1), cut(line2), cut(line3)].filter((l) => l.length > 0);
}
