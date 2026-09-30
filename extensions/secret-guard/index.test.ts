import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import secretGuardExtension, { NAMES_TOOL, isDisabled, loadConfig, namesIn, offending, secretNames } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL = process.env.PI_SECRET_GUARD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PI_SECRET_GUARD;
  else process.env.PI_SECRET_GUARD = ORIGINAL;
});

// The extension reads <agent-dir>/secret-guard.json; point it at an empty temp
// dir so the developer's live profile cannot leak into the expectations.
function setup() {
  const handlers = new Map<string, Handler>();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "secret-guard-defaults-"));
  try {
    secretGuardExtension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  return (toolName: string, input: any) => handlers.get("tool_call")?.({ toolName, input }, {});
}

describe("secret-guard", () => {
  const cfg = loadConfig("/nonexistent");

  test("blocks reads and shell access to the secrets file, in every spelling", () => {
    expect(offending("read", { path: "/Users/me/.vitu/test-secrets.env" }, cfg)).not.toBeNull();
    expect(offending("bash", { command: "cat ~/.vitu/test-secrets.env | head" }, cfg)).not.toBeNull();
    expect(offending("bash", { command: "node -e \"require('fs').readFileSync(process.env.HOME+'/.vitu/test-secrets.env')\"" }, cfg)).not.toBeNull();
    expect(offending("rg", { pattern: "PASSWORD", path: "/Users/me/.vitu/test-secrets.env" }, cfg)).not.toBeNull();
  });

  test("blocks pi auth, private keys and value-printing keychain lookups", () => {
    expect(offending("read", { path: "/Users/me/.pi-sub/agent/auth.json" }, cfg)).not.toBeNull();
    expect(offending("bash", { command: "cat ~/.ssh/id_ed25519" }, cfg)).not.toBeNull();
    expect(offending("bash", { command: "security find-generic-password -ws ai-gateway-key" }, cfg)).not.toBeNull();
    expect(offending("bash", { command: "printenv | grep TOKEN" }, cfg)).not.toBeNull();
  });

  test("leaves ordinary work and the sanctioned inputs alone", () => {
    expect(offending("read", { path: "/Users/me/.vitu/test-creds.json" }, cfg)).toBeNull();
    expect(offending("bash", { command: "cat ~/.ssh/id_ed25519.pub" }, cfg)).toBeNull();
    expect(offending("bash", { command: "npm run test-ci -- --include='**/x.spec.ts'" }, cfg)).toBeNull();
    expect(offending("bash", { command: "curl -u \"$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN\" https://api.atlassian.com/x" }, cfg)).toBeNull();
    expect(offending("bash", { command: "security find-generic-password -s foo" }, cfg)).toBeNull();
    expect(offending("bash", { command: "set -e; echo ok" }, cfg)).toBeNull();
    expect(offending("agent_message", { action: "send", message: "the file test-secrets.env is off limits" }, cfg)).toBeNull();
  });

  test("config extends deny and allow", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-guard-"));
    writeFileSync(join(dir, "secret-guard.json"), JSON.stringify({ deny: ["corp-token\\.txt"], allow: ["docs/secrets-policy\\.md"] }));
    const c = loadConfig(dir);
    expect(offending("read", { path: "/x/corp-token.txt" }, c)).not.toBeNull();
    expect(offending("read", { path: "/x/docs/secrets-policy.md" }, c)).toBeNull();
  });

  test("wired handler blocks with a reason and honours PI_SECRET_GUARD=off", () => {
    const call = setup();
    const blocked = call("bash", { command: "cat ~/.vitu/test-secrets.env" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("secret-guard");
    expect(call("read", { path: "src/app.ts" })).toBeUndefined();
    process.env.PI_SECRET_GUARD = "off";
    expect(isDisabled()).toBe(true);
    expect(call("bash", { command: "cat ~/.vitu/test-secrets.env" })).toBeUndefined();
  });

  test("secret_names returns names and never a value", async () => {
    expect(namesIn("# c\nA_USER=bob\nexport B_PASS='p=1'\n  C=\nnot a line\nA_USER=again\n")).toEqual(["A_USER", "B_PASS", "C"]);
    const dir = mkdtempSync(join(tmpdir(), "secret-guard-names-"));
    const envFile = join(dir, "test-secrets.env");
    writeFileSync(envFile, "PORTAL_PASSWORD=hunter2\nAPI_TOKEN=tok-123\n");
    writeFileSync(join(dir, "secret-guard.json"), JSON.stringify({ nameFiles: [envFile, join(dir, "missing.env")] }));
    const listed = secretNames(loadConfig(dir).nameFiles);
    expect(listed[0].names).toEqual(["PORTAL_PASSWORD", "API_TOKEN"]);
    expect(listed[1]).toEqual({ file: join(dir, "missing.env"), names: [], error: "unreadable" });

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const handlers = new Map<string, Handler>();
      const tools: any[] = [];
      secretGuardExtension({ on: (e: string, h: Handler) => handlers.set(e, h), registerTool: (t: any) => tools.push(t) } as any);
      expect(tools.map((t) => t.name)).toEqual([NAMES_TOOL]);
      const out = JSON.stringify(await tools[0].execute());
      expect(out).toContain("PORTAL_PASSWORD");
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("tok-123");
      const blocked = handlers.get("tool_call")?.({ toolName: "bash", input: { command: `cat ${envFile}` } }, {});
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain(NAMES_TOOL);
      expect(handlers.get("tool_call")?.({ toolName: NAMES_TOOL, input: {} }, {})).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("a deny entry can carry its own reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-guard-why-"));
    writeFileSync(join(dir, "secret-guard.json"), JSON.stringify({ deny: ["plain\\.env", { pattern: "creds\\.json", why: "run scripts/list-users.py instead" }] }));
    const cfg = loadConfig(dir);
    expect(offending("bash", { command: "cat creds.json" }, cfg)?.why).toBe("run scripts/list-users.py instead");
    expect(offending("bash", { command: "cat plain.env" }, cfg)?.why).toBe("listed in secret-guard.json");
    expect(offending("bash", { command: "cat list-users.py" }, cfg)).toBeNull();
  });

  test("a config edit applies to the running session", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-guard-reload-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const handlers = new Map<string, Handler>();
      secretGuardExtension({ on: (e: string, h: Handler) => handlers.set(e, h) } as any);
      const call = () => handlers.get("tool_call")?.({ toolName: "bash", input: { command: "cat ~/.vitu/test-secrets.env" } }, {});
      expect(call()?.block).toBe(true);
      writeFileSync(join(dir, "secret-guard.json"), JSON.stringify({ allow: ["test-secrets\\.env"] }));
      const { utimesSync } = require("node:fs");
      utimesSync(join(dir, "secret-guard.json"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      expect(call()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("no nameFiles, no tool", () => {
    const tools: any[] = [];
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/nonexistent";
    try {
      secretGuardExtension({ on: () => {}, registerTool: (t: any) => tools.push(t) } as any);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
    expect(tools).toEqual([]);
  });
});
