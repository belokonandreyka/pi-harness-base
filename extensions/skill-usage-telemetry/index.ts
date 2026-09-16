import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

const CUSTOM_TYPE = "skill-usage:report";

/**
 * Records which skills actually get loaded, so a set of installed skills can be
 * judged on evidence instead of impressions. Pi keeps only skill names and
 * descriptions in the system prompt and loads the body on demand, so a skill
 * that never loads is costing context for nothing — usually because its
 * description never triggers.
 *
 * Only skill identities are logged, never prompts, task text or `/skill:`
 * arguments.
 */
export default function skillUsageTelemetryExtension(pi: ExtensionAPI): void {
  const agentDir = resolveAgentDir();
  const profile = profileLabel(agentDir);
  const logPath = telemetryLogPath(agentDir);
  const run = randomUUID();

  let logDirReady = false;

  // Telemetry must never be the reason a session breaks, so every failure here
  // is swallowed rather than surfaced.
  function append(entry: Omit<TelemetryEntry, "ts" | "profile" | "run">): void {
    try {
      if (!logDirReady) {
        mkdirSync(dirname(logPath), { recursive: true });
        logDirReady = true;
      }
      const record: TelemetryEntry = {
        ts: new Date().toISOString(),
        profile,
        run,
        ...entry,
      };
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch {
      // ignore
    }
  }

  pi.on("session_start", (event, ctx) => {
    append({
      kind: "session_start",
      reason: event.reason,
      cwd: ctx.cwd,
      model: ctx.model?.id,
    });
  });

  pi.on("session_shutdown", (event) => {
    append({ kind: "session_end", reason: event.reason });
  });

  // The agent loads a skill body by reading it, which makes the read tool the
  // only reliable signal that a skill was actually consulted.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "read") return;
    const path = event.input?.path;
    if (typeof path !== "string") return;

    const skill = skillNameFromPath(path);
    if (!skill) return;

    append({ kind: "skill_read", skill, path });
  });

  pi.on("input", (event) => {
    const skill = parseSkillCommand(event.text);
    if (!skill) return;

    append({ kind: "skill_command", skill });
  });

  pi.registerCommand("skill-stats", {
    description: "Summarise recorded skill usage for this profile",
    handler: async (_args, ctx) => {
      const report = buildReport(logPath, agentDir, profile);
      pi.sendMessage({ customType: CUSTOM_TYPE, content: report, display: true });
      ctx.ui.notify(`skill-usage: report written from ${logPath}`, "info");
    },
  });
}

function buildReport(logPath: string, agentDir: string, profile: string): string {
  // An absent log is the normal state at the start of a measurement, and it is
  // exactly when the installed-but-unloaded list is worth seeing, so it is
  // treated as "no entries" rather than as an error worth bailing on.
  let contents = "";
  let note = "";

  if (existsSync(logPath)) {
    try {
      contents = readFileSync(logPath, "utf-8");
    } catch (error) {
      note = `\n  note: could not read the log — ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    note = "\n  note: no log recorded yet in this profile";
  }

  const summary = summarize(parseEntries(contents));
  return `${formatStats(summary, discoverSkillNames(agentDir))}\n  profile: ${profile}\n  log: ${logPath}${note}`;
}

/**
 * Roots pi discovers skills from, as far as this extension can see them: the
 * profile's own directory, the shared `.agents` location, and any directory
 * listed in the profile's `skills` setting. That last one matters — skills kept
 * in a shared repository are reachable only through it, and without it they
 * would be missing from the never-loaded list precisely when it is most useful.
 */
function skillRoots(agentDir: string): string[] {
  const roots = [join(agentDir, "skills"), join(agentDir, "..", "..", ".agents", "skills")];

  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    if (Array.isArray(settings?.skills)) {
      for (const entry of settings.skills) {
        if (typeof entry !== "string" || entry.trim().length === 0) continue;
        roots.push(entry.startsWith("~") ? join(process.env.HOME ?? "", entry.slice(1)) : entry);
      }
    }
  } catch {
    // No settings, unreadable, or malformed - the built-in roots still apply.
  }

  return roots;
}

/**
 * Best-effort list of installed skill names, used only to show which ones never
 * loaded. Mirrors pi's two discovery shapes: a directory holding SKILL.md, and
 * a bare .md file directly in a skills directory.
 */
function discoverSkillNames(agentDir: string): string[] {
  const roots = skillRoots(agentDir);
  const names = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (existsSync(join(root, entry.name, "SKILL.md"))) names.add(entry.name);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        names.add(entry.name.slice(0, -3));
      }
    }
  }

  return [...names];
}
