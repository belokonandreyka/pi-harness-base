import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alreadyPresent,
  buildContextText,
  contextPaths,
  insertionIndex,
  loadContext,
  MARKER,
  readSources,
  SIZE_WARN_CHARS,
  sourcesFingerprint,
} from "./context.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loading", () => {
  test("returns null when no rules file exists", () => {
    const dir = makeTempDir("durable-none-");
    expect(loadContext(contextPaths(dir, dir))).toBeNull();
  });

  test("treats an empty or whitespace-only file as absent", () => {
    const dir = makeTempDir("durable-empty-");
    writeFileSync(join(dir, "durable-context.md"), "   \n\n", "utf-8");
    expect(loadContext(contextPaths(dir, dir))).toBeNull();
  });

  // Project rules read as amendments to the profile's, so ordering matters.
  test("appends project rules after global ones", () => {
    const agentDir = makeTempDir("durable-agent-");
    const cwd = makeTempDir("durable-cwd-");
    writeFileSync(join(agentDir, "durable-context.md"), "global rule", "utf-8");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "durable-context.md"), "project rule", "utf-8");

    const loaded = loadContext(contextPaths(agentDir, cwd));

    expect(loaded?.text).toBe("global rule\n\nproject rule");
    expect(loaded?.sources).toHaveLength(2);
  });

  test("flags rules large enough to be worth repeating less often", () => {
    const dir = makeTempDir("durable-big-");
    writeFileSync(join(dir, "durable-context.md"), "x".repeat(SIZE_WARN_CHARS + 1), "utf-8");
    expect(loadContext(contextPaths(dir, dir))?.oversized).toBe(true);
  });
});

describe("change detection", () => {
  // The fingerprint is what lets an edited file take effect without a restart.
  test("changes when a rules file is edited", () => {
    const dir = makeTempDir("durable-fp-");
    const file = join(dir, "durable-context.md");
    const paths = contextPaths(dir, dir);

    writeFileSync(file, "one", "utf-8");
    const before = sourcesFingerprint(readSources(paths));

    // mtime has millisecond resolution, so move it explicitly rather than
    // relying on the write being slow enough to land in a later tick.
    const future = new Date(Date.now() + 5_000);
    writeFileSync(file, "two", "utf-8");
    require("node:fs").utimesSync(file, future, future);

    expect(sourcesFingerprint(readSources(paths))).not.toBe(before);
  });

  test("is stable when nothing changed", () => {
    const dir = makeTempDir("durable-fp-stable-");
    writeFileSync(join(dir, "durable-context.md"), "one", "utf-8");
    const paths = contextPaths(dir, dir);

    expect(sourcesFingerprint(readSources(paths))).toBe(sourcesFingerprint(readSources(paths)));
  });
});

describe("placement", () => {
  test("goes to the top of an ordinary session", () => {
    expect(insertionIndex([{ role: "user" }, { role: "assistant" }])).toBe(0);
  });

  // After compaction the summary has to stay first; the rules follow it.
  test("goes after leading compaction summaries", () => {
    const messages = [{ role: "compactionSummary" }, { role: "compactionSummary" }, { role: "user" }];
    expect(insertionIndex(messages)).toBe(2);
  });

  test("detects the block in both string and structured content", () => {
    expect(alreadyPresent([{ role: "user", content: `${MARKER} rules` }])).toBe(true);
    expect(
      alreadyPresent([{ role: "user", content: [{ type: "text", text: `${MARKER} rules` }] }]),
    ).toBe(true);
    expect(alreadyPresent([{ role: "user", content: [{ type: "text", text: "unrelated" }] }])).toBe(false);
    expect(alreadyPresent([{ role: "user", content: [{ type: "image" }] }])).toBe(false);
    expect(alreadyPresent([])).toBe(false);
  });
});

describe("rendering", () => {
  test("carries the marker and says the rules outlive compaction", () => {
    const text = buildContextText({ text: "no force pushes", sources: ["/x"], oversized: false });

    expect(text).toContain(MARKER);
    expect(text).toContain("survive compaction");
    expect(text).toContain("no force pushes");
  });
});
