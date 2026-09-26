#!/usr/bin/env python3
"""Draft eval tasks from the collaborating-agents run records.

Every implementation run a coordinator ever delegated is a candidate task: the
full prompt is the first user message of the subagent's session file, the
repository state is the parent of the commit that shipped the work, and that
commit is the reference the candidate diff is judged against.

    python3 eval/extract.py --repo ~/work/app --out eval/tasks

writes one `<KEY>-<run>.json` per usable run with `"status": "draft"`. A draft
is not runnable until a human has looked at it: the prompt may assume state
that is not in the base commit (staged contracts, an env var, a running
service), the reference commit may be the wrong one when a ticket had several
rounds, and the checks are a template. Flip `status` to `ready` after that.

Reference commit rule: the first non-merge commit mentioning the ticket key,
on any branch, committed after the run started. A run that ends without such
a commit is skipped and listed at the end.
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys

KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")
ACTION_RE = re.compile(r"^\s*(implement|finish|fix|apply|add|update|task:|ticket|build|write|refactor)", re.I)
PARENT_LINE_RE = re.compile(r"^Parent agent: \S+\s*\n+", re.I)


def parse_ts(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=False).stdout


def first_user_message(session_file):
    with open(session_file) as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("type") != "message" or row.get("message", {}).get("role") != "user":
                continue
            content = row["message"].get("content")
            if isinstance(content, str):
                return content
            return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def reference_commit(repo, key, started):
    """First non-merge commit naming the key on any branch after the run started."""
    out = git(repo, "log", "--all", "--no-merges", f"--grep={key}", "--format=%H %P %ct %s", "--reverse")
    exact = re.compile(rf"(?<![A-Z0-9-]){re.escape(key)}(?![0-9])")
    for line in out.splitlines():
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        sha, parents, ctime, subject = parts
        if not exact.search(subject):
            continue
        when = dt.datetime.fromtimestamp(int(ctime), dt.timezone.utc)
        if when > started:
            return sha, parents.split()[0] if parents else None, subject
    return None, None, None


def changed_files(repo, sha):
    return [f for f in git(repo, "show", "--format=", "--name-only", sha).splitlines() if f]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    default_runs = os.path.join(os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent")), "collaborating-agents", "runs")
    ap.add_argument("--runs-dir", default=default_runs)
    ap.add_argument("--repo", required=True, help="repository the runs worked in (cwd prefix match)")
    ap.add_argument("--out", required=True, help="directory for task JSON files")
    ap.add_argument("--since", type=int, default=60, help="days back (default 60)")
    ap.add_argument("--checks", default=None, help="JSON file with the check template: {\"checks\": [...], \"timeoutMin\": N, \"link\": [...]} ")
    ap.add_argument("--types", default="worker", help="comma-separated subagent types to consider")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()

    repo = os.path.realpath(os.path.expanduser(a.repo))
    template = {"checks": [], "timeoutMin": 20, "link": []}
    if a.checks:
        with open(a.checks) as fh:
            template.update(json.load(fh))
    os.makedirs(a.out, exist_ok=True)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.since)
    types = set(a.types.split(","))

    written, skipped = [], []
    for path in sorted(glob.glob(os.path.join(a.runs_dir, "*.json"))):
        try:
            with open(path) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if rec.get("type") not in types or rec.get("status") != "completed":
            continue
        started = parse_ts(rec.get("startedAt"))
        if not started or started < cutoff:
            continue
        cwd = os.path.realpath(rec.get("cwd") or "")
        if not cwd.startswith(repo):
            continue
        preview = rec.get("taskPreview") or ""
        if not ACTION_RE.search(preview):
            continue
        m = KEY_RE.search(preview) or KEY_RE.search(cwd)
        if not m:
            continue
        key = m.group(0)
        session_file = rec.get("sessionFile") or ""
        if not os.path.exists(session_file):
            skipped.append((key, rec["recordId"], "session file missing"))
            continue
        prompt = PARENT_LINE_RE.sub("", first_user_message(session_file)).strip()
        if len(prompt) < 200:
            skipped.append((key, rec["recordId"], "prompt too short"))
            continue
        ref, base, subject = reference_commit(repo, key, started)
        if not ref:
            skipped.append((key, rec["recordId"], "no commit with the key after the run"))
            continue
        task_id = f"{key}-{rec['recordId'][:8]}"
        out_path = os.path.join(a.out, f"{task_id}.json")
        if os.path.exists(out_path) and not a.overwrite:
            continue
        workdir = os.path.relpath(cwd, repo)
        files = changed_files(repo, ref)
        task = {
            "id": task_id,
            "status": "draft",
            "repo": repo,
            "workdir": "" if workdir == "." else workdir,
            "base": base,
            "reference": ref,
            "referenceSubject": subject,
            "prompt": prompt,
            "expectFiles": files,
            "checks": template["checks"],
            "link": template["link"],
            "timeoutMin": template["timeoutMin"],
            "source": {"recordId": rec["recordId"], "startedAt": rec.get("startedAt"), "model": rec.get("model"), "sessionFile": session_file},
            "notes": "DRAFT — check that the base commit carries everything the prompt assumes, that the reference commit is the right round, and that the checks fit; then set status to ready.",
        }
        with open(out_path, "w") as fh:
            json.dump(task, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        written.append(task_id)

    print(f"{len(written)} drafts written to {a.out}")
    for t in written:
        print(f"  {t}")
    if skipped:
        print(f"{len(skipped)} runs skipped:")
        for key, rid, why in skipped:
            print(f"  {key} {rid}: {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
