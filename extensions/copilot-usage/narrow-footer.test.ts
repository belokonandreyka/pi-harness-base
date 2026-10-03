import { describe, expect, test } from "bun:test";
import {
	BAR_DOTS,
	NARROW_FOOTER_COLS,
	agentRole,
	barDots,
	parseWeekly,
	providerLetter,
	quotaColor,
	quotaText,
	colorize,
	fillColor,
	hitColor,
	narrowLines,
	narrowThreshold,
	parseCeiling,
	shortModel,
	shortPath,
	shortThinking,
} from "./narrow-footer.ts";

const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);
const visibleWidth = (s: string) => [...s].length;
const base = {
	pwd: "~/work/portal/site/Scripts",
	branch: "test",
	contextTokens: 70_000,
	contextLimit: 160_000,
	cacheHitPercent: 96.2,
	cost: 1.503,
	role: "orchestrator",
	fmtTokens: fmt,
	fg: (_token: string, s: string) => s,
	// plain-text stand-in for pi-tui's truncateToWidth (every glyph here is one column)
	truncate: (s: string, width: number, ellipsis: string) => {
		const chars = [...s];
		if (chars.length <= width) return s;
		return width <= 0 ? "" : chars.slice(0, Math.max(0, width - 1)).join("") + ellipsis.slice(0, 1);
	},
	measure: visibleWidth,
};

describe("narrow footer", () => {
	test("keeps the last two folders of a long path", () => {
		expect(shortPath("~/work/portal/site/Scripts")).toBe("../site/Scripts");
		expect(shortPath("/opt/a/b/c")).toBe("../b/c");
		expect(shortPath("~/work/portal")).toBe("~/work/portal");
		expect(shortPath("~")).toBe("~");
	});

	test("line 1: path and role; line 2: context bar, percent, limit, cache hit; line 3: cost", () => {
		expect(narrowLines(base, 50)).toEqual(["../site/Scripts (test)" + " ".repeat(50 - 22 - 12) + "orchestrator", "●●●●◐○○○○○ 44% 70k/160k" + " ".repeat(50 - 23 - 7) + "CH96.2%", "$1.503"]);
	});

	test("the bar rounds to ten dots and clamps at full", () => {
		expect(narrowLines({ ...base, contextTokens: 0 }, 50)[1]).toBe("○○○○○○○○○○ 0% 0/160k" + " ".repeat(50 - 20 - 7) + "CH96.2%");
		expect(narrowLines({ ...base, contextTokens: 136_000 }, 50)[1]).toBe("●●●●●●●●◐○ 85% 136k/160k" + " ".repeat(50 - 24 - 7) + "CH96.2%");
		expect(narrowLines({ ...base, contextTokens: 170_000 }, 50)[1]).toBe("●●●●●●●●●● 100% 170k/160k" + " ".repeat(50 - 25 - 7) + "CH96.2%");
	});

	test("a partly filled dot shows a quarter, a half or three quarters; the bar is always ten wide", () => {
		expect(barDots(0)).toEqual({ filled: "", empty: "○○○○○○○○○○" });
		expect(barDots(0.01)).toEqual({ filled: "", empty: "○○○○○○○○○○" });
		expect(barDots(0.03)).toEqual({ filled: "◔", empty: "○○○○○○○○○" });
		expect(barDots(0.05)).toEqual({ filled: "◐", empty: "○○○○○○○○○" });
		expect(barDots(0.07)).toEqual({ filled: "◕", empty: "○○○○○○○○○" });
		expect(barDots(0.095)).toEqual({ filled: "●", empty: "○○○○○○○○○" });
		expect(barDots(0.44)).toEqual({ filled: "●●●●◐", empty: "○○○○○" });
		expect(barDots(1.2)).toEqual({ filled: "●●●●●●●●●●", empty: "" });
		for (let f = 0; f <= 1.0001; f += 0.01) {
			const b = barDots(f);
			expect([...b.filled].length + [...b.empty].length).toBe(BAR_DOTS);
		}
	});

	test("unknown context right after a compaction shows an empty bar", () => {
		expect(narrowLines({ ...base, contextTokens: null }, 50)[1]).toBe("○○○○○○○○○○ ?% ?/160k" + " ".repeat(50 - 20 - 7) + "CH96.2%");
		expect(narrowLines(base, 25)[1]).toBe("●●●●◐○○○○○ 44% 70k/160k");
	});

	test("the ceiling status is parsed into tokens", () => {
		expect(parseCeiling("ctx 70k/160k")).toEqual({ used: 70_000, limit: 160_000 });
		expect(parseCeiling("ctx ?/160k")).toEqual({ used: null, limit: 160_000 });
		expect(parseCeiling(undefined)).toBeNull();
	});

	test("the role sits right on line 1 and shortens to orch/sub before it goes", () => {
		expect(narrowLines(base, 50)[0]).toBe("../site/Scripts (test)" + " ".repeat(50 - 22 - 12) + "orchestrator");
		expect(narrowLines(base, 30)[0]).toBe("../site/Scripts (test)" + " ".repeat(30 - 22 - 4) + "orch");
		expect(narrowLines(base, 25)[0]).toBe("../site/Scripts (test)");
		expect(narrowLines({ ...base, role: "subagent" }, 30)[0]).toBe("../site/Scripts (test)" + " ".repeat(30 - 22 - 3) + "sub");
	});

	test("model and thinking sit right on line 3; a narrow screen drops the level, then the model", () => {
		const m = { ...base, model: "claude-opus-5-5", thinking: "medium" };
		expect(narrowLines(m, 50)[2]).toBe("$1.503" + " ".repeat(50 - 6 - 14) + "opus-5.5 · mid");
		expect(narrowLines(m, 20)[2]).toBe("$1.503" + " ".repeat(20 - 6 - 8) + "opus-5.5");
		expect(narrowLines(m, 12)[2]).toBe("$1.503");
		for (const w of [1, 10, 12, 20, 22, 25, 35, 50]) for (const l of narrowLines({ ...m, branch: "a-very-long-feature-branch-name" }, w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
	});

	test("on a gateway: the week's spend after the cost and (g) before the model", () => {
		const gw = { ...base, model: "claude-opus-5-5", thinking: "medium", provider: "vitu-gateway", budgetStatus: "gw wk $26.7/500 · mo $894/2000" };
		expect(narrowLines(gw, 50)[2]).toBe("$1.503 · wk $26.7" + " ".repeat(50 - 17 - 18) + "(g) opus-5.5 · mid");
	});

	test("on Copilot: the cost in credits and the period's used/limit", () => {
		const cp = { ...base, model: "claude-opus-5.5", thinking: "medium", provider: "github-copilot", cost: 1.0, copilotQuota: { used: 22_000, total: 60_000 } };
		expect(narrowLines(cp, 50)[2]).toBe("100 cr · 22/60k" + " ".repeat(50 - 15 - 18) + "(c) opus-5.5 · mid");
		expect(narrowLines({ ...cp, copilotQuota: undefined }, 50)[2]).toBe("100 cr" + " ".repeat(50 - 6 - 18) + "(c) opus-5.5 · mid");
		expect(narrowLines({ ...cp, budgetStatus: "gw wk $26.7/500 · mo $894" }, 50)[2]).not.toContain("wk");
		expect(quotaText(22_000, 60_000)).toBe("22/60k");
		expect(quotaText(1_500, 3_000)).toBe("1.5/3k");
		expect(quotaText(0, 60_000)).toBe("0/60k");
		expect(quotaText(120, 300)).toBe("120/300");
		expect(quotaColor(22_000, 60_000)).toBe("muted");
		expect(quotaColor(50_000, 60_000)).toBe("yellow");
		expect(quotaColor(58_000, 60_000)).toBe("red");
	});

	test("provider letters and the weekly budget parser", () => {
		expect(providerLetter("vitu-gateway")).toBe("g");
		expect(providerLetter("github-copilot")).toBe("c");
		expect(providerLetter("claude-bridge")).toBe("b");
		expect(providerLetter("acme-gateway")).toBe("g");
		expect(providerLetter("zeta")).toBe("z");
		expect(providerLetter(undefined)).toBeUndefined();
		expect(parseWeekly("gw wk $26.7/500 · mo $894/2000")).toEqual({ amount: "26.7", level: "ok" });
		expect(parseWeekly("gw wk $412/500 ⚠ · mo $894")).toEqual({ amount: "412", level: "near" });
		expect(parseWeekly("gw wk $512/500 ⛔ · mo $894")).toEqual({ amount: "512", level: "over" });
		expect(parseWeekly(undefined)).toBeNull();
		const near = narrowLines({ ...base, provider: "vitu-gateway", budgetStatus: "gw wk $412/500 ⚠ · mo $894", fg: (t: string, s: string) => `<${t}>${s}</>`, measure: (s: string) => [...s.replace(/<\/?[a-zA-Z]*>/g, "")].length, truncate: (s: string) => s }, 60);
		expect(near[2]).toContain("<yellow>wk $412</>");
	});;

	test("short model names and three-letter thinking levels", () => {
		expect(shortModel("claude-opus-5-5")).toBe("opus-5.5");
		expect(shortModel("claude-opus-5.5")).toBe("opus-5.5");
		expect(shortModel("claude-haiku-4.5")).toBe("haiku-4.5");
		expect(shortModel("gpt-6.1-sol")).toBe("sol-6.1");
		expect(shortModel("gemini-3.8-flash")).toBe("flash-3.8");
		expect(shortThinking("medium")).toBe("mid");
		expect(shortThinking("xhigh")).toBe("xhi");
		expect(shortThinking(undefined)).toBeUndefined();
		for (const l of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(shortThinking(l)!.length).toBeLessThanOrEqual(3);
	});

	test("colours carry meaning: fill, cache hit, role, thinking level", () => {
		expect(fillColor(0.44)).toBe("green");
		expect(fillColor(0.8)).toBe("yellow");
		expect(fillColor(0.95)).toBe("red");
		const fg = colorize((t, s) => `<${t}>${s}</>`);
		expect(fg("yellow", "●●")).toBe("\x1b[33m●●\x1b[39m");
		expect(fg("accent", "x")).toBe("<accent>x</>");
		expect(hitColor(96.2)).toBe("success");
		expect(hitColor(80)).toBe("warning");
		expect(hitColor(40)).toBe("error");
		const tagged = narrowLines(
			{ ...base, model: "claude-opus-5-5", thinking: "medium", fg: (t: string, s: string) => `<${t}>${s}</>`, measure: (s: string) => [...s.replace(/<\/?[a-zA-Z]*>/g, "")].length, truncate: (s: string) => s },
			50,
		);
		expect(tagged[0]).toBe("<muted>../site/Scripts</><dim> (</><accent>test</><dim>)</>" + " ".repeat(50 - 22 - 12) + "<accent>orchestrator</>");
		expect(tagged[1]).toBe("<green>●●●●◐</><dim>○○○○○</> <green>44%</> <dim>70k/160k</>" + " ".repeat(50 - 23 - 7) + "<success>CH96.2%</>");
		expect(tagged[2]).toContain("<text>$1.503</>");
		expect(tagged[0]).toContain("<accent>orchestrator</>");
		expect(tagged[2]).toContain("<thinkingMedium>mid</>");
	});

	test("role comes from the collab subagent depth; the threshold from the env", () => {
		expect(agentRole({ PI_COLLAB_SUBAGENT_DEPTH: "1" })).toBe("subagent");
		expect(agentRole({})).toBe("orchestrator");
		expect(narrowThreshold({})).toBe(NARROW_FOOTER_COLS);
		expect(narrowThreshold({ PI_FOOTER_NARROW_COLS: "0" })).toBe(0);
	});
});
