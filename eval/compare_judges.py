#!/usr/bin/env python3
"""Task × config grid with every judge slot side by side.

    python3 eval/compare_judges.py --results eval/results [--slots judge-astra,judge-opus55]

`judge.py --slot NAME` stores a second judge's verdict beside the first; this
prints checks + each slot's pass/fail + correctness per cell, then per-config
pass counts per judge and the "both judges pass" count. Slots default to every
`judge*` key found in the results.
"""

import argparse
import glob
import json
import os
import re
import sys


def passed(r, slot):
    """Judge verdict gated by code: a regression in the existing tests fails the run whatever the judge said."""
    j = r.get(slot) or {}
    if "pass" not in j:
        return None
    return bool(j["pass"]) and not (r.get("relatedTests") or {}).get("regression")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--slots", default=None, help="comma-separated result.json keys (default: all judge* keys)")
    ap.add_argument("--tasks", default=None, help="task JSON directory; with it, v2 gap evidence is checked against the prompts")
    ap.add_argument("--agreement", action="store_true", help="pairwise pass agreement between slots, gap kinds, mean cost per judge")
    a = ap.parse_args()
    rows = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(a.results, "*", "*", "*", "result.json")))]
    if not rows:
        print(f"no results under {a.results}", file=sys.stderr)
        return 1
    slots = a.slots.split(",") if a.slots else sorted({k for r in rows for k in r if k.startswith("judge") and k != "judge"} or {"judge"})
    tag = {s: s.replace("judge-", "")[:1].upper() or "J" for s in slots}
    configs = sorted({r["config"] for r in rows})
    tasks = sorted({r["task"] for r in rows})
    cell = {}
    for r in rows:
        c = "✓" if r.get("checksPassed") else ("T" if r.get("status") == "timeout" else "✗")
        parts = [f"{tag[s]}:{'·' if passed(r, s) is None else ('P' if passed(r, s) else 'F')}" for s in slots]
        corr = "/".join(str((r.get(s) or {}).get("correctness", "·")) for s in slots)
        cell.setdefault((r["task"], r["config"]), []).append(f"{c} {' '.join(parts)} c{corr}")
    print("| task | " + " | ".join(configs) + " |")
    print("|---|" + "---|" * len(configs))
    for t in tasks:
        print(f"| {t} | " + " | ".join(" ; ".join(cell.get((t, c), ["-"])) for c in configs) + " |")
    print("\ncell = checks · " + " · ".join(f"{tag[s]}: {s}" for s in slots) + " · correctness per judge\n")
    head = ["config", "runs", "checks"] + [f"{tag[s]} pass" for s in slots] + ["all pass", "hidden ok", "regressions", "$/run", "tool calls", "min", "peeks"]
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for c in configs:
        rs = [r for r in rows if r["config"] == c]
        n = len(rs)
        passes = [sum(1 for r in rs if passed(r, s)) for s in slots]
        allp = sum(1 for r in rs if all(passed(r, s) for s in slots))
        cost = sum((r.get("usage") or {}).get("cost") or 0 for r in rs) / n
        tc = sum(r.get("toolCallsTotal") or 0 for r in rs) / n
        mn = sum(r.get("minutes") or 0 for r in rs) / n
        pk = sum(1 for r in rs if r.get("gitPeeks") and r.get("isolation") != "clone")
        hid = [r["hiddenTests"] for r in rs if isinstance(r.get("hiddenTests"), dict) and r["hiddenTests"].get("ok") is not None and "error" not in r["hiddenTests"]]
        hidden = f"{sum(1 for h in hid if h['ok'])}/{len(hid)}" if hid else "-"
        rel = [r["relatedTests"] for r in rs if isinstance(r.get("relatedTests"), dict) and r["relatedTests"].get("ok") is not None]
        regressions = str(sum(1 for x in rel if x.get("regression"))) + f"/{len(rel)}" if rel else "-"
        print("| " + " | ".join([c, str(n), f"{sum(1 for r in rs if r.get('checksPassed'))}/{n}"] + [f"{p}/{n}" for p in passes] + [f"{allp}/{n}", hidden, regressions, f"${cost:.3f}", f"{tc:.1f}", f"{mn:.1f}", str(pk)]) + " |")
    if a.agreement:
        agreement(rows, slots, a.tasks)
    return 0


def agreement(rows, slots, tasks_dir):
    def verdict(r, s):
        return passed(r, s)
    print("\n## Pass agreement between judges (share of runs with the same pass verdict, both present)\n")
    print("| | " + " | ".join(slots) + " |")
    print("|---|" + "---|" * len(slots))
    for s1 in slots:
        cells = []
        for s2 in slots:
            pairs = [(verdict(r, s1), verdict(r, s2)) for r in rows]
            pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
            cells.append("-" if s1 == s2 or not pairs else f"{sum(1 for x, y in pairs if x == y) / len(pairs):.2f}")
        print(f"| {s1} | " + " | ".join(cells) + " |")
    print("\n## Per judge: pass rate, gap kinds, evidence found in the prompt, cost\n")
    prompts = {}
    if tasks_dir:
        for p in glob.glob(os.path.join(tasks_dir, "*.json")):
            t = json.load(open(p))
            prompts[t["id"]] = t.get("prompt", "")
    print("| slot | judged | pass | prompt gaps | breaks | guide | reference-only | evidence hit | $/verdict |")
    print("|---|---|---|---|---|---|---|---|---|")
    for s in slots:
        js = [(r, r[s]) for r in rows if r.get(s) and "pass" in r[s]]
        kinds = {"prompt": 0, "breaks": 0, "guide": 0, "reference-only": 0}
        hit = tot = 0
        for r, j in js:
            for g in j.get("gaps") or []:
                k = g.get("requiredBy")
                if k in kinds:
                    kinds[k] += 1
                ev = (g.get("evidence") or "").strip().strip('"').lower()
                if k in ("prompt", "guide") and prompts.get(r["task"]) and ev:
                    tot += 1
                    words = [w for w in re.findall(r"[a-z0-9_]+", ev) if len(w) > 2]
                    if words and sum(1 for w in words if w in prompts[r["task"]].lower()) >= max(1, int(0.8 * len(words))):
                        hit += 1
        costs = [j["cost"] for _, j in js if j.get("cost") is not None]
        print("| " + " | ".join([s, str(len(js)), f"{sum(1 for _, j in js if j['pass'])}/{len(js)}", *[str(kinds[k]) for k in ("prompt", "breaks", "guide", "reference-only")],
                                f"{hit}/{tot}" if tot else "-", f"${sum(costs) / len(costs):.3f}" if costs else "-"]) + " |")


if __name__ == "__main__":
    sys.exit(main())
