#!/usr/bin/env python3
"""Run a reviewer config against recorded pre-fix diffs and keep its report.

A review task is a base commit plus the staged diff a reviewer once saw
(`<id>.patch`, rebuilt from the worker's edits), the brief the reviewer was
given, and the findings that review produced (the ground truth, judged later by
`review_judge.py`). For every task × config × repeat this script:

1. makes a detached, ref-less checkout of the base (`run.make_worktree`),
   applies the patch to the index so `git diff --cached` is the diff under review;
2. runs `pi -p --mode json` with the config's system prompt and the task's brief
   (the config's `briefField`, default `brief`), paths rewritten to the worktree;
3. stores the final report, usage, turns, minutes and history-peek flags.

    python3 eval/review_run.py --tasks DIR --config CFG.json [--config …] [--repeats 1] [--out DIR] [--dry-run]

Config: the same shape as run.py's (`systemPromptToml`, `model`, `thinking`,
`tools`, `appendSystemPrompt`, `agentDir`) plus `briefField` and `briefPrefixFile`. Every run spends
real quota: `--dry-run` first.
"""
import argparse, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run import cheat_flags, expand, load_config, load_tasks, make_worktree, metrics_from_events, pi_command, prompt_for_worktree, remove_worktree, sh  # noqa: E402

EVAL_NOTE = (
    "This is an evaluation run with no collaboration bus: the agent_message tool is not available, skip every step that uses it "
    "(status, list, reserve, release, send, reply). The diff under review is STAGED in this worktree: read it with `git diff --cached` "
    "(and `git diff --cached --stat`); nothing is committed and there is no other branch. Do not look for the ticket in git history. "
    "End with your full review report as plain text."
)


def born_here(line, key):
    m = re.search(r"\(([^()]*)\)\.?\s*$", line.strip())
    keys = re.findall(r"\b[A-Z]+-\d+\b", m.group(1)) if m else []
    return bool(keys) and keys[0] == key


def run_one(task, cfg, n, out_root, per_run_cost):
    name = f"{task['id']}-{cfg['name']}-{n}"
    out_dir = os.path.join(out_root, name)
    if os.path.exists(os.path.join(out_dir, "result.json")):
        print(f"  {name}: done, skipping")
        return
    os.makedirs(out_dir, exist_ok=True)
    # the replay already folded any seeded files into the patch; run.py's seed means "checkout from reference", which review tasks do not have
    wt = make_worktree({**task, "seed": None}, name)
    try:
        patch = os.path.join(os.path.dirname(task["_path"]), task["patch"])
        code, out = sh(["git", "-C", wt, "apply", "--index", "--binary", patch])
        if code != 0:
            raise RuntimeError(f"patch failed: {out.strip()[:500]}")
        brief = task[cfg.get("briefField", "brief")]
        if cfg.get("briefPrefixFile"):  # a checklist or rule block put in front of every brief (one arm = one addition)
            prefix = open(expand(cfg["briefPrefixFile"])).read().rstrip()
            # a rule distilled from this very ticket would hand the reviewer its own answer: drop the
            # lines whose first cited ticket is this one (later citations mean the rule predates the task)
            prefix = "\n".join(l for l in prefix.splitlines() if not born_here(l, task["key"]))
            brief = prefix + "\n\n" + brief
        brief_task = dict(task, prompt=brief)
        prompt = prompt_for_worktree(brief_task, wt)
        cwd = os.path.join(wt, task.get("workdir", "."))
        session_dir = os.path.join(out_dir, "session"); os.makedirs(session_dir, exist_ok=True)
        cfg_run = dict(cfg, appendSystemPrompt=[*(cfg.get("appendSystemPrompt") or []), EVAL_NOTE])
        cmd = pi_command(cfg_run, prompt, session_dir)
        with open(os.path.join(out_dir, "prompt.md"), "w") as fh: fh.write(prompt)
        env = dict(os.environ, PI_CODING_AGENT_DIR=cfg["agentDir"], **(cfg.get("env") or {}))
        started = time.time(); status = "completed"
        import subprocess
        with open(os.path.join(out_dir, "events.jsonl"), "w") as o, open(os.path.join(out_dir, "stderr.txt"), "w") as e, open(os.devnull) as devnull:
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=devnull, stdout=o, stderr=e, env=env)
            try:
                rc = proc.wait(timeout=task.get("timeoutMin", 25) * 60)
            except subprocess.TimeoutExpired:
                proc.kill(); rc = proc.wait(); status = "timeout"
        if status == "completed" and rc != 0: status = "error"
        usage, tools, turns, bash_commands, final_text = metrics_from_events(os.path.join(out_dir, "events.jsonl"))
        flags = cheat_flags(bash_commands, task["key"], wt)
        result = {"task": task["id"], "config": cfg["name"], "repeat": n, "model": cfg.get("model"), "thinking": cfg.get("thinking"), "status": status, "exitCode": rc,
                  "minutes": round((time.time() - started) / 60, 1), "usage": {k: (round(v, 4) if k == "cost" else v) for k, v in usage.items()}, "turns": turns,
                  "toolCalls": tools, "cheatFlags": flags, "reportChars": len(final_text)}
        with open(os.path.join(out_dir, "report.md"), "w") as fh: fh.write(final_text)
        with open(os.path.join(out_dir, "result.json"), "w") as fh: json.dump(result, fh, indent=1)
        print(f"  {name}: {status} · {result['minutes']} min · ${result['usage']['cost']} · {turns} turns · {len(final_text)} chars" + (f" · PEEK {flags}" if flags else ""))
    finally:
        remove_worktree(task, wt)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tasks", required=True); ap.add_argument("--config", action="append", required=True)
    ap.add_argument("--repeats", type=int, default=1); ap.add_argument("--out", default="eval/results-review")
    ap.add_argument("--only", help="comma list of task ids"); ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--per-run-cost", type=float, default=1.3, help="$ estimate per run for the dry-run total")
    a = ap.parse_args()
    tasks = load_tasks(a.tasks, include_drafts=False)
    if a.only: tasks = [t for t in tasks if t["id"] in a.only.split(",")]
    cfgs = [load_config(c) for c in a.config]
    plan = [(t, c, n) for t in tasks for c in cfgs for n in range(1, a.repeats + 1)]
    print(f"{len(tasks)} tasks × {len(cfgs)} configs × {a.repeats} = {len(plan)} runs ≈ ${len(plan) * a.per_run_cost:.0f} at ${a.per_run_cost}/run")
    for c in cfgs: print(f"  config {c['name']}: {c.get('model')}:{c.get('thinking')} tools={c.get('tools')} brief={c.get('briefField', 'brief')} prompt={len(c.get('systemPrompt', ''))} chars")
    if a.dry_run:
        for t in tasks: print(f"  task {t['id']}: base {t['base'][:10]} · {len(t['files'])} files · brief {len(t.get('brief', ''))} chars · truth {len(t.get('ledger_findings', []))} ledger lines")
        return
    os.makedirs(a.out, exist_ok=True)
    for t, c, n in plan: run_one(t, c, n, a.out, a.per_run_cost)


if __name__ == "__main__":
    main()
