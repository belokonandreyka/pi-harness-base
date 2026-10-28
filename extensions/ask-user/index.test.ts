import { describe, expect, test } from "bun:test";
import { HERDR_BLOCKED_EVENT, isSubagent, blockedLabel, createExecute, defaultAfterMs, formatAnswers, normalizeQuestions, whileBlocked } from "./questions.ts";

function fakePi() {
  const events: Array<{ channel: string; data: any }> = [];
  const pi = { events: { emit: (channel: string, data: unknown) => events.push({ channel, data }), on: () => () => {} } } as any;
  return { pi, events };
}

const q = (header: string, n = 2) => ({ header, question: `${header}?`, options: Array.from({ length: n }, (_, i) => ({ label: `opt${i + 1}` })) });

describe("ask-user", () => {
  test("normalizes questions and rejects unusable input", () => {
    expect(normalizeQuestions({ questions: [] })).toBe("Error: no questions provided.");
    expect(normalizeQuestions({ questions: [q("a"), q("b"), q("c"), q("d"), q("e")] })).toContain("at most 4");
    expect(normalizeQuestions({ questions: [q("a", 1)] })).toContain("at least 2 options");
    expect(normalizeQuestions({ questions: [{ question: " ", options: [] }] })).toContain("no text");
    const ok = normalizeQuestions({ questions: [{ question: " Which? ", options: [{ label: " A " }, { label: "B", description: " " }, { label: "" }] }] });
    expect(ok).toEqual([{ header: "Q1", question: "Which?", options: [{ label: "A", description: undefined }, { label: "B", description: undefined }] }]);
    const long = normalizeQuestions({ questions: [{ ...q("x"), header: "A very long header indeed" }] }) as any[];
    expect(long[0].header.length).toBe(16);
  });

  test("labels the blocked pane and formats answers", () => {
    expect(blockedLabel([q("Branch")] as any)).toBe("Branch");
    expect(blockedLabel([q("Branch"), q("Scope"), q("PR")] as any)).toBe("Branch +2");
    expect(formatAnswers({ cancelled: false, answers: [{ header: "Branch", answer: "VITU-1", typed: false }, { header: "Why", answer: "because", typed: true }] }))
      .toBe("The user answered:\n- Branch: VITU-1\n- Why: (typed) because");
    expect(formatAnswers({ cancelled: true, answers: [] })).toContain("Carry on with everything that does not depend");
  });

  test("holds herdr's blocked state only while the dialog is open, also when it throws", async () => {
    const { pi, events } = fakePi();
    await whileBlocked(pi, "Branch", async () => {
      expect(events).toEqual([{ channel: HERDR_BLOCKED_EVENT, data: { active: true, label: "Branch" } }]);
    });
    expect(events.at(-1)).toEqual({ channel: HERDR_BLOCKED_EVENT, data: { active: false } });
    await expect(whileBlocked(pi, "x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(events.filter((e) => e.data.active).length).toBe(2);
    expect(events.filter((e) => !e.data.active).length).toBe(2);
  });

  test("asks through the dialog in the TUI and emits blocked around it", async () => {
    const { pi, events } = fakePi();
    let seenDuringAsk: any[] = [];
    const execute = createExecute(pi, async (_ctx, questions) => {
      seenDuringAsk = [...events];
      return { cancelled: false, answers: [{ header: questions[0].header, answer: "opt2", typed: false }] };
    }, {});
    const result = await execute("id", { questions: [q("Branch")] }, undefined, undefined, { mode: "tui", hasUI: true } as any);
    expect(seenDuringAsk).toEqual([{ channel: HERDR_BLOCKED_EVENT, data: { active: true, label: "Branch" } }]);
    expect(events.at(-1)?.data).toEqual({ active: false });
    expect(result.content[0].text).toBe("The user answered:\n- Branch: opt2");
    expect(result.isError).toBeUndefined();
  });

  test("refuses without a user and never signals herdr", async () => {
    const { pi, events } = fakePi();
    let asked = false;
    const execute = createExecute(pi, async () => { asked = true; return { cancelled: true, answers: [] }; }, {});
    for (const ctx of [{ mode: "print", hasUI: false }, { mode: "rpc", hasUI: true }, { mode: "tui", hasUI: false }]) {
      const result = await execute("id", { questions: [q("Branch")] }, undefined, undefined, ctx as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("state the assumption");
    }
    const bad = await execute("id", { questions: [] }, undefined, undefined, { mode: "tui", hasUI: true } as any);
    expect(bad.isError).toBe(true);
    expect(asked).toBe(false);
    expect(events).toEqual([]);
  });

  test("refuses in a subagent, which has no one watching its pane", async () => {
    expect(isSubagent({})).toBe(false);
    expect(isSubagent({ PI_COLLAB_SUBAGENT_DEPTH: "0" })).toBe(false);
    expect(isSubagent({ PI_COLLAB_SUBAGENT_DEPTH: "1" })).toBe(true);
    const { pi, events } = fakePi();
    const execute = createExecute(pi, async () => ({ cancelled: true, answers: [] }), { PI_COLLAB_SUBAGENT_DEPTH: "1" });
    const result = await execute("id", { questions: [q("Branch")] }, undefined, undefined, { mode: "tui", hasUI: true } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("agent_message");
    expect(events).toEqual([]);
  });
  test("applies the recommended options when nobody answers in time, keeping real answers", async () => {
    const { pi } = fakePi();
    // The fake dialog answers the first question, then waits until it is closed.
    const execute = createExecute(pi, (_ctx, questions, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve({ cancelled: true, answers: [{ header: questions[0].header, answer: "opt2", typed: false }] }));
    }), {});
    const result = await execute("id", { questions: [q("Build"), q("Phone")], defaultAfterMinutes: 0.0005 }, undefined, undefined, { mode: "tui", hasUI: true } as any);
    expect(result.details).toEqual({ cancelled: false, timedOut: true, answers: [{ header: "Build", answer: "opt2", typed: false }, { header: "Phone", answer: "opt1", typed: false }] });
    expect(result.content[0].text).toContain("applied by default");
  });

  test("an answer before the timeout wins, a user abort is not a default, and bad minutes are refused", async () => {
    const { pi } = fakePi();
    const answered = createExecute(pi, async (_c, qs) => ({ cancelled: false, answers: [{ header: qs[0].header, answer: "opt2", typed: false }] }), {});
    const ok = await answered("id", { questions: [q("A")], defaultAfterMinutes: 5 }, undefined, undefined, { mode: "tui", hasUI: true } as any);
    expect(ok.content[0].text).toBe("The user answered:\n- A: opt2");
    const outer = new AbortController();
    const aborted = createExecute(pi, (_c, _q, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ cancelled: true, answers: [] }))), {});
    const pending = aborted("id", { questions: [q("A")], defaultAfterMinutes: 5 }, outer.signal, undefined, { mode: "tui", hasUI: true } as any);
    outer.abort();
    expect((await pending).details).toEqual({ cancelled: true, answers: [] });
    expect(defaultAfterMs({ defaultAfterMinutes: 0 })).toContain("at most 240");
    expect(defaultAfterMs({})).toBeUndefined();
  });
});
