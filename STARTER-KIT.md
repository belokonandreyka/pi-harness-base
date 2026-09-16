# Starter kit

How to assemble a first version of this harness for yourself. Build it in the
order below; each tier works on its own, so stop where it is enough for you.

The shape: you talk to **pi** (the orchestrator) inside a **Herdr** pane. It
does not implement multi-file changes itself; it spawns **subagents**, each in
its own Herdr pane with its own slimmer profile, and reviews what comes back.
Models come from two places: an **AI gateway** your company runs (Bifrost in
front of Bedrock in the reference setup: Opus 5, Sonnet 5, Haiku 4.5, GPT-5.5,
GPT-5.6 Terra) and **GitHub Copilot** (Opus 5, Haiku 4.5, Gemini 3.7 Flash,
GPT-5.6 Sol).

Two repositories: this one holds everything generic; a private **overlay**
holds what is specific to your company and projects — Jira and Bitbucket
skills, review conventions, team rosters, the real `models.json` with the
gateway host, MCP server definitions with local paths. The overlay is yours to
create; the sections below say what belongs in it.

## 0. Prerequisites

Tools (macOS):

| Tool | Version | Install |
|---|---|---|
| Node | 24 (fnm) | `fnm install 24` |
| pi | 0.85.x | `npm i -g @earendil-works/pi-coding-agent` |
| bun | 1.3 | `brew install oven-sh/bun/bun` (runs the extension tests) |
| Herdr | 0.9+ | `curl -fsSL https://herdr.dev/install.sh \| sh`, then its pi integration |
| ripgrep, fd | any | `brew install ripgrep fd` |
| typescript-language-server | 6 | `npm i -g typescript-language-server` (pi-lsp is silent without it) |

Tokens, each stored in the macOS Keychain and never in a file:

| Keychain item | What | Read by |
|---|---|---|
| `ai-gateway-key` | the gateway's virtual key | `models.json`, as `"apiKey": "!security find-generic-password -ws ai-gateway-key"` |
| `jira-token` | Atlassian API token | `JIRA_GIT_HOOK_*` env, used by Jira skills and git hooks |
| `bitbucket-token` | Bitbucket API token | `BITBUCKET_API_TOKEN`, injected by the `pi()` shell function |
| `github-copilot-token` | GitHub PAT | the footer's Copilot quota poll (optional) |

```bash
security add-generic-password -s ai-gateway-key -a "$USER" -w   # prompts for the value
```

`~/.zshrc`:

```bash
kc() { security find-generic-password -s "$1" -w 2>/dev/null }
export JIRA_GIT_HOOK_USERNAME="you@company.com"
export JIRA_GIT_HOOK_TOKEN="$(kc jira-token)"
pi() { BITBUCKET_API_TOKEN=$(kc bitbucket-token) command pi "$@"; }
```

Copilot is authenticated inside pi: `/login`, then `github-copilot`.

## 1. Bare orchestrator

A single pi that talks to the gateway and knows the house rules.

```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/belokonandreyka/pi-harness-base
git clone https://github.com/belokonandreyka/pi-collaborating-agents
git clone https://github.com/belokonandreyka/pi-search-tools
pi-harness-base/scripts/install.sh            # add --copilot if you have no gateway
```

The installer also fills tier 2 (subagent profile, types, packages); it is
listed here because tier 1 is where you first check the result. Shortcut:
[docs/bootstrap-prompt.md](docs/bootstrap-prompt.md) lets a bare pi run all of
this for you.

What lands in `~/.pi/agent/` and what to do with it:

| File | Notes |
|---|---|
| `models.json` | from the template: replace `<GATEWAY_HOST>`; two providers, `gateway` (anthropic-messages) and `gateway-openai` (openai-responses); prices are list × 1.1 in the reference setup |
| `settings.json` | `defaultProvider: gateway` (or `github-copilot` with `--copilot`), `defaultModel: claude-opus-5`, thinking `medium`; `packages` are added by `pi install` |
| `AGENTS.md` | communication contract, roles, review rule, pane rules, context hygiene. Edit **Language** and **Aliases** |
| `pi-lsp.json` | tsserver wiring for `@narumitw/pi-lsp` |

Packages in `settings.json`: `@narumitw/pi-lsp` (diagnostics and fixes),
`pi-mcp-adapter` (tier 4), `pi-search-tools` (capped `rg`/`fd` tools that spill
to a file instead of the context; measured on a large Angular repo, 191 matches
in 95 files no longer land in the prompt).

Overlay: a `~/<work>/AGENTS.md` with rules true for every repo under that
directory (pi walks up from the cwd), and per-repo `AGENTS.md` files.

Sanity check: `pi`, ask it something about a repo, `/model` shows
`(gateway) claude-opus-5`.

## 2. Subagents in panes

| Piece | Where | What it does |
|---|---|---|
| `pi-collaborating-agents` fork | `~/projects/pi-collaborating-agents` | the `subagent` tool; the fork adds the `herdr-pane` launch mode and resolves types, sessions and config per profile |
| `@ogulcancelik/pi-herdr` | npm package in `settings.json` | `herdr_layout`, `herdr_pane`, `herdr_agent` tools |
| `collaborating-agents.json` | `profiles/orchestrator/` | `subagentLaunchMode: herdr-pane`, hidden displays, `triggerTurnOnSubagentCompletion: true`, `subagentAgentDir: ~/.pi-sub/agent` |
| Subagent profile | `~/.pi-sub/agent/` | own `settings.json` (same gateway, none of the orchestrator-only extensions), a 2.4 KB `AGENTS.md` holding only the report contract, `context-ceiling.json` on at 120k |
| Subagent types | `~/.pi/agents/*.toml` from `subagents/` | one file per type: model, reasoning, tool allowlist, system prompt |
| Skill `subagent-worktree-ops` | `skills/` | branch vs worktree, provisioning, model routing per task class, the verify and review turn that fires when a subagent completes |

pi must itself run inside a Herdr pane for pane mode (it reads `HERDR_ENV`
and `HERDR_PANE_ID`); launch mode `process` runs subagents headless.

Types worth using first:

| Type | Model | Tools | Use |
|---|---|---|---|
| `worker` | github-copilot/claude-opus-5, high | read bash edit write lsp rg fd | default implementer |
| `opus-5` | gateway/claude-opus-5, high | same | general coding; the default reviewer with a read-only prompt |
| `sonnet-5` | gateway/claude-sonnet-5, high | read-only | review, analysis |
| `reviewer` | github-copilot/gpt-5.6-sol, xhigh | read-only | second reviewer for payment and security changes |
| `scout` | github-copilot/gemini-3.7-flash, low | read-only | fast codebase questions |
| `haiku-mechanics` | github-copilot/claude-haiku-4.5 | edit | one or two file, exact-instruction diffs |
| `haiku-recon`, `gemini-flash` | Haiku 4.5, Gemini Flash | read-only | recon reports, not code |
| `browser-verify` | github-copilot/claude-opus-5 + `mcp` | read bash mcp | real-browser feature verification; needs an overlay browser skill |
| `scout-flash`, `scout-sol` | worker with one model swapped | | A/B comparisons; skip at first |

## 3. Guards and meters

Extensions from `extensions/`, registered by absolute path in `settings.json`.
Each exists because of a number measured on the reference setup between
2026-08-19 and 09-05.

| Extension | Profile | Why | Config |
|---|---|---|---|
| `read-guard` | both | 141M tokens re-shipped by `read` in 18 days; blocks re-reads of unchanged files and of files already in the system prompt, caps whole reads at 250 lines | none |
| `context-ceiling` | sub on, orchestrator off | 1M-window models never compacted; 121M tokens shipped above 120k per call | `context-ceiling.json` |
| `tool-result-offload` | both | bash results of 4–12k tokens re-sent 20M times; over 24k chars goes to a file, the model sees head and tail | `tool-result-offload.json` |
| `poll-guard` | orchestrator | the coordinator kept polling running subagents with `sleep 120` | `poll-guard.json` |
| `durable-context` | both | rules injected once vanish at compaction; this re-injects `durable-context.md` on every call | `durable-context.md` |
| `skill-usage-telemetry` | orchestrator | every skill description costs context on every request; `/skill-stats` shows which ever load | `telemetry/skill-usage.jsonl` |
| `gateway-budget` | both | a Bifrost virtual key cannot see its own usage; local ledger, `/budget` | `gateway-budget.json` (`providers`, `weeklyCap`) |
| `copilot-credits` | sub | Copilot credits are Anthropic list price × 100; `/credits` | `copilot-credits.json` |
| `copilot-usage` | both | a footer that always shows `(provider) model` plus the Copilot quota | Keychain `github-copilot-token` |

Tests: `bun test`.

## 4. Project workflows

Generic skills ship here and are symlinked into `~/.pi/agent/skills/` by the
installer:

| Skill | Trigger | What it does |
|---|---|---|
| `investigate-ticket` | a ticket key, "investigate" | read-only root cause: Jira and comments, a scout subagent, a report, no code changes. Fill in its **Configure** section |
| `my-quick-wins` | "plan my day" | reads your Jira filter, scouts each ticket in parallel batches, caches verdicts day to day so a quiet morning costs zero scouts. Config in `<agent-dir>/my-quick-wins.json` |
| `herdr-terminals` | before a long command | inline first, sentinels for `wait_output`, close panes before the turn ends |
| `ralplan` | `/ralplan` | Planner, Architect, Critic planning loop on subagents |
| `subagent-worktree-ops` | before spawning | see tier 2 |

What belongs in the overlay, with the shape used in the reference setup:

| Overlay skill | What it does |
|---|---|
| `<jira>-rest` | endpoints, ADF walking, the `curl -u` pattern, 401 and 429 handling for your Jira and Bitbucket sites |
| `bitbucket-pr` | fetch, read, comment, approve; the first review pass is blind to existing comments |
| `<project>-review` | spec naming, commit format, and the rule that every new module must justify itself |
| `finish-ticket` | push, merge into the integration branch, type-check, Jira comment and resolve with the worklog inside the transition |
| `browser-verify-<project>` | bug repro with layer ownership, or feature verification with real-browser proof |
| team and ownership skills | who owns which project and layer |

MCP servers go in `~/.config/mcp/mcp.json`, loaded lazily by
`pi-mcp-adapter`. The reference set: a Playwright server per project with its
own profile dir and `--secrets <env file>` (the model types a variable name,
never a value), a plain Playwright server, `@angular/cli mcp --read-only`,
`chrome-devtools-mcp --autoConnect`, and a web-search server.

Standing rules that must survive compaction go to `durable-context.md`: where
test credentials live, a password is never printed, Jira writes happen only
after the exact text was approved, no ticket transition unless asked, a skipped
check is said out loud.

## 5. Optional

- **model-fallback** (`extensions/model-fallback` in the
  `pi-collaborating-agents` fork): the orchestrator walks `gateway/claude-opus-5 →
  github-copilot/claude-opus-5 → github-copilot/gpt-5.6-sol` on quota errors
  and injects a "continue where you stopped" prompt.
- **A second profile** for another client, personal work, or a throwaway
  demo (`PI_CODING_AGENT_DIR=~/.pi-demo/agent pi`; the installer derives
  `~/.pi-demo-sub/agent` and `~/.pi-demo/agents` from it):
  `PI_CODING_AGENT_DIR` moves all of pi's state, `CLAUDE_CONFIG_DIR` moves
  Claude Code credentials. The fork, the bridge and the MCP adapter all honor
  the profile.
- **claude-bridge** (`pi-claude-bridge`): a Claude subscription as a pi
  provider. Whether a personal subscription may carry company work is a policy
  question, not a technical one.
- **A cron somewhere else** driving this machine over a forced-command SSH
  bridge, so a daily plan arrives at 09:00 without anyone typing it.

## Directory map

```
~/.pi/agent/                 orchestrator profile: settings, models, AGENTS.md,
                             durable-context.md, skills/, extensions/, state/,
                             sessions/, telemetry/, gateway-ledger.jsonl
~/.pi/agents/*.toml          subagent types, shared with the sub profile
~/.pi-sub/agent/             subagent profile: settings, AGENTS.md, ceiling
~/.config/mcp/mcp.json       MCP servers
~/projects/pi-harness-base   this repo
~/projects/<overlay>         your company-specific skills and configs
~/projects/pi-collaborating-agents   fork: subagents + model-fallback
~/projects/pi-search-tools
```

## What to personalize

- `AGENTS.md`: Language, Aliases, the review type you trust.
- `investigate-ticket`: the Configure section; `my-quick-wins.json`: Jira site, filter, repos root, CI account, language.
- `~/.zshrc`: your Jira username; the `JIRA_GIT_HOOK_*` names come from the
  repo's git hooks.
- `gateway-budget.json`: provider names and your weekly cap.
- Package paths in both `settings.json` files if your checkouts sit elsewhere.

## What never to version

`auth.json`, `trust.json`, `sessions/`, `gateway-ledger.jsonl`,
`models-store.json`, test credential files, `~/.claude*`. `.gitignore` here
refuses the first group by name.

## Known gaps

- Deferred tool loading does not work through a Bifrost gateway
  (`notes/deferred-tool-loading.md`), so every tool's schema ships on every
  request. Keep the tool set small; `measure/tools-probe.ts` shows the cost.
- The Copilot ×100 credit factor is verified for Opus only.

## What it costs

Measured on the reference setup in September 2026: a daily-plan scout batch of
six to eight tickets is about $2 on Copilot Opus 5, roughly $0.50 per ticket,
and the day-to-day cache brings a quiet morning down to zero scouts. Gateway
Opus 5 is $5.50 in and $27.50 out per million tokens; one Copilot credit is
$0.01 at list. `/budget`, `/credits` and `/skill-stats` show where it goes.
