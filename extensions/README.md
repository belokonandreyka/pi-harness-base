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
bun test                                   # unit tests, no pi process
bun test ./test/e2e/context-guard.e2e.ts   # end to end through the real pi CLI, no API
```

The end-to-end tests drive `pi --mode rpc` with a scripted model
(`test/harness/fake-provider.ts`): it reports usage that grows with the number
of messages, so pi's own threshold compaction and the context-ceiling clamp
fire as they would with a real model, and it answers deterministically
(`view_context` → `handoff_note` when warned → `DONE` once it sees its note in
the compaction summary). Two things a scripted provider needs that are easy to
miss: `baseUrl` and `apiKey` must both be set even though nothing is ever sent,
and its answers must carry real text bulk, because pi decides what a
compaction may cut from its own character estimate of the entries, not from
the usage the model reports. e2e files end in `.e2e.ts` so `bun test` alone
does not pick them up.

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

Enabled at 160k in `~/.pi-sub/agent` (subagents; 120k left only 25–40k of room
after a compaction, measured 2026-09-21); registered but disabled in
`~/.pi/agent` (orchestrator) so `/ceiling on` or `/ceiling 150k` turns it on
for one session. While enabled the footer shows the live gauge, `ctx 96k/160k`,
refreshed after every turn. Tests: `bun test extensions/context-ceiling`.

## context-guard

Lets the model see its own context gauge, warns it before pi's automatic
compaction, and carries its own handoff note across the cut. Since 2026-09-26
the summary opens with a `Goal:` line (the task as originally asked) and the
note starts with GOAL, and the guidelines tell the model to refocus after
each compaction: check that the next action still lies on the path to that
goal, and stop when the work has grown past what was asked. A long session
drifts one locally sensible step at a time, and a summary of the drifted
state makes the drift the new baseline. The idea comes from
[disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent);
what is deliberately left out is its tool lock and its cancelling of pi's own
compaction, so the ceiling above still guarantees a compaction even when the
model ignores every warning.

**Why.** pi's compaction is silent from the model's side. It fires at
`contextWindow - reserveTokens` (the context-ceiling clamp counts), replaces
everything but the most recent messages with a summary written by a separate
request, and that summary tends to lose what the agent was about to do next;
the agent then re-reads files and redoes finished steps. Measured 2026-09-21:
12 of 163 subagent sessions compacted, one of them three times in ten minutes
with the summary growing from 8k to 23k characters.

**What the model gets.**
- `view_context` tool: used tokens, the compaction limit, tokens left, whether
  a note is saved, as JSON.
- From `warnTokensBefore` (30k) under the limit, every model call carries a
  transient `[context-guard]` message with live numbers asking for a handoff
  note. It is appended last, so the cached prefix is untouched, and it is never
  persisted.
- `handoff_note` tool: DONE / IN PROGRESS / decisions / NEXT ACTION, up to
  `maxNoteChars` (6000). Stored as a session entry, so a restart keeps it.

**What happens at compaction.** The extension runs pi's own summariser (same
model, same split-turn handling, `cacheRetention: "none"`) with extra rules: no
work marked done without a confirming tool result, keep exact paths and
commands, merge the previous summary and stay under `maxSummaryChars` (12000).
The saved note is appended to the summary verbatim under a "Handoff note"
heading and the note is cleared. If the summariser fails, pi's default
compaction runs instead. `session_before_compact` is the only hook that changes
anything; pi's threshold logic still decides *when*.

| Source | Effect |
|---|---|
| `<agent-dir>/context-guard.json` `{ enabled, warnTokensBefore, maxNoteChars, maxSummaryChars }` | profile defaults |
| `<agent-dir>/context-guard-summary.md` | replaces the extra summary rules (`{{maxSummaryChars}}` is substituted) |
| `/context-guard` | prints the gauge |

Enabled in `~/.pi-sub/agent` (subagents, limit 160k from the ceiling) and in
`~/.pi/agent` (orchestrator: with the 1M window the warning never fires unless
`/ceiling` is on, but the summary rules apply to every `/compact`). Tests:
`bun test extensions/context-guard`.

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

## elapsed-clock

Appends `[elapsed 340s / 1200s]` (or `[elapsed 340s]` when no budget is known)
to the end of every tool result. Claude Opus 5.5 paces itself by elapsed-time
information from the harness and finishes inside a budget, usually well before
it; small agent teams given a budget finished sooner at comparable quality
(Anthropic, "Prompting Claude Opus 5.5", time signals for multiagent
harnesses). Older models ignore the line. In pi the message the harness sends
back to the model is the tool result, hence the placement. The budget comes
from env `PI_TIME_BUDGET_S` or from the task prompt (`time budget: 20m`); the
clock starts at session start. The budget is advisory, nothing stops the run
at the limit. Config `elapsed-clock.json` (`everyNth`, `tools`);
`PI_ELAPSED_CLOCK=0` disables. Meant for the subagent profile; the
coordinator's turns are driven by a person, not a clock.

## pasted-content

Wraps text the user pasted into a prompt in `<pasted_content id="ab12">` …
`</pasted_content id="ab12">` tags (random id, both tags on their own line),
which is what Claude Opus 5.5 needs to treat instructions inside an email, a
ticket or a PR comment as data rather than as the user's request (Anthropic,
"Prompting Claude Opus 5.5", mark pasted text in user messages). pi's editor
expands a paste verbatim on submit, so the extension reuses pi's own paste
threshold (over 10 lines or 1000 characters) and the shape of a typed prompt:
short lines before the first blank line and after the last one are the user's
words, the bulk between them is the paste. Only interactive input is touched;
subagent task prompts arrive as rpc input. The matching system-prompt sentence
lives in the orchestrator `AGENTS.md`, next to the other rules. Config
`pasted-content.json` (`minLines`, `minChars`, `ownLines`);
`PI_PASTED_CONTENT=0` disables.

## dropped-toolcall-guard

Recovers a turn whose tool call the provider lost. Seen 2026-09-24 through an
Anthropic-compatible gateway in front of Bedrock: thinking block, `stop_reason:
tool_use`, 216 output tokens, and no `tool_use` block. pi's loop treats that as
"Provider reported tool use without any tool calls" and ends the run; a pane
subagent then sits at its prompt until the coordinator's inactivity timeout,
which reports it as a crash. On `agent_end` with such a last message the guard
sends one user message asking the model to repeat the call (a new turn), at
most `maxRetries` (2) per session. Config `dropped-toolcall-guard.json`;
`PI_DROPPED_TOOLCALL_GUARD=0` disables. Enabled in both profiles.

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

## cache-telemetry

Records what the prompt cache actually did, so cache warming (pi >= 0.86) and
compaction settings can be judged on a few days of traffic instead of one test.

**What is logged.** One JSONL line per provider response — input / cache-read /
cache-write tokens, cost, and the pause since the previous response in the same
run — and one line per `cache_warming_decision` with pi's verdict and its own
cost estimates. No prompts, tool arguments or file names. The handler returns
nothing, so it observes warming decisions without changing them.

**Where.** `<agent-dir>/telemetry/cache-usage.jsonl`, one file per profile;
subagents run in their own profile, so their traffic lands in that profile's log.

**Report.** `/cache-stats [days]` (default 7) reads every `~/.pi*/agent` log and
prints, per profile and model: share of prompt tokens served from cache, pauses
of 270 s or more that still hit the cache versus those that lost it (and how many
tokens were re-sent), misses with a short pause (the prefix itself changed:
compaction, model switch, prompt edit), and warming spend next to pi's estimate
of what was at risk.

Warming needs a cache lifetime for the model: add
`"promptCache": { "short": 280, "long": 3300 }` to custom or gateway models in
`models.json`; pi only ships lifetimes for direct Anthropic.

Since 2026-09-24 it also records pi's own warm replays as seen through the
provider hooks (`warm_attempt` when a request carries `max_tokens: 1`,
`warm_result` with the HTTP status), the gateway-warmer's rows (`warm`,
`warm_skip`, `warm_error`), and a `warm_missing` alarm: after a run ends, if
the session is still idle 20 s before the cache lifetime runs out and no
warmer has done anything, one line is logged and a warning shown. The
report gains two lines, `gateway-warmer:` and `pi warmer:`.

## gateway-warmer

Keeps the prompt cache warm through an Anthropic-compatible gateway on its own
timer, replacing pi's warmer where that one cannot be trusted. Found
2026-09-24 on the Vitu gateway (Bifrost in front of Bedrock): pi's streaming
`max_tokens: 1` replay is sometimes cut after `message_start`, so pi-ai throws,
nothing is recorded (zero `cache_warm` entries in 51 sessions) and
`/cache-stats` cannot see the spend — although the replay does refresh
Bedrock's cache (write → +4 min warm → +4 min read hit, measured). Worse, pi's
warmer stops silently when its timer runs more than 14 s late or when it
judges the context changed; one such stop cost a 95k-token re-bill.

The extension captures the exact payload and headers of every real request
(`before_provider_request`, `before_provider_headers`) and, once the agent run
ends, replays the last one non-streaming with `max_tokens: 1` every 0.9 ×
`promptCache.short`, for as long as the cache-warm-policy rules allow (a
subagent of this process is running, or the first `idleMinutes` after the
last real request). Each replay is a `warm` row in the cache-telemetry log
with the gateway's usage; a refresh that would land after the lifetime is
skipped (`warm_skip`), gateway errors are logged (`warm_error`) and stop the
cycle until the next real request. Never runs during an active run. Only
adaptive thinking or thinking off is replayable: budget-based thinking
(`thinking.budget_tokens`, e.g. Haiku 4.5 with any level) derives the budget
from `max_tokens`, so a 1-token replay is rejected with 400 and would key a
different message cache anyway — such payloads are skipped with a `warm_skip`
row, same rule as pi's `CacheWarmer.isReplayable`. Needs
`cacheWarming: "off"` so pi's warmer does not double the spend; reads
`cache-warm-policy.json` for the rules and `gateway-warmer.json` `{ enabled }`;
`PI_GATEWAY_WARMER=0` disables. Orchestrator profile only.

## cache-warm-policy

Overrides pi's idle cache-warming verdict where its fixed 15% "another request
will arrive in time" estimate is known to be wrong.

> Superseded on gateways by `gateway-warmer` (above), which applies the same
> rules with its own timer; keep this one only where pi's warmer works
> end to end (direct Anthropic).

**Why.** On an orchestrator that delegates to subagents, every lost cache of a
measured day came from idle waits — the orchestrator ends its turn and sleeps
until a subagent reports back or the user answers — and the re-billed prefixes
were about half of that day's orchestrator spend. `streaming` mode never warms
while idle, and `idle` mode declines because 15% of the miss cost does not cover
a refresh. While a subagent is running the real probability is close to 100%.

**Rules** (idle only; during an active run pi's own verdict stands):
- a subagent started by this pi process is still running → warm;
- otherwise warm for the first `idleMinutes` (15) after the last real request,
  then stop;
- context under `minContextTokens` (30000) → leave it to pi.

Running children are read from pi-collaborating-agents run records
(`<agent-dir>/collaborating-agents/runs/*.json`: `status: "running"`, matching
`parentPid`, younger than `childMaxAgeMinutes`); without that directory the rule
is simply never true.

**Setup.** `"cacheWarming": "idle"` in the profile's settings.json, a
`promptCache` lifetime on the model, and this extension listed **after**
cache-telemetry (the last handler that returns an action wins). Optional
`<agent-dir>/cache-warm-policy.json` overrides the numbers. pi itself ends idle
warming 30 minutes after the last real request. Each override is logged as
`warm_override` in the cache-telemetry log and shows up in `/cache-stats`.
