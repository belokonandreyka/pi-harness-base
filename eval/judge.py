#!/usr/bin/env python3
"""Grade eval results with an LLM judge from another model family.

    python3 eval/judge.py --results eval/results [--model github-copilot/gpt-6-astra] [--rubric FILE] [--slot NAME] [--force]

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
what it is shown. Use a judge that is not the model under test. When the set
mixes families, `--slot judge-<name>` stores a second judge's verdict beside
the first (`judge-<name>.md` next to `judge.md`) instead of overwriting it.
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
    """Last JSON object in the text; notes may themselves contain braces, so try every `{` as a start."""
    dec = json.JSONDecoder()
    for i in reversed([m.start() for m in re.finditer(r"\{", text)]):
        try:
            obj, _ = dec.raw_decode(text[i:])
        except ValueError:
            continue
        if isinstance(obj, dict) and "pass" in obj:
            return obj
    return None


def test_evidence(result, res_dir, max_lines=30):
    """Hidden / related test outcomes (from hidden_tests.py) with the failing expectations, as extra evidence for the judge."""
    out = []
    for key, label, log in (("hiddenTests", "hidden tests from the reference commit (they encode the reference's design; a failure on a detail the prompt never asked for is reference-only)", "hidden-tests.log"),
                            ("relatedTests", "existing tests that import the changed files (a failure here that the base did not have is a regression)", "related-tests.log")):
        x = result.get(key)
        if not x or x.get("ok") is None:
            continue
        if x.get("error"):
            out.append(f"- {label}: not run ({x['error'][:120]})")
            continue
        line = f"- {label}: {x.get('passed', 0)} passed, {x.get('failed', 0)} failed"
        if x.get("baseline"):
            line += f" (same specs on the untouched base: {x['baseline'].get('failed')} failed)"
        out.append(line)
        if x.get("failed") and os.path.exists(os.path.join(res_dir, log)):
            fails = []
            for ln in open(os.path.join(res_dir, log)):
                ln = ln.rstrip()
                if re.match(r"\s*(Expected|Error:|TypeError|\S+ FAILED$|✗|\[ERROR\])", ln) or " FAILED" in ln:
                    fails.append("    " + ln.strip()[:200])
                if len(fails) >= max_lines:
                    break
            out += fails
    return ("\n" + "\n".join(out)) if out else ""


def judge_one(task, result, res_dir, model, agent_dir, limit, slot="judge", rubric=RUBRIC, rubric_name="v1"):
    with open(os.path.join(res_dir, "candidate.diff")) as fh:
        candidate = fh.read()
    if not candidate.strip():
        return {"correctness": 0, "scope": 0, "conventions": 0, "pass": False, "notes": "empty diff", "model": model, "rubric": rubric_name}
    checks = "\n".join(f"- {c['cmd']}: {'ok' if c['ok'] else 'FAILED'}" for c in result.get("checks") or []) or "- (no checks run)"
    checks += test_evidence(result, res_dir)
    seeded = "\n".join(f"- {rel}" for rel in task.get("seed") or [])
    seed_note = f"\n\n## Files provided to the agent up front (already in place, excluded from both diffs)\n\n{seeded}\n" if seeded else ""
    prompt = (
        f"## Task given to the agent\n\n{task['prompt']}{seed_note}\n\n"
        f"## Reference change (shipped by the engineer)\n\n```diff\n{reference_diff(task, limit)}\n```\n\n"
        f"## Candidate change (produced by the agent)\n\n```diff\n{candidate[:limit]}{'[... truncated ...]' if len(candidate) > limit else ''}\n```\n\n"
        f"## Check results on the candidate\n\n{checks}\n"
    )
    env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir)
    cmd = ["pi", "-p", "--mode", "json", "--no-session", "-ne", "-ns", "-nc", "--no-tools", "--model", model, "--system-prompt", rubric, prompt]
    with open(os.devnull) as devnull:
        r = subprocess.run(cmd, stdin=devnull, capture_output=True, text=True, env=env, timeout=900, check=False)
    text, cost = "", None
    for line in r.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "message_end" and (ev.get("message") or {}).get("role") == "assistant":
            text = "\n".join(b.get("text", "") for b in ev["message"].get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
            c = (ev["message"].get("usage") or {}).get("cost")
            cost = c.get("total") if isinstance(c, dict) else (c if c is not None else cost)
    verdict = last_json_object(text) or {"error": "no JSON in judge output", "raw": text[-500:]}
    verdict["model"] = model
    verdict["rubric"] = rubric_name
    if cost is not None:
        verdict["cost"] = cost
    with open(os.path.join(res_dir, f"{slot}.md"), "w") as fh:
        fh.write(text)
    return verdict


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", default="eval/results")
    ap.add_argument("--tasks", required=True, help="task JSON directory (for prompts and reference commits)")
    ap.add_argument("--model", default="github-copilot/gpt-6-astra")
    ap.add_argument("--agent-dir", default=os.path.expanduser("~/.pi-sub/agent"))
    ap.add_argument("--limit", type=int, default=60000, help="max chars per diff shown to the judge")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", default=None, help="comma-separated task ids")
    ap.add_argument("--config", default=None, help="comma-separated config names (default: all)")
    ap.add_argument("--repeats", default=None, help="comma-separated repeat numbers (default: all)")
    ap.add_argument("--slot", default="judge", help="result.json key to write (default judge; use another name for a second judge)")
    ap.add_argument("--rubric", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "rubrics", "v5-severity-scope.md"),
                    help="rubric file (default rubrics/v5-severity-scope.md; pass '' for the built-in v1 reference rubric)")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    rubric, rubric_name = RUBRIC, "v1"
    if a.rubric:
        with open(a.rubric) as fh:
            rubric = fh.read()
        rubric_name = os.path.splitext(os.path.basename(a.rubric))[0]

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
        if a.config and result["config"] not in a.config.split(","):
            continue
        if a.repeats and str(result["repeat"]) not in a.repeats.split(","):
            continue
        if result.get(a.slot) and not a.force:
            continue
        task = tasks.get(result["task"])
        if not task or result.get("status") == "harness-error":
            continue
        res_dir = os.path.dirname(rp)
        print(f"⚖ {result['task']} · {result['config']} · #{result['repeat']}", flush=True)
        result[a.slot] = judge_one(task, result, res_dir, a.model, os.path.expanduser(a.agent_dir), a.limit, a.slot, rubric, rubric_name)
        with open(rp, "w") as fh:
            json.dump(result, fh, indent=2, ensure_ascii=False)
        j = result[a.slot]
        print(f"  {'pass' if j.get('pass') else 'fail'} · correctness {j.get('correctness')} · scope {j.get('scope')} · conventions {j.get('conventions')} · {j.get('notes', j.get('error', ''))[:80]}", flush=True)
        n += 1
    print(f"judged {n} results")
    return 0


if __name__ == "__main__":
    sys.exit(main())
