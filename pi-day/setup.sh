#!/usr/bin/env bash
# Installs pi-day's pinned packages and default config into its agent directory. Safe to re-run.
set -euo pipefail

# Pinned third-party packages. Bump deliberately, after reading their changelogs.
PI_SUBAGENTS="npm:pi-subagents@0.89.0"
PI_WEB_ACCESS="npm:pi-web-access@0.48.0"
# Compound Engineering publishes no tags; pin a reviewed commit.
COMPOUND_ENGINEERING="git:github.com/EveryInc/compound-engineering-plugin@8f7614639e7f3792a6f9337d8742a80a232bd596"

PI_DAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$PI_DAY_DIR")"
PI_DAY="$PI_DAY_DIR/bin/pi-day"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi-day/agent}"

if [[ ! -d "$REPO_DIR/node_modules" ]]; then
	echo "pi-day: run 'npm install --ignore-scripts && npm run build' in $REPO_DIR first" >&2
	exit 1
fi
mkdir -p "$PI_CODING_AGENT_DIR"

# pi's package installer runs npm without --ignore-scripts. None of these packages need lifecycle
# scripts, so refuse them rather than run unreviewed install-time code.
export npm_config_ignore_scripts=true
for source in "$PI_SUBAGENTS" "$PI_WEB_ACCESS" "$COMPOUND_ENGINEERING" "$PI_DAY_DIR"; do
	"$PI_DAY" install "$source"
done

# Foreground subagents do not load the parent's extensions; load pi-web-access in each child so
# agents that list fetch_content can consult documentation.
export PI_WEB_ACCESS_EXTENSION="$PI_CODING_AGENT_DIR/npm/node_modules/pi-web-access/dist/index.js"
if [[ ! -f "$PI_WEB_ACCESS_EXTENSION" ]]; then
	echo "pi-day: pi-web-access extension not found at $PI_WEB_ACCESS_EXTENSION" >&2
	exit 1
fi

MERGE="$PI_DAY_DIR/scripts/merge-json-defaults.mjs"
node "$MERGE" "$PI_CODING_AGENT_DIR/settings.json" "$PI_DAY_DIR/config/settings.defaults.json"
node "$MERGE" "$PI_CODING_AGENT_DIR/web-search.json" "$PI_DAY_DIR/config/web-search.defaults.json"

GLOBAL_CONTEXT="$PI_CODING_AGENT_DIR/AGENTS.md"
if [[ -e "$GLOBAL_CONTEXT" && ! -L "$GLOBAL_CONTEXT" ]]; then
	echo "pi-day: keeping your existing $GLOBAL_CONTEXT; see $PI_DAY_DIR/AGENTS.md for pi-day's version" >&2
else
	ln -sfn "$PI_DAY_DIR/AGENTS.md" "$GLOBAL_CONTEXT"
fi

if [[ -d "$HOME/.local/bin" ]]; then
	ln -sfn "$PI_DAY" "$HOME/.local/bin/pi-day"
	echo "pi-day: linked $HOME/.local/bin/pi-day"
fi

# The Ollama provider discovers a loopback server at every startup, online or offline, so this
# listing doubles as a check that the extension loaded. (`pi update --models` does not load
# extensions, so it cannot refresh extension providers.)
echo "pi-day: Ollama models visible to pi-day:"
"$PI_DAY" --list-models ollama
