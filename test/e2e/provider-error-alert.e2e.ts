/**
 * End-to-end: provider-error-alert through the real pi CLI. The scripted
 * provider fails every call like an unreachable endpoint; after pi's retries
 * run out the extension must raise herdr's blocked state exactly once.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXT, runPi } from "../harness/rpc.ts";

const PROBE = join(import.meta.dir, "..", "harness", "herdr-probe.ts");

describe("provider-error-alert end to end", () => {
  test(
    "a run that dies on a provider error ends in herdr blocked after the retries",
    async () => {
      const probe = join(mkdtempSync(join(tmpdir(), "herdr-probe-")), "events.jsonl");
      const run = await runPi({
        extensions: [EXT("provider-error-alert"), PROBE],
        env: { FAKE_FAIL: "UND_ERR_CONNECT_TIMEOUT", HERDR_PROBE_FILE: probe, PI_PROVIDER_ERROR_ALERT_GRACE_MS: "200" },
        settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } },
        prompt: "start",
        agentEnds: 99,
        timeoutMs: 6000,
      });
      const retries = run.events.filter((e) => e.type === "auto_retry_start").length;
      const signals = existsSync(probe) ? readFileSync(probe, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      console.log(`retries=${retries} agent_end=${run.events.filter((e) => e.type === "agent_end").length} signals=${JSON.stringify(signals)}`);
      expect(retries).toBe(2);
      // one raise after the retries ran out; the clear comes from pi's shutdown at the end of the test
      expect(signals.filter((s) => s.active)).toEqual([{ active: true, label: "Збій провайдера" }]);
      expect(signals[0].active).toBe(true);
    },
    20000,
  );
});
