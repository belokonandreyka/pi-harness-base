/**
 * End-to-end: context-ceiling + context-guard through the real pi CLI with the
 * scripted provider. No API, no auth. Run with `bun test test/e2e`.
 */
import { describe, expect, test } from "bun:test";
import { assistantTexts, compactions, EXT, runPi, toolCalls } from "../harness/rpc.ts";

describe("context-guard end to end", () => {
  test(
    "warns, takes the note, compacts at the ceiling with the note appended, then continues",
    async () => {
      const run = await runPi({
        extensions: [EXT("context-ceiling"), EXT("context-guard")],
        env: { PI_CONTEXT_CEILING: "45000", FAKE_BASE: "5000", FAKE_PER_MESSAGE: "4000" },
        prompt: "start",
        timeoutMs: 40000,
      });
      const calls = toolCalls(run.events);
      expect(run.stderr).not.toContain("Error");
      expect(calls).toContain("view_context");
      expect(calls).toContain("handoff_note");
      // the warning arrived before the note was written, and the note before the compaction
      expect(calls.indexOf("view_context")).toBeLessThan(calls.indexOf("handoff_note"));

      const comps = compactions(run.events);
      expect(comps.length).toBeGreaterThanOrEqual(1);
      const first = comps[0];
      expect(first.reason).toBe("threshold");
      // pi's threshold fired at the ceiling, not at the model's 200k window
      expect(first.result.tokensBefore).toBeGreaterThanOrEqual(45000);
      expect(first.result.tokensBefore).toBeLessThan(45000 + 4000 * 3);
      expect(first.result.summary).toContain("FAKE SUMMARY");
      expect(first.result.summary).toContain("## Handoff note (written by the agent before compaction, verbatim)");
      expect(first.result.summary).toContain("NEXT ACTION: step");

      // the note reached the model after the cut: the scripted model answers DONE only when it sees it
      expect(assistantTexts(run.events).at(-1)).toBe("DONE");

      const noteEntries = run.entries.filter((e) => e.type === "custom" && e.customType === "context-guard:note");
      expect(noteEntries.length).toBeGreaterThanOrEqual(1);
      const compactionEntry = run.entries.find((e) => e.type === "compaction");
      expect(compactionEntry?.details?.contextGuard?.noteChars).toBeGreaterThan(0);
    },
    60000,
  );

  test(
    "without the ceiling a 200k window never warns and never compacts in a short run",
    async () => {
      const run = await runPi({
        extensions: [EXT("context-guard")],
        env: { FAKE_BASE: "5000", FAKE_PER_MESSAGE: "4000", FAKE_MAX_CALLS: "6" },
        prompt: "start",
        timeoutMs: 20000,
        settings: { compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 3000 } },
      });
      expect(toolCalls(run.events)).not.toContain("handoff_note");
      expect(compactions(run.events)).toHaveLength(0);
    },
    30000,
  );
});
