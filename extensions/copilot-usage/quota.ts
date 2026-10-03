/**
 * The Copilot quota endpoint, shared by the footer (copilot-usage) and the
 * orchestrator's pace note (copilot-pace). The endpoint is the one the
 * github.com settings page reads; the token is a fine-grained PAT with no repo
 * scopes in Keychain (service `github-copilot-token`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const KEYCHAIN_SERVICE = "github-copilot-token";
export const ENDPOINT = "https://api.github.com/copilot_internal/user";

export interface QuotaSnapshot {
	remaining?: number;
	entitlement?: number;
	percent_remaining?: number;
	unlimited?: boolean;
}

export interface CopilotUserResponse {
	quota_snapshots?: {
		chat?: QuotaSnapshot;
		completions?: QuotaSnapshot;
		premium_interactions?: QuotaSnapshot;
	};
	quota_reset_date_utc?: string;
	quota_reset_date?: string;
}

export function pickSnapshot(resp: CopilotUserResponse): QuotaSnapshot | undefined {
	const snaps = resp.quota_snapshots ?? {};
	const candidates = [snaps.premium_interactions, snaps.chat, snaps.completions].filter(
		(s): s is QuotaSnapshot => !!s && s.entitlement !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return candidates.reduce((best, s) =>
		(s.entitlement ?? 0) > (best.entitlement ?? 0) ? s : best,
	);
}

export async function readTokenFromKeychain(pi: ExtensionAPI, signal: AbortSignal): Promise<string | undefined> {
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

export async function fetchUsage(token: string, signal: AbortSignal): Promise<CopilotUserResponse> {
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
