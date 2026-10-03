/**
 * GitHub Copilot AI credits usage in the pi status bar.
 *
 * Reads a GitHub PAT from macOS Keychain (service `github-copilot-token`),
 * polls the same internal endpoint the github.com settings page hits, and
 * renders `<used>/<limit> credits · <days>d` inline on the stats line of a
 * custom footer — bright orange, immediately left of the (provider) model
 * segment on the right. Only visible when the current model is a Copilot
 * model. Refresh on demand via `/copilot-refresh`.
 *
 * One-time setup:
 *   security add-generic-password -s github-copilot-token -a "$USER" -w
 *   # (paste a fine-grained GitHub PAT with no repo scopes — auth-only)
 */

import { agentRole, colorize, footerLines, narrowThreshold, parseCeiling } from "./narrow-footer.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const KEYCHAIN_SERVICE = "github-copilot-token";
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const ENDPOINT = "https://api.github.com/copilot_internal/user";

interface QuotaSnapshot {
	remaining?: number;
	entitlement?: number;
	percent_remaining?: number;
	unlimited?: boolean;
}

interface CopilotUserResponse {
	quota_snapshots?: {
		chat?: QuotaSnapshot;
		completions?: QuotaSnapshot;
		premium_interactions?: QuotaSnapshot;
	};
	quota_reset_date_utc?: string;
	quota_reset_date?: string;
}

interface Snapshot {
	text: string; // pre-formatted plain text (no color)
	resetDays: number | undefined;
	pctUsed: number;
	unlimited: boolean;
	/** Credits used this period and the period's entitlement (0/0 when unlimited). */
	used: number;
	total: number;
}

function fmtCredits(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

function pickSnapshot(resp: CopilotUserResponse): QuotaSnapshot | undefined {
	const snaps = resp.quota_snapshots ?? {};
	const candidates = [snaps.premium_interactions, snaps.chat, snaps.completions].filter(
		(s): s is QuotaSnapshot => !!s && s.entitlement !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return candidates.reduce((best, s) =>
		(s.entitlement ?? 0) > (best.entitlement ?? 0) ? s : best,
	);
}

function daysUntilReset(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const reset = new Date(iso).getTime();
	if (Number.isNaN(reset)) return undefined;
	const diff = reset - Date.now();
	if (diff <= 0) return 0;
	return Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)));
}

function toSnapshot(resp: CopilotUserResponse): Snapshot | undefined {
	const snap = pickSnapshot(resp);
	if (!snap) return undefined;
	const days = daysUntilReset(resp.quota_reset_date_utc ?? resp.quota_reset_date);
	if (snap.unlimited) {
		return { text: "Copilot ∞", resetDays: days, pctUsed: 0, unlimited: true, used: 0, total: 0 };
	}
	const total = snap.entitlement ?? 0;
	const remaining = snap.remaining ?? total;
	const used = Math.max(0, total - remaining);
	const pctUsed = total > 0 ? (used / total) * 100 : 0;
	const parts = [`${fmtCredits(used)}/${fmtCredits(total)} credits`];
	if (days !== undefined) parts.push(`${days}d`);
	return { text: parts.join(" · "), resetDays: days, pctUsed, unlimited: false, used, total };
}

async function readTokenFromKeychain(pi: ExtensionAPI, signal: AbortSignal): Promise<string | undefined> {
	try {
		const res = await pi.exec(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", process.env.USER ?? "", "-w"],
			{ signal, timeout: 5000 },
		);
		if (res.code !== 0) return undefined;
		const token = res.stdout.trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

async function fetchUsage(token: string, signal: AbortSignal): Promise<CopilotUserResponse> {
	const resp = await fetch(ENDPOINT, {
		headers: {
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "pi-copilot-usage/0.2",
		},
		signal,
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	return (await resp.json()) as CopilotUserResponse;
}

function isCopilotModel(ctx: ExtensionContext): boolean {
	const id = ctx.model?.id ?? "";
	const provider = (ctx.model as { provider?: string } | undefined)?.provider ?? "";
	return provider === "github-copilot" || /copilot/i.test(id);
}

interface ModelWithMeta {
	id?: string;
	provider?: string;
	contextWindow?: number;
	reasoning?: unknown;
}

export default function (pi: ExtensionAPI) {
	let timer: NodeJS.Timeout | undefined;
	let abortCtl: AbortController | undefined;
	let tokenCache: string | undefined;
	let snapshotCache: Snapshot | undefined;
	let lastError: string | undefined;
	let requestRender: (() => void) | undefined;

	async function refresh(ctx: ExtensionContext) {
		abortCtl?.abort();
		abortCtl = new AbortController();
		const signal = abortCtl.signal;

		if (!isCopilotModel(ctx)) {
			// Nothing to fetch; the footer render skips the credits chunk based on model gate.
			requestRender?.();
			return;
		}

		if (!tokenCache) {
			tokenCache = await readTokenFromKeychain(pi, signal);
		}
		if (!tokenCache) {
			lastError = "no token";
			snapshotCache = undefined;
			requestRender?.();
			return;
		}

		try {
			const data = await fetchUsage(tokenCache, signal);
			snapshotCache = toSnapshot(data);
			lastError = undefined;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/HTTP 401|HTTP 403/.test(msg)) tokenCache = undefined;
			lastError = msg;
			snapshotCache = undefined;
		}
		requestRender?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		// Install the custom footer once per session.
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const renderLines = (width: number, pwd: string, branch: string | null, full: boolean): string[] => {
				let cost = 0;
				let hit: number | null = null;
				for (const e of ctx.sessionManager.getBranch()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const u = e.message.usage;
						cost += u.cost?.total ?? 0;
						const prompt = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
						hit = prompt > 0 ? ((u.cacheRead ?? 0) / prompt) * 100 : hit;
					}
				}
				// Measure against the compaction limit: the context-ceiling status
				// when that extension runs, the model's window otherwise.
				const usage = ctx.getContextUsage?.();
				const ceiling = parseCeiling(footerData.getExtensionStatuses().get("ceiling"));
				const contextLimit = ceiling?.limit ?? usage?.contextWindow ?? (ctx.model as ModelWithMeta | undefined)?.contextWindow ?? 0;
				const contextTokens = typeof usage?.tokens === "number" ? usage.tokens : (ceiling?.used ?? null);
				return footerLines(
					{
						pwd,
						branch,
						contextTokens,
						contextLimit,
						cacheHitPercent: hit,
						cost,
						role: agentRole(),
						model: ctx.model?.id,
						provider: ctx.model?.provider,
						copilotQuota: snapshotCache && !snapshotCache.unlimited ? { used: snapshotCache.used, total: snapshotCache.total } : undefined,
						copilotText: snapshotCache?.text,
						copilotNote:
							lastError === "no token"
								? "Copilot ⛔ (add token: security add-generic-password -s github-copilot-token -a $USER -w)"
								: lastError
									? `Copilot: ${lastError}`
									: isCopilotModel(ctx)
										? "Copilot …"
										: undefined,
						otherStatuses: [...footerData.getExtensionStatuses().entries()]
							.filter(([key]) => key !== "ceiling" && key !== "gateway-budget")
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
							.filter(Boolean),
						budgetStatus: footerData.getExtensionStatuses().get("gateway-budget"),
						thinking: (ctx.model as ModelWithMeta | undefined)?.reasoning ? pi.getThinkingLevel() : undefined,
						fmtTokens,
						fg: colorize((token, t) => theme.fg(token as never, t)),
						truncate: truncateToWidth,
						measure: visibleWidth,
					},
					width,
					full,
				);
			};
			return {
				dispose: () => {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const home = process.env.HOME || process.env.USERPROFILE || "";
					let pwd = ctx.cwd;
					if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
					return renderLines(width, pwd, footerData.getGitBranch(), width >= narrowThreshold());
				},
			};
		});

		await refresh(ctx);
		timer = setInterval(() => {
			void refresh(ctx);
		}, POLL_INTERVAL_MS);
	});

	pi.on("model_select", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		abortCtl?.abort();
		abortCtl = undefined;
		ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("copilot-refresh", {
		description: "Refresh GitHub Copilot AI-credits usage in the status bar",
		handler: async (_args, ctx) => {
			tokenCache = undefined;
			await refresh(ctx);
			ctx.ui.notify(
				snapshotCache
					? `Copilot: ${snapshotCache.text}`
					: lastError
						? `Copilot: ${lastError}`
						: "Copilot: (no model gate matched)",
				snapshotCache ? "info" : "warning",
			);
		},
	});
}
