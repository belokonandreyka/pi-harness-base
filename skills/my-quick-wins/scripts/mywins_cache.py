#!/usr/bin/env python3
"""Day-to-day cache for the my-quick-wins skill.

The scout subagent is the expensive part of "plan my day" (about $0.5 per
ticket on Opus). Most of the backlog does not change between two mornings, so
this script decides which tickets actually need a fresh scout and keeps the
verdicts of the rest.

Subcommands
  plan   compare today's Jira snapshot (+ git, + Jenkins deploy comments) with
         the cache and print which tickets to re-scout and why, plus a
         "what changed since last run" digest
  store  save scout verdicts and the seen-state snapshot for the next run

Only the standard library is used. Nothing here writes to Jira or to git
(the optional --fetch runs `git fetch`, which touches remote-tracking refs
only).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CACHE_VERSION = 1

# ---------------------------------------------------------------- config
#
# Everything site-specific comes from <agent-dir>/my-quick-wins.json (agent dir =
# $PI_CODING_AGENT_DIR or ~/.pi/agent); see config.example.json next to the
# skill. CLI flags override the file; the file overrides these defaults.

def agent_dir() -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or (Path.home() / ".pi/agent")).expanduser()


DEFAULTS: dict = {
    "jiraSite": "",                 # <site>.atlassian.net — used by the skill, not the script
    "filterId": 0,                  # the personal Jira filter — used by the skill
    "reposRoot": "~/work",          # parent directory of every repo the scout may point at
    "primaryRepos": [],             # repos always checked for "<KEY>" commits and origin/<KEY> branches
    "integrationRefs": ["origin/test", "origin/develop", "origin/master", "origin/main"],
    "skipPrefixes": [],             # project keys that never hold code (time tracking, ops)
    "skipKeys": [],                 # tickets pinned out of the triage
    "serviceEmails": [],            # CI accounts whose comments are deploy signals, not human
    "serviceNames": ["jenkins"],
    # A change under these paths means the scout's judgement rules changed: every verdict is stale.
    "rulesPaths": {},               # {"<repo>": ["AGENTS.md", "docs"]}
    "contextFiles": [],             # what the scout reads first — used by the skill
    "maxAgeDays": 7,
    "language": "en",               # "en" | "uk" — the script's own messages
    "cache": "",                    # default: <agent-dir>/state/my-quick-wins/cache.json
}
CFG: dict = dict(DEFAULTS)


def configure(**overrides) -> dict:
    """Reset to defaults, then apply overrides (used by main() and tests)."""
    CFG.clear()
    CFG.update(DEFAULTS)
    CFG.update({k: v for k, v in overrides.items() if v is not None})
    return CFG


def load_config(path: Path | None) -> dict:
    p = path or (agent_dir() / "my-quick-wins.json")
    if not p.exists():
        return {}
    data = json.loads(p.read_text())
    unknown = set(data) - set(DEFAULTS)
    if unknown:
        print(f"warning: unknown keys in {p}: {', '.join(sorted(unknown))}", file=sys.stderr)
    return {k: v for k, v in data.items() if k in DEFAULTS}


def cache_path() -> Path:
    return Path(CFG["cache"]).expanduser() if CFG["cache"] else agent_dir() / "state/my-quick-wins/cache.json"


def repos_root() -> Path:
    return Path(CFG["reposRoot"]).expanduser()


TERMINAL_STATUSES = {"resolved", "closed", "done"}
KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
# Bitbucket Cloud and GitHub commit links inside a CI "Changes" list
COMMIT_URL_RE = re.compile(r"(?:bitbucket\.org/[^/]+/([^/]+)/commits/|github\.com/[^/]+/([^/]+)/commit/)([0-9a-f]{7,40})")
HUMAN_COMMENTS_IN_FP = 5


# ---------------------------------------------------------------- helpers

def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def sha(obj) -> str:
    data = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()[:16]


def adf_text(node) -> str:
    """Flatten an Atlassian Document Format node into plain text."""
    out: list[str] = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text":
                out.append(n.get("text", ""))
            elif n.get("type") in ("hardBreak", "paragraph"):
                out.append("\n")
            for c in n.get("content") or []:
                walk(c)
        elif isinstance(n, list):
            for c in n:
                walk(c)

    walk(node)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def adf_links(node) -> list[tuple[str, str]]:
    """(text, href) for every link mark in an ADF node."""
    out: list[tuple[str, str]] = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text":
                for m in n.get("marks") or []:
                    if m.get("type") == "link":
                        out.append((n.get("text", ""), (m.get("attrs") or {}).get("href", "")))
            for c in n.get("content") or []:
                walk(c)
        elif isinstance(n, list):
            for c in n:
                walk(c)

    walk(node)
    return out


def is_service_comment(comment: dict) -> bool:
    a = comment.get("author") or {}
    if (a.get("emailAddress") or "").lower() in {e.lower() for e in CFG["serviceEmails"]}:
        return True
    if (a.get("displayName") or "").strip().lower() in {n.lower() for n in CFG["serviceNames"]}:
        return True
    return False


def parse_deploy(comment: dict) -> dict | None:
    """Jenkins writes ':blue_square: <job>/<env> [deployed to <env>](build)'
    followed by an expandable 'Changes' list of commits linked to Bitbucket."""
    body = comment.get("body")
    text = adf_text(body)
    m = re.search(r"deployed to (\w+)", text)
    if not m:
        return None
    env = m.group(1)
    job = text[: m.start()].strip(": ").strip()
    build_url = ""
    commits = []
    for link_text, href in adf_links(body):
        if "deployed to" in link_text and not build_url:
            build_url = href
        cm = COMMIT_URL_RE.search(href)
        if cm:
            commits.append({
                "repo": cm.group(1) or cm.group(2),
                "sha": cm.group(3),
                "subject": link_text.strip(),
                "keys": sorted(set(KEY_RE.findall(link_text))),
            })
    if not build_url:
        return None  # a human writing "deployed to test" is not a Jenkins build
    repo = commits[0]["repo"] if commits else (job.split("/")[-2] if "/" in job else job)
    return {
        "id": str(comment.get("id")),
        "created": comment.get("created", ""),
        "env": env,
        "job": job,
        "repo": repo,
        "build": build_url,
        "commits": commits,
    }


def blockers_of(issue: dict) -> list[list[str]]:
    """[key, status] of every ticket this one is blocked by (inward '02 Blocks')."""
    out = []
    for link in (issue.get("fields") or {}).get("issuelinks") or []:
        name = ((link.get("type") or {}).get("name") or "").lower()
        inward = link.get("inwardIssue")
        if "block" in name and inward:
            st = ((inward.get("fields") or {}).get("status") or {}).get("name") or ""
            out.append([inward.get("key"), st])
    return sorted(out)


def links_of(issue: dict) -> list[list[str]]:
    """[key, status] of every linked ticket, whatever the link type or direction.
    A '01 Relates' Portal/Retail task that gets Resolved is exactly the signal
    that lifts a "no endpoint" verdict."""
    out = []
    for link in (issue.get("fields") or {}).get("issuelinks") or []:
        other = link.get("inwardIssue") or link.get("outwardIssue")
        if other and other.get("key"):
            st = ((other.get("fields") or {}).get("status") or {}).get("name") or ""
            out.append([other["key"], st])
    return sorted(out)


def sprint_of(issue: dict) -> str:
    sprints = (issue.get("fields") or {}).get("customfield_10007") or []
    if not isinstance(sprints, list):
        return ""
    active = [s.get("name") for s in sprints if isinstance(s, dict) and s.get("state") == "active"]
    if active:
        return active[0]
    names = [s.get("name") for s in sprints if isinstance(s, dict) and s.get("name")]
    return names[-1] if names else ""


def snapshot(issue: dict, comments: list[dict]) -> dict:
    """Everything about a ticket that the plan compares, split into named parts
    so a changed fingerprint can say what changed."""
    f = issue.get("fields") or {}
    humans = [c for c in comments if not is_service_comment(c)]
    humans.sort(key=lambda c: c.get("created", ""))
    deploys = [d for d in (parse_deploy(c) for c in comments if is_service_comment(c)) if d]
    parts = {
        "summary": sha(f.get("summary") or ""),
        "description": sha(adf_text(f.get("description"))),
        "status": (f.get("status") or {}).get("name") or "",
        "blockers": blockers_of(issue),
        "links": links_of(issue),
        "comments": [str(c.get("id")) for c in humans[-HUMAN_COMMENTS_IN_FP:]],
    }
    return {
        "fp": sha(parts),
        "fpParts": parts,
        "seen": {
            "status": parts["status"],
            "sprint": sprint_of(issue),
            "priority": (f.get("priority") or {}).get("name") or "",
            "summary": f.get("summary") or "",
            "humanCommentIds": [str(c.get("id")) for c in humans],
            "blockers": parts["blockers"],
            "links": parts["links"],
            "deployBuilds": sorted({d["build"] for d in deploys}),
        },
        "deploys": deploys,
    }


# ---------------------------------------------------------------- inputs

def load_issues(path: Path) -> dict[str, dict]:
    data = json.loads(path.read_text())
    issues = data.get("issues") if isinstance(data, dict) else data
    return {i["key"]: i for i in issues}


def load_comments(comments_dir: Path, key: str) -> list[dict]:
    p = comments_dir / f"{key}.comments.json"
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    return data.get("comments", data) if isinstance(data, dict) else data


def load_cache(path: Path) -> dict:
    if path.exists():
        c = json.loads(path.read_text())
        if c.get("version") == CACHE_VERSION:
            return c
    return {"version": CACHE_VERSION, "tickets": {}, "repoHeads": {}, "rulesHash": {}, "deployCommits": {}}


def save_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cache["updatedAt"] = now_iso()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True))
    os.replace(tmp, path)


def skip_reason(key: str, prefixes, keys) -> str | None:
    if key in keys:
        return "stale-pinned"
    for p in prefixes:
        if key.startswith(p + "-"):
            return p
    return None


# ---------------------------------------------------------------- git

class Repo:
    def __init__(self, name: str, root: Path):
        self.name = name
        self.path = root / name
        self.ok = (self.path / ".git").exists() or (self.path / "HEAD").exists()
        self.ref = self._pick_ref() if self.ok else ""

    def git(self, *args: str) -> str:
        try:
            r = subprocess.run(["git", "-C", str(self.path), *args], capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return r.stdout.strip() if r.returncode == 0 else ""

    def _pick_ref(self) -> str:
        for ref in CFG["integrationRefs"]:
            if self.git("rev-parse", "--verify", "-q", ref):
                return ref
        return ""

    def fetch(self) -> None:
        if self.ok:
            subprocess.run(["git", "-C", str(self.path), "fetch", "-q", "--prune", "origin"],
                           capture_output=True, timeout=300)
            self.ref = self._pick_ref()

    def head(self) -> str:
        return self.git("rev-parse", self.ref) if self.ref else ""

    def branch_tip(self, key: str) -> str:
        return self.git("rev-parse", "--verify", "-q", f"origin/{key}")

    def commits_mentioning(self, key: str, old: str, new: str) -> int:
        # POSIX ERE: git's --grep has no \b, so spell the boundary out
        out = self.git("log", "--format=%H", "-E", f"--grep=(^|[^A-Za-z0-9]){key}([^0-9]|$)", f"{old}..{new}")
        return len(out.splitlines()) if out else 0

    def commits_touching(self, paths: list[str], old: str, new: str) -> int:
        if not paths:
            return 0
        out = self.git("log", "--format=%H", f"{old}..{new}", "--", *paths)
        return len(out.splitlines()) if out else 0

    def rules_hash(self, paths: list[str]) -> str:
        if not self.ref:
            return ""
        return self.git("log", "-1", "--format=%H", self.ref, "--", *paths)


def parse_paths(line: str) -> dict[str, list[str]]:
    """'web-app: src/app/A, src/app/B; pay-sdk: src/X'"""
    out: dict[str, list[str]] = {}
    for chunk in re.split(r"\s*;\s*", line.strip()):
        if ":" not in chunk:
            continue
        repo, rest = chunk.split(":", 1)
        repo = repo.strip().strip("`")
        paths = [p.strip().strip("`") for p in re.split(r"\s*,\s*", rest) if p.strip().strip("`")]
        if repo and paths:
            out.setdefault(repo, []).extend(paths)
    return out


# ---------------------------------------------------------------- plan

def build_plan(issues: dict[str, dict], comments_by_key: dict[str, list[dict]], cache: dict,
               repos_root: Path, *, max_age_days: int, fresh: bool, fetch: bool,
               skip_prefixes=None, skip_keys=None,
               now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    skip_prefixes = tuple(CFG["skipPrefixes"] if skip_prefixes is None else skip_prefixes)
    skip_keys = tuple(CFG["skipKeys"] if skip_keys is None else skip_keys)
    cached = cache.get("tickets", {})
    snaps = {k: snapshot(i, comments_by_key.get(k, [])) for k, i in issues.items()}

    skipped: dict[str, str] = {}
    working: list[str] = []
    for k in issues:
        r = skip_reason(k, skip_prefixes, skip_keys)
        if r:
            skipped[k] = r
        else:
            working.append(k)

    # repos: every repo any cached verdict points at, plus the primary ones for the key/branch checks
    repo_names = set(CFG["primaryRepos"])
    for t in cached.values():
        repo_names.update((t.get("fields") or {}).get("paths", {}).keys())
    repos = {n: Repo(n, repos_root) for n in sorted(repo_names)}
    if fetch:
        for r in repos.values():
            r.fetch()
    heads = {n: {"ref": r.ref, "sha": r.head()} for n, r in repos.items() if r.ok and r.ref}
    ranges = {}
    for n, h in heads.items():
        old = (cache.get("repoHeads") or {}).get(n, {}).get("sha")
        if old and old != h["sha"]:
            ranges[n] = (old, h["sha"])

    rules_hash = {n: repos[n].rules_hash(p) for n, p in CFG["rulesPaths"].items() if n in repos and repos[n].ok}
    rules_changed = bool(cache.get("rulesHash")) and any(
        cache["rulesHash"].get(n) and cache["rulesHash"][n] != h for n, h in rules_hash.items())

    # deploy commits seen in any Jenkins comment across the backlog, grouped by repo
    seen_deploy = {r: set(v) for r, v in (cache.get("deployCommits") or {}).items()}
    new_deploy_commits: dict[str, list[dict]] = {}
    for k in working:
        for d in snaps[k]["deploys"]:
            for c in d["commits"]:
                if c["sha"] not in seen_deploy.get(c["repo"], set()):
                    new_deploy_commits.setdefault(c["repo"], []).append({**c, "env": d["env"], "via": k})
    keys_in_new_deploys = {key for cs in new_deploy_commits.values() for c in cs for key in c["keys"]}

    tickets = {}
    changes = {"new": [], "gone": [], "status": [], "sprint": [], "comments": [], "blockersClosed": [],
               "linksResolved": [], "deploys": [], "branches": []}
    for k in working:
        snap = snaps[k]
        prev = cached.get(k)
        reasons: list[str] = []
        detail: dict = {"scoutedAt": None, "block": None, "fields": None}
        if not prev:
            reasons.append("new")
            changes["new"].append(k)
        else:
            detail = {"scoutedAt": prev.get("scoutedAt"), "block": prev.get("block"), "fields": prev.get("fields")}
            if not prev.get("block"):
                reasons.append("no-verdict")
            for part, val in snap["fpParts"].items():
                prev_parts = prev.get("fpParts") or {}
                if part not in prev_parts:
                    reasons.append(f"cache-upgrade:{part}")  # older cache never tracked this part
                elif prev_parts[part] != val:
                    reasons.append(f"jira:{part}")
            if prev.get("scoutedAt"):
                age = (now - parse_iso(prev["scoutedAt"])).days
                if age > max_age_days:
                    reasons.append(f"stale:{age}d")
            ps = prev.get("seen") or {}
            if ps.get("status") and ps["status"] != snap["seen"]["status"]:
                changes["status"].append(f"{k}: {ps['status']} → {snap['seen']['status']}")
            if ps.get("sprint") != snap["seen"]["sprint"] and (ps.get("sprint") or snap["seen"]["sprint"]):
                changes["sprint"].append(f"{k}: {ps.get('sprint') or '—'} → {snap['seen']['sprint'] or '—'}")
            new_comments = [c for c in snap["seen"]["humanCommentIds"] if c not in set(ps.get("humanCommentIds") or [])]
            if new_comments:
                changes["comments"].append(f"{k}: +{len(new_comments)}")
            prev_block = {b[0]: b[1] for b in ps.get("blockers") or []}
            for bk, bst in snap["seen"]["blockers"]:
                if bk in prev_block and prev_block[bk].lower() not in TERMINAL_STATUSES and bst.lower() in TERMINAL_STATUSES:
                    changes["blockersClosed"].append(f"{k}: {bk} → {bst}")
            prev_links = {l[0]: l[1] for l in ps.get("links") or []}
            for lk, lst in snap["seen"]["links"]:
                if lk in prev_links and prev_links[lk].lower() not in TERMINAL_STATUSES and lst.lower() in TERMINAL_STATUSES:
                    changes["linksResolved"].append(f"{k}: {lk} → {lst}")
            new_builds = [b for b in snap["seen"]["deployBuilds"] if b not in set(ps.get("deployBuilds") or [])]
            for d in snap["deploys"]:
                if d["build"] in new_builds:
                    reasons.append(f"deploy:{d['repo']}/{d['env']}")
                    changes["deploys"].append(f"{k}: {d['repo']} → {d['env']}")
        if fresh:
            reasons.append("fresh")
        if rules_changed:
            reasons.append("rules-changed")
        blocked_by = [bk for bk, bst in snap["seen"]["blockers"] if bst.lower() not in TERMINAL_STATUSES]

        paths = ((prev or {}).get("fields") or {}).get("paths") or {}
        tips = {}
        for n, r in repos.items():
            if not r.ok:
                continue
            tip = r.branch_tip(k)
            if tip:
                tips[n] = tip
            prev_tip = (((prev or {}).get("seen") or {}).get("branchTips") or {}).get(n)
            if tip and tip != prev_tip and prev:
                reasons.append(f"git:branch origin/{k} {'new' if not prev_tip else 'moved'} in {n}")
                changes["branches"].append(S()["branchMoved" if prev_tip else "branchNew"].format(k=k, repo=n))
            if n in ranges and prev:
                old, new = ranges[n]
                c = r.commits_mentioning(k, old, new)
                if c:
                    reasons.append(f"git:{c} commit(s) mention {k} in {n}")
                # backend work lands under the linked task's key, not this one's
                for lk, _ in snap["seen"]["links"]:
                    lc = r.commits_mentioning(lk, old, new)
                    if lc:
                        reasons.append(f"git:{lc} commit(s) mention linked {lk} in {n}")
                t = r.commits_touching(paths.get(n) or [], old, new)
                if t:
                    reasons.append(f"git:{t} commit(s) touch scout paths in {n}")
        snap["seen"]["branchTips"] = tips
        # a Jenkins build on any backlog ticket lists every commit it shipped for
        # that service; if this ticket's scope lives in that service, its
        # verdict was made against older code (deploys may come from branches
        # the local git range never sees, so this is checked regardless of git)
        for repo_name in new_deploy_commits:
            if repo_name in paths and prev:
                reasons.append(f"service-deploy:{repo_name}")
        if k in keys_in_new_deploys and prev and not any(x.startswith("deploy:") for x in reasons):
            reasons.append("deploy:mentioned in another ticket's build")

        reasons = list(dict.fromkeys(reasons))
        tickets[k] = {
            # blocked tickets are reported, never scouted: the blocker triage
            # rule of the skill; when the blocker closes, jira:blockers fires
            "rescout": bool(reasons) and not blocked_by,
            "reasons": reasons,
            "blockedBy": blocked_by,
            "summary": snap["seen"]["summary"],
            "status": snap["seen"]["status"],
            "sprint": snap["seen"]["sprint"],
            "priority": snap["seen"]["priority"],
            **detail,
        }
    for k in cached:
        if k not in issues:
            changes["gone"].append(k)

    return {
        "generatedAt": now_iso(),
        "tickets": tickets,
        "rescout": [k for k, t in tickets.items() if t["rescout"]],
        "keep": [k for k, t in tickets.items() if not t["rescout"]],
        "skipped": skipped,
        "changes": changes,
        "rulesChanged": rules_changed,
        "repoHeads": heads,
        "repoRanges": {n: {"from": o, "to": nw} for n, (o, nw) in ranges.items()},
        "newDeployCommits": new_deploy_commits,
        "firstRun": not cached,
    }


STRINGS = {
    "en": {
        "summary": "Cache: {keep} unchanged · {rescout} to re-scout · skipped {skipped}",
        "firstRun": " · first run",
        "rules": "⚠ rules files changed — every verdict goes back to the scout",
        "blocked": "  ⛔ {k} — BLOCKED by {by} (not scouted)",
        "kept": "  = {k} — scouted {date}",
        "changes": "Changed since the last run:",
        "service": "  service {repo}: {n} new commit(s) deployed to {envs}",
        "branchNew": "{k}: origin/{k} appeared in {repo}",
        "branchMoved": "{k}: origin/{k} moved in {repo}",
        "stored": "Stored verdicts: {n} ({keys}); tickets in cache: {total}",
        "unmatched": "; not in the filter, ignored: {keys}",
        "labels": [("new", "new"), ("gone", "left the filter"), ("status", "status"), ("sprint", "sprint"),
                   ("comments", "new comments"), ("blockersClosed", "blockers closed"),
                   ("linksResolved", "linked tickets resolved"), ("deploys", "deploys"), ("branches", "branches")],
    },
    "uk": {
        "summary": "Кеш: {keep} без змін · {rescout} на перескаут · пропущено {skipped}",
        "firstRun": " · перший прогін",
        "rules": "⚠ файли правил змінились — усі вердикти перескаутити",
        "blocked": "  ⛔ {k} — BLOCKED by {by} (не скаутимо)",
        "kept": "  = {k} — скаут {date}",
        "changes": "Що змінилось з минулого прогону:",
        "service": "  сервіс {repo}: {n} нових комітів задеплоєно на {envs}",
        "branchNew": "{k}: origin/{k} у {repo} з’явилась",
        "branchMoved": "{k}: origin/{k} у {repo} оновилась",
        "stored": "Збережено вердикти: {n} ({keys}); тікетів у кеші: {total}",
        "unmatched": "; не з фільтра, проігноровано: {keys}",
        "labels": [("new", "нові"), ("gone", "зникли з фільтра"), ("status", "статус"), ("sprint", "спринт"),
                   ("comments", "нові коментарі"), ("blockersClosed", "блокери закрито"),
                   ("linksResolved", "повʼязані закрито"), ("deploys", "деплої"), ("branches", "гілки")],
    },
}


def S() -> dict:
    return STRINGS.get(CFG["language"], STRINGS["en"])


def format_plan(plan: dict) -> str:
    s = S()
    lines = []
    t = plan["tickets"]
    lines.append(s["summary"].format(keep=len(plan["keep"]), rescout=len(plan["rescout"]), skipped=len(plan["skipped"]))
                 + (s["firstRun"] if plan["firstRun"] else ""))
    if plan["rulesChanged"]:
        lines.append(s["rules"])
    for k in plan["rescout"]:
        lines.append(f"  ↻ {k} — {'; '.join(t[k]['reasons'])}")
    for k in plan["keep"]:
        if t[k]["blockedBy"]:
            lines.append(s["blocked"].format(k=k, by=", ".join(t[k]["blockedBy"])))
        else:
            lines.append(s["kept"].format(k=k, date=(t[k].get("scoutedAt") or "")[:10]))
    ch = plan["changes"]
    body = [(lab, ch[key]) for key, lab in s["labels"] if ch.get(key)]
    if body and not plan["firstRun"]:
        lines.append(s["changes"])
        for lab, items in body:
            lines.append(f"  {lab}: " + "; ".join(items))
    for repo, cs in (plan.get("newDeployCommits") or {}).items():
        envs = sorted({c["env"] for c in cs})
        lines.append(s["service"].format(repo=repo, n=len(cs), envs=", ".join(envs)))
    return "\n".join(lines)


# ---------------------------------------------------------------- store

BLOCK_RE = re.compile(r"^###\s+([A-Z][A-Z0-9]+-\d+)\b.*$", re.M)
# Labels are accepted in English and Ukrainian; the enumerated values are fixed.
FIELD_RES = {
    "complexity": re.compile(r"^\*\*(?:Complexity|Складність)\*\*:\s*`?([a-z]+)", re.M),
    "readiness": re.compile(r"^\*\*(?:Readiness|Готовність)\*\*:\s*`?([A-Z][A-Z ]*[A-Z])", re.M),
    "quickWin": re.compile(r"^\*\*Quick-win\*\*:\s*`?(yes|no|так|ні)", re.M | re.I),
    "paths": re.compile(r"^\*\*(?:Paths|Шляхи)\*\*:\s*(.+)$", re.M),
}
QUICK_WIN_VALUES = {"yes": "yes", "так": "yes", "no": "no", "ні": "no"}


def parse_scout_output(text: str) -> dict[str, dict]:
    out = {}
    matches = list(BLOCK_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[m.start():end].rstrip() + "\n"
        fields = {}
        for name, rx in FIELD_RES.items():
            fm = rx.search(block)
            if fm:
                val = fm.group(1).strip()
                if name == "paths":
                    val = parse_paths(val)
                elif name == "quickWin":
                    val = QUICK_WIN_VALUES[val.lower()]
                fields[name] = val
        out[m.group(1)] = {"block": block, "fields": fields}
    return out


def store(cache: dict, issues: dict[str, dict], comments_by_key: dict[str, list[dict]], scout_texts: list[str],
          repos_root: Path, *, skip_prefixes=None, skip_keys=None,
          now: str | None = None) -> dict:
    now = now or now_iso()
    skip_prefixes = tuple(CFG["skipPrefixes"] if skip_prefixes is None else skip_prefixes)
    skip_keys = tuple(CFG["skipKeys"] if skip_keys is None else skip_keys)
    verdicts = {}
    for text in scout_texts:
        verdicts.update(parse_scout_output(text))
    tickets = cache.setdefault("tickets", {})
    deploy_commits = {r: set(v) for r, v in (cache.get("deployCommits") or {}).items()}
    repo_names = set(CFG["primaryRepos"])
    for k, issue in issues.items():
        if skip_reason(k, skip_prefixes, skip_keys):
            continue
        snap = snapshot(issue, comments_by_key.get(k, []))
        entry = tickets.get(k) or {}
        if k in verdicts:
            entry.update({"scoutedAt": now, "block": verdicts[k]["block"], "fields": verdicts[k]["fields"],
                          "fp": snap["fp"], "fpParts": snap["fpParts"]})
        elif "fp" not in entry:
            entry.update({"fp": snap["fp"], "fpParts": snap["fpParts"]})
        prev_tips = (entry.get("seen") or {}).get("branchTips") or {}
        entry["seen"] = {**snap["seen"], "branchTips": prev_tips}
        for d in snap["deploys"]:
            for c in d["commits"]:
                deploy_commits.setdefault(c["repo"], set()).add(c["sha"])
        repo_names.update((entry.get("fields") or {}).get("paths", {}).keys())
        tickets[k] = entry
    for k in list(tickets):
        if k not in issues:
            del tickets[k]
    repos = {n: Repo(n, repos_root) for n in sorted(repo_names)}
    cache["repoHeads"] = {n: {"ref": r.ref, "sha": r.head()} for n, r in repos.items() if r.ok and r.ref}
    cache["rulesHash"] = {n: repos[n].rules_hash(p) for n, p in CFG["rulesPaths"].items() if n in repos and repos[n].ok}
    for k, entry in tickets.items():
        entry["seen"]["branchTips"] = {n: tip for n, r in repos.items() if r.ok for tip in [r.branch_tip(k)] if tip}
    cache["deployCommits"] = {r: sorted(v) for r, v in deploy_commits.items()}
    return {"stored": sorted(verdicts), "unmatched": sorted(set(verdicts) - set(issues)), "tickets": len(tickets)}


# ---------------------------------------------------------------- cli

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "store"):
        p = sub.add_parser(name)
        p.add_argument("--issues", required=True, type=Path, help="Jira search result JSON (issues[])")
        p.add_argument("--comments-dir", required=True, type=Path, help="dir with <KEY>.comments.json")
        p.add_argument("--config", type=Path, help="config JSON (default <agent-dir>/my-quick-wins.json)")
        p.add_argument("--cache", type=Path, help="cache JSON (default from config)")
        p.add_argument("--repos-root", type=Path, help="parent dir of the repos (default from config)")
        p.add_argument("--lang", choices=sorted(STRINGS), help="message language (default from config)")
        p.add_argument("--skip-prefix", action="append", default=None)
        p.add_argument("--skip-key", action="append", default=None)
    pp = sub.choices["plan"]
    pp.add_argument("--max-age-days", type=int, help="verdict TTL in days (default from config)")
    pp.add_argument("--fresh", action="store_true", help="re-scout everything")
    pp.add_argument("--fetch", action="store_true", help="git fetch --prune each tracked repo first")
    pp.add_argument("--json", type=Path, help="also write the full plan as JSON here")
    ps = sub.choices["store"]
    ps.add_argument("--scout", action="append", default=[], type=Path, help="scout output markdown (repeatable)")
    a = ap.parse_args(argv)

    configure(**load_config(a.config))
    if a.lang:
        CFG["language"] = a.lang
    if a.skip_prefix is not None:
        CFG["skipPrefixes"] = list(a.skip_prefix)
    if a.skip_key is not None:
        CFG["skipKeys"] = list(a.skip_key)
    root = a.repos_root or repos_root()
    cache_file = a.cache or cache_path()

    issues = load_issues(a.issues)
    comments = {k: load_comments(a.comments_dir, k) for k in issues}
    cache = load_cache(cache_file)
    kw = {}

    if a.cmd == "plan":
        plan = build_plan(issues, comments, cache, root,
                          max_age_days=a.max_age_days if a.max_age_days is not None else int(CFG["maxAgeDays"]),
                          fresh=a.fresh, fetch=a.fetch, **kw)
        if a.json:
            a.json.parent.mkdir(parents=True, exist_ok=True)
            a.json.write_text(json.dumps(plan, ensure_ascii=False, indent=1))
        print(format_plan(plan))
        return 0
    texts = [p.read_text() for p in a.scout]
    res = store(cache, issues, comments, texts, root, **kw)
    save_cache(cache_file, cache)
    msg = S()["stored"].format(n=len(res["stored"]), keys=", ".join(res["stored"]) or "—", total=res["tickets"])
    if res["unmatched"]:
        msg += S()["unmatched"].format(keys=", ".join(res["unmatched"]))
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
