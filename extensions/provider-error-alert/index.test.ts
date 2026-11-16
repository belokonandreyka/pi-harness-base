import { describe, expect, test } from "bun:test";
import providerErrorAlert, { HERDR_BLOCKED_EVENT, LABEL, providerError } from "./index.ts";

const failed = { role: "assistant", stopReason: "error", errorMessage: "Retry failed after 3 attempts: Connect Timeout Error", content: [] };
const ok = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };

function setup() {
  const handlers = new Map<string, any>();
  const emitted: any[] = [];
  const notices: string[] = [];
  const queued: (() => void)[] = [];
  const pi = { on: (e: string, h: any) => handlers.set(e, h), events: { emit: (e: string, d: any) => emitted.push([e, d]) } } as any;
  providerErrorAlert(pi, {
    set: ((fn: () => void) => (queued.push(fn), queued.length)) as any,
    clear: ((id: number) => { queued[id - 1] = () => {}; }) as any,
  });
  const ctx = { ui: { notify: (m: string) => notices.push(m) } };
  const fire = (e: string, ev: any = {}) => handlers.get(e)?.(ev, ctx);
  const flush = () => queued.splice(0).forEach((fn) => fn());
  return { fire, flush, emitted, notices };
}

describe("provider-error-alert", () => {
  test("finds a provider error only on the last assistant message", () => {
    expect(providerError([{ role: "user" }, failed])).toContain("Retry failed");
    expect(providerError([failed, { role: "toolResult" }, ok])).toBeUndefined();
    expect(providerError([])).toBeUndefined();
  });

  test("signals herdr once the failed run settles, clears on the next run", () => {
    const t = setup();
    t.fire("agent_start");
    t.fire("agent_end", { messages: [failed] });
    t.fire("agent_settled", { aborted: false });
    expect(t.emitted).toEqual([]);
    t.flush();
    expect(t.emitted).toEqual([[HERDR_BLOCKED_EVENT, { active: true, label: LABEL }]]);
    expect(t.notices[0]).toContain("Connect Timeout");
    t.fire("agent_settled", { aborted: false });
    t.flush();
    expect(t.emitted.length).toBe(1);
    t.fire("agent_start");
    expect(t.emitted[1]).toEqual([HERDR_BLOCKED_EVENT, { active: false }]);
  });

  test("a resend inside the grace period cancels the alert", () => {
    const t = setup();
    t.fire("agent_end", { messages: [failed] });
    t.fire("agent_settled", { aborted: false });
    t.fire("agent_start");
    t.flush();
    expect(t.emitted).toEqual([]);
  });

  test("ignores aborted runs and normal ends", () => {
    const t = setup();
    t.fire("agent_end", { messages: [failed] });
    t.fire("agent_settled", { aborted: true });
    t.fire("agent_end", { messages: [ok] });
    t.fire("agent_settled", { aborted: false });
    t.flush();
    expect(t.emitted).toEqual([]);
  });

  test("user input clears the signal", () => {
    const t = setup();
    t.fire("agent_end", { messages: [failed] });
    t.fire("agent_settled", { aborted: false });
    t.flush();
    t.fire("input", { text: "continue" });
    expect(t.emitted.at(-1)).toEqual([HERDR_BLOCKED_EVENT, { active: false }]);
  });
});
