import { describe, expect, test } from "bun:test";
import herdrTicketLabel, { ENTRY_TYPE, findKeys, mergeKeys } from "./index.ts";

const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x", HERDR_PANE_ID: "w1:p1", HOME: "/nonexistent" } as any;

function setup(label = "vitu-portal", entries: any[] = []) {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const appended: any[] = [];
  const notices: string[] = [];
  const ws = { label };
  const calls: any[] = [];
  const herdr = {
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === "pane.get") return { result: { pane: { workspace_id: "w1" } } };
      if (method === "workspace.get") return { result: { workspace: { workspace_id: "w1", label: ws.label } } };
      if (method === "workspace.rename") ws.label = params.label;
      return { result: {} };
    },
  };
  const pi = {
    on: (e: string, h: any) => handlers.set(e, h),
    registerCommand: (n: string, c: any) => commands.set(n, c),
    appendEntry: (t: string, d: any) => appended.push([t, d]),
  } as any;
  herdrTicketLabel(pi, herdr, env);
  const ctx = { ui: { notify: (m: string) => notices.push(m) }, sessionManager: { getEntries: () => entries } };
  handlers.get("session_start")?.({}, ctx);
  const say = async (text: string, source = "interactive") => {
    handlers.get("input")({ text, source }, ctx);
    await new Promise((r) => setTimeout(r, 0));
  };
  const cmd = (args: string) => commands.get("ticket").handler(args, ctx);
  return { ws, say, cmd, appended, notices, calls };
}

describe("findKeys", () => {
  test("finds keys and Jira links, skips the denylist and pasted blocks", () => {
    expect(findKeys("візьми FLV-1572 і https://x.atlassian.net/browse/VITU-11802", null)).toEqual(["FLV-1572", "VITU-11802"]);
    expect(findKeys("GPT-6 on UTF-8, ISO-8601", null)).toEqual([]);
    expect(findKeys("see <pasted_content id=\"a\">MAVDEV-1 MAVDEV-2</pasted_content id=\"a\"> and VS-718", null)).toEqual(["VS-718"]);
    expect(findKeys("FLV-1572 FLV-1572 sha-256 a-1", null)).toEqual(["FLV-1572"]);
  });

  test("a project list limits the prefixes", () => {
    expect(findKeys("FLV-1 ABC-2 VITU-3", ["FLV", "VITU"])).toEqual(["FLV-1", "VITU-3"]);
  });

  test("merge keeps order, appends new, drops the oldest past max", () => {
    expect(mergeKeys(["A-1", "B-2"], ["B-2", "C-3"], 3)).toEqual(["A-1", "B-2", "C-3"]);
    expect(mergeKeys(["A-1", "B-2", "C-3"], ["D-4"], 3)).toEqual(["B-2", "C-3", "D-4"]);
  });
});

describe("herdr-ticket-label", () => {
  test("renames the workspace on the first key and adds later ones", async () => {
    const t = setup();
    await t.say("привіт");
    expect(t.ws.label).toBe("vitu-portal");
    await t.say("стартуй FLV-1572");
    expect(t.ws.label).toBe("FLV-1572");
    await t.say("і ще VITU-11802, FLV-1572");
    expect(t.ws.label).toBe("FLV-1572 · VITU-11802");
    expect(t.appended.at(-1)).toEqual([ENTRY_TYPE, { keys: ["FLV-1572", "VITU-11802"], off: false, original: "vitu-portal" }]);
  });

  test("ignores non-interactive input and slash commands", async () => {
    const t = setup();
    await t.say("wake: FLV-1", "extension");
    await t.say("/skill:start-ticket FLV-2");
    expect(t.ws.label).toBe("vitu-portal");
  });

  test("/ticket off restores the original label and stops renaming; KEY sets by hand", async () => {
    const t = setup();
    await t.say("FLV-1572");
    await t.cmd("off");
    expect(t.ws.label).toBe("vitu-portal");
    await t.say("VS-718");
    expect(t.ws.label).toBe("vitu-portal");
    await t.cmd("mavdev-633 vs-718");
    expect(t.ws.label).toBe("MAVDEV-633 · VS-718");
  });

  test("a resumed session continues from the stored keys", async () => {
    const t = setup("FLV-1572", [{ type: "custom", customType: ENTRY_TYPE, data: { keys: ["FLV-1572"], off: false, original: "vitu-portal" } }]);
    await t.say("VS-718");
    expect(t.ws.label).toBe("FLV-1572 · VS-718");
    await t.cmd("off");
    expect(t.ws.label).toBe("vitu-portal");
  });

  test("does nothing outside herdr", () => {
    const handlers = new Map();
    herdrTicketLabel({ on: (e: string, h: any) => handlers.set(e, h), registerCommand: () => {} } as any, null, env);
    expect(handlers.size).toBe(0);
  });
});
