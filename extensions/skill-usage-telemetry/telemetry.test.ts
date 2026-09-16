import { describe, expect, test } from "bun:test";
import {
  formatStats,
  parseEntries,
  parseSkillCommand,
  profileLabel,
  resolveAgentDir,
  skillNameFromPath,
  summarize,
  telemetryLogPath,
  type TelemetryEntry,
} from "./telemetry.ts";

describe("profile resolution", () => {
  test("honours PI_CODING_AGENT_DIR so profiles log separately", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/home/x/.pi-personal/agent" })).toBe(
      "/home/x/.pi-personal/agent",
    );
    expect(resolveAgentDir({ HOME: "/home/x" })).toBe("/home/x/.pi/agent");
  });

  test("names the profile after the directory holding the agent dir", () => {
    expect(profileLabel("/home/x/.pi/agent")).toBe("pi");
    expect(profileLabel("/home/x/.pi-personal/agent")).toBe("pi-personal");
  });

  test("keeps the log inside the profile", () => {
    expect(telemetryLogPath("/home/x/.pi/agent")).toBe("/home/x/.pi/agent/telemetry/skill-usage.jsonl");
  });
});

describe("skill identification", () => {
  test("names a bundle skill after its directory", () => {
    expect(skillNameFromPath("/home/x/.pi/agent/skills/reproduce-ticket/SKILL.md")).toBe("reproduce-ticket");
  });

  test("handles nested skill bundles", () => {
    expect(skillNameFromPath("/repo/.pi/skills/group/inner-skill/SKILL.md")).toBe("inner-skill");
  });

  test("names a bare markdown skill after its filename", () => {
    expect(skillNameFromPath("/home/x/.pi/agent/skills/quick-note.md")).toBe("quick-note");
  });

  // Reading ordinary markdown is not a skill load; counting it would inflate
  // every number in the report.
  test("ignores markdown that is not a skill", () => {
    expect(skillNameFromPath("/repo/README.md")).toBeNull();
    expect(skillNameFromPath("/repo/docs/skills-overview.md")).toBeNull();
    expect(skillNameFromPath("/repo/src/index.ts")).toBeNull();
    expect(skillNameFromPath("")).toBeNull();
  });
});

describe("skill command parsing", () => {
  test("extracts the skill name", () => {
    expect(parseSkillCommand("/skill:reproduce-ticket")).toBe("reproduce-ticket");
  });

  // Arguments carry task text, so only the name is ever recorded.
  test("drops the arguments", () => {
    expect(parseSkillCommand("/skill:pdf-tools extract secret-invoice.pdf")).toBe("pdf-tools");
  });

  test("ignores everything else", () => {
    expect(parseSkillCommand("/agents")).toBeNull();
    expect(parseSkillCommand("just a prompt")).toBeNull();
    expect(parseSkillCommand("/skill:")).toBeNull();
  });
});

describe("aggregation", () => {
  const entries: TelemetryEntry[] = [
    { ts: "2026-08-19T10:00:00.000Z", profile: "pi", run: "r1", kind: "session_start" },
    { ts: "2026-08-19T10:01:00.000Z", profile: "pi", run: "r1", kind: "skill_read", skill: "systematic-debugging" },
    { ts: "2026-08-19T10:02:00.000Z", profile: "pi", run: "r1", kind: "skill_read", skill: "systematic-debugging" },
    { ts: "2026-08-20T09:00:00.000Z", profile: "pi", run: "r2", kind: "session_start" },
    { ts: "2026-08-20T09:05:00.000Z", profile: "pi", run: "r2", kind: "skill_command", skill: "reproduce-ticket" },
    { ts: "2026-08-20T09:06:00.000Z", profile: "pi", run: "r2", kind: "skill_read", skill: "systematic-debugging" },
  ];

  test("counts loads, splits read from command, and counts distinct sessions", () => {
    const summary = summarize(entries);

    expect(summary.sessions).toBe(2);
    expect(summary.from).toBe("2026-08-19T10:00:00.000Z");
    expect(summary.to).toBe("2026-08-20T09:06:00.000Z");
    expect(summary.skills).toEqual([
      { skill: "systematic-debugging", reads: 3, commands: 0, runs: 2 },
      { skill: "reproduce-ticket", reads: 0, commands: 1, runs: 1 },
    ]);
  });

  test("tolerates a half-written final line from a live session", () => {
    const contents = `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n{"ts":"2026-08`;
    const parsed = parseEntries(contents);

    expect(parsed).toHaveLength(2);
    expect(summarize(parsed).skills[0]?.skill).toBe("systematic-debugging");
  });

  // A zero is the finding worth acting on, so installed-but-unloaded skills
  // have to appear somewhere in the report.
  test("reports installed skills that never loaded", () => {
    const report = formatStats(summarize(entries), [
      "systematic-debugging",
      "reproduce-ticket",
      "writing-skills",
      "verification-before-completion",
    ]);

    expect(report).toContain("never loaded: verification-before-completion, writing-skills");
    expect(report).toContain("2 session(s) recorded");
  });

  test("says so plainly when nothing was recorded", () => {
    const report = formatStats(summarize([]));
    expect(report).toContain("no skill loads recorded");
    expect(report).toContain("no data yet");
  });
});
