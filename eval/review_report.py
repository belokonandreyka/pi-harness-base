#!/usr/bin/env python3
"""Recall table for reviewer eval runs: per config, per category, task × config grid.

    python3 eval/review_report.py --results DIR [--md OUT.md]
Recall = (found + 0.5 × partial) / applicable truth findings. `defect recall` restricts
the truth to the defect classes (logic, stale-*, race, contract, guard, data-loss,
requirement-gap, state-reset, predicate-mismatch, security, validation, error-handling,
regression, mapping, fees); the rest (nit, naming, markup, docs, …) is reported separately.
"""
import argparse, collections, glob, json, os

DEFECT = {"logic", "stale-data", "stale-state", "race", "contract", "guard", "data-loss", "requirement-gap", "state-reset",
          "predicate-mismatch", "security", "validation", "error-handling", "regression", "mapping", "fees"}
W = {"found": 1.0, "partial": 0.5, "missed": 0.0}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--results", required=True); ap.add_argument("--md")
    a = ap.parse_args()
    rows = []
    for d in sorted(glob.glob(os.path.join(a.results, "*"))):
        rp, jp = os.path.join(d, "result.json"), os.path.join(d, "judge.json")
        if not (os.path.exists(rp) and os.path.exists(jp)): continue
        r, j = json.load(open(rp)), json.load(open(jp))
        cats = j.get("truthCategories") or []
        per = []
        for t in j.get("truth", []):
            i = (t.get("i") or 0) - 1
            cat = cats[i] if 0 <= i < len(cats) else "?"
            per.append((cat, t.get("status")))
        rows.append((r, j, per))
    by_cfg = collections.defaultdict(lambda: dict(runs=0, cost=0.0, minutes=0.0, turns=0, num=0.0, den=0, dnum=0.0, dden=0, extra=0, extra_ok=0, peek=0, cats=collections.defaultdict(lambda: [0.0, 0])))
    grid = collections.defaultdict(dict)
    for r, j, per in rows:
        c = by_cfg[r["config"]]; c["runs"] += 1; c["cost"] += r["usage"]["cost"]; c["minutes"] += r["minutes"]; c["turns"] += r["turns"]; c["peek"] += 1 if r.get("cheatFlags") else 0
        num = den = 0.0
        for cat, st in per:
            if st not in W: continue
            c["num"] += W[st]; c["den"] += 1; num += W[st]; den += 1
            c["cats"][cat][0] += W[st]; c["cats"][cat][1] += 1
            if cat in DEFECT: c["dnum"] += W[st]; c["dden"] += 1
        ex = j.get("extra", []); c["extra"] += len(ex); c["extra_ok"] += sum(1 for e in ex if e.get("plausible"))
        grid[r["task"]][f"{r['config']}#{r['repeat']}"] = f"{num:.1f}/{int(den)}" + ("!" if r.get("cheatFlags") else "")
    out = ["| config | runs | recall | defect recall | extra (plausible) | $/run | min/run | turns | peeks |", "|---|---|---|---|---|---|---|---|---|"]
    for name, c in by_cfg.items():
        out.append(f"| {name} | {c['runs']} | {c['num'] / max(c['den'], 1):.2f} ({c['num']:.1f}/{c['den']}) | {c['dnum'] / max(c['dden'], 1):.2f} ({c['dnum']:.1f}/{c['dden']}) | {c['extra']} ({c['extra_ok']}) | {c['cost'] / max(c['runs'], 1):.2f} | {c['minutes'] / max(c['runs'], 1):.1f} | {c['turns'] / max(c['runs'], 1):.0f} | {c['peek']} |")
    out += ["", "Per category (recall, n):", ""]
    allcats = sorted({k for c in by_cfg.values() for k in c["cats"]})
    out.append("| category | " + " | ".join(by_cfg) + " |"); out.append("|---|" + "---|" * len(by_cfg))
    for cat in allcats:
        out.append(f"| {cat}{' *' if cat in DEFECT else ''} | " + " | ".join(f"{c['cats'][cat][0] / max(c['cats'][cat][1], 1):.2f} ({c['cats'][cat][1]})" if c["cats"][cat][1] else "–" for c in by_cfg.values()) + " |")
    out += ["", "Task × run (found+½partial / applicable; ! = history peek):", ""]
    cols = sorted({k for v in grid.values() for k in v})
    out.append("| task | " + " | ".join(cols) + " |"); out.append("|---|" + "---|" * len(cols))
    for t, v in sorted(grid.items()): out.append(f"| {t} | " + " | ".join(v.get(k, "") for k in cols) + " |")
    text = "\n".join(out); print(text)
    if a.md: open(a.md, "w").write(text + "\n")


if __name__ == "__main__":
    main()
