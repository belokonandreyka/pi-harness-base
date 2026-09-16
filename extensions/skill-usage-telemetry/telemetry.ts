import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Pure helpers behind the skill-usage extension. Kept free of the pi API so the
 * path parsing and aggregation can be tested without a running agent.
 */

export interface TelemetryEntry {
  ts: string;
  profile: string;
  run: string;
  kind: "session_start" | "session_end" | "skill_read" | "skill_command";
  skill?: string;
  path?: string;
  reason?: string;
  cwd?: string;
  model?: string;
}

export interface SkillStats {
  skill: string;
  reads: number;
  commands: number;
  runs: number;
}

export interface StatsSummary {
  from?: string;
  to?: string;
  sessions: number;
  skills: SkillStats[];
}

function resolveHomeDir(source: NodeJS.ProcessEnv): string {
  const envHome = source.HOME?.trim();
  if (envHome) return envHome;
  const envUserProfile = source.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;
  return homedir();
}

/**
 * Mirrors how pi locates its agent directory, so a profile started with
 * PI_CODING_AGENT_DIR logs into its own directory instead of the default one.
 */
export function resolveAgentDir(source: NodeJS.ProcessEnv = process.env): string {
  const envAgentDir = source.PI_CODING_AGENT_DIR?.trim();
  if (envAgentDir) return envAgentDir;
  return join(resolveHomeDir(source), ".pi", "agent");
}

/**
 * Names the profile after the directory holding the agent dir — `~/.pi/agent`
 * becomes `pi`, `~/.pi-personal/agent` becomes `pi-personal` — so entries stay
 * attributable after the logs from both profiles are read together.
 */
export function profileLabel(agentDir: string): string {
  const parent = basename(dirname(agentDir));
  const trimmed = parent.startsWith(".") ? parent.slice(1) : parent;
  return trimmed.length > 0 ? trimmed : "unknown";
}

export function telemetryLogPath(agentDir: string): string {
  return join(agentDir, "telemetry", "skill-usage.jsonl");
}

/**
 * Recovers a skill name from a path the agent read. Pi discovers both
 * `<dir>/SKILL.md` bundles (recursively, so the containing directory names the
 * skill) and bare `.md` files sitting directly in a skills directory.
 */
export function skillNameFromPath(path: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");

  if (normalized.endsWith("/SKILL.md") || normalized === "SKILL.md") {
    const parent = basename(dirname(normalized));
    return parent && parent !== "." ? parent : null;
  }

  if (!normalized.endsWith(".md")) return null;
  // Only bare .md files that live in a skills directory are skills; every other
  // markdown read is ordinary file access.
  if (!/\/skills\/[^/]+\.md$/.test(normalized)) return null;

  return basename(normalized, ".md");
}

/** Parses `/skill:name rest of args`, ignoring the arguments themselves. */
export function parseSkillCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) return null;

  const withoutPrefix = trimmed.slice("/skill:".length);
  const name = withoutPrefix.split(/\s/, 1)[0];
  return name && name.length > 0 ? name : null;
}

export function parseEntries(contents: string): TelemetryEntry[] {
  const entries: TelemetryEntry[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        entries.push(parsed as TelemetryEntry);
      }
    } catch {
      // A partially written final line is expected while a session is live.
    }
  }
  return entries;
}

export function summarize(entries: TelemetryEntry[]): StatsSummary {
  const perSkill = new Map<string, { reads: number; commands: number; runs: Set<string> }>();
  const sessions = new Set<string>();
  let from: string | undefined;
  let to: string | undefined;

  for (const entry of entries) {
    if (entry.ts) {
      if (!from || entry.ts < from) from = entry.ts;
      if (!to || entry.ts > to) to = entry.ts;
    }
    if (entry.kind === "session_start" && entry.run) sessions.add(entry.run);
    if (entry.kind !== "skill_read" && entry.kind !== "skill_command") continue;
    if (!entry.skill) continue;

    const bucket = perSkill.get(entry.skill) ?? { reads: 0, commands: 0, runs: new Set<string>() };
    if (entry.kind === "skill_read") bucket.reads += 1;
    else bucket.commands += 1;
    if (entry.run) bucket.runs.add(entry.run);
    perSkill.set(entry.skill, bucket);
  }

  const skills = [...perSkill.entries()]
    .map(([skill, bucket]) => ({
      skill,
      reads: bucket.reads,
      commands: bucket.commands,
      runs: bucket.runs.size,
    }))
    .sort((a, b) => {
      const totalA = a.reads + a.commands;
      const totalB = b.reads + b.commands;
      if (totalA !== totalB) return totalB - totalA;
      return a.skill.localeCompare(b.skill);
    });

  return { from, to, sessions: sessions.size, skills };
}

/**
 * Renders the summary alongside the skills that exist but never loaded — a zero
 * is the most actionable reading here, since it points at a description that
 * never triggers rather than at a skill nobody needed.
 */
export function formatStats(summary: StatsSummary, knownSkills: string[] = []): string {
  const lines: string[] = [];
  const window =
    summary.from && summary.to ? `${summary.from.slice(0, 10)} .. ${summary.to.slice(0, 10)}` : "no data yet";
  lines.push(`Skill usage (${window}), ${summary.sessions} session(s) recorded`);

  if (summary.skills.length === 0) {
    lines.push("  no skill loads recorded");
  } else {
    lines.push("  skill                          loads   read   /skill:   sessions");
    for (const skill of summary.skills) {
      const total = skill.reads + skill.commands;
      lines.push(
        `  ${skill.skill.padEnd(28)} ${String(total).padStart(5)}  ${String(skill.reads).padStart(5)}  ${String(
          skill.commands,
        ).padStart(7)}  ${String(skill.runs).padStart(8)}`,
      );
    }
  }

  const used = new Set(summary.skills.map((entry) => entry.skill));
  const unused = knownSkills.filter((name) => !used.has(name)).sort();
  if (unused.length > 0) {
    lines.push("", `  never loaded: ${unused.join(", ")}`);
  }

  return lines.join("\n");
}
