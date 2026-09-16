# Let pi set itself up

The fastest way to a working harness is to hand the job to a bare pi. You
install two programs and log in; pi clones the repositories, runs the
installer and verifies the result. About ten minutes end to end.

## You do this

```bash
npm i -g @earendil-works/pi-coding-agent        # pi itself
curl -fsSL https://herdr.dev/install.sh | sh      # Herdr, the pane manager
herdr integration install pi                     # its pi hook (writes ~/.pi/agent/extensions/)
```

Open Herdr, start pi in a pane, then inside pi:

1. `/login` → **GitHub Copilot**, follow the device-code flow.
2. `/model` → `claude-opus-5` (any Opus works; the installer defaults to it).
3. Paste the prompt below as one message.

To try it in a throwaway profile instead of `~/.pi/agent`, start pi as
`PI_CODING_AGENT_DIR="$HOME/.pi-demo/agent" pi`; the installer derives the
subagent profile (`~/.pi-demo-sub/agent`) and the types directory
(`~/.pi-demo/agents`) from it, so nothing touches your real profile.

## The prompt

```text
Set up the pi harness from https://github.com/belokonandreyka/pi-harness-base on this machine. Work step by step, run the commands yourself, and stop to ask me only when something fails.

1. Check the prerequisites and report their versions: node (24 or newer), git, rg, fd, herdr, typescript-language-server. Do not install anything system-wide without telling me what and why first.

2. Clone three repositories side by side into ~/projects (create the directory if it is missing):
   https://github.com/belokonandreyka/pi-harness-base
   https://github.com/belokonandreyka/pi-collaborating-agents
   https://github.com/belokonandreyka/pi-search-tools
   If a clone already exists, run git pull in it instead of cloning again.

3. Read ~/projects/pi-harness-base/README.md and STARTER-KIT.md before touching any configuration.

4. Run ~/projects/pi-harness-base/scripts/install.sh --copilot and show me its full output. It writes into the profile of this pi ($PI_CODING_AGENT_DIR, or ~/.pi/agent when unset), creates a subagent profile and a subagent-types directory next to it, and installs the packages with pi install. Never overwrite a file that already exists; the script keeps existing files, respect that.

5. Verify: every path listed under "extensions" and "packages" in the profile's settings.json exists on disk; the subagent-types directory holds the toml files; the skills directory holds symlinks into the base repository; herdr --version works. Report anything missing.

6. Do not edit AGENTS.md or my-quick-wins.json, I will personalize them myself. Do not start another pi, do not log in anywhere on my behalf.

7. Finish with a short summary: what was written where, and what I must do next. I expect: restart pi inside a Herdr pane with the same PI_CODING_AGENT_DIR, /login github-copilot if not done yet, /model to pick the model, then try /subagent scout with a small read-only question.
```

## After it finishes

Restart pi in a Herdr pane (the same `PI_CODING_AGENT_DIR` if you used
one). The footer now shows `(github-copilot) claude-opus-5`. Try:

```text
/subagent scout What are the top-level directories of this repository and what does each hold? Read-only.
```

A new pane opens for the scout, closes when it is done, and the answer
lands in your session. From there, `STARTER-KIT.md` explains what each
tier adds and what to personalize.
