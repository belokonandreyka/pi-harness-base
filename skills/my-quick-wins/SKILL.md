---
name: my-quick-wins
description: >-
  Personal daily plan — fetch the user's own tickets from their Jira filter, read each in depth via a read-only scout subagent that greps the real code, and report what can be fixed today. Prioritises current-sprint READY tickets with trivial/small complexity as "quick wins" and surfaces obvious trivial picks from future sprints as bonus picks. Skips non-code project keys by config. **Primary trigger: "plan my day"**. Also triggers on: "my quick wins", "what should I pick up", "personal triage", or when the user gives a Jira filter and asks for **personal** picks. Not team planning: no workload, no assignment, just quick-win detection for one backlog. Caches scout verdicts day to day; only tickets changed in Jira, git or a CI deploy are re-scouted, "plan my day fresh" redoes all.
---

# my-quick-wins — personal daily plan

Primary trigger phrase: **"plan my day"**.

Read this skill before any tool call. It is authoritative for the flow.

## Configure

Everything site-specific lives in `<agent-dir>/my-quick-wins.json` (agent dir
= `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Start from
`config.example.json` next to this file. Read it at the start of every run;
the values below are referenced as `cfg.<key>`.

| Key | Meaning |
|---|---|
| `jiraSite` | the `<site>.atlassian.net` host name |
| `filterId` | the user's personal Jira filter (typically `assignee = currentUser() AND unresolved`) |
| `reposRoot` | parent directory of every repo the scout may point at (`~/work`) |
| `primaryRepos` | repos always checked for `<KEY>` commits and `origin/<KEY>` branches |
| `integrationRefs` | which remote branch counts as "landed", first match wins |
| `skipPrefixes` | project keys that never hold code (time tracking, ops) |
| `skipKeys` | tickets pinned out of the triage until removed here |
| `serviceEmails`, `serviceNames` | CI accounts whose comments are deploy signals, not human |
| `rulesPaths` | per repo, the files whose change means every verdict is stale (`AGENTS.md`, docs) |
| `contextFiles` | what the scout reads first |
| `maxAgeDays` | verdict TTL |
| `language` | language of the report and the scout's prose, e.g. `en`, `ru`, `uk`; the cache script's own one-line messages ship in `en`, `ru` and `uk`, anything else prints them in English |
| `cache` | where verdicts live; default `<agent-dir>/state/my-quick-wins/cache.json` |

## When to use

- **Primary trigger**: the user says **"plan my day"**.
- Also: "my quick wins", "what should I pick up", "personal triage", or a
  Jira filter with a request for **personal** picks (not team-level).
- Not for team planning: no team workload, no assignment recommendations.
  Every ticket in the filter is already the user's.

## Inputs

- **Filter ID** — `cfg.filterId`, or an override if the user gives a
  different filter ID or URL.
- **Date scope** — the whole filter, no recency clause. Do NOT add
  `updated >= startOfDay(-1d)`. If the filter returns > 20 tickets, ask
  whether to triage all or scope to the current sprint only.
- **`fresh` modifier** — "plan my day fresh" ignores the day-to-day cache
  and re-scouts every ticket (see step 5b).
- **Output language**: `cfg.language`. The bold field labels in the scout's
  blocks and the enumerated values stay exactly as written in step 6 in
  either language — the cache script parses them.

## Auto-skip rules (quiet)

Drop these from the report body — mention them only as a one-line note:

- keys with a prefix in `cfg.skipPrefixes` — `Skipped: N <PREFIX>-* tickets`;
- keys in `cfg.skipKeys` — `Skipped: N pinned (<keys>)`; do not fetch their
  descriptions or comments, do not put them in any bucket or the table. The
  user can opt in with "include pinned" for a one-off check.

If the list is empty after the skip, say so ("only non-code tickets in the
backlog") and stop.

## Credentials

- Username: `$JIRA_GIT_HOOK_USERNAME`
- Token: `$JIRA_GIT_HOOK_TOKEN` (a scoped token works only through the
  `api.atlassian.com` gateway; the site URL returns 404/permission errors)

NEVER echo, print, paste, or interpolate their values. Use only inside
`curl -u "$VAR:$VAR"`. If either env var is missing, tell the user and stop.

## Blocker triage — check `is blocked by` before deep analysis

**Trigger:** ANY ticket candidate. Run BEFORE deep code investigation,
BEFORE creating a worktree, BEFORE any scaffold work.

1. `issuelinks` is in the field list already. Scan for links of type
   `Blocks` where the **inward** direction points at this ticket (this
   ticket is BLOCKED BY the linked one). `Relates` is soft context, not a
   blocker.
2. For each inward-Blocks link, read the blocker's `status`. Terminal =
   `Resolved`, `Closed` or `Done`.
3. If ANY blocker is not terminal → classify the candidate as **BLOCKED**.
   Stop further investigation. Surface the blocker key + status + assignee
   and move on.
4. **Exception — reality check on the integration branch.** When the
   blocker is contract-shaped and easy to grep for (a backend field, a
   controller method, an enum member), do one fast read-only grep against
   the integration ref to check whether it already landed. If yes → report
   the Jira/reality inconsistency and ask the user before proceeding. Do
   NOT silently override the blocker.
5. If the grep finds nothing, wait until the blocker is terminal. Do not
   schedule the ticket, do not open a worktree, do not pre-write anything.

Two precedents shaped this rule. A backend field landed on the integration
branch in a commit without the ticket key and the author confirmed it in a
comment; the scout grepped only the frontend, saw no generated type and
returned BLOCKED although the ticket was READY pending a contract regen.
Hence the backend-first check in the scout prompt and the backend folders in
`Paths`. And two UI tickets surfaced as "today's quick wins" while both were
inward-blocked by an open backend ticket; the feasibility run correctly
returned NO-GO, and this rule keeps them out of the next run until the
blocker lands.

## Flow

### 0. Resolve gateway BASE (once per run)

```bash
CLOUD_ID=$(curl -s https://<cfg.jiraSite>.atlassian.net/_edge/tenant_info \
  | sed -e 's/.*"cloudId":"\([^"]*\)".*/\1/')
BASE="https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3"
```

### 1. Resolve the filter

```bash
curl -sS -u "$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN" \
  -H "Accept: application/json" \
  "$BASE/filter/<cfg.filterId>"
```

Extract `.name`, `.owner.displayName`, `.jql`. Print the name for context.

### 2. Fetch tickets

Use the resolved JQL as-is (do NOT add `updated >=`). Append sprint-aware
ordering if the filter's ORDER BY doesn't already handle it:

```bash
JQL='<filter jql>'
curl -sSG -u "$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN" \
  -H "Accept: application/json" \
  --data-urlencode "jql=$JQL" \
  --data-urlencode "fields=summary,status,priority,updated,parent,components,labels,description,customfield_10007,issuetype,issuelinks,subtasks" \
  --data-urlencode "maxResults=100" \
  "$BASE/search/jql" > /tmp/mywins-<runid>/issues.json
```

`issuelinks` and `subtasks` feed the blocker triage, the hand-off check and
the cache fingerprint (another layer's share of a story is usually a
sub-task, which `issuelinks` does not show). Keep
the raw response in `/tmp/mywins-<runid>/issues.json` — step 5b reads it.

Paginate via `nextPageToken` if `isLast` is false. A personal backlog rarely
exceeds one page; if it does, ask how to scope (all vs current sprint only
vs top-N by priority).

`customfield_10007` is Sprint (array of `{ id, name, state }`) on a default
Jira Cloud site; check the field id on yours once.

### 3. Determine current sprint

1. Union all sprint entries across (non-skipped) tickets, pick the one with
   `state == "active"`.
2. If none of the returned tickets is in an active sprint, probe:
   ```
   JQL='<filter jql> AND Sprint in openSprints()'
   fields=customfield_10007
   maxResults=1
   ```
   Read the returned ticket's sprint array and pick the `active` one.
3. If the probe returns zero, fall back to the highest trailing number.
4. If still nothing, print `## Sprint: —` and continue.

The current sprint name shapes the "quick wins today" bucket below.

### 4. Auto-skip filter

Drop `cfg.skipPrefixes` and `cfg.skipKeys` from the working set. Count them
for the skipped-summary line.

### 5. Per-ticket comment fetch (parallel)

For each remaining ticket, pull the latest 10 comments in parallel (10, not
5: CI posts a service comment per deploy, and those must not push the human
comments out of the window):

```bash
curl -sS -u "$JIRA_GIT_HOOK_USERNAME:$JIRA_GIT_HOOK_TOKEN" \
  -H "Accept: application/json" \
  "$BASE/issue/<KEY>/comment?orderBy=-created&maxResults=10" \
  > /tmp/mywins-<runid>/<KEY>.comments.json
```

The description is already in `issues.json`; write it to
`/tmp/mywins-<runid>/<KEY>.json` for the scout (`{summary, description,
related}`, where `related` is every linked ticket and sub-task as
`{key, type, status, summary}`).

Walk ADF (`content[].content[].text`) for both — do not dump raw JSON.

### 5b. Day-to-day cache — decide who gets re-scouted

The scout costs about $0.5 per ticket and the backlog barely changes between
two mornings, so verdicts are kept in `cfg.cache` and only tickets with a
reason are re-scouted. Run:

```bash
python3 <skill dir>/scripts/mywins_cache.py plan \
  --issues /tmp/mywins-<runid>/issues.json \
  --comments-dir /tmp/mywins-<runid> \
  --fetch --json /tmp/mywins-<runid>/plan.json
```

Add `--fresh` when the user said "fresh". `--fetch` runs `git fetch --prune`
in `cfg.reposRoot/<repo>` for every repo a cached verdict points at (it never
touches the working tree). Print the script's summary verbatim (`Cache: N
unchanged · M to re-scout …` plus the reasons per ticket).

What invalidates a verdict (the script decides, you don't):

- `new` — not in the cache; `jira:<part>` — summary, description, status,
  blocker statuses, the status of **any** linked ticket (a `Relates` backend
  task getting Resolved is what lifts a "no endpoint" verdict) or the last 5
  **human** comments changed (service comments are excluded from the
  fingerprint, otherwise every deploy would bust it); `cache-upgrade:<part>`
  — the cache predates that part, one-off re-scout;
- `deploy:<repo>/<env>` — a new CI "deployed to …" comment on the ticket
  (its own code moved); `service-deploy:<repo>` — a CI build on *another*
  backlog ticket shipped commits for a repo this verdict's `Paths` point at;
- `git:…` — since the cached integration-ref sha: commits mentioning the
  key **or any linked ticket's key** (backend work lands under the backend
  task's key, not the UI ticket's), commits touching the verdict's `Paths`
  folders, or `origin/<KEY>` appeared / moved (someone started or advanced
  it);
- tickets with a non-terminal inward blocker are never in `rescout` (the
  blocker-triage rule above); they are listed as `⛔ BLOCKED by …` and go
  straight to 7e. When the blocker closes, `jira:blockers` fires;
- `stale:Nd` — older than `cfg.maxAgeDays`, a TTL against drift the paths
  don't catch; `rules-changed` — a `cfg.rulesPaths` file changed, all
  verdicts go; `fresh` — the user asked.

`plan.json` carries, per ticket, `rescout`, `reasons`, and for kept tickets
the cached `block` (the scout's Markdown), `fields` and `scoutedAt`. It also
has `changes` (new / gone / status / sprint / comments / blockersClosed /
linksResolved / deploys / branches) for the "what changed" section of the
report, and `skipped`.

**If `rescout` is empty, skip step 6 entirely** and go to 6b.

### 6. Complexity assessment via a scout subagent (deep path — MANDATORY)

Do NOT judge complexity from summaries alone. Spawn a **read-only scout
subagent** to actually grep the codebase and evaluate each ticket **in the
`rescout` list of step 5b** (kept tickets already have a verdict). Pass no
`type`: the default executor tier is the right one here, and naming a model
pins this skill to a tier that will move again.

Batching:

- ≤ 8 tickets to re-scout: one subagent, all tickets in one prompt.
- > 8: split into batches of ~6–8 tickets, spawn 2–3 scouts in **parallel**
  via `subagent({ tasks: [...] })`. Each gets its own subset.

Scout prompt template (Markdown-per-ticket; write the prose in
`cfg.language`; keep the bold labels and the enumerated values exactly as
below — a script parses them):

```
You are a senior engineer in the repositories under <cfg.reposRoot>. This is
a personal triage for <user>.

LANGUAGE: write all prose in <cfg.language>. Keep every bold field label
below (**Complexity**, **Scope**, **Paths**, **Risks**, **Readiness**,
**Quick-win**) and the enumerated values (trivial/small/medium/large/xl,
READY/NEEDS CLARIFICATION/BLOCKED/STALE/REDIRECT, yes/no, the layer names)
exactly as written.

READ FIRST:
<cfg.contextFiles, one per line>
Then any project guide relevant to the area you land in.

Tickets (description + latest comments in /tmp/mywins-<runid>/<KEY>.*.json,
ADF; walk content[].content[].text):

- <KEY-1> — <summary>
  related: <KEY> (<status>, <link type | sub-task>) «<summary>»; … or «—»
- <KEY-2> — <summary>
- ...

For EACH ticket produce:

1. **Complexity**: `trivial` (1 file, ~30 min) / `small` (~half a day, 1-2
   files) / `medium` (1-2 days) / `large` (3+ days) / `xl` (epic).
2. **Scope**: 2-3 lines — which folders/files/services; is there a
   reference implementation nearby; does it need a backend contract change.
3. **Risks**: 1-3 bullets (generated contract, screenshot tests,
   cross-cutting impact, dependency on an external service).
4. **Readiness**: `READY` / `NEEDS CLARIFICATION` / `BLOCKED` / `STALE` /
   `REDIRECT`. `REDIRECT` — the cause is found but the diff lands outside the
   user's layer (item 7): the ticket goes to that layer's owner. A ticket in
   the user's filter is not proof the fix is theirs, and "the code is in our
   repository" is not "our layer" when several teams share the repository.
   If NEEDS CLARIFICATION — name what is missing in one line (no draft
   comment; this is a quick-win triage).
   Before writing BLOCKED because of a backend contract, check the backend
   source, not only the generated frontend types: grep the backend folders
   in the working tree **and** on the integration ref
   (`git grep <field> <integration ref> -- <backend folders>`). Generated
   code lags until someone regenerates it; a field missing there proves
   nothing. If the field exists in the backend but not in the generated
   types — that is `READY` with a note "needs a contract regen", not
   BLOCKED.
   Read comments chronologically: the implementer's reply to a support
   request ("done", "deployed", "should be deployed now") lifts the blocker
   unless someone objected after it.
5. **Quick-win**: `yes` / `no` + one sentence why. Rules:
   - complexity trivial or small;
   - readiness READY;
   - scope does not depend on a PM or backend answer;
   - the layer is the user's own; any other layer is quick-win `no` and
     readiness `REDIRECT`;
   - no unresolved question in the comments from anyone on the team.
6. **Paths**: a machine line for the cache — folders (not files) to watch
   to know the verdict went stale. Format strictly
   `<repo>: <dir>, <dir>; <repo>: <dir>` where repo is the directory name
   under <cfg.reposRoot> and paths are relative to the repo root. Example:
   `web-app: src/app/reports, src/app/shared/http; pay-sdk: src/PaymentOptions`.
   If the ticket depends on a backend contract, include the backend
   folders too (models, controllers), not only the generated types:
   backend commits often carry no ticket key, and the cache catches them
   only by path. If the code is not in our repos — `Paths: —`.

7. **Layer**: where the diff lands — `UI`, `BACKEND`, `SERVICE` (another
   repository or a vendor adapter), `STYLES` (shared styles), `MIXED` (name
   both) — then, after a dash, that layer's owner: from the ownership
   document among the context files; when the project is not listed there,
   the recent authors from
   `git log --format=%an -- <path> | sort | uniq -c | sort -rn | head -3`.
   For `MIXED` say which part is whose and whether the user's part can ship
   alone. The user's own layer is stated in the context files; when it is
   not, assume `UI` is theirs and say that you assumed it.

8. **Blocked on**: whose part the ticket waits on — `BACKEND` (a missing
   field, endpoint or fix on the server side of this repository), `SERVICE`
   (another repository, a vendor adapter), `PM` (an unanswered question),
   `EXTERNAL` (a vendor, an authority), or `—` for nothing. After a dash,
   what exactly is missing, in one sentence the layer owner understands
   without context. Fill it for `BLOCKED`, `NEEDS CLARIFICATION` and
   `REDIRECT` alike. Look at `related` and the comments first: a closed
   sub-task or link for that layer, or its owner answering "provided / done /
   deployed", means the layer has ALREADY delivered its share. Confirm it in
   the code (`git log --grep <sub-task key>`, the endpoint on the integration
   branch); `Blocked on` is then only what is STILL missing. If the main scope
   can be built and one acceptance criterion or a product decision is open,
   that is `PM`, not `BACKEND`/`SERVICE`, and readiness is `READY` for the
   main scope with a note about the open criterion. Whether a related task
   formally covers the blocker is checked by the cache script.

Format — one Markdown block per ticket (the `### KEY — …` heading is
mandatory, the cache splits the output on it):

### <KEY> — <short title>
**Complexity**: trivial/small/medium/large/xl
**Layer**: UI | BACKEND | SERVICE | STYLES | MIXED — owner: <name> (backup <name>)
**Scope**: ...
**Paths**: <repo>: <dir>, <dir>; <repo>: <dir>
**Risks**: ...
**Readiness**: READY | NEEDS CLARIFICATION | BLOCKED | STALE | REDIRECT (+ short why)
**Blocked on**: BACKEND | SERVICE | PM | EXTERNAL | — (+ what exactly is missing)
**Quick-win**: yes/no — <why>

Do not retell the description — it is already in the files. Focus on the
code and on speed.
```

Wait for completion via `agent_message({ action: "session", runId })` until
`Status: completed`, then verify the output is complete (all tickets
covered).

If the scout is unavailable or repeatedly failing, fall back to a
preliminary coordinator assessment BUT mark the report with a warning
("⚠ estimates without a scout — may be inaccurate"). Do NOT store such
assessments in the cache (skip `--scout` for them in 6b); the ticket will be
re-scouted next run.

### 6b. Store verdicts and today's snapshot (ALWAYS, even with no scout)

Write each scout's final message to `/tmp/mywins-<runid>/scout-<n>.md` and:

```bash
python3 <skill dir>/scripts/mywins_cache.py store \
  --issues /tmp/mywins-<runid>/issues.json \
  --comments-dir /tmp/mywins-<runid> \
  --scout /tmp/mywins-<runid>/scout-1.md --scout /tmp/mywins-<runid>/scout-2.md
```

After the "Stored verdicts" line `store` prints hand-off candidates, from the
scouts' `**Blocked on**` field and the tickets' open `issuelinks`:

```
  ↪ Hand off: APP-1437 — waits on BACKEND, no open blocker or related task for that team in Jira
  ? Check: APP-711 — waits on SERVICE; open links: SVC-705 (Open) «Adapter: return signer order» — is one of them that team's task?
```

They feed section 7e2.

Run it with no `--scout` when nothing was re-scouted — it still records
today's statuses, comments, deploys, branch tips and integration-ref shas,
which is what tomorrow's "what changed" and git checks compare against.
Tickets that left the filter are dropped from the cache here.

### 7. Consolidated report

In `cfg.language`, and only that language; the headings below are English,
translate them when `cfg.language` is not `en`.
Output in this order:

#### 7a0. What changed since the last run

From `plan.json` → `changes` (skip the whole section on the first run, and
print `No changes since the last run.` when every list is empty):

```
## 🔄 What changed since yesterday

- new: NEW-1; left the filter: OLD-2
- status: PAY-5747: Open → In Progress
- new comments: APP-1458: +1
- blockers closed: APP-1400: APP-1402 → Resolved
- deploys: SVC-580: reg-service → stage
- branches: PAY-5747: origin/PAY-5747 appeared in web-app
- re-scout: 3 (APP-1458: jira:comments; …) · from cache: 12
```

This is the part the user reads first — everything below they saw
yesterday.

#### 7a. Current sprint heading

```
## Sprint: Sprint 378
```

#### 7b. Quick wins today (top section)

Highlight up to **5** tickets from the working set that satisfy:

- Never a `REDIRECT` ticket, and never one whose layer is not the user's,
  whatever the scout wrote in `Quick-win`. List those first, under a
  `## ↪ Redirect` heading, one line each: layer, owner, the cause in a clause.
- **Primary bucket** (current sprint): Quick-win = yes AND sprint =
  current-active.
- **Bonus bucket** (future sprint / no sprint): Quick-win = yes AND
  complexity = trivial ONLY (not small). Never propose small/medium from
  future sprints — it breaks the sprint plan.

Sort primary before bonus; within each bucket by priority DESC, then
complexity ASC (trivial before small).

```
## 🎯 Quick wins today

1. **<KEY>** — <short summary> · trivial · <one-line hint>
2. **<KEY>** — ...
```

If there are none, print the heading and `Nothing quick in sight — see the
table below.` Do not stay silent.

#### 7c. Full table

One row per non-skipped ticket, current sprint first (priority DESC, then
updated DESC), then future/no-sprint (same sort):

```
| Key | Prio | Sprint | Status | Upd | Complexity | Layer | Readiness | Summary |
|-----|------|--------|--------|-----|------------|-------|-----------|---------|
| APP-1666 | Major | S 378 | Open | 2d ago | small | UI | READY | Autologout ... |
```

Rules: `Upd` — `today HH:MM` / `yest HH:MM` / `Nd ago`; `Sprint` — full
name or `—`; `Summary` — truncate ~60 chars with `…`; `Complexity` and
`Readiness` come from the scout (from `fields` for kept tickets).

Right after the table print the skipped-summary line, e.g.
`Skipped: 0 TIME-* · 2 pinned.`

#### 7d. Per-issue detail (compact)

For **each ticket in the quick-wins buckets** (7b) — the full scout block.
Others — skip (the user can drill into any one on request). For a ticket
taken from the cache, append `(scouted YYYY-MM-DD)` to its heading from
`scoutedAt`, so the age of the verdict is visible; drop the `**Paths**` line
from what the user sees.

#### 7e. Actions to unblock (only if any NEEDS CLARIFICATION / BLOCKED)

A list of tickets with `NEEDS CLARIFICATION` / `BLOCKED` with a one-line
note of what or whom to ping. This is NOT a Jira comment, only a reminder.
No draft texts — this skill is about quick wins, not comment writing.

```
## 🔓 Unblock:

- **APP-1437** — BLOCKED by APP-1439 (owner). Ping if needed for the sprint.
- **APP-7094** — NEEDS CLARIFICATION from the PM about the composite key API. The question is already on the ticket.
```

#### 7e2. Hand off to another team (only if `store` printed candidates)

A ticket that waits on another team's layer with nobody on that side
tracking it will wait forever in the user's filter. For every `↪ Hand off`
line, and for every `? Check` line where none of the open links is that
team's task, propose the reassignment:

```
## 📤 Hand off

- **APP-1437** → <backend owner> (BACKEND): the response DTO lacks
  `thirdPartyFee`; the ticket has neither a blocker nor a related backend
  task. Suggest reassigning with a comment about that field. Say "hand off
  APP-1437".
```

- The owner comes from the ownership document among the context files, by
  project and layer; git authors of the path when nothing is listed.
- A closed sub-task or link of that team means it has already delivered
  something. Do not write "nobody tracks this": say what was delivered and
  what is still missing, and propose a comment in the existing thread or on
  that sub-task instead of a reassignment, unless the missing part is new
  work that needs its own ticket.
- A linked ticket counts as that team's task when its summary or type names
  the layer or it is assigned to the layer owner. If such a task exists the
  ticket is simply blocked: list it under 7e and, when the link type is not
  "is blocked by", say that it should be.
- `REDIRECT` tickets are already listed under `## ↪ Redirect`; do not repeat.
- The line carries the substance of the comment in a clause, not a draft.
  Only after the user says "hand off KEY" write the full comment, show it,
  wait for approval of the exact text, then post it and reassign.

#### 7f. Questions to the user

None. The skill reports and recommends — the user decides.

## Limits and gotchas

- **Read-only.** Do NOT comment, transition, reassign, or push from within
  this skill.
- **A ticket in the filter is not proof it is the user's to fix.** If they
  say "take KEY" for a ticket whose layer is not theirs (or that has no layer
  yet), name the layer and its owner and ask before creating a branch. The
  case this rule comes from: a backend fix sat in a frontend developer's
  filter, the scout called it READY "in our repository", it topped the quick
  wins, and the coordinator implemented and reviewed a change that belonged
  to another team.
- **Do NOT auto-spawn implementation subagents.** A quick-win recommendation
  is an invitation. The user says "take KEY-N", and a separate flow starts.
- **Do NOT run dev servers, test suites, or `git status`** as part of the
  triage — the goal is a fast readable overview, not a dev loop.
- **Do NOT re-fetch** tickets across turns. Raw Jira JSON lives in
  `/tmp/mywins-<runid>/` per run; verdicts persist in `cfg.cache` (delete it
  for a cold start).
- **Cache limits.** A verdict can go stale without any signal firing when
  code changed in a shared service the scout did not list under `Paths` —
  the TTL bounds that, not eliminates it. When the user doubts a kept
  verdict, "plan my day fresh" or asking for one ticket is the fix. Tests:
  `cd scripts && python3 -m unittest test_mywins_cache`.
- If a scout takes > 5 minutes on a batch of ≤ 8 tickets, ping the user
  before waiting more. It searches real code and can be slow on large files,
  but 5 minutes is the upper bound.
- If the filter grows past 20 tickets, ask the user to scope (current sprint
  only, or top-N by priority) before triggering the scout.

## Planned extensions (NOT yet implemented)

- **PR cross-reference**: mark tickets with an open PR authored by the user
  as "PR open" in the table and skip them from quick wins.
- **Auto-delegate**: after the user picks a quick win, spawn a worker
  subagent with the standard delegate pattern. A separate skill triggered by
  "take <KEY>", not baked in here.
