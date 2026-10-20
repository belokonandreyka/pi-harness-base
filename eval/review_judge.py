#!/usr/bin/env python3
"""Score a reviewer's report against the findings the original review produced.

For every result directory (from `review_run.py`) without a `judge.json`, a
judge model (no tools, another family or a cheaper model than the one under
test) reads the task's ground-truth findings, the original reviewer's report
for context, and the candidate report, and returns JSON: per truth finding
`found` / `partial` / `missed` / `not-applicable` with the evidence line, plus
the candidate's findings that are not in the truth (`extra`), each judged
plausible or not. Recall is computed by `review_report.py`.

    python3 eval/review_judge.py --results DIR --tasks DIR [--model PROVIDER/MODEL:low] [--all-days] [--force]
"""
import argparse, glob, json, os, re, subprocess, sys

RUBRIC = """You grade a code review report against a list of known findings.

Inputs: the known findings (one line each, numbered; they were written by a human-approved review of the same diff), the original reviewer's report that produced them (context only), and the candidate report to grade.

For every known finding decide:
- "found": the candidate names the same defect at the same place (wording may differ; the file or the mechanism must match);
- "partial": the candidate touches the same place or mechanism but misses the point (e.g. notes the code without the consequence, or the consequence without the place);
- "missed": nothing in the candidate corresponds;
- "not-applicable": the known finding is about code that is not in the diff under review (a later round) — use only when the finding's file or area is plainly absent.
Quote the candidate's sentence as evidence for found/partial.

Then list the candidate's findings that match no known finding (`extra`): a short name, the candidate's class (blocker/suggestion/simplify/nit/question), and `plausible` true when it describes a concrete defect or a concrete smaller shape in the diff, false when it is generic, speculative or contradicts the repository's stated conventions.

Answer with ONE JSON object and nothing else:
{"truth": [{"i": 1, "status": "found|partial|missed|not-applicable", "evidence": "..."}], "extra": [{"finding": "...", "class": "...", "plausible": true}], "notes": "one line"}"""


def last_json_object(text):
    depth, start = 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0: start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try: return json.loads(text[start:i + 1])
                except ValueError: pass
    return None


def truth_lines(task, all_days):
    f = task.get("ledger_findings") or []
    if not f: return []
    day = min(x["date"] for x in f)
    chosen = f if all_days else [x for x in f if x["date"] == day]
    return chosen


def judge_one(task, res_dir, model, agent_dir, all_days):
    report = open(os.path.join(res_dir, "report.md")).read()
    truth = truth_lines(task, all_days)
    if not report.strip(): return {"error": "empty report", "truth": [{"i": i + 1, "status": "missed"} for i in range(len(truth))], "extra": []}
    lines = "\n".join(f"{i + 1}. [{t['category']}] {t['area']} — {t['finding']}" for i, t in enumerate(truth))
    prompt = (f"## Known findings\n\n{lines}\n\n## Original reviewer's report (context only, not graded)\n\n{task.get('reviewer_report', '')[:12000]}\n\n"
              f"## Candidate report to grade\n\n{report[:20000]}\n")
    env = dict(os.environ, PI_CODING_AGENT_DIR=agent_dir)
    cmd = ["pi", "-p", "--mode", "json", "--no-session", "-ne", "-ns", "-nc", "--no-tools", "--model", model, "--system-prompt", RUBRIC, prompt]
    with open(os.devnull) as devnull:
        r = subprocess.run(cmd, stdin=devnull, capture_output=True, text=True, env=env, timeout=900, check=False)
    text, cost = "", None
    for line in r.stdout.splitlines():
        try: ev = json.loads(line)
        except ValueError: continue
        if ev.get("type") == "message_end" and (ev.get("message") or {}).get("role") == "assistant":
            text = "\n".join(b.get("text", "") for b in ev["message"].get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
            c = (ev["message"].get("usage") or {}).get("cost"); cost = c.get("total") if isinstance(c, dict) else cost
    verdict = last_json_object(text) or {"error": "no JSON in judge output", "raw": text[-500:], "truth": [], "extra": []}
    verdict.update({"model": model, "truthCount": len(truth), "truthCategories": [t["category"] for t in truth], "cost": cost})
    with open(os.path.join(res_dir, "judge.md"), "w") as fh: fh.write(text)
    return verdict


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--results", required=True); ap.add_argument("--tasks", required=True)
    ap.add_argument("--model", default="vitu-gateway/claude-sonnet-5:low"); ap.add_argument("--agent-dir", default=os.path.expanduser("~/.pi-sub/agent"))
    ap.add_argument("--all-days", action="store_true", help="grade against every ledger line of the ticket, not only the first review day"); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    tasks = {}
    for p in glob.glob(os.path.join(a.tasks, "*.json")):
        t = json.load(open(p)); tasks[t["id"]] = t
    for res_dir in sorted(glob.glob(os.path.join(a.results, "*"))):
        rp = os.path.join(res_dir, "result.json")
        if not os.path.exists(rp): continue
        if os.path.exists(os.path.join(res_dir, "judge.json")) and not a.force: continue
        result = json.load(open(rp)); task = tasks.get(result["task"])
        if not task: print(f"  {os.path.basename(res_dir)}: no task"); continue
        v = judge_one(task, res_dir, a.model, a.agent_dir, a.all_days)
        json.dump(v, open(os.path.join(res_dir, "judge.json"), "w"), indent=1)
        st = [x.get("status") for x in v.get("truth", [])]
        print(f"  {os.path.basename(res_dir)}: found {st.count('found')} partial {st.count('partial')} missed {st.count('missed')} n/a {st.count('not-applicable')} extra {len(v.get('extra', []))} ${v.get('cost') or 0:.3f}")


if __name__ == "__main__":
    main()
