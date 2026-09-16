import { afterEach, describe, expect, test } from "bun:test";
import copilotCreditsExtension, { STATUS_KEY, formatCredits, resolveCreditsPerDollar, sumCopilotCredits } from "./index.ts";

type Handler = (event: any, ctx: any) => any;

const ORIGINAL_ENV = process.env.PI_COPILOT_CREDITS_PER_DOLLAR;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PI_COPILOT_CREDITS_PER_DOLLAR;
  else process.env.PI_COPILOT_CREDITS_PER_DOLLAR = ORIGINAL_ENV;
});

function assistant(provider: string, model: string, total: number) {
  return { type: "message", message: { role: "assistant", provider, model, usage: { cost: { total } } } };
}

function setup(entries: any[]) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const statuses: Array<[string, string | undefined]> = [];
  const notices: string[] = [];
  copilotCreditsExtension({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, def: any) => commands.set(name, def),
  } as any);
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: { setStatus: (k: string, v: string | undefined) => statuses.push([k, v]), notify: (t: string) => notices.push(t) },
  };
  return { fire: (e: string, p: any = {}) => handlers.get(e)?.(p, ctx), commands, statuses, notices, ctx };
}

describe("copilot-credits", () => {
  test("counts only github-copilot assistant messages, at list price × 100", () => {
    const t = sumCopilotCredits(
      [
        assistant("github-copilot", "claude-opus-5", 0.138),
        assistant("gateway", "claude-opus-5", 2.0),
        assistant("github-copilot", "gpt-5.6-sol", 0.012),
        { type: "message", message: { role: "user", content: "hi" } },
      ],
      100,
    );
    expect(t.dollars).toBeCloseTo(0.15, 6);
    expect(t.credits).toBeCloseTo(15, 6);
    expect(t.byModel.get("claude-opus-5")).toEqual({ credits: 13.8, messages: 1 });
    expect(t.byModel.has("gpt-5.6-sol")).toBe(true);
  });

  test("Opus rates: 500/2500/50/625 credits per 1M equal the list price times 100", () => {
    // Pi's built-in cost for github-copilot/claude-opus-5 is 5 / 25 / 0.5 / 6.25 $ per 1M.
    const perMillion = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(Object.values(perMillion).map((v) => v * 100)).toEqual([500, 2500, 50, 625]);
  });

  test("status shows the credits and clears when the session has no Copilot usage", () => {
    const withUsage = setup([assistant("github-copilot", "claude-opus-5", 4.126)]);
    withUsage.fire("turn_end");
    expect(withUsage.statuses.at(-1)).toEqual([STATUS_KEY, "⚡ 412.6 cr"]);

    const without = setup([assistant("gateway", "claude-opus-5", 4.126)]);
    without.fire("turn_end");
    expect(without.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
  });

  test("/credits reports a per-model breakdown", () => {
    const s = setup([assistant("github-copilot", "claude-opus-5", 1), assistant("github-copilot", "claude-opus-5", 0.5)]);
    s.fire("session_start");
    s.commands.get("credits").handler("", s.ctx);
    expect(s.notices.at(-1)).toContain("claude-opus-5: 150.0 cr over 2 responses");
    expect(s.notices.at(-1)).toContain("total: 150.0 cr");
  });

  test("env override changes the factor", () => {
    process.env.PI_COPILOT_CREDITS_PER_DOLLAR = "90";
    expect(resolveCreditsPerDollar("/nonexistent")).toBe(90);
    delete process.env.PI_COPILOT_CREDITS_PER_DOLLAR;
    expect(resolveCreditsPerDollar("/nonexistent")).toBe(100);
  });

  test("formatting scales with magnitude", () => {
    expect(formatCredits(3.14159)).toBe("3.14");
    expect(formatCredits(412.55)).toBe("412.6");
    expect(formatCredits(12345.6)).toBe("12,346");
  });
});
