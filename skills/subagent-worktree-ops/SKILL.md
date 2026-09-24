---
name: subagent-worktree-ops
description: >-
  Operational playbook for spawning implementation subagents, deciding branch-vs-worktree, provisioning a fresh git worktree (node_modules symlink + husky runtime), handling commit gotchas in worktrees, merging a ticket branch into local `test` only when the user asks (never automatically), worktree cleanup, and the automatic subagent wake-on-completion verify+review turn. **Load this skill BEFORE any of: spawning an implementation subagent, delegating multi-file code changes, creating a git worktree, or handling a subagent completion / verify+review turn.** Examples come from an Angular repo with husky hooks, but the branch/worktree/wake-up rules apply to any repo.
---

# subagent-worktree-ops

Load this skill proactively when spawning an implementation subagent, creating a
git worktree, or handling a subagent completion (verify + review) turn.

## Subagent wake-up on completion

The collaborating-agents extension is configured locally with hidden launch /
completion messages and `triggerTurnOnSubagentCompletion: true`. A completed
subagent therefore sends a minimal wake token with its Run ID(s), then
automatically starts the coordinator's verify + review turn. The full result
remains in the durable run/session registry; it is not injected by the hidden
completion message.

**Do NOT instruct subagents to send an urgent completion DM.** Automatic
completion triggering replaces that workaround. Using both mechanisms can race
and start competing coordinator turns. Subagents should simply print their final
report after completing validation.

**In the automatically triggered completion turn do all of this:**

1. Read the Run ID(s) from the wake token, then call
   `agent_message({ action: "session", runId })` to confirm status `completed`
   and read the output preview. Use `agent_message({ action: "tail", runId })`
   when transcript detail is needed. **A report that announces a next step
   instead of taking it is an early stop, not a completion** (Opus 5.5 ends
   turns this way): its session and pane are still alive, so reply instead of
   verifying half-done work, at most twice, then respawn:

       agent_message({ action: "reply", runId, message: "Your task list still has open items: <them>. Continue with them. If one is blocked, say what is blocking it." })
   A run reported `failed`, exit code 1, whose last session entry is an
   assistant message with `stopReason: toolUse` and no tool call is not a crash:
   the gateway dropped the `tool_use` block, pi ended the turn on "tool use
   without any tool calls", and the child sat at its prompt until the
   inactivity timeout. The `dropped-toolcall-guard` extension now re-asks for
   the call; if it still shows up, respawn with the same prompt, nothing was lost.

2. `git diff HEAD` in the subagent's working directory (main checkout or
   worktree) to see the actual changes.
3. **Commit through the hooks — that is the DoD check.** In the repo's
   frontend root (for example `site/Scripts/`) stage the subagent's diff
   and commit with the message `TASK` (`TASK=<KEY>` when the branch is not
   named after the ticket). husky `pre-commit` runs lint-staged (eslint,
   `--max-warnings 0`) and `ngc -p tsconfig.cli.json --noEmit`;
   `prepare-commit-msg` replaces `TASK` with the ticket key and its Jira
   summary. Do not run `npm run lint` / `npm run check-types` separately and
   never use `--no-verify`. `npm run test-ci` is NOT in the hook: run it only
   when the diff touches existing `*.spec.ts` files or the code paths those
   specs exercise, scoped with `--include='**/<TICKET>.spec.ts'` or the
   nearest neighbour path; otherwise skip it (no new specs by default). If the
   commit is rejected, do NOT proceed to review — relaunch the subagent with
   the hook output and re-verify. Only a landed commit earns the review turn;
   review findings are applied as a follow-up commit (or amend, if the
   developer prefers) on the same branch.
4. Review by `subagent` `type: "opus-5"` (Opus 5 via the Vitu gateway,
   read-only tools) with the full review prompt; wait for its wake-up.
5. Present the review verdict to the developer with the landed commit (key +
   Jira summary as written by the hook), the follow-up-commit plan for any
   findings, and the next-step decision prompt.

Do verify + review in that same turn. Do not wait for or re-quote a
developer-facing auto-post; inspect the durable run record immediately.

**Corollary — subagent task prompts.** When spawning an implementer
subagent, its instructions MUST NOT:

- ask it to run `npm run lint`, `npm run check-types`, `npm run test-ci`, or
  any equivalent full-project verification (the coordinator's commit in
  step 3 runs lint + type-check through the husky hook);
- ask it to write a new spec / unit test unless the user has explicitly asked
  for one on this ticket, or the project's AGENTS.md says otherwise. The
  default is: no spec.

The subagent's Definition of Done is: (a) `lsp_diagnostics` on every edited file
reports 0 diagnostics (or each remaining one is justified in the report), (b) any spec it wrote (only if explicitly asked)
is syntactically valid, (c) it produced a compact final report with
`git diff --stat` and per-file notes. The heavy checks are the
coordinator's job in step 3 above. Subagents that duplicate them waste
tokens + wall-clock and regularly hit env-drift errors that mean nothing
(e.g. a stale karma process) which we then have to debug. Precedent:
a 2026-08-06 spawn originally asked Opus 5 to run all three
checks AND write a spec; corrected to coordinator-only + no-spec-by-default.

## Model routing

Which subagent type/model to pick per task class (executor, reviewer, recon,
mechanics), the Copilot-vs-subscription pool rule and the precedents behind it
are in `reference/model-routing.md`. Read it once per ticket, right before the
first spawn, then reuse the choice for the rest of the ticket.

## Branch upstream trap when starting a ticket from a non-default base

**Precedent: 2026-08-07, ABC-1445_2.** Started with
`git checkout -b ABC-1445_2 origin/stage` → git default `branch.autoSetupMerge=true`
silently set the new branch's upstream to `refs/heads/stage`. A plain `git push`
would have pushed the ticket work straight into `origin/stage`. Same trap applies
to any remote-tracking start point (`origin/master`, `origin/<someone-else>`).

A project skill may document the fix (`--no-track`) for one base branch and
not another, and the copy on the checked-out branch can lag behind. Reading the
project skill is not enough; the rule lives HERE.

**Rule (any repo): when the ticket branch's base is a
remote-tracking branch other than the same-name remote, use `--no-track`:**

```bash
git fetch origin --quiet
git switch -c <TICKET> --no-track origin/<base>       # stage, master, foreign branch
git push -u origin HEAD                               # first push, sets upstream to origin/<TICKET>
git branch -vv | grep '^\*'                           # verify [origin/<TICKET>], NEVER [origin/<base>]
```

Equivalent alternative when a synced local branch exists: `git switch <base> &&
git pull --ff-only && git switch -c <TICKET>`. Local-branch start points do NOT
trigger `autoSetupMerge`, so upstream stays unset until the first `push -u`.

The common `git checkout -b <TICKET>` (no start point, current HEAD is already
`test`) is unaffected — it uses the local `test`, not `origin/test`. That's why
two other branches were clean and only ABC-1445_2 tripped.

## Branch vs worktree — when to use which

**Default: plain branch in the main checkout.** For a single ticket with a
single implementer subagent (the common case), the coordinator just switches
the main checkout to the ticket branch and delegates. Simpler for the
developer (they see changes in their normal IDE path), no `node_modules`
symlink dance, no worktree cleanup.

**Use a dedicated worktree (`git worktree add ../<repo>-<TICKET> -b <TICKET> origin/<base>`) only when at least one holds:**

1. **Parallel work.** Two or more tickets are being worked on at the same
   time (either by different subagents or by the developer + a subagent),
   and they must not step on each other's `node_modules`, karma, screenshot
   caches, or working tree.
2. **Parallel agents on the same ticket.** Two or more implementer subagents
   editing different areas simultaneously.
3. **Coordinator has its own active branch context** (e.g. researching or
   drafting on a different branch) that would be lost by a branch switch
   in the main checkout.
4. **Long-running dev server / karma watch** is already up in the main
   checkout, and pausing it would be disruptive.

**Before switching the main checkout to a ticket branch, MUST verify:**

- `git status` in the main checkout is **clean** (no uncommitted or untracked
  changes that matter). If dirty, stop and ask the developer whether to
  stash, commit, or use a worktree instead. Do NOT silently stash.
- The developer is not mid-edit in their IDE on the current branch (ask if
  unsure).
- The current branch is not a shared long-lived branch being used elsewhere
  in a way that a switch would disrupt (rare, but check).

**After finishing a ticket in the main checkout**, leave the checkout on the
ticket branch until commit/push is decided. Only switch back to `test` (or
whatever the base is) after the developer confirms the ticket is done.

**Worktree cleanup** — when a worktree is used and the ticket is finished
(commit + push done, or hold decided): `git worktree remove --force
../<repo>-<TICKET>` (see "Worktree post-create provisioning" below for why
`--force` is expected and safe) and delete the branch if it was already
merged. Do not leave stale worktrees around; they duplicate ~1 GB of Angular
source per copy on this repo.

## Worktree post-create provisioning (mandatory)

`git worktree add` gives you a fresh checkout without `node_modules` and
without the `.husky/_/` runtime files that `npm install`'s postinstall
normally generates. If you skip provisioning, the subagent hits two failures:

1. `npm run lint / check-types / test-ci` — no `node_modules`, nothing runs.
2. `git commit` — husky pre-commit hook aborts with
   `.husky/_/husky.sh: No such file or directory`. Silent-fatal when piped
   through `| tail`, so the commit doesn't happen and the merge afterwards
   says "Already up to date" — easy to miss.

**Immediately after `git worktree add`, before spawning the subagent, run:**

```bash
MAIN=~/work/<repo>            # the repo's canonical main checkout
WT=../<repo>-<TICKET>

# 1. node_modules symlink — shared with main; safe as long as main isn't running
#    `npm run devserver` or a karma watch on the same tree.
ln -s "$MAIN/site/Scripts/node_modules" "$WT/site/Scripts/node_modules"

# 2. husky runtime (".husky/_/" is gitignored; regenerated by npm install postinstall).
mkdir -p "$WT/site/Scripts/.husky/_"
cp "$MAIN/site/Scripts/.husky/_/husky.sh" "$WT/site/Scripts/.husky/_/husky.sh"
```

Do NOT rely on the subagent to ask you about `node_modules` — that wastes a
round-trip. Provision proactively, mention it in the spawn prompt as "done
for you; do NOT run `npm install`".

## Commit gotchas in worktrees (repeat rules, not defaults)

- Run `git commit` **from inside the worktree** (its `git dir` is a linked
  reference to the main `.git`). Standard commands work; there is no extra
  flag.
- **Do NOT** pipe `git commit` through `| tail` in a `set -e` script — the
  pipe eats the exit code and a failed hook goes unnoticed. Use `set -o
  pipefail`, or just don't pipe the commit output.
- If the husky hook still fails after provisioning (e.g. hook file changed),
  `--no-verify` is acceptable **only** because you (the coordinator) already
  ran lint / check-types / test-ci in the verify turn and they passed. Never
  use `--no-verify` to skip a real failure.

## Merging, delivery bundle and cleanup

Everything after a green review — merging the ticket branch into local `test`
(only when the user asks), the four-item Jira delivery bundle after
`git push origin test`, post-delivery cleanup, the mandatory end-of-cycle
dangling-worktree sweep and cleanup details — lives in
`reference/delivery-and-cleanup.md`. Read it only when the user asks to merge,
push or deliver, or at the end of a cycle; the verify/review turn above never
needs it.
