/**
 * Minimal driver for `pi --mode rpc` used by the e2e tests: starts pi with the
 * scripted provider and the extensions under test in a throwaway agent dir,
 * sends one prompt, collects events until the agent settles, and returns the
 * events together with the persisted session entries.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const BASE_DIR = join(import.meta.dir, "..", "..");
export const EXT = (name: string) => join(BASE_DIR, "extensions", name, "index.ts");
export const FAKE_PROVIDER = join(import.meta.dir, "fake-provider.ts");

export interface RpcRun {
  events: any[];
  entries: any[];
  stderr: string;
  sessionFile?: string;
}

export interface RpcOptions {
  extensions: string[];
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  prompt: string;
  timeoutMs?: number;
  /** Stop collecting after this many agent_end events (default 1). */
  agentEnds?: number;
}

function piBinary(): string {
  const fnm = join(homedir(), ".local", "share", "fnm", "node-versions");
  if (existsSync(fnm)) {
    for (const v of readdirSync(fnm)) {
      const bin = join(fnm, v, "installation", "bin", "pi");
      if (existsSync(bin)) return bin;
    }
  }
  return "pi";
}

export async function runPi(options: RpcOptions): Promise<RpcRun> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-e2e-agent-"));
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 3000 }, ...(options.settings ?? {}) }, null, 2));

  const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", FAKE_PROVIDER];
  for (const e of options.extensions) args.push("-e", e);
  args.push("--model", "fake/scripted", "--session-dir", sessionDir);

  const child = spawn(piBinary(), args, {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let stderr = "";
  let buffer = "";
  let ends = 0;
  const wanted = options.agentEnds ?? 1;
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, options.timeoutMs ?? 30000);
    child.stdout.on("data", (d) => {
      buffer += d;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          events.push(e);
          if (e.type === "agent_end" && ++ends >= wanted) {
            clearTimeout(timer);
            // give pi a moment to flush the session file
            setTimeout(resolve, 300);
          }
        } catch {
          // non-JSON noise on stdout
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: options.prompt })}\n`);
  await settled;
  child.kill("SIGTERM");

  const files = existsSync(sessionDir)
    ? (readdirSync(sessionDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessionDir, f))
    : [];
  const sessionFile = files.sort().at(-1);
  const entries = sessionFile
    ? readFileSync(sessionFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  return { events, entries, stderr, sessionFile };
}

export const toolCalls = (events: any[]) => events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName as string);
export const compactions = (events: any[]) => events.filter((e) => e.type === "compaction_end");
export const assistantTexts = (events: any[]) =>
  events
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => (Array.isArray(e.message.content) ? e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : ""));
