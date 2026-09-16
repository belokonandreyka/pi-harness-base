# subagent-worktree-ops — reference: model-routing

Moved out of SKILL.md on 2026-09-05 to keep the skill body small; read this file only at the step in SKILL.md that points to it.

## Model routing

Principle: the strongest model goes where **peak complexity per token** lives
(executor, reviewer), not where the role's status is highest. Since 2026-09-01 the
default executor is Opus 5 on Copilot rather than Opus 5 through the Vitu
gateway (2026-09-05: Copilot prices Opus 5 the same as Opus 4.7, so the
4.7/4.8 types are retired everywhere; through the Vitu gateway Opus 4.8 and
Opus 5 also cost the same, $5.50/M in): it keeps implementation off the pool the orchestrator itself runs
on, so a long delegation run no longer competes with the session driving it. The orchestrator is
a long-lived context running a mature protocol.
Second principle: the two pools (Copilot credits, 45k/month, and the Vitu
gateway budget, $1000/month with a $250/week cap) are balanced by splitting
roles across them. The Claude subscription bridge is gone since 2026-09-05.

Model selection table for spawning:

| Task class | Signals | Model | Pool |
|---|---|---|---|
| Mechanics | deterministic result, 1–2 files, exact instruction (sed replacements, template edits, moves) | `claude-haiku-4-5` | Copilot |
| Recon / bash agentics | many turns, noisy output, result = a concise REPORT, not code (repo-wide grep, log analysis, doc distillation). Recon reports must be grounded in the inspected source only; treat any claim that matches our own AGENTS.md / skill / config wording as suspected context leak during verify. | `github-copilot/gemini-3.7-flash` (approved 2026-07-24 head-to-head vs Haiku); `haiku-recon` as fallback on Flash unavailability or ledger escalation | Copilot |
| Implementation | logic changes, multiple files, tests, design judgment; result = a DIFF headed for review | Opus 5 via Copilot — the default `worker` type, so no `type` argument is needed. `type: "opus-5"` is the same model via the Vitu gateway: use it only to spread load when Copilot credits run out, since it spends the gateway budget the orchestrator runs on | Copilot |
| Review | read-only, fresh eyes | default: `type: "opus-5"` (Opus 5 via the Vitu gateway, read-only tools); switchable to a Copilot-hosted reviewer on the user's signal. The RALPLAN Critic role is separately bound to `codex-sol-reviewer` — see skill `ralplan`, not this row | floating |

**5-second rule:** task can be described as a bash sequence → Haiku; result is a
report → Flash; result is a diff → Opus 5; unsure between recon and
implementation → implementation (rework costs more than the credit difference).

**Escalation:** if a Flash/Haiku executor fails to deliver within 2 iterations, or
its report is rejected — relaunch the task on Opus 5; no third attempt on the
weaker model.

Economic rationale: Copilot credits per typical subagent session ≈ Opus 5 (measured on Opus 4.7, same price):
~400 (dominated by cache write at 625/1M), Flash: ~24 (cache write 0). So every
task moved down from Opus-tier to Flash frees ~17× quota for orchestration.

**Flash validation test (run before activating the Flash row):** first confirm
collaborating-agents can spawn Gemini models through the Copilot provider (a
subagent type with `model = "github-copilot/gemini-3.7-flash"`). If it
cannot, keep Haiku in the Recon row and log a Pending infra task. If it can, run
a parallel batch — one real recon task on both Flash and the current default —
and compare (a) report usable without rework, (b) turn count, (c) credits spent.
Record the outcome in the `model-routing` memory (pi-collaborating-agents key);
activate the Flash row only once approved.

**Dual review for critical changes.** For payment/security-critical changes, shared-infra edits (skills, AGENTS.md, extensions the whole session loads), and new packages headed for `settings.json`, run TWO independent the `opus-5` review subagent reviews before commit — parallel, same isolated/read/opus config, separate calls. Precedent: 2026-07-24 `pi-search-tools` initial-commit gate — two independent reviews of the same diff surfaced four blocker-class findings with ZERO overlap (spill collision + missing-binary test gap in review #1; `rg --max-count` per-file undercounting + swallowed binary errors in review #2). One-reviewer coverage would have shipped two of the four. Cheap ordinary changes stay single-review.

**API constraint — batch is single-typed.** The `subagent` tool's `type`
parameter is per-batch, not per-task: every task in a `tasks[]` array runs on
the same subagent type. A mixed-model parallel batch (e.g. Flash vs Haiku
head-to-head) is NOT possible via one call — issue separate single-task
spawns and note wall-clock is not comparable across them. Precedent:
2026-07-24 head-to-head validation batch silently ran two workers on the
default (Opus 4.7) instead of Flash+Haiku.

**Fallback chain can silently substitute the effective model.** The
`collaborating-agents` run ledger records the REQUESTED model (from the
subagent type toml or `--models` argv), not the model that actually served
the turn. When the requested provider is rate-limited or unavailable, the
`model-fallback` extension transparently switches to the next chain entry;
the ledger and the run-record `model` field still show the original. For any
run where model identity is part of the task (validation head-to-heads,
tier comparisons, benchmarks, "send this to X specifically") verify the
effective model in the session jsonl AFTER completion, BEFORE counting the
result. Grep the session file for `"model"` events or
`after_provider_response` entries; the ledger alone is not sufficient. For
ordinary tasks the substitution is desirable — that's the fallback's job —
and no verification is required. Precedent: 2026-07-24 `pi-search-tools`
third review requested on `openai-codex/gpt-5.6-sol`; ledger showed
requested model, session showed effective run on `github-copilot/claude-opus-4.7`.
