---
name: herdr-terminals
description: >-
  Rules for terminal panes on this macOS workstation with herdr (`herdr_layout`, `herdr_pane`, `herdr_agent`). **Load before opening a pane or running any long command (tests, build, dev server, watch, log tail).** cmux is dead here — `cmux_open_terminal` fails with "Connection refused" and must not be retried. Covers: inline-first (finite commands go through `bash` with a timeout and `| tail`, panes only for long-lived processes); the false-failure "Expected JSON output" reply from `herdr_pane run` / `send_text` (the command DID run); the empty-read gotcha (`source: "recent"` is empty — pass `"visible"`); the sentinel rule for `wait_output` (it matches old scrollback first — wait on `^DONE-<token>` you echoed, never on the tool's summary); close one-off panes before the turn ends; never claim a check passed because a pane opened.
---

# herdr terminals (macOS, this workstation)

Verified against herdr 0.8.0 on 2026-08-28 and re-checked on 0.9.0 on 2026-09-10
(`~/.local/bin/herdr`).

## cmux is dead here

`cmux_open_terminal` returns
`Failed to connect to socket at ~/.local/state/cmux/cmux.sock (Connection refused, errno 61)`.
The binary still exists at `/usr/local/bin/cmux`, but no daemon runs. Do not
retry it and do not start the daemon — the workstation moved to herdr. Use
`herdr_layout` + `herdr_pane` instead.

## Opening a pane and running a command

Layout and execution are separate tools: `herdr_layout` never runs a command,
`herdr_pane` never creates a pane.

1. `herdr_layout({ action: "pane_split", direction: "right", cwd: "<path>" })`
   → returns the new pane id (`w1:p26`). Defaults to the caller's pane and cwd.
2. `herdr_pane({ action: "run", pane: "<id>", command: "<cmd>" })`.

herdr panes DO inherit the login shell (zsh + oh-my-zsh, nvm shims on PATH).
The cmux-era `export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"` prefix
is unnecessary — `npm run devserver` works with no prefix. The trailing
`; read` trick is also unnecessary: a finished command leaves the pane at a
prompt with the scrollback intact.

## "Expected JSON output" is a false failure — the command ran

`herdr_pane` `run` and `send_text` respond with
`Expected JSON output from herdr pane run <id> <cmd>` because the herdr 0.8.0
CLI prints nothing for those subcommands and the MCP wrapper insists on JSON.
The command is delivered and executed anyway (verified: `herdr pane run <id>
"echo x > /tmp/f"` wrote the file; the pane scrollback shows every command sent
through the erroring tool).

Consequence: never re-send after this error. A retry runs the command a second
time. Verify instead — read the pane, or check the command's side effect
(listening port, log file, process).

## Reading a pane: pass `source: "visible"`

The default source (`recent`) returns an EMPTY result for a freshly created
pane, through both the MCP tool and the CLI. `source: "visible"` returns the
scrollback. If a read comes back empty, that is the tool default, not an empty
pane — re-read with `visible` before concluding the command did nothing.

`herdr_layout({ action: "pane_list" })` (or `herdr pane get <id>`) is JSON and
always works: use it to confirm a pane exists and to see its `cwd`,
`agent_status`, and `terminal_title`.

## Waiting for a long command: echo a sentinel, wait for the sentinel

`herdr_pane wait_output` (CLI `herdr pane wait-output`) searches the existing
snapshot FIRST, then polls. There is no "only new output" mode. Two
consequences, both seen on 2026-09-10 while running `npm run test-ci`:

- Waiting on the tool's own final text (`SUMMARY:`, `TOTAL:`, `Executed …`)
  matches the previous run still sitting in the scrollback and returns at once
  with stale results.
- Trying to outsmart that with a regex anchored on the echoed command line
  (`… tail -30\n[\s\S]*SUMMARY:`) never matches: herdr pads every line with
  spaces to the pane width, so `\n` never follows the command text. The
  coordinator then sits in the wait until its timeout (15 minutes that day).

The pattern that works: make the command print a token that cannot exist in
the scrollback, and wait for that literal token.

```
herdr_pane run  →  ( npm run test-ci; echo "DONE-k7q2 exit=$?" ) 2>&1 | tail -80
herdr_pane wait_output  →  match: "^DONE-k7q2 exit=", regex: true,
                           source: "recent-unwrapped", timeout: 900000
```

Anchor the match to the line start (`^`, regex on): the shell echoes the whole
command into the pane, so a plain substring match hits the token inside that
echoed command line at once, before anything ran (seen 2026-09-10). Only the
sentinel's own output line starts with the token.

Pick a fresh token per run (4+ random characters). The subshell keeps the real
exit code inside the piped output, so the matched line also tells you whether
the command failed. After the match, `read` the pane with `source: "visible"`
for the summary above the sentinel. `wait_output` blocks the coordinator's turn
for the whole timeout on a bad pattern, so a suite that usually takes 3 minutes
gets `timeout: 300000`, not 900000.

## Finite commands belong in `bash`, not in a pane

Checked 2026-09-10 on pi 0.85.1: the `bash` tool has no default timeout (the
`timeout` argument is optional, in seconds) and it truncates output at 2 000
lines / 50 KB. So a test run, a build, lint or a one-off script is one call:

```
bash({ command: "npm run test-ci 2>&1 | tail -60", timeout: 900 })
```

No split, no sentinel, no `wait_output`, no pane to close, and the coordinator
is blocked for exactly as long as it would be waiting on a pane anyway. While
it runs only the elapsed counter moves: `tail` prints nothing until the end.
That is the intended trade-off — whatever streams to the screen is the same
stdout that becomes the tool result and stays in context for the session
(a full Karma run unfiltered is ~12k tokens; the decision on 2026-09-10 was
to keep `tail` and live without progress). Reach
for a pane only when the process must outlive the tool call (the Angular
devserver, a watcher) or when the user wants to watch the full output live.
Everything below about sentinels and closing applies to those cases.

## Close the pane when it is no longer needed

A pane opened for a one-off command (a test run, a build, a log tail you have
already read) is closed with `herdr_pane({ action: "close", pane: "<id>" })`
as soon as its output has been read — and in any case before the turn ends.
"I may rerun the suite once the user answers" is not a reason to keep it: a
fresh `pane_split` costs nothing, while a leftover pane hides the
orchestrator's own pane and its stale scrollback is exactly what `wait_output`
matches by mistake on the next run (2026-09-10: the coordinator ended its turn
with a question for the user and left the test pane open). The exception is a
process that must keep running for the work (the Angular devserver, a
watcher) — leave that pane open and say so in the report.

Never close a pane that hosts a subagent: those are owned by
collaborating-agents and are released when the run completes.

## Verification rule (unchanged from the cmux era)

A pane that opened, or a `run` that returned anything at all, proves nothing
about the command's outcome. Confirm the result independently: read the pane
with `source: "visible"`, re-run the check inline via `bash`, tail the log file
the command writes, or probe the port it should listen on. Never report a check
as passed on the strength of a pane appearing.

## Long-running processes survive the session

A dev server started in a pane keeps running after the pi session that started
it ends, and a second `npm run devserver` then fails with
`Port 5000 is already in use`. Before starting one, check
(`lsof -nP -iTCP:5000 -sTCP:LISTEN`) — an existing Angular devserver in watch
mode already serves the current working tree and needs no restart.
