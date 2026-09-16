/**
 * copilot-credits — show the session's GitHub Copilot spend in AI credits.
 *
 * Pi prices built-in `github-copilot` models at the Anthropic list price, so the
 * footer's `$` for a Copilot session is not what the subscription bills. Copilot
 * meters premium requests in credits per token; measured on 2026-09-04 for Opus
 * (500 / 2500 / 50 / 625 credits per 1M tokens) that is exactly the list price
 * times 100. This extension sums `usage.cost.total` of assistant messages whose
 * provider is `github-copilot` on the current branch, multiplies by that factor
 * and shows it as a footer status. Gateway / other providers are left to the
 * built-in `$`.
 *
 * Config: `<agentDir>/copilot-credits.json` → { "creditsPerDollar": 100 }
 * Env:    PI_COPILOT_CREDITS_PER_DOLLAR overrides the config.
 * Command: /credits — per-model breakdown for the session.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "copilot-credits";
export const DEFAULT_CREDITS_PER_DOLLAR = 100;
export const COPILOT_PROVIDER = "github-copilot";

export interface CreditTotals {
  credits: number;
  dollars: number;
  byModel: Map<string, { credits: number; messages: number }>;
}

export function resolveCreditsPerDollar(agentDir?: string): number {
  const env = Number(process.env.PI_COPILOT_CREDITS_PER_DOLLAR);
  if (Number.isFinite(env) && env > 0) return env;
  const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const file = join(dir, "copilot-credits.json");
  if (existsSync(file)) {
    try {
      const cfg = JSON.parse(readFileSync(file, "utf-8")) as { creditsPerDollar?: unknown };
      if (typeof cfg.creditsPerDollar === "number" && cfg.creditsPerDollar > 0) return cfg.creditsPerDollar;
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_CREDITS_PER_DOLLAR;
}

/** Sum Copilot spend over session entries (the shape `sessionManager.getBranch()` returns). */
export function sumCopilotCredits(entries: Iterable<any>, creditsPerDollar: number): CreditTotals {
  const byModel = new Map<string, { credits: number; messages: number }>();
  let dollars = 0;
  for (const entry of entries) {
    const message = entry?.message ?? entry;
    if (!message || message.role !== "assistant" || message.provider !== COPILOT_PROVIDER) continue;
    const total = message.usage?.cost?.total;
    if (typeof total !== "number" || !Number.isFinite(total)) continue;
    dollars += total;
    const model = typeof message.model === "string" ? message.model : "unknown";
    const slot = byModel.get(model) ?? { credits: 0, messages: 0 };
    slot.credits += total * creditsPerDollar;
    slot.messages += 1;
    byModel.set(model, slot);
  }
  return { credits: dollars * creditsPerDollar, dollars, byModel };
}

export function formatCredits(credits: number): string {
  if (credits < 10) return credits.toFixed(2);
  if (credits < 1000) return credits.toFixed(1);
  return Math.round(credits).toLocaleString("en-US");
}

export default function copilotCreditsExtension(pi: ExtensionAPI): void {
  let creditsPerDollar = DEFAULT_CREDITS_PER_DOLLAR;

  const totals = (ctx: any): CreditTotals =>
    sumCopilotCredits(ctx?.sessionManager?.getBranch?.() ?? [], creditsPerDollar);

  const refresh = (ctx: any) => {
    if (!ctx?.ui?.setStatus) return;
    const t = totals(ctx);
    ctx.ui.setStatus(STATUS_KEY, t.byModel.size > 0 ? `⚡ ${formatCredits(t.credits)} cr` : undefined);
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    creditsPerDollar = resolveCreditsPerDollar();
    refresh(ctx);
  });
  pi.on("turn_end", (_event: any, ctx: any) => refresh(ctx));
  pi.on("agent_end", (_event: any, ctx: any) => refresh(ctx));
  pi.on("session_compact", (_event: any, ctx: any) => refresh(ctx));

  pi.registerCommand?.("credits", {
    description: "Copilot spend for this session in AI credits, per model",
    handler: async (_args: string, ctx: any) => {
      const t = totals(ctx);
      if (t.byModel.size === 0) {
        ctx.ui?.notify?.("No github-copilot usage in this session.", "info");
        return;
      }
      const lines = [...t.byModel.entries()]
        .sort((a, b) => b[1].credits - a[1].credits)
        .map(([model, v]) => `${model}: ${formatCredits(v.credits)} cr over ${v.messages} responses`);
      lines.push(`total: ${formatCredits(t.credits)} cr (list price $${t.dollars.toFixed(3)} × ${creditsPerDollar})`);
      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });
}
