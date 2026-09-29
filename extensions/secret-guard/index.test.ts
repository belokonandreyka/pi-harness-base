import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import secretGuardExtension, { isDisabled, loadConfig, offending } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL = process.env.PI_SECRET_GUARD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PI_SECRET_GUARD;
  else process.env.PI_SECRET_GUARD = ORIGINAL;
});

function setup() {
  const handlers = new Map<string, Handler>();
  secretGuardExtension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);
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
});
