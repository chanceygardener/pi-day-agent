# pi-day

A personal distribution of [pi](../README.md), packaged as one pi package inside this fork. It adds:

- the `~/engineering-skills` network, routed through `engineering-router`;
- subagents ([`pi-subagents`](https://github.com/nicobailon/pi-subagents)) with agent definitions built on that network;
- [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) skills;
- documentation fetch and web search ([`pi-web-access`](https://github.com/nicobailon/pi-web-access)) through Exa;
- a local Ollama provider that works offline.

Nothing in `packages/` is modified. MCP support and the Anthropic and OpenAI providers are built into pi.

## Setup

```bash
cd ~/repos/pi-day-agent
npm install --ignore-scripts && npm run build
pi-day/setup.sh
```

`setup.sh` is safe to re-run. It:

1. installs the pinned packages into `~/.pi-day/agent` with npm lifecycle scripts disabled (pi's installer does not disable them itself);
2. installs this directory as a local package (no copy; edits apply on the next start or `/reload`);
3. merges `config/*.defaults.json` into `settings.json` and `web-search.json`, never overriding values you set;
4. links `AGENTS.md` as pi-day's global context and `bin/pi-day` into `~/.local/bin`;
5. lists the Ollama models pi-day can see, which also confirms the extension loaded.

`pi-day` runs this checkout's pi from source (via `pi-test.sh`) with `PI_CODING_AGENT_DIR=~/.pi-day/agent`, so its settings, auth and sessions never mix with a stock `pi` install, and core changes take effect without a rebuild.

## Layout

| Path | Purpose |
|---|---|
| `bin/pi-day` | Launcher |
| `setup.sh` | Installs pins and default config |
| `package.json` | pi package manifest: the Ollama extension and the agents directory |
| `AGENTS.md` | Global context: router first, delegation authority, review packet, offline fallback |
| `agents/` | `scout`, `planner`, `worker`, `reviewer`, `oracle`; they replace the `pi-subagents` builtins of the same name |
| `extensions/ollama/` | Ollama provider: `client.ts` (wire format), `provider.ts` (catalog rules), `index.ts` (registration) |
| `config/` | Defaults merged into the agent directory |
| `scripts/merge-json-defaults.mjs` | The merge used by setup |
| `test/` | `node --test` suites |

## Models

- **Anthropic / OpenAI:** set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or use `/login`. To keep keys off disk, put a command in `~/.pi-day/agent/auth.json`, such as `"key": "!security find-generic-password -ws anthropic"`.
- **Ollama:** discovered automatically from `OLLAMA_HOST` (default `127.0.0.1:11434`). Only models that report the `tools` capability are listed, because Ollama rejects tool calls for the others and pi needs tools on every turn.

Pick a model with `/model` or `--model ollama/qwen3.8:27b`. Subagents inherit the parent's model unless told otherwise. Choosing a separate reviewer model is left to you per task.

### Ollama context windows

Ollama cannot report a model's context window before loading it, and its OpenAI-compatible API cannot set one. The provider reports, in order: the allocation of a currently loaded model (`/api/ps`), the Modelfile's `num_ctx`, then the model's trained length capped by `OLLAMA_CONTEXT_LENGTH`. Ollama's default allocation depends on GPU memory (4k below 24 GiB, 32k up to 48 GiB, 256k above, per [docs.ollama.com/context-length](https://docs.ollama.com/context-length)). On a machine under 48 GiB, set `OLLAMA_CONTEXT_LENGTH` for both the Ollama server and pi-day, or pi will overestimate the window and Ollama will silently truncate the prompt.

## Offline use

pi-day runs fully offline with Ollama. Only `web_search` and `fetch_content` need the internet.

The Ollama provider discovers a loopback server at every startup, including print mode and `--offline`, where pi refreshes catalogs with network access disabled. This intentionally departs from pi's built-in llama.cpp provider, which skips discovery then: the offline rule here is "no internet", and loopback never leaves the machine. A remote `OLLAMA_HOST` is not contacted when network access is disabled; the last catalog persisted from that same host is used instead. A catalog from a different host is never restored, so requests cannot reach a server you no longer configure. Discovery has a 5-second deadline so a hung server cannot stall startup.

`pi update --models` does not load extensions, so it cannot refresh the Ollama catalog. That is not needed: any `pi-day` start refreshes it.

## Web search and documentation fetch

Search is limited to Exa (`webSearch.allowedProviders`) and reads `EXA_API_KEY` from the environment. The key is never written to config. A search costs about $0.007 for two results with highlights. Browser-cookie access and third-party hosted page fetchers stay disabled. `fetch_content` fetches pages directly and converts them locally, and clones GitHub URLs.

Subagents running in the foreground do not load the parent's extensions, so setup adds `pi-web-access` to `subagents.defaultSubagentOnlyExtensions`. Agents that list `fetch_content` (`worker`, `reviewer`, `planner`) can then check version-matched documentation, as the router requires.

## Agents and review independence

Each agent's prompt is thin: it names its role and attaches the matching `engineering-*` skills through `skills:`, so every rule has a single owner, the skill.

| Agent | Skills | Context |
|---|---|---|
| `scout` | explain | fresh; writes `context.md` |
| `planner` | plan, design, schema, runtime | fresh; writes `plan.md` |
| `worker` | implement, verify, design, runtime, schema | fresh; reads `context.md`, `plan.md` |
| `reviewer` | review, verify | fresh |
| `oracle` | explore | fork (by design: it checks decisions for drift) |

`delegate` is left as the builtin, because Compound Engineering needs one agent that adds no role of its own.

Fresh context for review is required by `engineering-review` and requested by `AGENTS.md`, but it is not enforced in code: a model can still pass `context: "fork"`. To make adherence observable, `reviewer` must start its output with `Context: fresh` or `Context: forked — independence compromised`. If forks show up, the fix is a `tool_call` hook that blocks forked launches of `reviewer`.

## Pins and updates

| Package | Pin | Where |
|---|---|---|
| `pi-subagents` | `0.89.0` | `setup.sh` |
| `pi-web-access` | `0.48.0` (its own dependencies use caret ranges) | `setup.sh` |
| Compound Engineering | commit `8f76146` (no release tags) | `setup.sh` |

To update, read the changelog, change the pin in `setup.sh`, and re-run it.

## Development

```bash
cd pi-day
npm test        # Ollama provider against a stub HTTP server
npm run check   # tsc against the extension-facing module view, then Biome
```

`biome.json` is a nested Biome config (`"root": false`, `"extends": "//"`): it inherits the root's lint and format rules and adds pi-day's files, which the root config's includes leave out. A second `"root": true` config breaks the repository's pre-commit check.
