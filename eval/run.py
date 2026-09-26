#!/usr/bin/env python3
"""Run eval tasks through pi non-interactively, one git worktree per run.

    python3 eval/run.py --tasks eval/tasks --config eval/configs/worker.json \
        [--config eval/configs/worker-b.json ...] --repeats 3 --out eval/results

For every task × config × repeat the runner

1. adds a detached git worktree at the task's base commit (a sibling of the
   repository, `<repo>-eval-<task>-<config>-<n>`), symlinks the paths the task
   lists under `link` (node_modules and the like) from the main checkout,
2. runs `pi -p --mode json` in `<worktree>/<workdir>` with the config's profile,
   model, thinking level, system prompt and tools, stdin from /dev/null,
   stdout to `events.jsonl`, and kills it after the task's `timeoutMin`,
3. takes the candidate diff (`git add -A && git diff --cached`), runs the
   task's checks in the workdir (each with its own timeout), scans the tool
   calls for peeks at git history (`git log/show/diff ...` naming the ticket,
   a remote or `--all`: the shipped fix is in the repository's history),
4. writes `result.json` with pass/fail per check, tokens, cost, tool calls by
   name, wall time, expected-file coverage and the cheat flag, then removes the
   worktree (`--keep-worktrees` to inspect).

Only tasks with `"status": "ready"` run; `--include-drafts` overrides.
`--dry-run` prints the plan. Results already present are skipped unless
`--force`. Every run costs real money and quota: check the plan first.

Config JSON:
    {
      "name": "worker-opus55",
      "agentDir": "~/.pi-sub/agent",
      "model": "github-copilot/claude-opus-5.5",
      "thinking": "medium",
      "systemPromptToml": "~/.pi/agents/worker.toml",   # or "systemPrompt": "..."
      "appendSystemPrompt": ["No collaboration bus in this run: ..."],
      "tools": "read,bash,edit,write,lsp_diagnostics,lsp_fix,rg,fd",
      "extraArgs": [],
      "env": {}
    }
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib

KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")
GIT_PEEK_RE = re.compile(r"\bgit\b[^\n|;&]*\b(log|show|reflog|branch|checkout|switch|fetch|stash|diff)\b", re.I)


def expand(p):
    return os.path.realpath(os.path.expanduser(p)) if p else p


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def load_config(path):
    cfg = load_json(path)
    cfg.setdefault("name", os.path.splitext(os.path.basename(path))[0])
    cfg["agentDir"] = expand(cfg.get("agentDir", "~/.pi/agent"))
    if cfg.get("systemPromptToml"):
        with open(expand(cfg["systemPromptToml"]), "rb") as fh:
            toml = tomllib.load(fh)
        cfg["systemPrompt"] = toml.get("prompt", "")
        cfg.setdefault("tools", toml.get("tools"))
        cfg.setdefault("model", toml.get("model"))
        cfg.setdefault("thinking", toml.get("reasoning"))
    return cfg


def load_tasks(spec, include_drafts):
    paths = sorted(glob.glob(os.path.join(spec, "*.json"))) if os.path.isdir(spec) else sorted(glob.glob(spec))
    tasks = []
    for p in paths:
        t = load_json(p)
        if t.get("status") == "ready" or include_drafts:
            t["_path"] = p
            tasks.append(t)
    return tasks


def sh(args, cwd=None, timeout=None, env=None):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env, check=False)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired as e:
        return 124, f"timeout after {timeout}s\n" + ((e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))


def make_worktree(task, name):
    repo = expand(task["repo"])
    wt = f"{repo}-eval-{name}"
    if os.path.exists(wt):
        sh(["git", "-C", repo, "worktree", "remove", "--force", wt])
        shutil.rmtree(wt, ignore_errors=True)
    code, out = sh(["git", "-C", repo, "worktree", "add", "--detach", wt, task["base"]])
    if code != 0:
        raise RuntimeError(f"worktree add failed: {out.strip()}")
    for rel in task.get("link") or []:
        src, dst = os.path.join(repo, rel), os.path.join(wt, rel)
        if os.path.exists(src) and not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(src, dst)
    # state the prompt assumes but the base commit lacks (regenerated contracts
    # the coordinator had staged): taken from the reference commit, kept out of
    # the candidate diff
    if task.get("seed"):
        code, out = sh(["git", "-C", wt, "checkout", task["reference"], "--", *task["seed"]])
        if code != 0:
            raise RuntimeError(f"seed checkout failed: {out.strip()}")
        sh(["git", "-C", wt, "reset", "-q", "--", *task["seed"]])
    return wt


def remove_worktree(task, wt):
    sh(["git", "-C", expand(task["repo"]), "worktree", "remove", "--force", wt])
    shutil.rmtree(wt, ignore_errors=True)


def pi_command(cfg, prompt, session_dir):
    cmd = ["pi", "-p", "--mode", "json", "--session-dir", session_dir]
    if cfg.get("model"):
        model = cfg["model"] + (f":{cfg['thinking']}" if cfg.get("thinking") else "")
        cmd += ["--model", model]
    if cfg.get("systemPrompt"):
        cmd += ["--system-prompt", cfg["systemPrompt"]]
    for extra in cfg.get("appendSystemPrompt") or []:
        cmd += ["--append-system-prompt", extra]
    if cfg.get("tools"):
        cmd += ["--tools", cfg["tools"].replace(" ", "")]
    cmd += cfg.get("extraArgs") or []
    cmd.append(prompt)
    return cmd


def prompt_for_worktree(task, wt):
    """Coordinators write absolute paths to the main checkout into their prompts;
    the run happens in the worktree, so every spelling of the repo path is
    rewritten, otherwise the agent edits the real checkout."""
    prompt = task["prompt"]
    repo = expand(task["repo"])
    home = os.path.expanduser("~")
    for spelling in sorted({task["repo"], repo, repo.replace(home, "~"), repo.replace(home, "$HOME")}, key=len, reverse=True):
        if not spelling:
            continue
        # the repo itself, or a sibling worktree of it (`<repo>-<KEY>`), followed
        # by a path separator or a delimiter — never a longer directory name
        pattern = re.compile(re.escape(spelling) + r"(?:-[A-Za-z0-9_.-]+)?(?=/|[\s`'\")\],.:;]|$)")
        prompt = pattern.sub(wt, prompt)
    return prompt


def run_pi(cfg, task, cwd, out_dir, wt):
    session_dir = os.path.join(out_dir, "session")
    os.makedirs(session_dir, exist_ok=True)
    env = dict(os.environ, PI_CODING_AGENT_DIR=cfg["agentDir"], **(cfg.get("env") or {}))
    prompt = prompt_for_worktree(task, wt)
    with open(os.path.join(out_dir, "prompt.md"), "w") as fh:
        fh.write(prompt)
    cmd = pi_command(cfg, prompt, session_dir)
    with open(os.path.join(out_dir, "command.txt"), "w") as fh:
        fh.write(" ".join(repr(c) if " " in c or "\n" in c else c for c in cmd[:-1]) + " <prompt>\n")
    started = time.time()
    status = "completed"
    with open(os.path.join(out_dir, "events.jsonl"), "w") as out, open(os.path.join(out_dir, "stderr.txt"), "w") as err, open(os.devnull) as devnull:
        proc = subprocess.Popen(cmd, cwd=cwd, stdin=devnull, stdout=out, stderr=err, env=env)
        try:
            code = proc.wait(timeout=task.get("timeoutMin", 20) * 60)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait()
            status = "timeout"
    if status == "completed" and code != 0:
        status = "error"
    return status, code, time.time() - started


def metrics_from_events(path):
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0}
    tools = {}
    turns = 0
    bash_commands = []
    final_text = ""
    with open(path) as fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") != "message_end":
                continue
            msg = ev.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            turns += 1
            u = msg.get("usage") or {}
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                usage[k] += u.get(k) or 0
            usage["cost"] += ((u.get("cost") or {}).get("total")) or 0
            texts = []
            for block in msg.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "toolCall":
                    name = block.get("name") or "?"
                    tools[name] = tools.get(name, 0) + 1
                    if name == "bash":
                        bash_commands.append(str((block.get("arguments") or {}).get("command", "")))
                elif block.get("type") == "text":
                    texts.append(block.get("text", ""))
            if texts:
                final_text = "\n".join(texts)
    return usage, tools, turns, bash_commands, final_text


def cheat_flags(bash_commands, key, wt):
    """`git diff` of the agent's own work is fine; looking at history, remote
    branches or reflog for the ticket is not. The worktree path carries the
    ticket key, so it is stripped before the key is looked for."""
    hits = []
    for c in bash_commands:
        m = GIT_PEEK_RE.search(c)
        if not m:
            continue
        # judge the git clause itself (up to the next |, ;, & or newline), not
        # the rest of a long command line
        clause_end = min([i for i in (c.find(ch, m.start()) for ch in "|;&\n") if i != -1] or [len(c)])
        bare = c[m.start():clause_end].replace(wt, "<wt>")
        verb = m.group(1).lower()
        # history before the base commit is legitimate context; the shipped fix
        # is only reachable through the key, a remote ref, --all or the reflog
        suspicious = "origin/" in bare or "--all" in bare or "@{" in bare or (verb != "diff" and key in bare)
        if verb in ("reflog", "fetch") or suspicious:
            hits.append(c.strip()[:160])
    return hits


def candidate_diff(wt, excluded):
    # the symlinked node_modules shows up as untracked when .gitignore names it
    # with a trailing slash (a directory pattern does not match a symlink);
    # seeded files are the task's premise, not the candidate's work
    excludes = [f":(exclude){rel}" for rel in excluded or []]
    sh(["git", "-C", wt, "add", "-A", "--", ".", *excludes])
    _, diff = sh(["git", "-C", wt, "diff", "--cached", "--binary"])
    _, names = sh(["git", "-C", wt, "diff", "--cached", "--name-only"])
    files = [f for f in names.splitlines() if f]
    return diff, files


def run_checks(task, cwd):
    results = []
    for check in task.get("checks") or []:
        cmd = check if isinstance(check, str) else check["cmd"]
        timeout = (check.get("timeoutMin", 15) if isinstance(check, dict) else 15) * 60
        started = time.time()
        code, out = sh(["bash", "-lc", cmd], cwd=cwd, timeout=timeout)
        results.append({"cmd": cmd, "ok": code == 0, "code": code, "seconds": round(time.time() - started), "tail": out[-3000:]})
    return results


def one_run(task, cfg, n, out_root, keep):
    name = f"{task['id']}-{cfg['name']}-{n}"
    out_dir = os.path.join(out_root, task["id"], cfg["name"], str(n))
    os.makedirs(out_dir, exist_ok=True)
    key = (KEY_RE.search(task["id"]) or KEY_RE.search(task["prompt"]) or [None])
    key = key.group(0) if hasattr(key, "group") else task["id"]
    print(f"▶ {name}", flush=True)
    wt = make_worktree(task, name)
    cwd = os.path.join(wt, task.get("workdir") or "")
    result = {"task": task["id"], "config": cfg["name"], "repeat": n, "model": cfg.get("model"), "thinking": cfg.get("thinking"),
              "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    try:
        status, code, seconds = run_pi(cfg, task, cwd, out_dir, wt)
        usage, tools, turns, bash_commands, final_text = metrics_from_events(os.path.join(out_dir, "events.jsonl"))
        diff, files = candidate_diff(wt, (task.get("link") or []) + (task.get("seed") or []))
        with open(os.path.join(out_dir, "candidate.diff"), "w") as fh:
            fh.write(diff)
        with open(os.path.join(out_dir, "final.md"), "w") as fh:
            fh.write(final_text)
        expected = [f for f in task.get("expectFiles") or []]
        touched_expected = [f for f in expected if f in files]
        checks = run_checks(task, cwd) if diff.strip() else [{"cmd": c if isinstance(c, str) else c["cmd"], "ok": False, "code": -1, "seconds": 0, "tail": "no diff produced"} for c in task.get("checks") or []]
        result.update({
            "status": status, "exitCode": code, "minutes": round(seconds / 60, 2),
            "usage": {k: (round(v, 4) if k == "cost" else v) for k, v in usage.items()},
            "turns": turns, "toolCalls": tools, "toolCallsTotal": sum(tools.values()),
            "changedFiles": files, "expectedFiles": expected, "expectedCoverage": round(len(touched_expected) / len(expected), 2) if expected else None,
            "checks": checks, "checksPassed": all(c["ok"] for c in checks) if checks else None,
            "gitPeeks": cheat_flags(bash_commands, key, wt),
        })
    except Exception as e:  # noqa: BLE001 — one broken run must not stop the matrix
        result.update({"status": "harness-error", "error": str(e)})
    finally:
        if not keep:
            remove_worktree(task, wt)
        else:
            result["worktree"] = wt
    with open(os.path.join(out_dir, "result.json"), "w") as fh:
        json.dump(result, fh, indent=2, ensure_ascii=False)
    checks_s = "-" if result.get("checksPassed") is None else ("pass" if result["checksPassed"] else "FAIL")
    print(f"  {result.get('status')} · {result.get('minutes', '?')} min · ${result.get('usage', {}).get('cost', 0)} · {result.get('toolCallsTotal', 0)} tool calls · checks {checks_s}"
          + (f" · GIT PEEK {len(result['gitPeeks'])}" if result.get("gitPeeks") else ""), flush=True)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tasks", required=True, help="task JSON directory or glob")
    ap.add_argument("--config", action="append", required=True, help="config JSON (repeatable)")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--out", default="eval/results")
    ap.add_argument("--include-drafts", action="store_true")
    ap.add_argument("--only", default=None, help="comma-separated task ids")
    ap.add_argument("--no-checks", action="store_true", help="skip the checks (plumbing smoke)")
    ap.add_argument("--keep-worktrees", action="store_true")
    ap.add_argument("--force", action="store_true", help="rerun even when result.json exists")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    tasks = load_tasks(a.tasks, a.include_drafts)
    if a.only:
        wanted = set(a.only.split(","))
        tasks = [t for t in tasks if t["id"] in wanted]
    if a.no_checks:
        for t in tasks:
            t["checks"] = []
    configs = [load_config(c) for c in a.config]
    plan = [(t, c, n) for t in tasks for c in configs for n in range(1, a.repeats + 1)]
    if not plan:
        print("nothing to run (no ready tasks? --include-drafts, --only)", file=sys.stderr)
        return 1
    print(f"{len(plan)} runs: {len(tasks)} tasks × {len(configs)} configs × {a.repeats} repeats → {a.out}")
    for t, c, n in plan:
        print(f"  {t['id']} · {c['name']} ({c.get('model')}:{c.get('thinking')}) · #{n} · base {t['base'][:10]} · {len(t.get('checks') or [])} checks · {t.get('timeoutMin', 20)} min cap")
    if a.dry_run:
        return 0
    done = 0
    for t, c, n in plan:
        rp = os.path.join(a.out, t["id"], c["name"], str(n), "result.json")
        if os.path.exists(rp) and not a.force:
            print(f"= {t['id']}-{c['name']}-{n} (result exists)")
            continue
        one_run(t, c, n, a.out, a.keep_worktrees)
        done += 1
    print(f"done: {done} runs · report: python3 eval/report.py --results {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
