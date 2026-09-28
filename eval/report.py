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


def passed(r, slot="judge"):
    """Judge verdict gated by code: a regression in the existing tests fails the run whatever the judge said."""
    j = r.get(slot) or {}
    if "pass" not in j:
        return None
    rel = r.get("relatedTests") or {}
    return bool(j["pass"]) and not rel.get("regression")


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
        verdicts = [passed(r) for r in ok if passed(r) is not None]
        lines.append("| " + " | ".join([
            name, str(ok[0].get("model") if ok else "-") + (f":{ok[0].get('thinking')}" if ok and ok[0].get("thinking") else ""), str(len(ok)),
            fmt(mean([1.0 if c else 0.0 for c in checks]) , 2) + f" ({len(checks)})" if checks else "-",
            fmt(mean([1.0 if v else 0.0 for v in verdicts]), 2) + f" ({len(verdicts)})" if verdicts else "-",
            fmt(mean([j.get("correctness") for j in judged]), 1), fmt(mean([j.get("scope") for j in judged]), 1), fmt(mean([j.get("conventions") for j in judged]), 1),
            fmt(mean([r.get("usage", {}).get("cost") for r in ok]), 3),
            fmt(mean([(r.get("usage", {}).get("input", 0) + r.get("usage", {}).get("cacheRead", 0) + r.get("usage", {}).get("cacheWrite", 0)) for r in ok]), 0),
            fmt(mean([r.get("usage", {}).get("output") for r in ok]), 0),
            fmt(mean([r.get("toolCallsTotal") for r in ok]), 1),
            fmt(mean([r.get("minutes") for r in ok]), 1),
            str(sum(1 for r in ok if r.get("status") == "timeout")),
            str(sum(1 for r in ok if r.get("gitPeeks") and r.get("isolation") != "clone")),
        ]) + " |")
    return lines


def grid(rows):
    tasks = sorted({r["task"] for r in rows})
    configs = sorted({r["config"] for r in rows})
    cell = collections.defaultdict(list)
    for r in rows:
        c = "✓" if r.get("checksPassed") else ("✗" if r.get("checksPassed") is False else "·")
        v = passed(r)
        jv = "·" if v is None else ("P" if v else ("R" if (r.get("relatedTests") or {}).get("regression") else "F"))
        if r.get("status") == "timeout":
            c = "T"
        cell[(r["task"], r["config"])].append(f"{c}{jv}")
    lines = ["| task | " + " | ".join(configs) + " |", "|---|" + "---|" * len(configs)]
    for t in tasks:
        lines.append(f"| {t} | " + " | ".join(" ".join(cell.get((t, c), [])) or "-" for c in configs) + " |")
    lines.append("")
    lines.append("cell = one run: checks (✓ pass, ✗ fail, · none, T timeout) + verdict (P pass, F judge fail, R regression in existing tests, · not judged)")
    return lines


def against(base, rows, slot):
    """Per config present in both sets: pass counts, cost and tool calls, then every task whose verdict flipped."""
    def key(r):
        return (r["task"], r["config"], r["repeat"])
    b = {key(r): r for r in base}
    n = {key(r): r for r in rows}
    configs = sorted({r["config"] for r in base} & {r["config"] for r in rows})
    lines = ["| config | runs | judge pass before → after | checks before → after | $/run before → after | tool calls before → after | flipped |",
             "|---|---|---|---|---|---|---|"]
    flips = []
    for c in configs:
        common = sorted(k for k in b if k in n and k[1] == c)
        if not common:
            continue
        pb = [passed(b[k], slot) for k in common]
        pn = [passed(n[k], slot) for k in common]
        cb = [b[k].get("checksPassed") for k in common]
        cn = [n[k].get("checksPassed") for k in common]
        cost_b = mean([(b[k].get("usage") or {}).get("cost") for k in common])
        cost_n = mean([(n[k].get("usage") or {}).get("cost") for k in common])
        tc_b = mean([b[k].get("toolCallsTotal") for k in common])
        tc_n = mean([n[k].get("toolCallsTotal") for k in common])
        flipped = [k for k in common if passed(b[k], slot) is not None and passed(n[k], slot) is not None and passed(b[k], slot) != passed(n[k], slot)]
        flips += [(k, passed(b[k], slot), passed(n[k], slot)) for k in flipped]
        lines.append("| " + " | ".join([c, str(len(common)),
                                         f"{sum(1 for x in pb if x)}/{sum(1 for x in pb if x is not None)} → {sum(1 for x in pn if x)}/{sum(1 for x in pn if x is not None)}",
                                         f"{sum(1 for x in cb if x)} → {sum(1 for x in cn if x)}",
                                         f"{fmt(cost_b, 3)} → {fmt(cost_n, 3)}", f"{fmt(tc_b, 1)} → {fmt(tc_n, 1)}", str(len(flipped))]) + " |")
    only_new = sorted(k for k in n if k not in b)
    if only_new:
        lines.append(f"\nruns only in the new set: {len(only_new)} (not compared)")
    if flips:
        lines += ["", "| task | config | # | before | after |", "|---|---|---|---|---|"]
        for (t, c, i), x, y in flips:
            lines.append(f"| {t} | {c} | {i} | {'P' if x else 'F'} | {'P' if y else 'F'} |")
    else:
        lines.append("\nno verdict flipped")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--md", default=None, help="also write the report to this file")
    ap.add_argument("--baseline", default=None, help="another results directory: per config, what changed against it (pass flips, cost, tool calls)")
    ap.add_argument("--slot", default="judge", help="judge slot to read (default judge)")
    a = ap.parse_args()
    rows = load(a.results)
    if not rows:
        print(f"no results under {a.results}", file=sys.stderr)
        return 1
    text = "\n".join(["## Per config", ""] + per_config(rows) + ["", "## Task × config", ""] + grid(rows))
    if a.baseline:
        base = load(a.baseline)
        if not base:
            print(f"no results under {a.baseline}", file=sys.stderr)
            return 1
        text += "\n\n" + "\n".join(["## Against baseline " + a.baseline, ""] + against(base, rows, a.slot))
    print(text)
    if a.md:
        with open(a.md, "w") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
