import { afterEach, describe, expect, test } from "bun:test";
import droppedToolCallGuard, { EMPTY_REPLY_MESSAGE, RETRY_MESSAGE, droppedToolCall, emptyReply } from "./index.ts";

const ORIGINAL = process.env.PI_DROPPED_TOOLCALL_GUARD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PI_DROPPED_TOOLCALL_GUARD;
  else process.env.PI_DROPPED_TOOLCALL_GUARD = ORIGINAL;
});

const thinkingOnly = { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "…" }] };
const withCall = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: {} }] };
const stop = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };

function setup() {
  const handlers = new Map<string, any>();
  const sent: string[] = [];
  const notices: string[] = [];
  const pi = { on: (e: string, h: any) => handlers.set(e, h), sendUserMessage: (t: string) => sent.push(t) } as any;
  droppedToolCallGuard(pi, (fn) => fn());
  const ctx = { ui: { notify: (m: string) => notices.push(m) } };
  return { end: (messages: any[]) => handlers.get("agent_end")?.({ messages }, ctx), sent, notices, handlers };
}

describe("dropped-toolcall-guard", () => {
  test("detects a tool-use stop with no tool call, ignores the rest", () => {
    expect(droppedToolCall([{ role: "user", content: "x" }, thinkingOnly])).toBe(true);
    expect(droppedToolCall([withCall])).toBe(false);
    expect(droppedToolCall([stop])).toBe(false);
    expect(droppedToolCall([thinkingOnly, { role: "toolResult", content: [] }, stop])).toBe(false);
    expect(droppedToolCall([])).toBe(false);
  });

  test("asks the model to repeat the call, at most twice per session", () => {
    delete process.env.PI_DROPPED_TOOLCALL_GUARD;
    const g = setup();
    g.end([thinkingOnly]);
    expect(g.sent).toEqual([RETRY_MESSAGE]);
    g.end([stop]);
    expect(g.sent.length).toBe(1);
    g.end([thinkingOnly]);
    g.end([thinkingOnly]);
    expect(g.sent.length).toBe(2);
    expect(g.notices.at(-1)).toContain("not retrying");
  });

  test("detects an empty normal stop, not an aborted or failed one", () => {
    const empty = { role: "assistant", stopReason: "stop", content: [] };
    expect(emptyReply([{ role: "toolResult", content: [] }, empty])).toBe(true);
    expect(emptyReply([{ ...empty, content: [{ type: "thinking", thinking: "…" }] }])).toBe(true);
    expect(emptyReply([{ ...empty, content: [{ type: "text", text: "  \n" }] }])).toBe(true);
    expect(emptyReply([stop])).toBe(false);
    expect(emptyReply([withCall])).toBe(false);
    expect(emptyReply([{ ...empty, stopReason: "aborted" }])).toBe(false);
    expect(emptyReply([{ ...empty, stopReason: "error", errorMessage: "503" }])).toBe(false);
    expect(emptyReply([{ ...empty, errorMessage: "boom" }])).toBe(false);
    expect(emptyReply([empty, { role: "user", content: "x" }])).toBe(false);
    expect(emptyReply([])).toBe(false);
  });

  test("an empty reply is retried, the counter resets after a normal turn", () => {
    delete process.env.PI_DROPPED_TOOLCALL_GUARD;
    const empty = { role: "assistant", stopReason: "stop", content: [] };
    const g = setup();
    g.end([empty]);
    g.end([empty]);
    expect(g.sent).toEqual([EMPTY_REPLY_MESSAGE, EMPTY_REPLY_MESSAGE]);
    g.end([empty]);
    expect(g.sent.length).toBe(2);
    expect(g.notices.at(-1)).toContain("not retrying");
    g.end([stop]);
    g.end([empty]);
    expect(g.sent.length).toBe(3);
  });

  test("env switch disables", () => {
    process.env.PI_DROPPED_TOOLCALL_GUARD = "0";
    const g = setup();
    expect(g.handlers.get("agent_end")).toBeUndefined();
  });
});
