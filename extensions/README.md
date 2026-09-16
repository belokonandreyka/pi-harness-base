# Extensions and skills

Written for this setup and referenced by absolute path from both profiles
(one per profile), so there is one source of truth and
per-profile configuration.

## skill-usage-telemetry

Records which skills actually get loaded, so an installed set can be judged on
evidence rather than impressions.

**Why it is needed.** Pi keeps only skill *names and descriptions* in the system
prompt and loads the body on demand. A skill that never loads still costs
context on every single session — and the usual cause is a description that
never triggers, not a skill nobody needed. That is a fixable problem, but only
if it is visible.

### What it records

| Signal | Event | Meaning |
|---|---|---|
| `skill_read` | `tool_call` on `read` of a `SKILL.md` | the agent loaded the body itself |
| `skill_command` | `input` starting with `/skill:` | a human forced the load |
| `session_start` / `session_end` | session events | the denominator |

Skill **identities only**. Prompts, task text and `/skill:` arguments are never
written to the log.

### Where it writes

`<agent-dir>/telemetry/skill-usage.jsonl`, with the agent dir resolved from
`PI_CODING_AGENT_DIR`, so the two profiles log separately without any extra
configuration. The `profile` field is derived from that path (`~/.pi/agent` →
`pi`, `~/.pi-personal/agent` → `pi-personal`) so the two logs stay attributable
if they are ever read together.

### Reading the numbers

`/skill-stats` prints a per-skill summary plus a `never loaded:` line listing
installed skills with no recorded load.

Read the `read` and `/skill:` columns separately. `read` is the one that answers
"does this skill trigger on its own"; `/skill:` only says a human remembered it
existed. A load forced by `/skill:` that the model then re-reads shows up in
both columns, so the `loads` total can exceed the number of distinct occasions.

### Failure behaviour

Telemetry never takes a session down: every write is best-effort and errors are
swallowed. A half-written final line from a live session is tolerated by the
parser.

### Install

Add to a profile's `settings.json`:

```json
{
  "extensions": [
    "/Users/<you>/Projects/pi-harness-base/extensions/skill-usage-telemetry/index.ts"
  ]
}
```

To try it for a single run without touching any profile:

```bash
pi -e ~/Projects/pi-harness-kit/extensions/skill-usage-telemetry/index.ts
```

## durable-context

Keeps a profile's standing instructions in front of the model for the whole
session, including after compaction.

### Why it works the way it does

Pi's `context` hook fires before every model call, receives a deep copy of the
session, and discards the edit once the request is sent. Nothing injected there
is ever persisted.

That has a consequence worth stating plainly, because the obvious
implementation gets it wrong: injecting once per session leaves the rule in
force for exactly one request. This extension therefore re-injects on **every**
call, and places the block at a fixed offset from the top (after any leading
compaction summaries) so the request prefix stays byte-identical between calls
and remains cacheable.

### Rules files

| Path | Scope |
|---|---|
| `<agent-dir>/durable-context.md` | the profile |
| `<cwd>/.pi/durable-context.md` | the repository, appended after the profile's |

With neither file present the extension does nothing. Files are re-read when
their mtime changes, so an edit takes effect on the next model call without a
restart.

Rules are repeated on every call, so they cost tokens on every call. Past
~4000 characters the extension says so once per session rather than letting the
cost stay invisible.

`/durable-context` prints what is currently loaded and where it came from.

### Install

```json
{
  "extensions": [
    "/Users/<you>/Projects/pi-harness-base/extensions/durable-context/index.ts"
  ]
}
```

## Skills

Four skills adapted from [obra/superpowers](https://github.com/obra/superpowers)
(MIT, Jesse Vincent), rewritten for this setup rather than copied: the coercive
framing is gone, the examples are from these repos, and the subagent skill
targets `pi-collaborating-agents` instead of `pi-subagents`.

| Skill | Triggers on |
|---|---|
| `verification-before-completion` | about to claim done, fixed, or passing |
| `systematic-debugging` | something fails and the cause is unknown |
| `subagent-driven-development` | a plan with independent tasks to delegate |
| `writing-skills` | creating or fixing a skill, including one that never loads |

Wire the directory into a profile:

```json
{
  "skills": ["/Users/<you>/Projects/pi-harness-base/skills"]
}
```

These are the subjects of the measurement — `skill-usage-telemetry` records
which of them actually load, and `writing-skills` explains what a zero means.

## Tests

```bash
bun test
```

## read-guard

Stops `read` from re-shipping content the model already holds. Measured over
2026-08-19..09-05: `read` results were 141M re-shipped tokens; AGENTS.md files
already in the system prompt were read 35 times, 28–38 KB SKILL.md bodies up to
20 times each, and 1,712 of 2,290 reads had no offset/limit.

| Trigger | Action |
|---|---|
| `read` of a file listed in `systemPromptOptions.contextFiles` | blocked with a reason |
| second whole `read` of a file unchanged since the first (same mtime and size) | blocked; ranged reads stay allowed |
| whole `read` of a text file over 400 lines | `limit` set to 250 and the result annotated: use `rg`, then a range |

The seen-set resets on `session_start` and `session_compact`, because after a
compaction the earlier content really is gone from context. Binary files and
files over 8 MB are left alone. Registered by absolute path in both
`~/.pi/agent/settings.json` and `~/.pi-sub/agent/settings.json`.

Run its tests with `bun test extensions/read-guard`.

## context-ceiling

An absolute compaction threshold. pi's own auto-compaction fires at
`contextWindow - reserveTokens`; every subagent model in use advertises a 1M
window, so between 2026-08-19 and 09-05 381 subagent sessions compacted zero
times while averaging 74k tokens per call, and 121M tokens were shipped above
120k per call.

pi only compacts *inside* a running agent loop through its own threshold check,
which reads `model.contextWindow` live; `ctx.compact()` aborts the run and never
resumes it. So the extension clamps the active model's `contextWindow` to
`ceilingTokens + reserveTokens` on `session_start`, `before_agent_start`,
`turn_start` and `model_select`, and pi's native path compacts at the ceiling and
carries on. `reserveTokens` must equal `compaction.reserveTokens` in that
profile's settings.json (pi default 16384).

| Source | Effect |
|---|---|
| `PI_CONTEXT_CEILING=<tokens>` / `0` / `off` | per-process override, wins over the file |
| `<agent-dir>/context-ceiling.json` `{ "enabled", "ceilingTokens", "reserveTokens" }` | profile default |
| `/ceiling [tokens\|on\|off\|status]` | change it in a running session; `off` restores the real window |

Enabled at 120k in `~/.pi-sub/agent` (subagents); registered but disabled in
`~/.pi/agent` (orchestrator) so `/ceiling on` or `/ceiling 150k` turns it on
for one session. Tests: `bun test extensions/context-ceiling`.

## tool-result-offload

Keeps big tool outputs out of the context window, the way Claude Code persists
large outputs to a file and shows only a preview. pi truncates at 50 KB, but
everything under that cap lands in the conversation and is re-sent on every
later call: over 2026-08-19..09-05, bash results of 4k–12k tokens were
re-shipped 20M times over.

On `tool_result`, when the text of a result exceeds `thresholdChars`
(default 24 000 ≈ 6k tokens), the full text goes to `$TMPDIR/pi-offload/<tool>-<callId>.txt`
and the model sees head (5 000) + a marker with size, path and "use rg / read
with offset/limit, do not re-run" + tail (1 500). `read` results and results with
images are left alone. Config in `<agent-dir>/tool-result-offload.json`
(`thresholdChars`, `headChars`, `tailChars`, `dir`, `tools`), env
`PI_OFFLOAD_THRESHOLD=<chars>` overrides, `0` disables. Live-checked
2026-09-05: a 33 738-char `cat` reached the model as 6 824 chars.
Tests: `bun test extensions/tool-result-offload`.

## copilot-credits

Shows the session's GitHub Copilot spend in AI credits as a footer status
(`⚡ 412.6 cr`). Pi prices built-in `github-copilot` models at the Anthropic
list price, and Copilot's credit meter for Opus (measured 2026-09-04:
500 / 2500 / 50 / 625 credits per 1M tokens) is that list price × 100, so the
extension sums `usage.cost.total` of Copilot assistant messages on the current
branch and multiplies by 100. Other providers are untouched, so a gateway
session keeps the built-in `$` and a Copilot worker gets credits next to it.
The ×100 factor is verified for Opus only; for Sonnet, Haiku, GPT and Gemini it
is an estimate until measured. `/credits` prints a per-model breakdown.
Config `copilot-credits.json` → `{ "creditsPerDollar": 100 }`; env
`PI_COPILOT_CREDITS_PER_DOLLAR` overrides it. Enabled in the subagent profile.

## poll-guard

Deterministic replacement for the "do not poll a running subagent" rule the
coordinator kept ignoring (`sleep 120; echo waited` + `agent_message tail
mode:status` in a loop). Blocks `bash` commands containing `sleep N` with N ≥
`minSleepSeconds` (default 20) and blocks a repeat `tail`/`session`/`sessions`
on the same run id inside `pollIntervalSeconds` (default 90); the block reason
tells the model to end its turn and let the completion wake start the next
one. `send`, `reply`, `broadcast` and short retry pauses are never touched.
Config `poll-guard.json`; `PI_POLL_GUARD=off` disables it for a session.
Enabled in the orchestrator profile.

## copilot-usage

A replacement footer. Replaces
the built-in footer so the `(provider) model` label is always shown — the
built-in one drops it in narrow herdr panes — and, when the current model is a
Copilot model, shows the account-wide GitHub quota `used/limit credits · Nd`
polled every 5 minutes from `api.github.com/copilot_internal/user` with a PAT
from Keychain item `github-copilot-token`. Other extensions' statuses render
on a third footer line. `/copilot-refresh` re-polls. Enabled in the
orchestrator (auto-discovered via the symlink) and the subagent profile.

## gateway-budget

Week and month spend on the AI gateway against the caps
(`gw wk $41.2/250 · mo $512/1000`, ⚠ at 80 %, ⛔ at 100 %). Bifrost exposes
per-key usage only to admins (the virtual key gets 401 on `/api/governance/*`
and responses carry no budget headers), so the numbers are local: every
session appends its gateway spend deltas to `~/.pi/agent/gateway-ledger.jsonl`
(shared by all profiles on purpose) and the status sums the ledger. Calendar
week = Monday–Sunday; `weekFloor` (ISO instant) counts the current week only
from an admin reset mid-week. A cap of 0 shows the bare total. Backfilled from
session files on 2026-09-10 from 2026-09-01. Expect ~5 % under the dashboard.
Config `gateway-budget.json` (`providers`, `weeklyCap`, `monthlyCap`,
`weekFloor`, `ledger`) — the live one is `~/.pi/agent/gateway-budget.json`,
symlinked into `~/.pi-sub/agent`; `/budget` prints totals, remaining and this
session's share. The ledger is re-read every `refreshSeconds` (default 60), so
spend from other windows and subagents shows up within a minute. Sessions that
ran without the extension are reconciled from their session files on every
session start and via `/budget sync`: messages are priced from tokens with the
current `models.json` rates (old `us.anthropic.*` ids mapped), because costs
stored before 2026-09-05 are ~2.7× too high. The status is shown only while
the current model is on a gateway provider (`statusOnlyForGatewayModel`), so a
Copilot worker sees its credits and not the gateway line; the ledger is kept
either way. Enabled in both profiles.
