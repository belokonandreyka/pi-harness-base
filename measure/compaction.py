#!/usr/bin/env python3
"""Was each compaction worth it, and at what context size does one pay off?

A compaction is a trade: one summary call plus a cache re-write of the
summary, against a smaller cache read on every turn that follows. Reads the
session files of one profile, finds every compaction pi recorded, and prints
per compaction: context before and after, what the summary call cost, what the
first turn after it wrote to the cache, and how many turns followed. Then the
break-even from the prices in models.json:

    pays off after N* = write_cost / (delta_ctx x read_price) turns

where write_cost = summary call + cache write of the new tail, delta_ctx =
context before - context after. The last table turns that around: for a given
number of turns still ahead, the smallest context at which compacting is
cheaper than carrying on - the number a ceiling should be set from.

Usage:
    python3 measure/compaction.py                       # orchestrator profile, last 14 days
    python3 measure/compaction.py --agent-dir ~/.pi-sub/agent --since 30
    python3 measure/compaction.py --model claude-opus-5-5   # price the break-even for another model
"""

import argparse
import datetime as dt
import glob
import json
import os
import statistics
import sys


def load_prices(models_path, model_id):
    with open(os.path.expanduser(models_path)) as fh:
        data = json.load(fh)
    for provider in (data.get("providers") or {}).values():
        for m in provider.get("models") or []:
            if m.get("id") == model_id:
                return m["cost"]
    return None


def session_rows(path):
    with open(path) as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def usage_of(row):
    m = row.get("message") or {}
    if m.get("role") != "assistant" or not m.get("usage"):
        return None
    u = m["usage"]
    c = u.get("cost")
    return {
        "ctx": (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0),
        "write": u.get("cacheWrite") or 0,
        "read": u.get("cacheRead") or 0,
        "cost": (c.get("total") if isinstance(c, dict) else c) or 0,
        "model": m.get("model"),
    }


def compactions(sessions_glob, since):
    out = []
    for path in sorted(glob.glob(sessions_glob)):
        if "collaborating-agents-subagents" in path:
            continue
        rows = list(session_rows(path))
        usages = [(i, usage_of(r)) for i, r in enumerate(rows)]
        usages = [(i, u) for i, u in usages if u]
        for i, row in enumerate(rows):
            if row.get("type") != "compaction":
                continue
            ts = row.get("timestamp") or ""
            if ts and dt.datetime.fromisoformat(ts.replace("Z", "+00:00")) < since:
                continue
            before = [u for j, u in usages if j < i]
            after = [u for j, u in usages if j > i]
            if not before or not after:
                continue
            su = row.get("usage") or {}
            out.append({
                "session": os.path.basename(path)[:16],
                "ts": ts[:16],
                "before": before[-1]["ctx"],
                "after": after[0]["ctx"],
                "prefix": after[0]["read"],
                "write": after[0]["write"],
                "turn_cost": after[0]["cost"],
                "summary_in": su.get("input") or 0,
                "summary_out": su.get("output") or 0,
                "turns_after": len(after),
                "model": after[0]["model"],
            })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--agent-dir", default=os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent")))
    ap.add_argument("--models", default=os.path.expanduser("~/.pi/agent/models.json"))
    ap.add_argument("--since", type=int, default=14, help="days back (default 14)")
    ap.add_argument("--model", default=None, help="model id to price the break-even with (default: the one seen most)")
    a = ap.parse_args()

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.since)
    rows = compactions(os.path.join(os.path.expanduser(a.agent_dir), "sessions", "*", "*.jsonl"), since)
    if not rows:
        print("no compactions found")
        return 0

    print(f"{len(rows)} compactions in the last {a.since} days under {a.agent_dir}")
    print(f"{'session':17}{'before':>9}{'after':>8}{'prefix':>8}{'write':>8}{'$ turn':>8}{'summary in/out':>16}{'turns after':>13}")
    for r in rows:
        print(f"{r['session']:17}{r['before']:9,}{r['after']:8,}{r['prefix']:8,}{r['write']:8,}{r['turn_cost']:8.3f}"
              f"{r['summary_in']:>9,}/{r['summary_out']:<6,}{r['turns_after']:13}")

    model = a.model or statistics.mode([r["model"] for r in rows if r["model"]])
    prices = load_prices(a.models, model)
    if not prices:
        print(f"\nno prices for {model} in {a.models}; pass --model")
        return 1
    med = lambda k: statistics.median(r[k] for r in rows)
    summary_tokens = med("after") - med("prefix")
    summary_call = med("summary_in") * prices["input"] / 1e6 + med("summary_out") * prices["output"] / 1e6
    write_cost = summary_call + summary_tokens * prices["cacheWrite"] / 1e6
    print(f"\nmedians: before {med('before'):,.0f} · after {med('after'):,.0f} · cached prefix {med('prefix'):,.0f} · "
          f"summary tail {summary_tokens:,.0f} tokens · turns after {med('turns_after'):.0f}")
    print(f"prices ({model}): read ${prices['cacheRead']}/M · write ${prices['cacheWrite']}/M · input ${prices['input']}/M · output ${prices['output']}/M")
    print(f"one compaction costs ≈ ${write_cost:.3f} (summary call ${summary_call:.3f} + cache write ${summary_tokens * prices['cacheWrite'] / 1e6:.3f})")

    print("\nbreak-even turns by context at compaction (median after-size kept):")
    print(f"{'context':>10}{'saved/turn':>12}{'$/turn saved':>14}{'turns to pay off':>18}")
    for ctx in (80_000, 100_000, 120_000, 140_000, 160_000, 200_000):
        delta = ctx - med("after")
        if delta <= 0:
            continue
        saved = delta * prices["cacheRead"] / 1e6
        print(f"{ctx:10,}{delta:12,.0f}{saved:14.4f}{write_cost / saved:18.1f}")

    print("\nsmallest context worth compacting, by turns still ahead:")
    print(f"{'turns ahead':>12}{'compact from':>14}")
    for n in (10, 25, 50, 100, 200):
        ctx = med("after") + write_cost / (n * prices["cacheRead"] / 1e6)
        print(f"{n:12}{ctx:14,.0f}")
    print(f"\nobserved: median {med('turns_after'):.0f} turns followed a compaction; "
          f"{sum(1 for r in rows if r['turns_after'] * (r['before'] - r['after']) * prices['cacheRead'] / 1e6 >= write_cost)} of {len(rows)} paid off.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
