# Temporary dependency drift

Moved out of `~/.pi/agent/AGENTS.md` on 20260831: it is a note, not a rule the agent follows, and it was shipping in the system prompt of every request.

Both profiles load the claude bridge from a LOCAL PATCHED CLONE instead of npm:
`../../projects/pi-claude-bridge` (branch `merge-global-project-agents-md`).
It now carries TWO deviations from upstream:
1. commit 55b252c — merges global+project AGENTS.md, fence-aware sanitizer.
2. commit cfa7340 — `DISABLE_OMC=1` in the bridge's childEnv so the
   oh-my-claudecode plugin's interactive CC hooks (workflow-drift-guard nudging
   AskUserQuestion, skill-injector, rules-injector) don't run in pi sessions.
Exit condition: when upstream (elidickinson) merges the PR and ships a release,
switch `packages` back to `npm:pi-claude-bridge` in BOTH profiles
(`~/.pi/agent/settings.json` and `~/.pi-personal/agent/settings.json`),
delete the local clone if unneeded, and remove this section from BOTH AGENTS.md.
Deviation #2 is PERMANENT for the fork and NOT part of the upstream PR (it's
specific to this setup — the plugin-hooks argument, if pursued at all, goes as a
separate issue). The upstream PR is opened from branch `agents-md-merge-fix` (forked at 55b252c, merge-fix only) and covers ONLY deviation #1. The working branch `merge-global-project-agents-md` (both commits) is what the profiles load. So when switching
`packages` back to npm, carry `DISABLE_OMC=1` over some other way (e.g. a pi launch
alias/wrapper that exports it), otherwise the WORKFLOW-DRIFT-GUARD / AskUserQuestion
nudge silently returns.

