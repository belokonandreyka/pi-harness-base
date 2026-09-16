#!/usr/bin/env bash
# Put this repository's profile templates, subagent types and skills into
# the two pi profiles. Never overwrites a file that already exists, so it is
# safe to re-run after a pull; skills are symlinked so edits here flow through.
#
#   ./scripts/install.sh            # ~/.pi/agent (orchestrator), ~/.pi-sub/agent (subagents)
#
# Paths inside the templates are written as /Users/<you>/projects/...; this
# script rewrites them to $HOME and to where this repository actually sits.
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SUB="$HOME/.pi-sub/agent"
TYPES="$HOME/.pi/agents"

render() {  # render <src> <dest>: copy with placeholders resolved, skip if dest exists
  local src="$1" dest="$2"
  if [[ -e "$dest" ]]; then
    printf '  keep    %s\n' "${dest/#$HOME/~}"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  sed -e "s#/Users/<you>/projects/pi-harness-base#$BASE#g" \
      -e "s#/Users/<you>#$HOME#g" "$src" > "$dest"
  printf '  write   %s\n' "${dest/#$HOME/~}"
}

link() {  # link <src-dir> <dest>: symlink a skill directory, skip if dest exists
  local src="$1" dest="$2"
  if [[ -e "$dest" || -L "$dest" ]]; then
    printf '  keep    %s\n' "${dest/#$HOME/~}"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  printf '  link    %s -> %s\n' "${dest/#$HOME/~}" "${src/#$HOME/~}"
}

echo "Orchestrator profile ($ORCH):"
for f in settings.json AGENTS.md durable-context.md collaborating-agents.json \
         model-fallback.json context-ceiling.json gateway-budget.json pi-lsp.json; do
  render "$BASE/profiles/orchestrator/$f" "$ORCH/$f"
done
render "$BASE/profiles/orchestrator/models.json.template" "$ORCH/models.json"
render "$BASE/skills/my-quick-wins/config.example.json" "$ORCH/my-quick-wins.json"
for d in "$BASE"/skills/*/; do
  link "${d%/}" "$ORCH/skills/$(basename "$d")"
done

echo "Subagent profile ($SUB):"
for f in settings.json AGENTS.md context-ceiling.json; do
  render "$BASE/profiles/subagent/$f" "$SUB/$f"
done
render "$BASE/profiles/orchestrator/durable-context.md" "$SUB/durable-context.md"
render "$BASE/profiles/orchestrator/gateway-budget.json" "$SUB/gateway-budget.json"

echo "Subagent types ($TYPES):"
for t in "$BASE"/subagents/*.toml; do
  render "$t" "$TYPES/$(basename "$t")"
done

cat <<EOF

Next:
  1. $ORCH/models.json — replace <GATEWAY_HOST>, keep the apiKey line as a
     Keychain command; store the key with:
       security add-generic-password -s ai-gateway-key -a "\$USER" -w
  2. Both settings.json — check the package paths point at your checkouts of
     pi-collaborating-agents and pi-search-tools.
  3. $ORCH/AGENTS.md — the Language and Aliases sections are yours to edit.
  4. $ORCH/my-quick-wins.json — your Jira site, filter id, repos root and
     the CI account, for "plan my day".
  5. pi, then /login for github-copilot.
EOF
