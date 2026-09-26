#!/usr/bin/env python3
"""Grade eval results with an LLM judge from another model family.

    python3 eval/judge.py --results eval/results [--model github-copilot/gpt-5.6-sol] [--force]

For every `result.json` that has a candidate diff and no `judge` block yet,
the judge gets the task prompt, the reference diff (what actually shipped),
the candidate diff and the check results, and returns a JSON verdict:

    {"correctness": 0-5, "scope": 0-5, "conventions": 0-5, "pass": true|false, "notes": "..."}

- correctness: would this diff satisfy the task the way the reference does
  (functionally, not textually — a different but sound approach scores well)
- scope: did it stay on the task (extra features, refactors, tooling and
  unrelated cleanups cost points; missing parts of the task cost more)
- conventions: does it follow the repository's guides as the reference does
  (patterns, naming, tests where the reference added tests)

Pass means: a reviewer would accept it with at most small follow-ups. The
judge runs through `pi -p` with no tools and no extensions, so it grades only
what it is shown. Use a judge that is not the model under test.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

RUBRIC = """You are grading a code change produced by an AI coding agent against the change a human engineer actually shipped for the same task.

Return ONLY a JSON object on the last line, no prose after it:
{"correctness": 0-5, "scope": 0-5, "conventions": 0-5, "pass": true|false, "notes": "<=60 words"}

Scoring:
- correctness: would the candidate satisfy the task the way the reference does? Judge behaviour, not text: a different but sound approach scores high; a diff that misses part of the task or would break something scores low. 5 = equivalent or better, 3 = mostly right with a real gap, 0 = wrong or empty.
- scope: did it stay on the task? Extra features, refactors, tooling, unrelated cleanups cost points; missing parts of the task cost more. 5 = exactly the task.
- conventions: does it follow the repository's patterns as the reference does (structure, naming, where things live, tests when the reference added tests)?
- pass: true only when a reviewer would accept this diff with at most small follow-ups.
The check results below are evidence, not the verdict: a passing type check with a wrong change is still wrong."""


def sh(args, stdin_text=None, cwd=None, env=None, timeout=600):
    r = subprocess.run(args, input=stdin_text, capture_output=True, text=True, cwd=cwd, env=env, timeout=timeout, check=False)
    return r.returncode, r.stdout, r.stderr


def reference_diff(task, limit):
    repo = os.path.realpath(os.path.expanduser(task["repo"]))
    args = ["git", "-C", repo, "show", "--format=", "--patch", task["reference"]]
    # seeded files were handed to the agent up front and are not in the
    # candidate diff, so they must not count as "missing" against the reference
    if task.get("workdir") or task.get("seed"):
        args += ["--", task.get("workdir") or ".", *[f":(exclude){rel}" for rel in task.get("seed") or []]]
    _, out, _ = sh(args)
    return out[:limit] + ("\n[... truncated ...]" if len(out) > limit else "")


def last_json_object(text):
    for m in reversed(list(re.finditer(r"\{[^{}]*\}", text, re.S))):
        try:
            return json.loads(m.group(0))
        except ValueError:
            continue
    return None


def judge_one(task, result, res_dir, model, agent_dir, limit):
    with open(os.path.join(res_dir, "candidate.diff")) as fh:
        candidate = fh.read()
    if not candidate.strip():
        return {"correctness": 0, "scope": 0, "conventions": 0, "pass": False, "notes": "empty diff", "model": model}
    checks = "\n".join(f"- {c['cmd']}: {'ok' if c['ok'] else 'FAILED'}" for c in result.get("checks") or []) or "- (no checks run)"
    seeded = "\n".join(f"- {rel}" for rel in task.get("seed") or [])
    seed_note = f"\n\n## Files provided to the agent up front (already in place, excluded from both diffs)\n\n{seeded}\n" if seeded else ""
    prompt = (
        f"## Task given to the agent\n\n{task['prompt']}{seed_note}\n\n"
        f"## Reference change (shipped by the engineer)\n\n```diff\n{reference_diff(task, limit)}\n```\n\n"
        f"## Candidate change (produced by the agent)\n\n```diff\n{candidate[:limit]}{'[... truncated ...]' if len(candidate) > limit else ''}\n```\n\n"
        f"## Check results on the candidate\n\n{checks}\n"
    )
    env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir)
    cmd = ["pi", "-p", "--mode", "json", "--no-session", "-ne", "-ns", "-nc", "--no-tools", "--model", model, "--system-prompt", RUBRIC, prompt]
    with open(os.devnull) as devnull:
        r = subprocess.run(cmd, stdin=devnull, capture_output=True, text=True, env=env, timeout=900, check=False)
    text = ""
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "message_end" and (ev.get("message") or {}).get("role") == "assistant":
            text = "\n".join(b.get("text", "") for b in ev["message"].get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
    verdict = last_json_object(text) or {"error": "no JSON in judge output", "raw": text[-500:]}
    verdict["model"] = model
    with open(os.path.join(res_dir, "judge.md"), "w") as fh:
        fh.write(text)
    return verdict


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--tasks", required=True, help="task JSON directory (for prompts and reference commits)")
    ap.add_argument("--model", default="github-copilot/gpt-5.6-sol")
    ap.add_argument("--agent-dir", default=os.path.expanduser("~/.pi-sub/agent"))
    ap.add_argument("--limit", type=int, default=60000, help="max chars per diff shown to the judge")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default=None, help="comma-separated task ids")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None

    tasks = {}
    for p in glob.glob(os.path.join(a.tasks, "*.json")):
        with open(p) as fh:
            t = json.load(fh)
        tasks[t["id"]] = t
    n = 0
    for rp in sorted(glob.glob(os.path.join(a.results, "*", "*", "*", "result.json"))):
        with open(rp) as fh:
            result = json.load(fh)
        if only and result["task"] not in only:
            continue
        if result.get("judge") and not a.force:
            continue
        task = tasks.get(result["task"])
        if not task or result.get("status") == "harness-error":
            continue
        res_dir = os.path.dirname(rp)
        print(f"⚖ {result['task']} · {result['config']} · #{result['repeat']}", flush=True)
        result["judge"] = judge_one(task, result, res_dir, a.model, os.path.expanduser(a.agent_dir), a.limit)
        with open(rp, "w") as fh:
            json.dump(result, fh, indent=2, ensure_ascii=False)
        j = result["judge"]
        print(f"  {'pass' if j.get('pass') else 'fail'} · correctness {j.get('correctness')} · scope {j.get('scope')} · conventions {j.get('conventions')} · {j.get('notes', j.get('error', ''))[:80]}", flush=True)
        n += 1
    print(f"judged {n} results")
    return 0


if __name__ == "__main__":
    sys.exit(main())
