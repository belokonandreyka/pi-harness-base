import { basename, dirname, join } from "node:path";

export interface RequestEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "request";
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Seconds since the previous provider response in the same run; null for the first one. */
  gapSec: number | null;
}

export interface WarmEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "warm_decision";
  provider: string;
  model: string;
  action: "warm" | "stop";
  warmCost: number;
  missCost: number;
  probability: number;
}

export interface OverrideEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "warm_override";
  provider: string;
  model: string;
  /** pi's own verdict and the verdict a policy extension replaced it with. */
  pi: "warm" | "stop";
  final: "warm" | "stop";
  reason: string;
  warmCost: number;
  missCost: number;
}

/** A refresh made by the gateway-warmer extension, with the usage the gateway reported. */
export interface GatewayWarmEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "warm";
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  reason: string;
}

/** gateway-warmer bookkeeping and pi's own warmer as seen through the provider hooks. */
export interface WarmNoteEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "warm_skip" | "warm_error" | "warm_attempt" | "warm_result" | "warm_missing";
  provider: string;
  model: string;
  reason?: string;
  status?: number;
}

export type CacheEntry = RequestEntry | WarmEntry | OverrideEntry | GatewayWarmEntry | WarmNoteEntry;

const KINDS = new Set(["request", "warm_decision", "warm_override", "warm", "warm_skip", "warm_error", "warm_attempt", "warm_result", "warm_missing"]);

/** A gap this long means the default 5-minute provider cache would have expired without a refresh. */
export const EXPIRY_GAP_SEC = 270;
/** Below this many prompt tokens a miss is noise, not money. */
export const MIN_PREFIX_TOKENS = 4000;

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(env.HOME ?? "", ".pi", "agent");
}

export function profileLabel(agentDir: string): string {
  const parent = basename(dirname(agentDir));
  const trimmed = parent.startsWith(".") ? parent.slice(1) : parent;
  return trimmed.length > 0 ? trimmed : "unknown";
}

export function logPath(agentDir: string): string {
  return join(agentDir, "telemetry", "cache-usage.jsonl");
}

export function parseEntries(contents: string): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && KINDS.has(e.kind)) out.push(e);
    } catch {
      // a torn line from a crashed session is not worth failing the report
    }
  }
  return out;
}

export interface ModelStats {
  key: string;
  requests: number;
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Requests after a gap >= EXPIRY_GAP_SEC that still read the cache: the refresh paid off. */
  longGapHits: number;
  /** Requests after such a gap that re-wrote the prefix: the cache was lost. */
  longGapMisses: number;
  longGapMissTokens: number;
  /** Misses with a short gap: the prefix itself changed (compaction, model switch, prompt edit). */
  shortGapMisses: number;
  warmCount: number;
  stopCount: number;
  /** Refreshes that happened only because a policy extension overruled pi. */
  policyWarms: number;
  warmCost: number;
  avoidedMissCost: number;
  /** gateway-warmer: refreshes actually sent, what they cost, how many found the cache already gone. */
  gwWarms: number;
  gwWarmCost: number;
  gwWarmMisses: number;
  gwSkips: number;
  gwErrors: number;
  /** pi's own warmer, seen through the provider hooks: replays sent and replays that failed. */
  piWarmAttempts: number;
  piWarmFailures: number;
  /** idle stretches in which no warmer did anything before the cache lifetime ran out */
  warmMissing: number;
}

function blank(key: string): ModelStats {
  return { key, requests: 0, promptTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, longGapHits: 0, longGapMisses: 0,
    longGapMissTokens: 0, shortGapMisses: 0, warmCount: 0, stopCount: 0, policyWarms: 0, warmCost: 0, avoidedMissCost: 0,
    gwWarms: 0, gwWarmCost: 0, gwWarmMisses: 0, gwSkips: 0, gwErrors: 0, piWarmAttempts: 0, piWarmFailures: 0, warmMissing: 0 };
}

export function summarize(entries: CacheEntry[], sinceMs = 0): ModelStats[] {
  const byKey = new Map<string, ModelStats>();
  const get = (e: CacheEntry) => {
    const key = `${e.profile} · ${e.provider}/${e.model}`;
    let s = byKey.get(key);
    if (!s) byKey.set(key, (s = blank(key)));
    return s;
  };
  for (const e of entries) {
    if (sinceMs && Date.parse(e.ts) < sinceMs) continue;
    const s = get(e);
    if (e.kind === "warm_override") {
      // The decision line already counted pi's verdict; move it to the final one.
      if (e.final === "warm" && e.pi !== "warm") {
        s.policyWarms++;
        s.warmCount++;
        s.stopCount = Math.max(0, s.stopCount - 1);
        s.warmCost += e.warmCost || 0;
        s.avoidedMissCost += e.missCost || 0;
      } else if (e.final === "stop" && e.pi === "warm") {
        s.stopCount++;
        s.warmCount = Math.max(0, s.warmCount - 1);
        s.warmCost = Math.max(0, s.warmCost - (e.warmCost || 0));
        s.avoidedMissCost = Math.max(0, s.avoidedMissCost - (e.missCost || 0));
      }
      continue;
    }
    if (e.kind === "warm") {
      s.gwWarms++;
      s.gwWarmCost += e.cost || 0;
      if (!e.cacheRead) s.gwWarmMisses++;
      continue;
    }
    if (e.kind === "warm_skip") { s.gwSkips++; continue; }
    if (e.kind === "warm_error") { s.gwErrors++; continue; }
    if (e.kind === "warm_attempt") { s.piWarmAttempts++; continue; }
    if (e.kind === "warm_result") { if ((e.status ?? 0) >= 400) s.piWarmFailures++; continue; }
    if (e.kind === "warm_missing") { s.warmMissing++; continue; }
    if (e.kind === "warm_decision") {
      if (e.action === "warm") {
        s.warmCount++;
        s.warmCost += e.warmCost || 0;
        s.avoidedMissCost += e.missCost || 0;
      } else s.stopCount++;
      continue;
    }
    const prompt = e.input + e.cacheRead + e.cacheWrite;
    s.requests++;
    s.promptTokens += prompt;
    s.cacheRead += e.cacheRead;
    s.cacheWrite += e.cacheWrite;
    s.cost += e.cost || 0;
    if (e.gapSec === null || prompt < MIN_PREFIX_TOKENS) continue;
    const hit = e.cacheRead >= prompt * 0.5;
    if (e.gapSec >= EXPIRY_GAP_SEC) {
      if (hit) s.longGapHits++;
      else {
        s.longGapMisses++;
        s.longGapMissTokens += e.cacheWrite + e.input;
      }
    } else if (!hit) s.shortGapMisses++;
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost);
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export function formatStats(stats: ModelStats[], days: number): string {
  if (stats.length === 0) return `cache-telemetry: no requests recorded in the last ${days} day(s)`;
  const lines = [`Prompt cache, last ${days} day(s)`, ""];
  for (const s of stats) {
    const hitPct = s.promptTokens ? Math.round((100 * s.cacheRead) / s.promptTokens) : 0;
    lines.push(`${s.key}`);
    lines.push(`  requests ${s.requests} · prompt ${k(s.promptTokens)} tok · from cache ${hitPct}% · written ${k(s.cacheWrite)} · cost ${usd(s.cost)}`);
    lines.push(`  pauses >= ${EXPIRY_GAP_SEC}s: ${s.longGapHits} still hit the cache, ${s.longGapMisses} lost it (${k(s.longGapMissTokens)} tok re-sent) · prefix changed mid-run: ${s.shortGapMisses}`);
    if (s.warmCount || s.stopCount) {
      lines.push(`  warming: ${s.warmCount} refreshes for ${usd(s.warmCost)} (pi estimated ${usd(s.avoidedMissCost)} at risk), ${s.stopCount} times judged not worth it${s.policyWarms ? `, ${s.policyWarms} of the refreshes forced by policy` : ""}`);
    } else lines.push("  warming: no decisions recorded");
    if (s.gwWarms || s.gwSkips || s.gwErrors) {
      lines.push(`  gateway-warmer: ${s.gwWarms} refreshes for ${usd(s.gwWarmCost)}${s.gwWarmMisses ? ` (${s.gwWarmMisses} found the cache already gone)` : ""}, ${s.gwSkips} skipped, ${s.gwErrors} errors`);
    }
    if (s.piWarmAttempts || s.warmMissing) {
      lines.push(`  pi warmer: ${s.piWarmAttempts} replays sent, ${s.piWarmFailures} failed at the gateway · ${s.warmMissing} idle stretches with no refresh at all`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
