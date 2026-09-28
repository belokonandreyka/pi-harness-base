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
| `judge.py` | grades a candidate with a judge from another model family (default GPT-6 Astra on Copilot) under `rubrics/v5-severity-scope.md`: the prompt and the ticket's goal are the spec, every gap carries a source (prompt / goal / guide / breaks / beyond-prompt / reference-only), a kind, a severity and evidence; only blocking behaviour gaps fail |
| `hidden_tests.py` | runs the reference commit's spec files against each candidate (hidden tests) and, with `--related`, the existing specs that import the changed files (regressions); code, not opinion |
| `report.py` | per-config table and a task × config grid of every run; `--baseline DIR` lists what flipped against an earlier result set |
| `compare_judges.py` | the same grid with every judge slot side by side; `--agreement` adds pairwise pass agreement, gap kinds and evidence checks |

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
- **No peeking.** The shipped fix is in the repository's history. `run.py`
  works in a shared clone of the base commit with the remote, every branch
  and all tags removed, so `git log --all`, `git branch -a` and local ticket
  branches show nothing newer than the base; it still flags bash calls that
  look at history for the ticket key, a remote or `--all`, and a flagged run
  is void.
- **Hidden tests beat judges where they exist.** When the reference added or
  changed spec files, `extract.py` lists them under `hiddenTests` and
  `hidden_tests.py` runs them against the candidate; `--related` also runs
  the existing specs that import the changed files. The judge stays for
  tasks without tests and for scope and conventions.

## Reading the numbers

- Differences of one or two runs are noise. Three repeats per cell is the
  minimum before a conclusion; the grid shows every repeat so a lucky run is
  visible.
- The judge is another model with the reference in front of it, not ground
  truth: read `judge.md` in a result directory before trusting a fail, and
  keep the judge outside the family under test.
- The built-in v1 rubric (`--rubric ''`) grades against the reference; when
  the reference carries later review rounds the judge fails candidates for
  things the prompt never asked, and two judge families agreed on only 73%
  of verdicts. `rubrics/v2-prompt-is-spec.md` makes the prompt the spec and
  asks for each gap with `requiredBy` (prompt / guide / breaks /
  reference-only) and a quote as evidence (agreement 0.81);
  `rubrics/v3-behaviour-gates.md` also splits gaps into behaviour / style
  and lets only behaviour gaps fail (agreement 0.90). A human pass over the
  18 borderline verdicts then showed v3 too lenient: it dropped gaps the
  prompt states only implicitly, which v1 had caught through the reference.
  `rubrics/v4-ticket-goal.md` keeps v3's structure and adds `goal` as a
  source: a case the ticket's behaviour covers and the reference handles
  counts even without a quote (human match 14/18, same as v1). The default
  `rubrics/v5-severity-scope.md` adds a severity per behaviour gap (a
  timing window of seconds or data the system never produces is a
  follow-up, not a block) and a `beyond-prompt` source for fixes the
  reference made in components the prompt never names; Astra under v5
  matched the human on 16 of 18 borderline rows. Astra is the default
  judge. Calibrate against a human before trusting agreement between
  judges: two judges agreeing at 0.90 were both wrong on the same rows.
  Judge strictness differs more between model families than candidates do
  between models: before comparing configs, run two judges (`--slot`), repeat
  one (`--slot judge-x-r2`) and look at `compare_judges.py --agreement`; a
  judge that disagrees with itself across repeats cannot rank configs.
- Cost per run includes the profile's startup prefix; a cheaper model with a
  lower pass rate is not cheaper once the rework is counted. Compare
  `$/run ÷ pass rate`.
- The configs differ in exactly one thing when the question is one thing
  (model, or thinking level, or AGENTS.md size), and the set stays fixed
  while the harness changes. Editing prompts to please the eval is the
  failure mode to watch for.
