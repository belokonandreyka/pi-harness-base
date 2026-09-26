#!/usr/bin/env python3
"""Summarise eval results per config and per task.

    python3 eval/report.py --results eval/results [--md report.md]

Per config: runs, check pass rate, judge pass rate and mean scores, mean cost,
tokens, tool calls, minutes, timeouts, git peeks. Then a task × config grid
of "checks/judge" so a config that wins on average but loses a class of tasks
is visible. Differences of one or two runs are noise; the grid shows the
repeats so you can see it.
"""

import argparse
import collections
import glob
import json
import os
import sys


def load(results):
    out = []
    for rp in sorted(glob.glob(os.path.join(results, "*", "*", "*", "result.json"))):
        with open(rp) as fh:
            out.append(json.load(fh))
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def fmt(x, digits=2, suffix=""):
    return "-" if x is None else f"{x:.{digits}f}{suffix}"


def per_config(rows):
    by = collections.defaultdict(list)
    for r in rows:
        by[r["config"]].append(r)
    lines = ["| config | model | runs | checks pass | judge pass | corr | scope | conv | $/run | tokens in | out | tool calls | min | timeouts | git peeks |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, rs in sorted(by.items()):
        ok = [r for r in rs if r.get("status") not in ("harness-error",)]
        checks = [r["checksPassed"] for r in ok if r.get("checksPassed") is not None]
        judged = [r["judge"] for r in ok if r.get("judge") and "pass" in r["judge"]]
        lines.append("| " + " | ".join([
            name, str(ok[0].get("model") if ok else "-") + (f":{ok[0].get('thinking')}" if ok and ok[0].get("thinking") else ""), str(len(ok)),
            fmt(mean([1.0 if c else 0.0 for c in checks]) , 2) + f" ({len(checks)})" if checks else "-",
            fmt(mean([1.0 if j["pass"] else 0.0 for j in judged]), 2) + f" ({len(judged)})" if judged else "-",
            fmt(mean([j.get("correctness") for j in judged]), 1), fmt(mean([j.get("scope") for j in judged]), 1), fmt(mean([j.get("conventions") for j in judged]), 1),
            fmt(mean([r.get("usage", {}).get("cost") for r in ok]), 3),
            fmt(mean([(r.get("usage", {}).get("input", 0) + r.get("usage", {}).get("cacheRead", 0) + r.get("usage", {}).get("cacheWrite", 0)) for r in ok]), 0),
            fmt(mean([r.get("usage", {}).get("output") for r in ok]), 0),
            fmt(mean([r.get("toolCallsTotal") for r in ok]), 1),
            fmt(mean([r.get("minutes") for r in ok]), 1),
            str(sum(1 for r in ok if r.get("status") == "timeout")),
            str(sum(1 for r in ok if r.get("gitPeeks"))),
        ]) + " |")
    return lines


def grid(rows):
    tasks = sorted({r["task"] for r in rows})
    configs = sorted({r["config"] for r in rows})
    cell = collections.defaultdict(list)
    for r in rows:
        c = "✓" if r.get("checksPassed") else ("✗" if r.get("checksPassed") is False else "·")
        j = r.get("judge") or {}
        jv = ("P" if j.get("pass") else "F") if "pass" in j else "·"
        if r.get("status") == "timeout":
            c = "T"
        cell[(r["task"], r["config"])].append(f"{c}{jv}")
    lines = ["| task | " + " | ".join(configs) + " |", "|---|" + "---|" * len(configs)]
    for t in tasks:
        lines.append(f"| {t} | " + " | ".join(" ".join(cell.get((t, c), [])) or "-" for c in configs) + " |")
    lines.append("")
    lines.append("cell = one run: checks (✓ pass, ✗ fail, · none, T timeout) + judge (P pass, F fail, · not judged)")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--md", default=None, help="also write the report to this file")
    a = ap.parse_args()
    rows = load(a.results)
    if not rows:
        print(f"no results under {a.results}", file=sys.stderr)
        return 1
    text = "\n".join(["## Per config", ""] + per_config(rows) + ["", "## Task × config", ""] + grid(rows))
    print(text)
    if a.md:
        with open(a.md, "w") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
