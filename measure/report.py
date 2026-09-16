#!/usr/bin/env python3
"""Report what each installed package costs in every request, against how often
its tools are actually called.

Reads the dump written by `measure/tools-probe.ts` and cross-references it with
the session history, because cost only means something next to usage: a package
nobody calls is paid for on every request of every session.

Usage:
    pi -e measure/tools-probe.ts        # in a Herdr pane; needs no model call
    python3 measure/report.py
"""

import collections
import glob
import json
import os
import re
import sys

REPORT = "/tmp/pi-tools-report.json"
SESSIONS = os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl")

# Tool-name prefixes are a more reliable package signal than the source path,
# which points at a bundled entry file rather than the package the user chose.
PACKAGE_OF = [
    ("pi-mono-figma", lambda n: n.startswith("figma")),
    ("pi-web-access", lambda n: n in {"web_search", "fetch_content", "source_check", "web_fetch"}),
    ("pi-herdr", lambda n: n.startswith("herdr_")),
    ("pi-cmux", lambda n: n.startswith("cmux")),
    ("pi-mcp-adapter", lambda n: n == "mcp"),
    ("pi-lsp", lambda n: n.startswith("lsp")),
    ("pi-collaborating-agents", lambda n: n in {"agent_message", "subagent"}),
]


def package_for(name, source):
    for package, matches in PACKAGE_OF:
        if matches(name):
            return package
    if source == "builtin":
        return "pi (builtin)"
    if not source:
        return "?"
    # Sources arrive as install specs — `npm:pi-lsp`, `../../projects/pi-lsp` —
    # so reduce them to the bare package name, or the same package shows up as
    # two rows whenever one of its tools escapes the prefix table above.
    return os.path.basename(source.split(":", 1)[-1].rstrip("/"))


def load_report():
    if not os.path.exists(REPORT):
        sys.exit(f"{REPORT} not found — run `pi -e measure/tools-probe.ts` first")
    with open(REPORT) as fh:
        return json.load(fh)


def count_usage():
    """How many times each tool was called across the recorded sessions."""
    calls = collections.Counter()
    sessions = collections.defaultdict(set)
    files = glob.glob(SESSIONS)
    for path in files:
        try:
            text = open(path, errors="ignore").read()
        except OSError:
            continue
        for name in re.findall(r'"toolName"\s*:\s*"([a-zA-Z0-9_]+)"', text):
            calls[name] += 1
            sessions[name].add(path)
    return calls, sessions, len(files)


def main():
    report = load_report()
    tools = report.get("tools", [])
    calls, sessions, session_count = count_usage()

    grouped = collections.defaultdict(list)
    for tool in tools:
        grouped[package_for(tool["name"], tool.get("source"))].append(tool)

    total_chars = sum(t["chars"] for t in tools) or 1
    print(f"cwd: {report.get('cwd')}   tools: {len(tools)}   sessions scanned: {session_count}\n")
    print(f"{'package':26} {'n':>3} {'chars':>8} {'~tokens':>8} {'share':>6} {'calls':>7} {'in sessions':>12}")
    print("-" * 76)

    rows = sorted(grouped.items(), key=lambda kv: -sum(t["chars"] for t in kv[1]))
    for package, package_tools in rows:
        chars = sum(t["chars"] for t in package_tools)
        used = sum(calls[t["name"]] for t in package_tools)
        seen = len(set().union(*[sessions[t["name"]] for t in package_tools])) if package_tools else 0
        flag = "  <-- never called" if used == 0 else ""
        print(
            f"{package:26} {len(package_tools):3} {chars:8,} {chars // 4:8,} "
            f"{100 * chars / total_chars:5.1f}% {used:7} {seen:12}{flag}"
        )

    print("-" * 76)
    print(f"{'TOTAL':26} {len(tools):3} {total_chars:8,} {total_chars // 4:8,}")

    dead = [p for p, ts in rows if sum(calls[t["name"]] for t in ts) == 0]
    if dead:
        wasted = sum(t["chars"] for p, ts in rows if p in dead for t in ts)
        print(f"\nnever called: {', '.join(dead)} — {wasted // 4:,} tokens on every request")


if __name__ == "__main__":
    main()
