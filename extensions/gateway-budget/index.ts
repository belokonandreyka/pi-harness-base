/**
 * gateway-budget — how much of the AI-gateway budget this machine has used.
 *
 * Bifrost only exposes per-key usage to gateway admins (the virtual key gets 401
 * on /api/governance/*), so the numbers are kept locally: every session appends
 * its own gateway spend deltas to a shared ledger, and the footer status sums the
 * ledger for the current calendar week (Mon–Sun) and month against the caps.
 * The ledger is shared by all profiles on purpose (orchestrator and subagents
 * both spend from the same key), so it lives under ~/.pi/agent regardless of
 * PI_CODING_AGENT_DIR.
 *
 * Config `<agentDir>/gateway-budget.json`:
 *   { "providers": ["gateway", "gateway-openai"],
 *     "weeklyCap": 500, "monthlyCap": 0,
 *     "weekFloor": "2026-09-10T20:30:00Z",
 *     "ledger": "~/.pi/agent/gateway-ledger.jsonl" }
 * A cap of 0 means "no cap, just show the total". `weekFloor` counts the current
 * week only from that instant — set it when the gateway admin resets the key's
 * counter mid-week; it stops mattering once the next calendar week starts.
 * `refreshSeconds` (default 60) re-reads the ledger on a timer so spend from
 * other sessions (subagents, a second orchestrator window) shows up without
 * waiting for this session's next turn.
 *
 * Sessions that ran without this extension (started before it was enabled, or
 * in a profile that does not load it) never write to the ledger, so on session
 * start — and on `/budget sync` — the session files under `sessionsDir`
 * modified in the last `reconcileDays` (default 8) are scanned and any spend
 * the ledger is missing for a session is appended per (session, day).
 * Command: /budget — week and month totals, remaining, and this session's share.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "gateway-budget";

export interface BudgetConfig {
  providers: string[];
  weeklyCap: number;
  monthlyCap: number;
  /** ISO instant; the current week is counted only from here (admin reset mid-week). */
  weekFloor?: string;
  ledger: string;
  /** How often to re-read the ledger for other sessions' spend; 0 disables the timer. */
  refreshSeconds: number;
  /** Where pi keeps session .jsonl files (scanned two levels deep for reconciliation). */
  sessionsDir: string;
  /** Only session files modified within this many days are reconciled; 0 disables it. */
  reconcileDays: number;
  /** models.json to price reconciled messages from tokens (stored costs may predate a price fix). */
  modelsFile: string;
  /** Show the footer status only while the current model is on a gateway provider (default true). */
  statusOnlyForGatewayModel: boolean;
}

export type PriceTable = Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;

export function loadPriceTable(modelsFile: string): PriceTable {
  const table: PriceTable = new Map();
  if (!existsSync(modelsFile)) return table;
  try {
    const raw = JSON.parse(readFileSync(modelsFile, "utf-8")) as any;
    for (const [provider, p] of Object.entries<any>(raw?.providers ?? {})) {
      for (const m of p?.models ?? []) {
        const c = m?.cost ?? {};
        if (typeof m?.id !== "string") continue;
        table.set(`${provider}/${m.id}`, {
          input: Number(c.input) || 0,
          output: Number(c.output) || 0,
          cacheRead: Number(c.cacheRead) || 0,
          cacheWrite: Number(c.cacheWrite) || 0,
        });
      }
    }
  } catch {
    // no table
  }
  return table;
}

/** Cost of one assistant message: tokens × current prices when the model is known, else the stored cost. */
export function priceMessage(m: any, table: PriceTable): number | undefined {
  const stored = m?.usage?.cost?.total;
  const ids = [m?.model, typeof m?.model === "string" ? m.model.replace(/^us\.anthropic\./, "") : undefined];
  for (const id of ids) {
    const price = id ? table.get(`${m.provider}/${id}`) : undefined;
    if (!price) continue;
    const u = m.usage ?? {};
    return (
      ((u.input ?? 0) * price.input + (u.output ?? 0) * price.output + (u.cacheRead ?? 0) * price.cacheRead + (u.cacheWrite ?? 0) * price.cacheWrite) /
      1_000_000
    );
  }
  return typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
}

export const DEFAULT_CONFIG: BudgetConfig = {
  providers: ["gateway", "gateway-openai"],
  weeklyCap: 500,
  monthlyCap: 0,
  ledger: join(homedir(), ".pi", "agent", "gateway-ledger.jsonl"),
  refreshSeconds: 60,
  sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
  reconcileDays: 8,
  modelsFile: join(homedir(), ".pi", "agent", "models.json"),
  statusOnlyForGatewayModel: true,
};

export interface LedgerEntry {
  ts: string; // ISO timestamp the spend was recorded at
  session: string;
  delta: number; // dollars
  source?: string;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(agentDir?: string): BudgetConfig {
  const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const file = join(dir, "gateway-budget.json");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<BudgetConfig>;
    return {
      providers: Array.isArray(raw.providers) && raw.providers.length > 0 ? raw.providers.map(String) : DEFAULT_CONFIG.providers,
      weeklyCap: typeof raw.weeklyCap === "number" && raw.weeklyCap >= 0 ? raw.weeklyCap : DEFAULT_CONFIG.weeklyCap,
      monthlyCap: typeof raw.monthlyCap === "number" && raw.monthlyCap >= 0 ? raw.monthlyCap : DEFAULT_CONFIG.monthlyCap,
      ...(typeof raw.weekFloor === "string" && !Number.isNaN(new Date(raw.weekFloor).getTime()) ? { weekFloor: raw.weekFloor } : {}),
      ledger: typeof raw.ledger === "string" && raw.ledger.trim() ? expandHome(raw.ledger.trim()) : DEFAULT_CONFIG.ledger,
      refreshSeconds:
        typeof raw.refreshSeconds === "number" && raw.refreshSeconds >= 0 ? raw.refreshSeconds : DEFAULT_CONFIG.refreshSeconds,
      sessionsDir:
        typeof raw.sessionsDir === "string" && raw.sessionsDir.trim() ? expandHome(raw.sessionsDir.trim()) : DEFAULT_CONFIG.sessionsDir,
      reconcileDays:
        typeof raw.reconcileDays === "number" && raw.reconcileDays >= 0 ? raw.reconcileDays : DEFAULT_CONFIG.reconcileDays,
      modelsFile:
        typeof raw.modelsFile === "string" && raw.modelsFile.trim() ? expandHome(raw.modelsFile.trim()) : join(dir, "models.json"),
      statusOnlyForGatewayModel:
        typeof raw.statusOnlyForGatewayModel === "boolean" ? raw.statusOnlyForGatewayModel : DEFAULT_CONFIG.statusOnlyForGatewayModel,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (typeof e.ts === "string" && typeof e.session === "string" && typeof e.delta === "number") out.push(e);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export function appendLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/** Start of the calendar week (Monday 00:00 local) and month for a given instant. */
export function periodStarts(now: Date, weekFloor?: string): { week: Date; month: Date } {
  let week = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (week.getDay() + 6) % 7; // Monday = 0
  week.setDate(week.getDate() - dow);
  if (weekFloor) {
    const floor = new Date(weekFloor);
    if (!Number.isNaN(floor.getTime()) && floor > week && floor <= now) week = floor;
  }
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  return { week, month };
}

export function sumSince(entries: LedgerEntry[], since: Date): number {
  const t = since.getTime();
  let total = 0;
  for (const e of entries) if (new Date(e.ts).getTime() >= t) total += e.delta;
  return total;
}

/** Gateway spend on the session branch: assistant messages whose provider is one of `providers`. */
export function sessionGatewaySpend(entries: Iterable<any>, providers: string[]): number {
  let total = 0;
  for (const entry of entries) {
    const m = entry?.message ?? entry;
    if (!m || m.role !== "assistant" || !providers.includes(m.provider)) continue;
    const c = m.usage?.cost?.total;
    if (typeof c === "number" && Number.isFinite(c)) total += c;
  }
  return total;
}

/** Gateway spend per (session id, UTC day) found in session files modified since `sinceMs`. */
export function scanSessionSpend(
  sessionsDir: string,
  providers: string[],
  sinceMs: number,
  prices: PriceTable = new Map(),
): Map<string, { session: string; day: string; spend: number; lastTs: string }> {
  const out = new Map<string, { session: string; day: string; spend: number; lastTs: string }>();
  if (!existsSync(sessionsDir)) return out;
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 2) visit(full, depth + 1);
      } else if (name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) {
        files.push(full);
      }
    }
  };
  visit(sessionsDir, 0);
  const needle = providers.map((p) => `"provider":"${p}"`);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let sessionId: string | undefined;
    for (const line of text.split("\n")) {
      if (!sessionId && line.includes('"type":"session"')) {
        try {
          const head = JSON.parse(line);
          if (typeof head.id === "string") sessionId = head.id;
        } catch {
          // ignore
        }
        continue;
      }
      if (!needle.some((n) => line.includes(n))) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const m = entry?.message;
      if (!m || m.role !== "assistant" || !providers.includes(m.provider)) continue;
      const c = priceMessage(m, prices);
      const ts: string = entry.timestamp ?? m.timestamp ?? "";
      if (c === undefined || !ts) continue;
      const session = sessionId ?? file;
      const day = ts.slice(0, 10);
      const key = `${session}|${day}`;
      const slot = out.get(key) ?? { session, day, spend: 0, lastTs: ts };
      slot.spend += c;
      if (ts > slot.lastTs) slot.lastTs = ts;
      out.set(key, slot);
    }
  }
  return out;
}

/**
 * Append what the ledger is missing per session (spend found in session files
 * minus what the ledger already holds for that session). Returns the entries added.
 */
export function reconcileLedger(cfg: BudgetConfig, ledger: LedgerEntry[], now = new Date()): LedgerEntry[] {
  if (cfg.reconcileDays <= 0) return [];
  const since = now.getTime() - cfg.reconcileDays * 86_400_000;
  const found = scanSessionSpend(cfg.sessionsDir, cfg.providers, since, loadPriceTable(cfg.modelsFile));
  const recorded = new Map<string, number>();
  for (const e of ledger) recorded.set(e.session, (recorded.get(e.session) ?? 0) + e.delta);
  const perSession = new Map<string, Array<{ day: string; spend: number; lastTs: string }>>();
  for (const v of found.values()) {
    const list = perSession.get(v.session) ?? [];
    list.push(v);
    perSession.set(v.session, list);
  }
  const added: LedgerEntry[] = [];
  for (const [session, days] of perSession) {
    let missing = days.reduce((s, d) => s + d.spend, 0) - (recorded.get(session) ?? 0);
    if (missing <= 0.0005) continue;
    // Attribute the missing amount to the latest days first so week buckets stay honest.
    for (const d of days.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))) {
      if (missing <= 0.0005) break;
      const part = Math.min(d.spend, missing);
      const entry: LedgerEntry = { ts: d.lastTs, session, delta: Number(part.toFixed(6)), source: "reconcile" };
      appendLedger(cfg.ledger, entry);
      added.push(entry);
      missing -= part;
    }
  }
  return added;
}

export function formatStatus(week: number, month: number, cfg: BudgetConfig): string {
  const mark = (v: number, cap: number) => (cap <= 0 ? "" : v >= cap ? " ⛔" : v >= cap * 0.8 ? " ⚠" : "");
  const money = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const part = (label: string, v: number, cap: number) => `${label} $${money(v)}${cap > 0 ? `/${cap}` : ""}${mark(v, cap)}`;
  return `gw ${part("wk", week, cfg.weeklyCap)} · ${part("mo", month, cfg.monthlyCap)}`;
}

export default function gatewayBudgetExtension(pi: ExtensionAPI): void {
  let cfg = loadConfig();
  let ledger: LedgerEntry[] = [];

  const record = (ctx: any): void => {
    const sessionId: string | undefined = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    const spent = sessionGatewaySpend(ctx?.sessionManager?.getBranch?.() ?? [], cfg.providers);
    const recorded = ledger.filter((e) => e.session === sessionId).reduce((s, e) => s + e.delta, 0);
    const delta = spent - recorded;
    if (delta > 0.0005) {
      const entry: LedgerEntry = { ts: new Date().toISOString(), session: sessionId, delta: Number(delta.toFixed(6)) };
      appendLedger(cfg.ledger, entry);
      ledger.push(entry);
    }
  };

  const refresh = (ctx: any): void => {
    if (!ctx?.ui?.setStatus) return;
    // The ledger is always kept; the status is only for a session whose current
    // model spends from the gateway. A Copilot worker sees its credits instead.
    const provider = ctx?.model?.provider;
    if (cfg.statusOnlyForGatewayModel && typeof provider === "string" && !cfg.providers.includes(provider)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const { week, month } = periodStarts(new Date(), cfg.weekFloor);
    ctx.ui.setStatus(STATUS_KEY, formatStatus(sumSince(ledger, week), sumSince(ledger, month), cfg));
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    cfg = loadConfig();
    ledger = readLedger(cfg.ledger);
    refresh(ctx);
    // Pick up sessions that ran without this extension; off the startup path.
    setTimeout(() => {
      try {
        const added = reconcileLedger(cfg, readLedger(cfg.ledger));
        if (added.length > 0) {
          ledger = readLedger(cfg.ledger);
          refresh(ctx);
        }
      } catch {
        // best effort
      }
    }, 0);
    stopTimer();
    if (cfg.refreshSeconds > 0) {
      // Other sessions append to the same ledger at their own turn ends; poll it so
      // their spend is visible here within a minute, not at this session's next turn.
      timer = setInterval(() => {
        ledger = readLedger(cfg.ledger);
        refresh(ctx);
      }, cfg.refreshSeconds * 1000);
      (timer as any).unref?.();
    }
  });
  pi.on("session_shutdown", () => stopTimer());
  const onTurn = (_event: any, ctx: any) => {
    // Re-read so concurrent sessions (subagents) are reflected, then add ours.
    ledger = readLedger(cfg.ledger);
    record(ctx);
    refresh(ctx);
  };
  pi.on("turn_end", onTurn);
  pi.on("agent_end", onTurn);
  pi.on("model_select", (_event: any, ctx: any) => refresh(ctx));

  pi.registerCommand?.("budget", {
    description: "Gateway spend this week and month against the caps (`/budget sync` reconciles with session files)",
    handler: async (args: string, ctx: any) => {
      ledger = readLedger(cfg.ledger);
      if (args.trim() === "sync") {
        const added = reconcileLedger(cfg, ledger);
        ledger = readLedger(cfg.ledger);
        refresh(ctx);
        ctx.ui?.notify?.(
          added.length > 0
            ? `sync: added ${added.length} entries, $${added.reduce((s, e) => s + e.delta, 0).toFixed(2)} the ledger was missing`
            : "sync: ledger already matches the session files",
          "info",
        );
        return;
      }
      const { week, month } = periodStarts(new Date(), cfg.weekFloor);
      const w = sumSince(ledger, week);
      const m = sumSince(ledger, month);
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const mine = sessionGatewaySpend(ctx?.sessionManager?.getBranch?.() ?? [], cfg.providers);
      const line = (label: string, v: number, cap: number) =>
        cap > 0 ? `${label}: $${v.toFixed(2)} of $${cap}, $${Math.max(0, cap - v).toFixed(2)} left` : `${label}: $${v.toFixed(2)} (no cap)`;
      ctx.ui?.notify?.(
        [
          line(`week (from ${week.toISOString().slice(0, 16).replace("T", " ")}Z)`, w, cfg.weeklyCap),
          line("month", m, cfg.monthlyCap),
          `this session${sessionId ? ` (${sessionId.slice(0, 8)})` : ""}: $${mine.toFixed(3)}`,
          `ledger: ${cfg.ledger} (${ledger.length} entries; local accounting, ~5% under the gateway dashboard)`,
        ].join("\n"),
        "info",
      );
    },
  });
}
