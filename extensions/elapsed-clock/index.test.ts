import { afterEach, describe, expect, test } from "bun:test";
import elapsedClockExtension, { budgetFromPrompt, clockLine, parseDuration } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
const ORIGINAL_BUDGET = process.env.PI_TIME_BUDGET_S;
const ORIGINAL_SWITCH = process.env.PI_ELAPSED_CLOCK;
afterEach(() => {
  if (ORIGINAL_BUDGET === undefined) delete process.env.PI_TIME_BUDGET_S;
  else process.env.PI_TIME_BUDGET_S = ORIGINAL_BUDGET;
  if (ORIGINAL_SWITCH === undefined) delete process.env.PI_ELAPSED_CLOCK;
  else process.env.PI_ELAPSED_CLOCK = ORIGINAL_SWITCH;
});

function setup(clock: { t: number }) {
  const handlers = new Map<string, Handler>();
  elapsedClockExtension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any, () => clock.t);
  return handlers;
}

describe("elapsed-clock", () => {
  test("parses durations and prompt budgets", () => {
    expect(parseDuration("1200s")).toBe(1200);
    expect(parseDuration("20m")).toBe(1200);
    expect(parseDuration("1.5h")).toBe(5400);
    expect(parseDuration("900")).toBe(900);
    expect(parseDuration("soon")).toBeNull();
    expect(budgetFromPrompt("Fix the flaky spec. Time budget: 20m. Report when done.")).toBe(1200);
    expect(budgetFromPrompt("time budget 600s")).toBe(600);
    expect(budgetFromPrompt("no budget here")).toBeNull();
  });

  test("appends the elapsed line to the last text block, with the budget once known", () => {
    delete process.env.PI_TIME_BUDGET_S;
    const clock = { t: 1_000_000 };
    const h = setup(clock);
    h.get("session_start")?.({ type: "session_start" }, {});
    clock.t += 340_000;
    const plain = h.get("tool_result")?.({ toolName: "bash", content: [{ type: "text", text: "ok" }] }, {});
    expect(plain.content[0].text).toBe(`ok${clockLine(340, null)}`);

    h.get("before_agent_start")?.({ prompt: "Do the thing. time budget: 1200s" }, {});
    clock.t += 10_000;
    const withBudget = h.get("tool_result")?.(
      { toolName: "bash", content: [{ type: "image", data: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] },
      {},
    );
    expect(withBudget.content[2].text).toBe("b\n\n[elapsed 350s / 1200s]");
    expect(withBudget.content[1].text).toBe("a");
  });

  test("env budget wins, env switch disables", () => {
    process.env.PI_TIME_BUDGET_S = "30m";
    const clock = { t: 0 };
    const h = setup(clock);
    h.get("before_agent_start")?.({ prompt: "time budget: 1s" }, {});
    clock.t = 5_000;
    const r = h.get("tool_result")?.({ toolName: "rg", content: [{ type: "text", text: "x" }] }, {});
    expect(r.content[0].text).toBe("x\n\n[elapsed 5s / 1800s]");

    process.env.PI_ELAPSED_CLOCK = "0";
    const off = setup(clock);
    expect(off.get("tool_result")).toBeUndefined();
  });

  test("a result with no text block gets the line as its own block", () => {
    delete process.env.PI_TIME_BUDGET_S;
    const clock = { t: 0 };
    const h = setup(clock);
    clock.t = 2_000;
    const r = h.get("tool_result")?.({ toolName: "read", content: [{ type: "image", data: "x" }] }, {});
    expect(r.content[1]).toEqual({ type: "text", text: "[elapsed 2s]" });
  });
});
