# subagent-worktree-ops — reference: delivery-and-cleanup

Moved out of SKILL.md on 2026-09-05 to keep the skill body small; read this file only at the step in SKILL.md that points to it.

## Merging ticket branches into local `test` — only when the user asks

The project AGENTS.md may say "PRs are optional for minor changes,
mandatory for major core changes". So merging a ticket directly into
`test` and pushing IS a valid workflow for small tickets — but the
coordinator MUST NOT do it automatically as part of the verify/review
turn. Do it ONLY when the user explicitly asks ("мерж у test", "пуш у test",
"злий і пушни", or English equivalent).

**Default behavior after a green review:**

1. Coordinator commits on the ticket branch (in worktree or main checkout).
2. Coordinator asks the user what to do next: push ticket branch + open PR,
   OR merge into local `test` + push.
3. Do NOT preemptively `git merge <TICKET> test` "as a smoke test" — that
   leaves `test` at `[origin/test: ahead 1]` and one plain `git push`
   away from shipping a possibly-not-yet-approved change to remote `test`.
   Precedent: 2026-08-06 — coordinator merged into local
   `test` right after the review as a self-check for merge cleanliness;
   the user caught the `ahead 1` state and told coordinator to reset. When
   he explicitly asked to merge+push a minute later, that was the moment.

**When the user asks to merge + push — the sequence:**

```bash
cd <main checkout>              # main checkout, on `test`
git fetch origin --quiet
git merge --ff-only <TICKET>    # ff-merge from the worktree's branch
git push origin test            # may reject if remote moved — rebase and retry
```

If `git push` rejects because `origin/test` moved (another dev pushed in
the meantime, common on active repos): `git pull --rebase origin test`
followed by another `git push`. The ff-merge above becomes a rebase
automatically — no conflicts as long as the ticket branch had no
overlap with the interim commits (which is typical for isolated
frontend tickets).

**Merge-cleanliness dry-run without contaminating `test`.** If you want
to verify the merge is conflict-free BEFORE asking the user what to do,
use `git merge-tree origin/test <TICKET>` — no working tree touched,
no branch state changed, exit 0 = clean. Do NOT use `git merge --ff-only
test` as the "dry-run" — it's not a dry-run, it actually moves the
branch.

## Delivery-done bundle — Jira workflow after `git push origin test`

After a ticket branch is merged and pushed to `origin/test` AND the remote
advance is verified (`git fetch origin && git rev-parse origin/test` matches
the merged SHA), the ticket is not "done" yet — the Jira side has a
four-item bundle. Apply all four; skipping any one leaves the ticket in a
wrong state.

1. **Comment**: `Fixed and merged to test.` — exactly this literal. When part
   of the ticket stayed unfinished because another layer owes us something,
   append only the UI-side view of it — what the screen needs, what endpoint
   we call, what we don't get back. Do NOT prescribe the other layer's fix
   (no class names, no method overloads, no "line X hardcodes Y"), even when
   the investigation established exactly that; that detail goes in the report
   to the user, not the ticket. Tag the person who must act as
   `@Name — could you check it ?`, and anyone merely informed (PMs) as a bare
   `@Name — FYI` with no trailing explanation. Full rule + precedent: memory
   `feedback-jira-comment-stay-in-ui-lane` (2026-08-17).
2. **Transition to `Resolved` with Resolution = `Fixed`** (transition id from the
   project's Jira workflow; look it up once with `GET /issue/<KEY>/transitions`), **carrying the
   worklog in the same POST** (see below).
3. **Worklog with the approved time.** Comment is minimal by default —
   `Implementation and verification.` — unless the user explicitly asks for a
   longer note. Never paste the ticket description, root-cause analysis, or
   PR write-up into the worklog: that belongs in the ticket / PR, not in a
   time entry.
4. **`adjustEstimate=leave`** on the worklog so the ticket's remaining
   estimate isn't clobbered.

**Ordering rule (the user, 2026-08-17): NEVER `POST /issue/<KEY>/worklog`
before the transition.** Resolving on this instance always demands a worklog
and there is no way to decline it, so time logged beforehand does not count
toward the transition — it only leaves you two bad options: delete the entry
you just made, or log extra time you did not spend. Log time exactly once,
inside the transition. If the ticket genuinely needs time logged without
resolving (mid-work, or handing off), the standalone `/worklog` endpoint is
fine — just don't do it in the same turn you intend to resolve.

Precedent: 2026-08-17 ABC-649 and ABC-668 — worklog posted first in both, the
transition then demanded another, so a `1m` stub was added and immediately
`DELETE`d. Two wasted round-trips per ticket and a moment where the issue
carried a wrong total.

**Combine steps 2 and 3 in a single POST.** The `Resolve Issue` transition
on this instance carries a workflow validator (`Time Spent Required`) that
fails if the transition body has no new worklog entry — existing time on the
issue does NOT satisfy it, and the API rejects `timetracking.timeSpent` /
`timeSpentSeconds` as "Setting the Time Spent directly is not supported."
Use the transition's `update.worklog[].add` operation:

```json
{
  "transition": { "id": "771" },
  "fields":     { "resolution": { "name": "Fixed" } },
  "update":     { "worklog": [ { "add": {
      "timeSpent": "2h",
      "adjustEstimate": "leave",
      "comment": "Implementation and verification."
  } } ] }
}
```

**Two payload details inside `update.worklog[].add` — both differ from the
normal `/worklog` endpoint, and getting either wrong costs a 400:**

- **Duration MUST be `timeSpent` as a Jira duration string** (`"2h"`,
  `"30m"`, `"1d 2h"`). `timeSpentSeconds` is accepted by the JSON schema but
  does NOT satisfy the `Time Spent Required` validator — the transition
  returns `400 {"errorMessages":["Time Spent Required"]}` as if no worklog
  had been supplied at all. Confusing because the same field name works fine
  on a standalone `POST /issue/<KEY>/worklog`.
- **The worklog `comment` MUST be a plain string, NOT ADF.** An ADF doc here
  returns `400 {"errors":{"comment":"expected a string"}}`. This is the
  opposite of the issue-comment endpoint (`POST /issue/<KEY>/comment`), which
  requires ADF and rejects a bare string. Do not copy the ADF shape across.

Precedent: 2026-08-17 — coordinator hit both errors in sequence
(ADF comment → `expected a string`; then `timeSpentSeconds` →
`Time Spent Required`), three POSTs to land one transition. The corrected
payload above went through on the first try (HTTP 204).

A previously-used workaround — POST the real worklog separately, then
transition with a throwaway `{"timeSpent":"1m"}` and `DELETE` the stub
afterwards — is no longer needed. Prefer the single POST above; it leaves
exactly one worklog entry and needs no cleanup.

POST `/rest/api/3/issue/<KEY>/transitions`. On success returns HTTP 204;
read back status + resolution with `?fields=status,resolution,resolutiondate`
to verify.

**Precedent — 2026-08-14, ABC-671.** Coordinator did the comment and worklog
as two separate calls, then tried to transition later; the workflow
validator rejected the transition ("Time Spent Required"), and adding
another worklog to satisfy it would have double-logged. This is why the
transition MUST be bundled with the worklog on the transition itself.

## Post-delivery cleanup (automatic on green remote verify)

Once the four-item Jira bundle above is green AND `git rev-parse origin/test`
contains the merged SHA, the ticket's worktree is done. Cleanup runs
automatically as part of the same turn, no separate ask needed:

```bash
cd <main checkout>
git worktree remove --force ../<repo>-<TICKET>   # --force covers provisioned
                                                 # node_modules symlink + .husky/_
git branch -D <TICKET>                           # safe: commit lives on test
```

**Retain the worktree only when at least one applies** — otherwise remove:

- The change is unmerged and awaiting review / a backend contract answer
  (e.g. ABC-651 blocked pending the backend owner's contract confirmation).
- the user explicitly asked to keep it ("keep the worktree for later", "don't
  clean up", etc.).
- The commit is on the ticket branch locally but has NOT been pushed to a
  shared branch (would lose work).

Do not keep a worktree "just in case" once the SHA is on `origin/test` — it's
~1 GB of Angular source per copy and it drifts as `test` moves forward.

## Dangling-worktree inventory — mandatory end-of-cycle sweep

At the end of every implementation / review / delivery cycle — including
cycles where the just-completed task's own worktree was already cleaned up
by the Post-delivery cleanup step above — enumerate ALL remaining managed
task worktrees for the repository and surface them explicitly. Do NOT skip
this just because the current ticket is clean. The purpose is to catch
OTHER worktrees left over from earlier tasks (blocked, retained, forgotten,
or spawned in a parallel batch that partially failed) before they accumulate
into ~1 GB of stale Angular source each.

Coordinator runs this sweep unprompted. Do not wait for the user to ask.

**Procedure:**

1. `cd <main checkout>` and run `git worktree list` to get the current
   inventory. **Exclude the main checkout itself** — that's the developer's
   working directory, not a managed task worktree.
2. For each remaining task worktree, gather:
   - **Ticket key + branch name** (usually equal, e.g. `ABC-671`).
   - **Path** (`<main checkout>-<TICKET>`, or the actual disk path).
   - **Dirty vs clean** — `git -C <path> status --short`. Ignore the two
     provisioned artefacts (`?? site/Scripts/node_modules`,
     `?? site/Scripts/.husky/_/`) — those are noise, not real dirt.
   - **Ahead/behind vs `origin/test`** —
     `git -C <path> rev-list --left-right --count <branch>...origin/test`
     gives `<ahead>\t<behind>`. Then check merge state:
     `git -C <main> merge-base --is-ancestor <branch tip> origin/test` — exit 0 =
     fully merged (or an ancestor at branch-creation time with no new
     commits added); non-zero = has commits NOT on origin/test.
   - **Active subagent?** — run
     `agent_message({ action: "sessions", includeCompleted: false })` and
     check if any active run's `Working directory` matches this worktree's
     path. If yes, the worktree is in use — hands off.
   - **Recommended action** — one of `keep` (blocked awaiting external
     answer / active review), `review` (uncommitted changes that need a
     verify+review turn), `merge` (has commits not yet on `origin/test`
     that the user wanted merged), `discard` (uncommitted changes that
     should be thrown away), `remove` (branch fully merged / ancestor of
     origin/test AND no dirty work AND no active subagent — safe to remove).
3. Present the inventory as a compact per-worktree line or table (ticket,
   branch, path, clean/dirty, ahead/behind, active subagent, recommendation).
4. **Then explicitly ask the user what to do with each remaining worktree**
   (keep, review, merge, discard, or remove). Do NOT auto-remove anything
   the sweep flags as unmerged, dirty, or currently in use by an active
   subagent — those require an explicit answer. Only worktrees whose
   recommendation is unambiguously `remove` (clean, merged, no active run)
   may be proposed for removal in the same turn, and even then only after
   the user confirms.

If the inventory is empty (only the main checkout is left), say so
explicitly — don't drop the sweep silently. "No dangling worktrees" is
information the user uses to trust that the cycle actually ended clean.

**Precedent — 2026-08-14, ABC-651.** ABC-671 was resolved and its worktree
cleaned up as part of the Post-delivery step. ABC-651 was still sitting on
disk from an earlier parallel batch (blocked pending the backend owner's
contract answer). The user had to prompt "clean up ABC-651" as a separate
turn because the coordinator did not sweep. This rule ensures the next
cycle proposes it — with the correct classification (branch fully-ancestor
of origin/test, no dirty tracked files) — without waiting to be asked.

## Cleanup detail

After push, the worktree has a `node_modules` symlink and a
`.husky/_/` directory that were provisioned by you; both are untracked, so
`git worktree remove` refuses without `--force`. `--force` is safe here
because those files are provisioned artefacts, not user work.
