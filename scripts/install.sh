#!/usr/bin/env bash
# Put this repository's profile templates, subagent types and skills into
# the two pi profiles, then install the packages through `pi install`.
#
#   ./scripts/install.sh              # gateway + Copilot, the reference setup
#   ./scripts/install.sh --copilot    # GitHub Copilot only: no gateway, no models.json
#
# Profiles: the orchestrator is $PI_CODING_AGENT_DIR (default ~/.pi/agent);
# the subagent profile and the types directory are derived from it, so a
# throwaway profile stays self-contained:
#   ~/.pi/agent       -> ~/.pi-sub/agent,       ~/.pi/agents
#   ~/.pi-demo/agent  -> ~/.pi-demo-sub/agent,  ~/.pi-demo/agents
#
# Sibling repositories (pi-collaborating-agents, pi-search-tools) are expected
# next to this checkout; clone all three into one directory.
#
# Never overwrites a file that already exists, so it is safe to re-run after
# a pull; skills are symlinked so edits here flow through.
# Env: PI_HARNESS_SKIP_PACKAGES=1 skips the `pi install` step.
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLINGS="$(dirname "$BASE")"
ORCH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
ORCH="${ORCH%/}"
ROOT="$(dirname "$ORCH")"                  # ~/.pi or ~/.pi-demo
SUB="${ROOT}-sub/agent"
TYPES="$ROOT/agents"
PROVIDER="gateway"
for arg in "$@"; do
  case "$arg" in
    --copilot) PROVIDER="github-copilot" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

for repo in pi-collaborating-agents pi-search-tools; do
  if [[ ! -d "$SIBLINGS/$repo" ]]; then
    echo "missing $SIBLINGS/$repo — clone it next to this repository first" >&2
    exit 1
  fi
done

render() {  # render <src> <dest>: copy with placeholders resolved, skip if dest exists
  local src="$1" dest="$2"
  if [[ -e "$dest" ]]; then
    printf '  keep    %s\n' "${dest/#$HOME/~}"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  local out
  out="$(sed -e "s#/Users/<you>/projects/pi-harness-base#$BASE#g" \
             -e "s#/Users/<you>/projects/#$SIBLINGS/#g" \
             -e "s#/Users/<you>/.pi-sub/agent#$SUB#g" \
             -e "s#/Users/<you>#$HOME#g" "$src")"
  if [[ "$PROVIDER" == "github-copilot" ]]; then
    out="$(printf '%s\n' "$out" \
      | sed -e '/"gateway\/claude-opus-5",/d' \
            -e 's#"gateway/claude-#"github-copilot/claude-#g' \
            -e 's#^model = "gateway/#model = "github-copilot/#' \
            -e 's#"defaultProvider": "gateway"#"defaultProvider": "github-copilot"#')"
  fi
  printf '%s\n' "$out" > "$dest"
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

echo "Provider: $PROVIDER"
echo "Orchestrator profile ($ORCH):"
for f in settings.json AGENTS.md durable-context.md collaborating-agents.json \
         model-fallback.json context-ceiling.json gateway-budget.json pi-lsp.json; do
  render "$BASE/profiles/orchestrator/$f" "$ORCH/$f"
done
if [[ "$PROVIDER" == "gateway" ]]; then
  render "$BASE/profiles/orchestrator/models.json.template" "$ORCH/models.json"
fi
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
if [[ "$PROVIDER" == "gateway" && -f "$ORCH/models.json" ]]; then
  render "$ORCH/models.json" "$SUB/models.json"
fi

# Provider logins live in <profile>/auth.json, so the subagent profile shares
# the orchestrator's file: one /login serves both. pi drops an empty "{}"
# there on first start; replace that, keep anything else.
if [[ -f "$SUB/auth.json" && ! -L "$SUB/auth.json" && "$(cat "$SUB/auth.json")" == "{}" ]]; then
  rm "$SUB/auth.json"
fi
if [[ ! -e "$SUB/auth.json" && ! -L "$SUB/auth.json" ]]; then
  mkdir -p "$SUB"
  ln -s "$ORCH/auth.json" "$SUB/auth.json"
  printf '  link    %s -> %s\n' "${SUB/#$HOME/~}/auth.json" "${ORCH/#$HOME/~}/auth.json"
fi

# herdr's own pi integration writes its extension into ~/.pi/agent only;
# a non-default profile gets a copy so pane status works there too.
HERDR_EXT="$HOME/.pi/agent/extensions/herdr-agent-state.ts"
if [[ -f "$HERDR_EXT" ]]; then
  for p in "$ORCH" "$SUB"; do
    if [[ ! -e "$p/extensions/herdr-agent-state.ts" ]]; then
      mkdir -p "$p/extensions"
      cp "$HERDR_EXT" "$p/extensions/"
      printf '  copy    %s\n' "${p/#$HOME/~}/extensions/herdr-agent-state.ts"
    fi
  done
fi

echo "Subagent types ($TYPES):"
for t in "$BASE"/subagents/*.toml; do
  render "$t" "$TYPES/$(basename "$t")"
done

if [[ "${PI_HARNESS_SKIP_PACKAGES:-0}" != "1" ]]; then
  if ! command -v pi >/dev/null 2>&1; then
    echo "pi is not on PATH; install it, then re-run this script for the packages" >&2
    exit 1
  fi
  echo "Packages (pi install):"
  for p in "npm:@ogulcancelik/pi-herdr" "npm:pi-mcp-adapter" "npm:@narumitw/pi-lsp" \
           "$SIBLINGS/pi-collaborating-agents" "$SIBLINGS/pi-search-tools"; do
    printf '  orchestrator  %s\n' "$p"
    PI_CODING_AGENT_DIR="$ORCH" pi install "$p" >/dev/null
  done
  for p in "npm:@narumitw/pi-lsp" "npm:pi-mcp-adapter" \
           "$SIBLINGS/pi-collaborating-agents" "$SIBLINGS/pi-search-tools"; do
    printf '  subagent      %s\n' "$p"
    PI_CODING_AGENT_DIR="$SUB" pi install "$p" >/dev/null
  done
fi

echo
echo "Next:"
if [[ "$PROVIDER" == "gateway" ]]; then
  echo "  1. $ORCH/models.json — replace <GATEWAY_HOST>, keep the apiKey line as a"
  echo "     Keychain command; store the key with:"
  echo "       security add-generic-password -s ai-gateway-key -a \"\$USER\" -w"
else
  echo "  1. Copilot only: every type and the fallback chain point at github-copilot."
  echo "     Add a gateway later by rendering profiles/orchestrator/models.json.template."
fi
echo "  2. $ORCH/AGENTS.md — the Language and Aliases sections are yours to edit."
echo "  3. $ORCH/my-quick-wins.json — your Jira site, filter id, repos root and"
echo "     the CI account, for \"plan my day\"."
echo "  4. Restart pi inside a Herdr pane (PI_CODING_AGENT_DIR=$ORCH if it is not"
echo "     the default), /login github-copilot if not done yet, /model to pick one."
