/**
 * gateway-warmer — keeps the prompt cache warm through an Anthropic-compatible
 * gateway, independently of pi's own cache warmer.
 *
 * Why not pi's warmer (0.87): through the Vitu gateway (Bifrost in front of
 * Bedrock) its streaming `max_tokens: 1` replay is sometimes cut after
 * `message_start`, so pi-ai throws, nothing is recorded and `/cache-stats`
 * cannot see the spend; and the warmer stops silently when its refresh timer
 * runs more than (ttl - 0.9 ttl) / 2 = 14 s late or when it judges the
 * conversation context changed — on 2026-09-24 that turned an 11-minute wait
 * into a 95k-token re-bill. Measured 2026-09-24: a max_tokens=1 replay does
 * refresh Bedrock's cache (write → +4 min warm → +4 min read hit).
 *
 * How: `before_provider_request` hands over the exact payload pi sends, and
 * `before_provider_headers` the headers (beta features included). After each
 * agent run ends the extension replays the last payload non-streaming with
 * `max_tokens: 1` every 0.9 × cache lifetime, for as long as the
 * cache-warm-policy rules say so (a subagent of this process is running, or
 * the first `idleMinutes` after the last real request), and logs every replay
 * as a `warm` row in the cache-telemetry log with the usage the gateway
 * reported. A refresh that would land after the lifetime has passed is skipped
 * (it would be a full-price write for a cache nobody may use). Never runs
 * while an agent run is active: the next real request rewrites the cache anyway.
 *
 * Needs a `promptCache.short` lifetime on the model and `cacheWarming: "off"`
 * in settings so pi's warmer does not double the spend. Config: the same
 * `cache-warm-policy.json` (idleMinutes, minContextTokens, childMaxAgeMinutes)
 * plus `gateway-warmer.json` { enabled }. Env `PI_GATEWAY_WARMER=0` disables.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { countRunningChildren, decide, loadConfig as loadPolicy, type WarmPolicyConfig } from "../cache-warm-policy/policy.ts";

export interface Deps {
  now?: () => number;
  fetch?: typeof fetch;
  setTimer?: (fn: () => unknown, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv || join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

export function enabled(agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_GATEWAY_WARMER?.trim() === "0") return false;
  const p = join(agentDir, "gateway-warmer.json");
  if (!existsSync(p)) return true;
  try {
    return JSON.parse(readFileSync(p, "utf-8"))?.enabled !== false;
  } catch {
    return true;
  }
}

/** The warm replay: same request, one output token, no streaming. */
/** A 1-token replay keeps the cache key only when thinking is off or adaptive (no budget_tokens). */
export function isReplayable(payload: Record<string, unknown>): boolean {
  const t = payload.thinking as { type?: string; budget_tokens?: unknown } | undefined;
  if (!t || typeof t !== "object") return true;
  return t.type !== "enabled" && typeof t.budget_tokens !== "number";
}

export function buildWarmPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { stream: _stream, ...rest } = payload;
  return { ...rest, max_tokens: 1 };
}

/** Refresh at 90% of the lifetime, at least ten seconds before it ends. */
export function refreshDelayMs(ttlMs: number): number | null {
  if (!Number.isFinite(ttlMs) || ttlMs <= 10_000) return null;
  return Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000));
}

export function costOf(model: any, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const c = model?.cost ?? {};
  const per = (n: number, price: unknown) => (typeof price === "number" ? (n * price) / 1_000_000 : 0);
  return per(usage.input, c.input) + per(usage.output, c.output) + per(usage.cacheRead, c.cacheRead) + per(usage.cacheWrite, c.cacheWrite);
}

export function parseUsage(body: any): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const u = body?.usage ?? {};
  return {
    input: Number(u.input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
    cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
  };
}

export function warmHeaders(auth: { apiKey?: string; headers?: Record<string, string> }, captured: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(auth.headers ?? {}) };
  for (const [k, v] of Object.entries(captured)) {
    const key = k.toLowerCase();
    if (key === "anthropic-beta" || key === "anthropic-version") h[key] = v;
  }
  if (auth.apiKey) {
    h["x-api-key"] = auth.apiKey;
    if (!h.authorization && !h.Authorization) h.authorization = `Bearer ${auth.apiKey}`;
  }
  return h;
}

export default function gatewayWarmerExtension(pi: any, deps: Deps = {}): void {
  const agentDir = resolveAgentDir();
  if (!enabled(agentDir)) return;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as any));
  const policy: WarmPolicyConfig = loadPolicy(agentDir);
  const runsDir = join(process.env.COLLABORATING_AGENTS_DIR?.trim() || join(agentDir, "collaborating-agents"), "runs");
  const logFile = join(agentDir, "telemetry", "cache-usage.jsonl");
  const profile = (() => {
    const parent = dirname(agentDir).split("/").pop() ?? "";
    return (parent.startsWith(".") ? parent.slice(1) : parent) || "unknown";
  })();

  let lastPayload: Record<string, unknown> | null = null;
  let lastHeaders: Record<string, string> = {};
  let lastRealRequestAt: number | null = null;
  let lastRefreshAt: number | null = null; // real request or successful warm
  let active = false;
  let timer: unknown = null;
  let lastCtx: any = null;
  let warmsThisIdle = 0;

  function log(entry: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${JSON.stringify({ ts: new Date(now()).toISOString(), profile, run: "gateway-warmer", ...entry })}\n`, "utf-8");
    } catch {
      // telemetry must never break the session
    }
  }

  function cancel(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function model(): any {
    return lastCtx?.model ?? null;
  }

  function ttlMs(): number | null {
    const s = model()?.promptCache?.short;
    return typeof s === "number" && s > 0 ? s * 1000 : null;
  }

  function schedule(fromMs: number): void {
    cancel();
    const ttl = ttlMs();
    const delay = ttl === null ? null : refreshDelayMs(ttl);
    if (delay === null) return;
    const at = fromMs + delay;
    timer = setTimer(() => refresh(), Math.max(0, at - now()));
  }

  async function refresh(): Promise<void> {
    timer = null;
    const m = model();
    const ttl = ttlMs();
    if (active || !lastPayload || !m || ttl === null || m.api !== "anthropic-messages") return;
    if (!isReplayable(lastPayload)) {
      // Budget-based thinking derives budget_tokens from max_tokens and Anthropic keys the
      // message cache on the budget: a 1-token replay would be rejected (400) or refresh
      // only the system/tools prefix. Same rule as pi's own CacheWarmer.isReplayable.
      log({ kind: "warm_skip", provider: m.provider, model: m.id, reason: "budget thinking is not replayable (needs adaptive thinking or thinking off)" });
      return;
    }
    const since = lastRefreshAt === null ? null : now() - lastRefreshAt;
    if (since !== null && since > ttl - 15_000) {
      log({ kind: "warm_skip", provider: m.provider, model: m.id, reason: `too late: ${Math.round(since / 1000)}s since last refresh, lifetime ${ttl / 1000}s` });
      return;
    }
    let contextTokens: number | null = null;
    try {
      contextTokens = lastCtx?.getContextUsage?.()?.tokens ?? null;
    } catch {
      contextTokens = null;
    }
    const verdict = decide(
      {
        idle: true,
        contextTokens,
        childrenRunning: countRunningChildren(runsDir, process.pid, policy.childMaxAgeMinutes, now()),
        secondsSinceRealRequest: lastRealRequestAt === null ? null : (now() - lastRealRequestAt) / 1000,
      },
      policy,
    );
    if (verdict.action !== "warm") {
      log({ kind: "warm_skip", provider: m.provider, model: m.id, reason: verdict.reason });
      return;
    }
    let auth: any;
    try {
      auth = await lastCtx?.modelRegistry?.getApiKeyAndHeaders?.(m);
    } catch (e) {
      auth = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!auth?.ok) {
      log({ kind: "warm_skip", provider: m.provider, model: m.id, reason: `no credentials: ${auth?.error ?? "unknown"}` });
      return;
    }
    const base = String(auth.baseUrl ?? m.baseUrl ?? "").replace(/\/+$/, "");
    const started = now();
    try {
      const res = await doFetch(`${base}/v1/messages`, {
        method: "POST",
        headers: warmHeaders(auth, lastHeaders),
        body: JSON.stringify(buildWarmPayload(lastPayload)),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        log({ kind: "warm_error", provider: m.provider, model: m.id, status: res.status, error: String(body?.error?.message ?? "").slice(0, 200) });
        return; // a failing gateway is not worth hammering; the next real request re-arms
      }
      const usage = parseUsage(body);
      const cost = costOf(m, usage);
      lastRefreshAt = now();
      warmsThisIdle += 1;
      log({ kind: "warm", provider: m.provider, model: m.id, ...usage, cost, reason: verdict.reason, ms: now() - started, n: warmsThisIdle });
      lastCtx?.ui?.notify?.(`gateway-warmer: cache refreshed (${usage.cacheRead.toLocaleString()} tok read, $${cost.toFixed(3)}, ${verdict.reason})`, "info");
      schedule(lastRefreshAt);
    } catch (e) {
      log({ kind: "warm_error", provider: m.provider, model: m.id, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }

  pi.on("before_provider_request", (event: any) => {
    const p = event?.payload;
    if (p && typeof p === "object" && Array.isArray(p.messages) && p.max_tokens !== 1) lastPayload = p;
  });

  pi.on("before_provider_headers", (event: any) => {
    const h = event?.headers;
    if (h && typeof h === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
      lastHeaders = out;
    }
  });

  pi.on("agent_start", () => {
    active = true;
    cancel();
  });

  pi.on("turn_end", (event: any, ctx: any) => {
    if (ctx) lastCtx = ctx;
    if (event?.message?.role === "assistant" && event.message.usage) {
      lastRealRequestAt = now();
      lastRefreshAt = lastRealRequestAt;
      warmsThisIdle = 0;
    }
  });

  pi.on("agent_end", (_event: any, ctx: any) => {
    if (ctx) lastCtx = ctx;
    active = false;
    if (lastRefreshAt !== null) schedule(lastRefreshAt);
  });

  pi.on("session_shutdown", cancel);
}
