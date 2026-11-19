/**
 * herdr-ticket-label — name the herdr workspace after the tickets this session works on.
 *
 * Several workspaces opened on the same repository all show the repository
 * name in herdr's sidebar, so telling them apart means opening each one. This
 * extension watches what the user types: the first time a message names a
 * ticket key (`FLV-1572`, or a Jira link that contains one), the workspace
 * that holds this pi pane is renamed to the keys, newest last, at most `max`
 * of them (`FLV-1572 · VITU-11802`). The label stays after pi exits — the
 * workspace is still about that ticket — and the keys are stored in the
 * session, so a resumed session keeps adding to the same list.
 *
 *   /ticket                 show the keys and the label
 *   /ticket KEY [KEY ...]   set the keys by hand (replaces the list)
 *   /ticket off             restore the workspace's label from before the first rename, stop renaming
 *   /ticket on              rename again from the next message
 *
 * Only interactive input counts: messages injected by other extensions or the
 * collaboration bus never rename. Inside `<pasted_content>` blocks keys are
 * ignored — a pasted ticket description lists related tickets.
 *
 * Config: `<agentDir>/herdr-ticket-label.json` →
 *   { "enabled": true, "projects": ["FLV", "VITU"], "max": 3, "separator": " · " }
 * `projects` limits keys to those Jira project prefixes; without it any
 * `ABC-123` counts except a short denylist (GPT-6, UTF-8, ISO-8601, ...).
 * Env: PI_HERDR_TICKET_LABEL=0 disables.
 * Needs herdr's pane environment (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID); a no-op elsewhere.
 */
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "herdr-ticket-label";
const DENY = new Set(["GPT", "UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "SSL", "ES", "TS", "IPV", "CVE", "MP", "H", "X", "COVID", "WCAG", "AES", "RSA"]);

export type Config = { enabled: boolean; projects: string[] | null; max: number; separator: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".pi", "agent");
  let file: Record<string, any> = {};
  const p = join(dir, "herdr-ticket-label.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
    } catch {}
  }
  const flag = env.PI_HERDR_TICKET_LABEL?.trim().toLowerCase();
  const projects = Array.isArray(file.projects)
    ? file.projects.filter((x: unknown) => typeof x === "string" && /^[A-Z][A-Z0-9]+$/.test(x))
    : null;
  return {
    enabled: file.enabled !== false && flag !== "0" && flag !== "off",
    projects: projects && projects.length ? projects : null,
    max: Number.isInteger(file.max) && file.max > 0 ? file.max : 3,
    separator: typeof file.separator === "string" ? file.separator : " · ",
  };
}

/** Ticket keys in the order they appear, pasted blocks left out, duplicates dropped. */
export function findKeys(text: string, projects: string[] | null): string[] {
  const own = text.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, " ");
  const keys: string[] = [];
  for (const m of own.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})(?![A-Za-z0-9])/g)) {
    const prefix = m[1];
    if (projects ? !projects.includes(prefix) : DENY.has(prefix)) continue;
    const key = `${prefix}-${m[2]}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Keys after a message: a key already listed keeps its place, new ones go last, the oldest drop past `max`. */
export function mergeKeys(current: string[], found: string[], max: number): string[] {
  const next = [...current];
  for (const k of found) if (!next.includes(k)) next.push(k);
  return next.slice(-max);
}

type Herdr = { request(method: string, params: Record<string, unknown>): Promise<any> };

export function herdrClient(env: NodeJS.ProcessEnv = process.env): Herdr | null {
  const socketPath = env.HERDR_SOCKET_PATH;
  if (env.HERDR_ENV !== "1" || !socketPath || !env.HERDR_PANE_ID) return null;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  let seq = 0;
  return {
    request(method, params) {
      return new Promise((resolve) => {
        let buf = "";
        let done = false;
        const finish = (v: any) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(v);
        };
        const socket = net.createConnection(endpoint);
        socket.on("error", () => finish(null));
        socket.on("connect", () => socket.write(`${JSON.stringify({ id: `pi:ticket-label:${++seq}`, method, params })}\n`));
        socket.on("data", (d) => {
          buf += d.toString("utf-8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          try {
            finish(JSON.parse(buf.slice(0, nl)));
          } catch {
            finish(null);
          }
        });
        socket.on("end", () => finish(null));
        const timer = setTimeout(() => finish(null), 1500);
        timer.unref?.();
      });
    },
  };
}

export default function herdrTicketLabel(pi: ExtensionAPI, herdr: Herdr | null = herdrClient(), env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(env);
  if (!config.enabled || !herdr) return;
  const paneId = env.HERDR_PANE_ID!;
  let keys: string[] = [];
  let off = false;
  let original: string | undefined;
  let workspaceId: string | undefined;

  const workspace = async (): Promise<{ id: string; label: string } | undefined> => {
    const pane = (await herdr.request("pane.get", { pane_id: paneId }))?.result?.pane;
    const id = pane?.workspace_id ?? workspaceId;
    if (!id) return undefined;
    workspaceId = id;
    const ws = (await herdr.request("workspace.get", { workspace_id: id }))?.result?.workspace;
    return { id, label: typeof ws?.label === "string" ? ws.label : "" };
  };

  const rename = async (label: string) => {
    const ws = await workspace();
    if (!ws || ws.label === label) return ws;
    if (original === undefined) original = ws.label;
    await herdr.request("workspace.rename", { workspace_id: ws.id, label });
    return ws;
  };

  const save = () => pi.appendEntry(ENTRY_TYPE, { keys, off, original });
  const label = () => keys.join(config.separator);

  pi.on("session_start", (_event: any, ctx: any) => {
    keys = [];
    off = false;
    try {
      for (const e of ctx?.sessionManager?.getEntries?.() ?? []) {
        if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
        const d = e.data ?? {};
        keys = Array.isArray(d.keys) ? d.keys.filter((k: unknown) => typeof k === "string") : [];
        off = d.off === true;
        if (typeof d.original === "string") original = d.original;
      }
    } catch {}
  });

  pi.on("input", (event: any) => {
    if (off || event?.source !== "interactive") return { action: "continue" } as any;
    const text = typeof event.text === "string" ? event.text : "";
    if (text.startsWith("/")) return { action: "continue" } as any;
    const next = mergeKeys(keys, findKeys(text, config.projects), config.max);
    if (next.join() !== keys.join()) {
      keys = next;
      save();
      void rename(label()).catch(() => {});
    }
    return { action: "continue" } as any;
  });

  pi.registerCommand("ticket", {
    description: "Workspace label from ticket keys: /ticket [KEY ...|off|on]",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim();
      if (arg.toLowerCase() === "off") {
        off = true;
        const ws = await workspace();
        if (ws && original !== undefined && ws.label !== original) await herdr.request("workspace.rename", { workspace_id: ws.id, label: original });
        save();
        ctx.ui.notify(`ticket-label: off${original !== undefined ? `, workspace back to "${original}"` : ""}`, "info");
        return;
      }
      if (arg.toLowerCase() === "on") {
        off = false;
        save();
        if (keys.length) await rename(label());
        ctx.ui.notify(`ticket-label: on${keys.length ? ` — ${label()}` : ", waiting for a ticket key"}`, "info");
        return;
      }
      if (arg) {
        const found = findKeys(arg.toUpperCase(), null);
        if (!found.length) {
          ctx.ui.notify("ticket-label: no ticket key in that (expected e.g. FLV-1572)", "warning");
          return;
        }
        keys = found.slice(-config.max);
        off = false;
        save();
        await rename(label());
      }
      const ws = await workspace();
      ctx.ui.notify(`ticket-label: ${off ? "off" : "on"} · keys ${keys.length ? label() : "none"} · workspace "${ws?.label ?? "?"}"`, "info");
    },
  });
}
