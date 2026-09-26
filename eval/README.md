# eval — regression set for the harness itself

Routing decisions ("Haiku for mechanics", "Flash for recon", "Opus 5.5 at
medium instead of Opus 5 at high"), prompt edits and skill changes are made on
a feeling and a few sessions. This directory turns the coordinator's own past
delegations into a task set that any config can be run against, so a change
is kept because it held the pass rate at lower cost, not because it felt
faster.

Four scripts, all plain Python, no dependencies:

| script | does |
|---|---|
| `extract.py` | drafts tasks from the collab run records: prompt = the subagent's first user message, base = parent of the commit that shipped the ticket, reference = that commit |
| `run.py` | task × config × repeat in detached git worktrees through `pi -p --mode json`; collects diff, checks, tokens, cost, tool calls, minutes, git-history peeks |
| `judge.py` | grades candidate vs reference with a judge from another model family (default GPT-5.6 Sol on Copilot), JSON rubric: correctness / scope / conventions / pass |
| `report.py` | per-config table and a task × config grid of every run |

## Workflow

```bash
# 1. drafts from the last 60 days of worker runs in one repository
python3 eval/extract.py --repo ~/work/app --out ../kit/eval/tasks --checks ../kit/eval/checks-app.json

# 2. curate: open each draft, confirm base/reference, fix checks, set "status": "ready"

# 3. plan, then run (every run spends real quota)
python3 eval/run.py --tasks ../kit/eval/tasks --config ../kit/eval/configs/worker.json --repeats 1 --dry-run
python3 eval/run.py --tasks ../kit/eval/tasks --config ../kit/eval/configs/worker.json --config ../kit/eval/configs/worker-b.json --repeats 3 --out ../kit/eval/results

# 4. grade and report
python3 eval/judge.py --results ../kit/eval/results --tasks ../kit/eval/tasks
python3 eval/report.py --results ../kit/eval/results --md ../kit/eval/results/report.md
```

Tasks and results hold private prompts and diffs: keep them in the private
overlay, not here. `tasks/example.json` and `configs/example.json` show the
shapes.

## What a task needs to be fair

- **Base commit carries everything the prompt assumes.** Coordinators write
  prompts like "contracts are already staged" or "branch X is checked out";
  the worktree has only the commit. Either pick a base that has it or edit
  the prompt. This is the main reason drafts need a human pass.
- **Reference is the right round.** A ticket with three worker runs has
  three commits; `extract.py` pairs each run with the first commit after it.
  Check the pairing when the second run was "apply review findings".
- **Checks are cheap enough to run per candidate.** A full type-check of a
  large Angular app is minutes per run; prefer the spec subset for the
  touched area plus eslint on the changed files, and keep the full check for
  the finalists.
- **No peeking.** The shipped fix is in the repository's history, and the
  worktree is detached at the base, but `git log --all` still finds it.
  `run.py` flags bash calls that look at history for the ticket key, a
  remote or `--all`; a flagged run is void.

## Reading the numbers

- Differences of one or two runs are noise. Three repeats per cell is the
  minimum before a conclusion; the grid shows every repeat so a lucky run is
  visible.
- The judge is another model with the reference in front of it, not ground
  truth: read `judge.md` in a result directory before trusting a fail, and
  keep the judge outside the family under test.
- Cost per run includes the profile's startup prefix; a cheaper model with a
  lower pass rate is not cheaper once the rework is counted. Compare
  `$/run ÷ pass rate`.
- The configs differ in exactly one thing when the question is one thing
  (model, or thinking level, or AGENTS.md size), and the set stays fixed
  while the harness changes. Editing prompts to please the eval is the
  failure mode to watch for.
