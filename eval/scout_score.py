#!/usr/bin/env python3
"""Score reconnaissance runs against the files the reference commit actually touched.

A scout is asked where a change belongs, not to make it, so a diff cannot grade
it. The reference commit can: every task records the files it changed
(`expectFiles`). This script reads each scout run's final report, pulls the
file paths it names, and matches them to the reference files by path suffix (scouts print paths relative
to the workdir or to a directory they named a line earlier; a bare file name
counts when it is unique in the reference set).

    python3 eval/scout_score.py --results eval/results-scout --tasks eval/tasks [--only ID,ID]

Per config: mean recall (share of reference files the report names), mean
precision (share of named source files that are reference files), the share of
tasks where the report names at least half of the reference files, credits and
minutes per run. Spec files and seeded files are left out of the reference set.
Per task: recall as `hit/total` for every config side by side.
"""

import argparse
import glob
import json
import os
import re
import statistics
import sys

PATH_RE = re.compile(r"(?<![\w/])((?:[\w.@-]+/)*[\w.@-]+\.(?:ts|html|less|scss|css|cs|json|js|py|md|xml))\b")
SKIP_SUFFIXES = (".spec.ts", ".test.ts", "_test.py", "Tests.cs")


def parts(path):
    return tuple(path.strip().strip("`'\"").lstrip("./").split("/"))


def matches(named, ref_files):
    """Reference files a named path points at: the named path's components must be a
    suffix of the reference path (scouts print paths relative to whatever directory
    they last mentioned); a bare file name counts only when it is unique in the set."""
    n = parts(named)
    hits = [f for f in ref_files if parts(f)[-len(n):] == n]
    if len(n) == 1 and len(hits) != 1:
        return []
    return hits


def reference_files(task):
    seeds = set(task.get("seed") or [])
    return [f for f in task.get("expectFiles") or [] if not f.endswith(SKIP_SUFFIXES) and f not in seeds]


def named_files(report):
    out = []
    for m in PATH_RE.finditer(report):
        p = m.group(1)
        if p.endswith(SKIP_SUFFIXES) or "node_modules" in p:
            continue
        if p not in out:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", required=True)
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--only", default=None)
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    tasks = {}
    for p in glob.glob(os.path.join(a.tasks, "*.json")):
        t = json.load(open(p))
        tasks[t["id"]] = t

    rows = []
    for rp in sorted(glob.glob(os.path.join(a.results, "*", "*", "*", "result.json"))):
        r = json.load(open(rp))
        task = tasks.get(r["task"])
        if not task or (only and r["task"] not in only):
            continue
        ref = reference_files(task)
        if not ref:
            continue
        final = os.path.join(os.path.dirname(rp), "final.md")
        report = open(final).read() if os.path.exists(final) else ""
        named = named_files(report)
        hits = {f for n in named for f in matches(n, ref)}
        # a named path that is a source file in the repo but not in the reference counts against precision
        src_named = [n for n in named if re.search(r"\.(ts|html|less|cs)$", n)]
        precision = (len(hits) / len(src_named)) if src_named else 0.0
        rows.append({
            "task": r["task"], "config": r["config"], "repeat": r.get("repeat"), "status": r.get("status"),
            "recall": len(hits) / len(ref), "precision": precision, "hits": len(hits), "ref": len(ref), "named": len(src_named),
            "cost": (r.get("usage") or {}).get("cost") or 0, "minutes": r.get("minutes") or 0,
            "tools": r.get("toolCallsTotal") or sum((r.get("toolCalls") or {}).values()),
        })
    if not rows:
        print("no scored runs")
        return 0

    configs = sorted({x["config"] for x in rows})
    print(f"{'config':18}{'runs':>5}{'recall':>8}{'precision':>10}{'≥½ files':>9}{'all files':>10}{'cr/run':>7}{'min':>6}{'tools':>6}")
    for c in configs:
        sel = [x for x in rows if x["config"] == c]
        n = len(sel)
        print(f"{c:18}{n:5}{statistics.mean(x['recall'] for x in sel):8.2f}{statistics.mean(x['precision'] for x in sel):10.2f}"
              f"{sum(1 for x in sel if x['recall'] >= 0.5)/n:9.0%}{sum(1 for x in sel if x['recall'] >= 1)/n:10.0%}"
              f"{statistics.mean(x['cost'] for x in sel)*100:7.0f}{statistics.mean(x['minutes'] for x in sel):6.1f}{statistics.mean(x['tools'] for x in sel):6.1f}")
    print(f"\n{'task':24}" + "".join(f"{c.replace('scout-', ''):>12}" for c in configs) + "   ref files")
    for t in sorted({x["task"] for x in rows}):
        cells = []
        for c in configs:
            sel = [x for x in rows if x["task"] == t and x["config"] == c]
            cells.append("/".join(f"{x['hits']}" for x in sel) + (f"/{sel[0]['ref']}" if sel else "·"))
        ref = len(reference_files(tasks[t]))
        print(f"{t:24}" + "".join(f"{cell:>12}" for cell in cells) + f"   {ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
