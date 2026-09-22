---
name: investigate-ticket
description: Investigate a Jira ticket end-to-end without changing any code — fetch ticket + comments from the configured Jira site, spawn a read-only scout subagent to locate the root cause in the local codebase, and return a structured findings report (suspected files, hypothesis, reproduction path, risks, open questions). Use when the user gives a ticket key like ABC-1234 and asks to "investigate", "look into", "find the cause" (in any language). Does NOT propose or apply a fix — that is a separate step handed to Opus/Fable.
---

# Investigate ticket (read-only root-cause scout)

Read this skill fully before any tool call. It is authoritative for the flow.

## When to use

- User gives a Jira key and asks to investigate / find the cause (in whatever language), without asking for an immediate fix.
- User wants a scoped, evidence-backed report before deciding who plans the fix (Opus / Fable / a subagent).

Do NOT use for:
- Tickets the user already understands and wants implemented — go straight to a normal implementation flow.
- Non-code tickets (the `skip` prefixes in Configure) — report and stop.
- Multi-ticket triage — use `jira-daily-triage` instead.

## Inputs

- **Ticket key** — e.g. `ABC-1234`. If the user gave a URL, extract the key from the last path segment.
- **Optional focus hint** — a phrase like "look at the refund flow" or "check FL signing". If present, forward it verbatim to the scout as an extra hint.

If no key is given, ask for one and stop.

## Configure

Edit these for your Jira site and repository before first use:

- **Jira site**: `<JIRA_SITE>` in step 0 (the `<name>.atlassian.net` host).
- **Skip prefixes**: project keys that never hold code (time tracking, ops),
  used by the auto-skip guard in step 2. Example: `TIME`, `OPS`.
- **Prefix → folder table** in step 3: where each project key's code lives.
- **Project context files** in the scout prompt (step 4): the repository's
  `AGENTS.md` and the guides a scout must read before exploring.

## Credentials

Basic auth vars — NEVER echo, print, or paste their values, including into subagent prompts. Use only inside `curl -u "$VAR:$VAR"`.

- Username: `$JIRA_GIT_HOOK_USERNAME`
- Token: `$JIRA_GIT_HOOK_TOKEN` (scoped — works only through the `api.atlassian.com` gateway; the site URL returns 404/permission errors)

If either is missing, tell the user and stop.

## Flow

### 0. Resolve gateway BASE (once per session)

```bash
CLOUD_ID=$(curl -s https://<JIRA_SITE>.atlassian.net/_edge/tenant_info \
  | sed -e 's/.*"cloudId":"\([^"]*\)".*/\1/')
BASE="https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3"
```

### 1. Pull the ticket

Fetch the issue with the fields needed for investigation:

```bash
curl -sS -u "$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN" \
  -H "Accept: application/json" \
  "$BASE/issue/<KEY>?fields=summary,status,issuetype,priority,description,assignee,reporter,parent,components,labels,customfield_10007,attachment,issuelinks"
```

Then latest comments (up to 10, newest first):

```bash
curl -sS -u "$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN" \
  -H "Accept: application/json" \
  "$BASE/issue/<KEY>/comment?orderBy=-created&maxResults=10"
```

Description and comment bodies are ADF — walk `content[].content[].text`; render bold / italic / link marks; do NOT dump raw JSON.

Always fetch comments even when the description looks complete. Comments are the
primary place where developers, QA, and PMs record: real reproduction steps,
AC changes made after the ticket was created, decisions from calls, VINs / deal
ids / user accounts used to reproduce, error messages / stack traces, links to
logs or screenshots, and answers to earlier questions in-thread. Skipping
comments is the single biggest cause of a wrong scout report on this project.

If the parent field is set, also fetch the parent's summary + description in the same way — it often carries the real acceptance criteria for a subtask. Fetch the parent's comments too when the subtask description is thin.

If any `issuelinks` entry has type `is blocked by` or `depends on` with an unresolved target, note it — this may end the investigation early.

### 1a. Build a comments digest (coordinator side)

Before spawning the scout, read the full comment thread yourself and produce a
short chronological digest. This forces you to actually parse them (instead of
dumping raw text into the subagent prompt and hoping) and gives the scout a
targeted starting point.

Digest rules:
- Chronological, oldest first. Keep dates (`YYYY-MM-DD`) and author display name.
- One bullet per comment that carries signal. Skip pure noise ("ok", "thanks",
  bot pings, status changes with no text).
- Extract and highlight, when present:
  - **AC changes / decisions** ("we decided to keep the field required").
  - **Reproduction data** — VINs, deal ids, plate numbers, user accounts,
    environment (TEST/STAGE/PROD), state, dealer, feature-flag combos.
  - **Error messages / stack traces / status codes / log excerpts**.
  - **File / endpoint / component / service names** mentioned by devs.
  - **Q&A pairs** — question in one comment, answer in a later one.
  - **External links** — screenshots, Slack threads, other tickets, Confluence.
  - **Attachments** referenced from `attachment[]` on the issue.
- If comments contradict the description, keep both and mark the contradiction.
- If a comment says "see attached" and there is an attachment, note the
  attachment filename — the scout will not open binaries but should know it exists.

This digest is passed to the scout as `<COMMENTS_DIGEST>` alongside the full
raw comments. The scout is told to re-read raw comments too — the digest is a
speed aid, not a replacement.

### 2. Auto-skip guard

- A key with a skip prefix (Configure) → not a code ticket. Print a one-line note and stop.
- Ticket status `Closed` / `Resolved` / `Done` → confirm with the user before continuing (they may want a post-mortem, but also may have pasted the wrong key).

### 3. Locate likely code area (coordinator side, cheap pass)

Before spawning the scout, do a fast, cheap area guess so the scout starts focused:

1. **Key prefix → area** (fill in for your projects; example shape):
   - `ABC-*` → `app/feature-a/`
   - `XYZ-*` → `app/feature-x/`
   - `CORE-*` → cross-cutting; use summary/description keywords
2. **Labels / components** may override the prefix guess.
3. **Summary keywords** — a `rg -l` for 2–3 distinctive nouns from the summary inside the guessed folder confirms the guess.

Record the guess as the scout's starting folder. If confidence is low, mark it as "unverified — scout should validate".

### 4. Spawn the read-only scout subagent

Use the `subagent` tool. Model: default (same as coordinator). If the ticket description is small and the area is narrow, downgrade to Sonnet to save budget; do NOT use Haiku for real investigation (it misses cross-file relations).

**The scout prompt MUST enforce read-only behavior via wording.** Pi does not restrict tools per subagent, so discipline lives in the prompt. Copy the block below verbatim, substituting `<TICKET_KEY>`, `<SUMMARY>`, `<DESCRIPTION_PLAINTEXT>`, `<COMMENTS_PLAINTEXT>`, `<AREA_GUESS>`, `<FOCUS_HINT>`.

```
You are a READ-ONLY scout subagent. Your job is to investigate a bug and return a
findings report. You MUST NOT modify anything.

Hard rules — violating any of these is a failure:
- Do NOT call `edit`, `write`, `lsp_fix`, or any tool that mutates files.
- Do NOT run `bash` commands that write, install, migrate, commit, push, delete,
  build, start a dev server, or run tests. Read-only shell only: `ls`, `rg`, `grep`,
  `find`, `cat`/`head`/`tail`, `git log`, `git blame`, `git show`, `git diff` (no
  `--apply`), `git status`. If a command would touch state, skip it and note the
  gap in the report.
- Do NOT open terminal panes, dev servers, or browser sessions.
- Do NOT propose a fix or write code. Only describe the current behavior, the
  suspected cause, and the evidence.
- Do NOT commit or create branches / worktrees.

Project context (read BEFORE any code exploration):
- `<repo>/AGENTS.md`
- any nested `AGENTS.md` for the area you land in
- any project guide relevant to that area (forms, services, components,
  testing, styles).

Ticket:
- Key: <TICKET_KEY>
- Summary: <SUMMARY>
- Description (plaintext):
<DESCRIPTION_PLAINTEXT>

- Comments digest (coordinator's chronological summary — latest AC / repro /
  evidence / Q&A / references / tags):
<COMMENTS_DIGEST>

- Full comments (plaintext, chronological — oldest first so you can see how the
  understanding evolved):
<COMMENTS_PLAINTEXT>

Comments are authoritative over the description whenever they conflict. If the
digest and the raw text disagree, trust the raw text and flag the mismatch in
Open Questions.

Starting area guess (verify or reject): <AREA_GUESS>
Extra focus hint from the developer: <FOCUS_HINT>

Investigation checklist:
0. Re-read the comments digest AND the full comment thread before touching code.
   Note any late-breaking AC / decisions that override the description. If a
   comment names specific files, VINs, deal ids, endpoints, or error messages —
   start from those, not from the area guess.
1. Confirm or reject the area guess. If wrong, find the real one and say how you got there.
2. Identify the exact files / functions / components involved. Give paths relative
   to the repo root and, where useful, line numbers (e.g. `path/to/file.ts:123`).
3. Trace the flow that produces the reported behavior (call chain, state transitions,
   HTTP calls, template bindings — whatever applies).
4. Form ONE primary hypothesis for the root cause, plus at most two alternates.
   Back each with concrete code evidence (short quotes or path:line refs).
5. List reproduction preconditions (state code, user role, feature flag, profile,
   data shape) — do NOT try to reproduce, just enumerate.
6. Flag risks and blast radius: what other states / solutions / flows touch the
   same code and could regress.
7. List OPEN QUESTIONS the developer needs to answer before a fix can be planned
   (missing AC, ambiguous copy, unclear API contract, needs PM/design input).
8. If the ticket looks blocked (waiting on portal team, service change, design
   input), say so explicitly and stop early.

Output format (Markdown, in this exact order — omit empty sections):

## Ticket
<KEY> — <one-line summary>

## Area confirmed
<folder(s) with brief justification>

## Files in scope
- `path/to/file.ts:LINE` — role in the flow
- ...

## Comments takeaway
<2–5 bullets: what the comments changed vs the description, key repro details,
unanswered questions raised in-thread>

## Flow trace
<short prose or numbered steps of what happens today>

## Root-cause hypothesis (primary)
<one paragraph; cite path:line evidence>

## Alternate hypotheses
- <alt 1 + evidence>
- <alt 2 + evidence>

## Reproduction preconditions
- <state / role / flag / data>

## Blast radius
<other consumers of the same code>

## Open questions
- <question the developer must answer>

## Blockers
<empty if none; otherwise name the blocker and who owns the unblock>

Keep the whole report under ~400 lines. Prefer path:line evidence over long code
quotes. When in doubt about scope, ask a focused OPEN QUESTION rather than
guessing. Do NOT include a fix plan.
```

Launch the subagent, capture the run id, then poll with
`agent_message({ action: "session", runId: "<id>" })` and read the final report
with `agent_message({ action: "tail", runId: "<id>" })`.

### 5. Return the report to the coordinator (you)

Print the scout's report **verbatim** to the user, prefixed with a compact 3-line
header:

```
Ticket: <KEY> — <summary>
Status: <Jira status> | Assignee: <name or —> | Sprint: <name or —>
Parent: <parent key or —>
```

After the report, print **one** short "next step" line — no plan, just a choice:

```
Next: hand to Claude Opus 5 for a fix plan, or to Fable for a payment/security
plan, or spawn a normal implementation subagent if the fix is obvious.
```

Do NOT propose the plan yourself. The user picks who plans.

**Output-hygiene note (pacing).** The collaborating-agents extension will
auto-post the scout's raw output on the NEXT coordinator turn after the scout
completes. Timing rules to keep the UI clean:

- Poll `agent_message({ action: "session", runId })` until
  `Status: completed`. Then spend ONE turn presenting the header + verbatim
  report + next-step line. The auto-post arrives during this turn (may show
  the same content twice — acceptable, single duplication is fine and lets
  the user compare).
- Do NOT chain a hand-off (a planning or review subagent) in the same turn as the
  scout completion. Wait for the developer's decision first.
- When the developer says "hand to Opus" (or similar), that hand-off runs on
  its own turn. When the hand-off subagent returns, your reply MUST be only: verdict +
  short plan summary + decision prompt. Do NOT re-quote the scout's report,
  do NOT re-quote Opus's full plan, do NOT dump the launch prompt. Those are
  in earlier turns / auto-posts already.

## Rules and gotchas

- **Never** post Jira comments or transition the ticket from this skill.
- **Never** print credential values or interpolate them into the subagent prompt.
- **Do not** run `npm run devserver`, `npm run test-ci`, or any build during
  investigation. Scout must not either.
- If the scout returns something that looks like a fix diff or edits code
  anyway, discard the diff and re-run with the prompt strengthened (or fall
  back to your own read-only exploration). Report the violation to the user.
- If the ticket is a subtask (`parent` present), the scout report should refer
  to the parent's AC when there is no local AC on the subtask.
- One scout per invocation. If the ticket needs both frontend and backend
  investigation (rare — this repo is FE-focused), spawn two scouts in parallel
  with narrowed prompts, then merge the reports under one header.
- If the scout runs out of budget or its session dies, keep whatever partial
  report was produced and mark unfinished sections `## <section> — UNFINISHED`
  before returning to the user.

## Not in scope (do not attempt)

- Writing tests, adding TODOs, or renaming symbols — even trivial ones.
- Reproducing the bug in a browser or by running the app.
- Estimating effort or points — that is a separate conversation with the team.
- Assignment recommendations — `jira-daily-triage` does that.
