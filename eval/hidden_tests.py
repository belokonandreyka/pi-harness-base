#!/usr/bin/env python3
"""Run the reference commit's tests against each candidate diff.

    python3 eval/hidden_tests.py --results eval/results --tasks eval/tasks [--related] [--only ID,ID] [--force]

The judge reads diffs; this runs code. For every result with a candidate
diff: a clean checkout of the base (`run.make_worktree`), the candidate
diff applied, then

- hidden tests: the spec files the task lists under `hiddenTests` (by
  default `extract.py` fills it with the spec files the reference commit
  added or changed), taken from the reference commit and run against the
  candidate's code. A spec that names a helper only the reference introduced
  fails on the name, not on behaviour: read the log before trusting a fail.
- related tests (`--related`): existing spec files at the base that import
  one of the files the candidate changed, run as they are. A fail here is a
  regression the candidate caused.

The command comes from the task's `testCmd`, run in `workdir`, with
`{includes}` replaced by one `--include <spec>` per file relative to workdir.
Writes `hiddenTests` / `relatedTests` into result.json: {ok, passed, failed,
specs, seconds} and the log to `hidden-tests.log` / `related-tests.log`.
"""

import argparse
import glob
import json
import os
import re
import shlex
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run  # noqa: E402

SUMMARY_RE = re.compile(r"Success:\s*(\d+),\s*Failed:\s*(\d+)")
EXECUTED_RE = re.compile(r"Executed (\d+) of (\d+)(?: \((\d+) FAILED\))?")


def related_specs(wt, workdir, changed, cap=60):
    """Existing spec files under workdir that import one of the changed files (matched on the last three path components, so `enums` or `grid/grid` alone match nothing)."""
    root = os.path.join(wt, workdir) if workdir else wt
    keys = set()
    for f in changed:
        if f.endswith(".spec.ts") or not f.endswith((".ts", ".html")):
            continue
        rel = os.path.relpath(os.path.join(wt, f), root)
        stem = re.sub(r"\.(ts|html)$", "", rel)
        stem = re.sub(r"\.(component|service|directive|pipe|module)$", "", stem)
        parts = stem.split("/")
        if len(parts) >= 2:
            # three trailing components, so `log/grid/grid` does not match every grid in the app
            keys.add("/".join(parts[-3:]))
    if not keys:
        return []
    pattern = "|".join(re.escape(k) for k in sorted(keys, key=len, reverse=True))
    code, out = run.sh(["rg", "-l", "--glob", "*.spec.ts", rf"from\s+['\"][^'\"]*(^|/)({pattern})(\.service|\.component|\.directive|\.pipe|\.module)?['\"]", root])
    specs = sorted(os.path.relpath(p, root) for p in out.split() if p.endswith(".spec.ts")) if code == 0 else []
    return specs[:cap]


def run_specs(task, wt, specs, log_path):
    workdir = task.get("workdir") or ""
    cwd = os.path.join(wt, workdir) if workdir else wt
    rel = [os.path.relpath(os.path.join(wt, s), cwd) for s in specs]
    cmd = task["testCmd"].replace("{includes}", " ".join(f"--include {shlex.quote(r)}" for r in rel))
    if "{specTsconfig}" in cmd:
        # narrow the type-check program to the selected specs: Angular's karma
        # builder compiles every spec in tsconfig.spec.json even with --include,
        # so one broken unrelated spec at the base kills the run
        tc = dict(task.get("specTsconfig") or {"extends": "./tsconfig.spec.json"})
        tc["include"] = list(tc.get("include") or []) + rel
        tc.setdefault("files", [])
        path = os.path.join(cwd, "tsconfig.spec.eval.json")
        with open(path, "w") as fh:
            json.dump(tc, fh, indent=2)
        cmd = cmd.replace("{specTsconfig}", "tsconfig.spec.eval.json")
    t0 = time.time()
    code, out = run.sh(["bash", "-lc", cmd], cwd=cwd, timeout=60 * task.get("testTimeoutMin", 10))
    with open(log_path, "w") as fh:
        fh.write(cmd + "\n\n" + out)
    m = SUMMARY_RE.search(out) or None
    if m:
        passed, failed = int(m.group(1)), int(m.group(2))
    else:
        m2 = EXECUTED_RE.findall(out)
        passed, failed = (int(m2[-1][0]) - int(m2[-1][2] or 0), int(m2[-1][2] or 0)) if m2 else (0, -1)
    return {"ok": code == 0 and failed == 0, "passed": passed, "failed": failed, "specs": specs, "seconds": round(time.time() - t0, 1), "exit": code}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--related", action="store_true")
    ap.add_argument("--only", default=None)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    tasks = {}
    for p in glob.glob(os.path.join(a.tasks, "*.json")):
        t = json.load(open(p))
        tasks[t["id"]] = t
    n = 0
    for rp in sorted(glob.glob(os.path.join(a.results, "*", "*", "*", "result.json"))):
        r = json.load(open(rp))
        t = tasks.get(r["task"])
        if not t or (only and r["task"] not in only) or not t.get("testCmd"):
            continue
        hidden = t.get("hiddenTests") or []
        want_hidden = hidden and (a.force or "hiddenTests" not in r)
        want_related = a.related and (a.force or "relatedTests" not in r)
        if not want_hidden and not want_related:
            continue
        res_dir = os.path.dirname(rp)
        diff_path = os.path.join(res_dir, "candidate.diff")
        if not os.path.exists(diff_path) or not open(diff_path).read().strip():
            continue
        name = f"{r['task']}-{r['config']}-{r['repeat']}-tests"
        print(f"⚗ {r['task']} · {r['config']} · #{r['repeat']}", flush=True)
        wt = run.make_worktree(t, name)
        try:
            code, out = run.sh(["git", "-C", wt, "apply", "--whitespace=nowarn", diff_path])
            if code != 0:
                r["hiddenTests"] = {"ok": False, "error": "candidate diff did not apply: " + out.strip()[:300]}
                print("  diff did not apply", flush=True)
            else:
                if want_related:
                    specs = related_specs(wt, t.get("workdir") or "", r.get("changedFiles") or [])
                    if specs:
                        full = [os.path.join(t.get("workdir") or "", s) for s in specs]
                        r["relatedTests"] = run_specs(t, wt, full, os.path.join(res_dir, "related-tests.log"))
                        x = r["relatedTests"]
                        if not x["ok"]:
                            # the same specs on the untouched base: a fail there is pre-existing, not the candidate's
                            bwt = run.make_worktree(t, name + "-base")
                            try:
                                x["baseline"] = run_specs(t, bwt, full, os.path.join(res_dir, "related-tests-base.log"))
                            finally:
                                run.remove_worktree(t, bwt)
                            x["regression"] = x["failed"] > x["baseline"]["failed"] or (x["failed"] < 0 and x["baseline"]["failed"] >= 0)
                        else:
                            x["regression"] = False
                        print(f"  related: {'ok' if x['ok'] else ('REGRESSION' if x['regression'] else 'fail (pre-existing)')} · {x['passed']} passed · {x['failed']} failed · {len(specs)} specs · {x['seconds']}s", flush=True)
                    else:
                        r["relatedTests"] = {"ok": None, "passed": 0, "failed": 0, "specs": [], "seconds": 0}
                        print("  related: no existing spec imports the changed files", flush=True)
                if want_hidden:
                    code, out = run.sh(["git", "-C", wt, "checkout", t["reference"], "--", *hidden])
                    if code != 0:
                        r["hiddenTests"] = {"ok": False, "error": "spec checkout failed: " + out.strip()[:300]}
                    else:
                        r["hiddenTests"] = run_specs(t, wt, hidden, os.path.join(res_dir, "hidden-tests.log"))
                        x = r["hiddenTests"]
                        print(f"  hidden: {'ok' if x['ok'] else 'FAIL'} · {x['passed']} passed · {x['failed']} failed · {x['seconds']}s", flush=True)
        finally:
            run.remove_worktree(t, wt)
        with open(rp, "w") as fh:
            json.dump(r, fh, indent=2, ensure_ascii=False)
        n += 1
    print(f"tested {n} results")
    return 0


if __name__ == "__main__":
    sys.exit(main())
