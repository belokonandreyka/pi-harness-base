#!/usr/bin/env python3
"""Ceremony against progress, per ticket, from the collaborating-agents run records.

An orchestrator that delegates can spin for a long time without moving a
ticket: review rounds, verification runs, respawns after timeouts, and recon
that never turns into a diff. This script reads the durable run records the
collab bus writes for every subagent (`<agent-dir>/collaborating-agents/runs/*.json`)
and prints, per ticket, how much subagent time went into implementation and
how much into ceremony around it, so a rule or a gate is added only when the
number says the process is the problem.

Classification is by subagent type first and by the opening of the task text
second: a task that starts with apply / fix / implement is implementation even
when it mentions a review; `scout` / `investigate` / `triage` mark recon,
`review` / `audit` a review, `verify` a verification run; everything else
counts as implementation. It is a heuristic: sample-check a ticket's rows
before acting on its ratio. Ticket keys come from the task text, the working directory or
the parent session file. Runs that name no ticket land in `(no ticket)`.

Usage:
    python3 measure/ceremony.py                 # last 14 days, per ticket
    python3 measure/ceremony.py --since 30      # last 30 days
    python3 measure/ceremony.py --weekly        # totals per ISO week instead
    python3 measure/ceremony.py --runs-dir DIR  # another profile's records

Ceremony ratio = (review + verify minutes) / implementation minutes. Above 1.0
the ticket spent more subagent time on checking than on building; three or
more review rounds, or two or more failed runs, are flagged on their own.
"""

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import sys

REVIEW_TYPES = {"reviewer", "codex-sol-reviewer", "scout-sol"}
VERIFY_TYPES = {"browser-verify"}
RECON_TYPES = {"scout", "scout-flash", "gemini-flash", "haiku-recon"}
KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b")
ACTION_RE = re.compile(r"\b(apply|fix|fixes|implement|finish|correct|add|update|refactor|write)\b", re.I)
RECON_RE = re.compile(r"\b(scout|recon|investigat|explore|survey|triage|тріаж|триаж)", re.I)
REVIEW_RE = re.compile(r"\b(review|reviewer|audit)\b", re.I)
VERIFY_RE = re.compile(r"\bverif", re.I)


def parse_ts(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def classify(rec):
    """Type first; then the opening of the task text, because a worker told to
    "apply review fixes" produces a diff and a scout told to "review the log"
    produces a report. Only the first sentence is read: further down every
    task mentions verification and review steps."""
    t = rec.get("type") or ""
    if t in REVIEW_TYPES:
        return "review"
    if t in VERIFY_TYPES:
        return "verify"
    if t in RECON_TYPES:
        return "recon"
    head = re.sub(r"\s+", " ", (rec.get("taskPreview") or "")[:160])
    opening = head[:70]
    if ACTION_RE.search(opening):
        return "impl"
    if RECON_RE.search(head):
        return "recon"
    if REVIEW_RE.search(head):
        return "review"
    if VERIFY_RE.search(opening):
        return "verify"
    return "impl"


def ticket_of(rec):
    for field in ("taskPreview", "cwd", "parentSessionFile"):
        m = KEY_RE.search(rec.get(field) or "")
        if m:
            return m.group(0)
    return "(no ticket)"


def minutes(rec):
    start = parse_ts(rec.get("startedAt"))
    end = parse_ts(rec.get("completedAt")) or parse_ts(rec.get("lastSeenAt"))
    if not start or not end or end < start:
        return 0.0
    return (end - start).total_seconds() / 60


def load(runs_dir, since_days):
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days)
    out = []
    for path in glob.glob(os.path.join(runs_dir, "*.json")):
        try:
            with open(path) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        start = parse_ts(rec.get("startedAt"))
        if not start or start < cutoff:
            continue
        out.append(rec)
    out.sort(key=lambda r: r.get("startedAt") or "")
    return out


def respawns(records):
    """A run whose task text repeats an earlier run's opening in the same ticket
    is a respawn: the first attempt did not deliver."""
    seen = collections.defaultdict(set)
    count = collections.Counter()
    for rec in records:
        key = ticket_of(rec)
        head = re.sub(r"\s+", " ", (rec.get("taskPreview") or "")[:120]).strip().lower()
        if not head:
            continue
        if head in seen[key]:
            count[key] += 1
        seen[key].add(head)
    return count


def summarize(records, group_of):
    rows = collections.defaultdict(lambda: collections.defaultdict(float))
    for rec in records:
        g = group_of(rec)
        kind = classify(rec)
        mins = minutes(rec)
        row = rows[g]
        row["runs"] += 1
        row[f"{kind}_n"] += 1
        row[f"{kind}_min"] += mins
        if rec.get("status") == "failed" or rec.get("exitCode") not in (None, 0):
            row["failed"] += 1
    return rows


def fmt_row(name, row, resp):
    impl = row["impl_min"]
    ceremony = row["review_min"] + row["verify_min"]
    ratio = ceremony / impl if impl > 0 else float("inf") if ceremony > 0 else 0.0
    flags = []
    if impl > 0 and ratio > 1.0:
        flags.append("ceremony>impl")
    if row["review_n"] >= 3:
        flags.append(f"{int(row['review_n'])} review rounds")
    if row["failed"] >= 2:
        flags.append(f"{int(row['failed'])} failed")
    if resp:
        flags.append(f"{resp} respawn{'s' if resp > 1 else ''}")
    ratio_s = "∞" if ratio == float("inf") else f"{ratio:.2f}"
    return (
        f"{name:<14} {int(row['runs']):>4} "
        f"{int(row['impl_n']):>3}/{impl:>5.0f}m "
        f"{int(row['review_n']):>3}/{row['review_min']:>4.0f}m "
        f"{int(row['verify_n']):>2}/{row['verify_min']:>3.0f}m "
        f"{int(row['recon_n']):>2}/{row['recon_min']:>3.0f}m "
        f"{int(row['failed']):>3} {ratio_s:>6}  {', '.join(flags)}"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    default_dir = os.path.join(os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent")), "collaborating-agents", "runs")
    ap.add_argument("--runs-dir", default=default_dir)
    ap.add_argument("--since", type=int, default=14, help="days back (default 14)")
    ap.add_argument("--weekly", action="store_true", help="group by ISO week instead of ticket")
    ap.add_argument("--min-runs", type=int, default=2, help="hide tickets with fewer runs (default 2)")
    a = ap.parse_args()

    records = load(a.runs_dir, a.since)
    if not records:
        print(f"no run records in {a.runs_dir} for the last {a.since} days", file=sys.stderr)
        return 1

    if a.weekly:
        def group_of(rec):
            d = parse_ts(rec.get("startedAt"))
            y, w, _ = d.isocalendar()
            return f"{y}-W{w:02d}"
        resp = collections.Counter()
    else:
        group_of = ticket_of
        resp = respawns(records)

    rows = summarize(records, group_of)
    header = f"{'group':<14} {'runs':>4} {'impl n/min':>9} {'review':>8} {'verify':>6} {'recon':>6} {'fail':>4} {'ratio':>6}  flags"
    print(f"{len(records)} runs in the last {a.since} days from {a.runs_dir}")
    print(header)
    print("-" * len(header))
    shown = 0
    for name, row in sorted(rows.items(), key=lambda kv: -kv[1]["runs"]):
        if not a.weekly and row["runs"] < a.min_runs and name != "(no ticket)":
            continue
        print(fmt_row(name, row, resp.get(name, 0)))
        shown += 1
    total = collections.defaultdict(float)
    for row in rows.values():
        for k, v in row.items():
            total[k] += v
    print("-" * len(header))
    print(fmt_row("TOTAL", total, sum(resp.values())))
    if not a.weekly:
        hidden = len(rows) - shown
        if hidden:
            print(f"({hidden} tickets with fewer than {a.min_runs} runs hidden; --min-runs 1 shows them)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
