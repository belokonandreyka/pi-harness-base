# pi-harness-base

The reusable core of a [pi](https://github.com/earendil-works/pi) coding-agent
harness: an orchestrator that delegates to subagents running in their own
[Herdr](https://herdr.dev) panes, a set of extensions that keep context and
spend under control, and the profile templates that wire it together.

Nothing here knows about a specific company, repository or person. Project
skills, hostnames, rosters and the like live in a private overlay repository
that sits next to this one; see [STARTER-KIT.md](STARTER-KIT.md) for the build
order and where the overlay plugs in.

## What is opinionated about it

- **The orchestrator plans, subagents implement.** `AGENTS.md` forbids the
  coordinator from multi-file edits; `subagent-worktree-ops` says how to spawn,
  where the work happens, and what the verify-and-review turn looks like.
- **Subagents get visible panes.** A fork of `pi-collaborating-agents` launches
  each subagent into a Herdr pane that closes itself once the result is in.
- **Every guard exists because of a number.** `read-guard`, `context-ceiling`,
  `tool-result-offload`, `poll-guard` were each written after measuring what
  the unguarded behaviour cost; `extensions/README.md` keeps the numbers.
- **Standing rules survive compaction.** `durable-context` re-injects them into
  every model call instead of once per session.
- **Skills are measured, not assumed.** `skill-usage-telemetry` records which
  skills actually load; `/skill-stats` shows the ones that never do.
- **Subscription first, paid last.** `model-fallback` walks a chain when a
  quota runs out and shouts only when it reaches an entry that costs money.

## Layout

| Path | What it is |
|---|---|
| `extensions/` | the extensions, each with tests, documented in [extensions/README.md](extensions/README.md) |
| `skills/` | `herdr-terminals`, `investigate-ticket`, `my-quick-wins` ("plan my day", with its day-to-day cache script), `ralplan`, `subagent-worktree-ops` |
| `subagents/` | subagent type definitions (`*.toml`): model, reasoning, tools, prompt |
| `profiles/orchestrator/` | templates for `~/.pi/agent`: settings, `AGENTS.md`, `durable-context.md`, `models.json.template`, extension configs |
| `profiles/subagent/` | templates for `~/.pi-sub/agent` |
| `measure/` | probes for what each request actually costs |
| `notes/` | measurements worth keeping (deferred tool loading through a gateway, dependency drift) |
| `scripts/install.sh` | renders the templates into both profiles without overwriting, symlinks the skills, installs the packages; `--copilot` for a gateway-less setup |
| `scripts/patch-terminal-font.py` | JetBrains Mono with the Herdr agent-icon glyphs, for terminals without font fallback (Terminal.app) |
| `herdr/` | sidebar colour entry for pi, used by the icon plugin ([docs/herdr-sidebar-icons.md](docs/herdr-sidebar-icons.md)) |
| `docs/bootstrap-prompt.md` | the prompt that lets a bare pi install all of this by itself |

Extensions that live in their own repositories are referenced by path from the
profile settings and are not vendored here:

| Repository | Purpose |
|---|---|
| `pi-collaborating-agents` (fork) | subagents; adds the `herdr-pane` launch mode, per-profile resolution and the `model-fallback` extension |
| `pi-search-tools` | `rg` / `fd` tools with a byte cap and spill-to-file |

## Install

Clone the three repositories side by side, then run the installer:

```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/belokonandreyka/pi-harness-base
git clone https://github.com/belokonandreyka/pi-collaborating-agents
git clone https://github.com/belokonandreyka/pi-search-tools
pi-harness-base/scripts/install.sh --copilot     # or without the flag for gateway + Copilot
```

It writes the profile of the current pi (`$PI_CODING_AGENT_DIR`, default
`~/.pi/agent`), a subagent profile and a types directory next to it, symlinks
the skills and runs `pi install` for the packages. It never overwrites, so
re-running after a pull is safe. Then it prints the few things to edit by hand.

Or let pi do all of that itself: [docs/bootstrap-prompt.md](docs/bootstrap-prompt.md)
has the two commands you run and the prompt you paste. Full walk-through,
tier by tier, in [STARTER-KIT.md](STARTER-KIT.md).

## Tests

```bash
bun test
```
