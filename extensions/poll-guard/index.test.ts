import { afterEach, describe, expect, test } from "bun:test";
import pollGuardExtension, { DEFAULT_CONFIG, loadConfig, longestSleepSeconds } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL = process.env.PI_POLL_GUARD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PI_POLL_GUARD;
  else process.env.PI_POLL_GUARD = ORIGINAL;
});

function setup() {
  const handlers = new Map<string, Handler>();
  pollGuardExtension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);
  return (toolName: string, input: any) => handlers.get("tool_call")?.({ toolName, input }, {});
}

describe("poll-guard", () => {
  test("finds the longest sleep in a command", () => {
    expect(longestSleepSeconds("sleep 120; echo waited")).toBe(120);
    expect(longestSleepSeconds("cd x && sleep 2 && curl localhost")).toBe(2);
    expect(longestSleepSeconds("sleep 5m")).toBe(300);
    expect(longestSleepSeconds("npm run test-ci 2>&1 | tail -60")).toBe(0);
    expect(longestSleepSeconds("grep sleepy file")).toBe(0);
  });

  test("blocks a bash sleep-wait but allows short retry pauses", () => {
    const call = setup();
    const blocked = call("bash", { command: "sleep 240; echo waited" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("end your turn");
    expect(call("bash", { command: "sleep 3; curl -s localhost:5000" })).toBeUndefined();
    expect(call("bash", { command: "npm run test-ci 2>&1 | tail -60" })).toBeUndefined();
  });

  test("allows one status poll per run, then blocks repeats inside the interval", () => {
    const call = setup();
    expect(call("agent_message", { action: "tail", mode: "status", runId: "7a683462-0" })).toBeUndefined();
    const second = call("agent_message", { action: "tail", mode: "status", runId: "7a683462-0" });
    expect(second?.block).toBe(true);
    expect(second?.reason).toContain("completion wake");
    // A different run is a different key.
    expect(call("agent_message", { action: "session", runId: "b7a54db8-0" })).toBeUndefined();
    // Non-poll actions are never touched.
    expect(call("agent_message", { action: "send", to: "DeepRiver", message: "hi" })).toBeUndefined();
    expect(call("agent_message", { action: "reply", runId: "7a683462-0", message: "yes" })).toBeUndefined();
  });

  test("PI_POLL_GUARD=off disables everything", () => {
    process.env.PI_POLL_GUARD = "off";
    const call = setup();
    expect(call("bash", { command: "sleep 600" })).toBeUndefined();
  });

  test("config falls back to defaults for a missing file", () => {
    expect(loadConfig("/nonexistent")).toEqual(DEFAULT_CONFIG);
  });
});
