# pi-day

Route engineering work through the `engineering-router` skill. Load it first for code changes, engineering decisions, explanations, or changes to the skill network.

## Delegation

These instructions authorize subagents in two cases:

- **Post-implementation review.** The router requires independent review of every implementation. Dispatch `reviewer` with `context: "fresh"`. Never fork a review: a forked child inherits the conversation that produced the change, so it is not independent.
- **Steps a loaded `engineering-*` or `ce-*` skill assigns to a subagent.**

Any other delegation needs a request from the user.

Give the reviewer the review packet that `engineering-review` defines: the requirement, acceptance criteria and constraints, the base and proposed revisions (or the complete change including untracked files), the relevant environment, and the commands to rerun the checks. Leave out the implementer's summary, self-assessment and diagnosis. Relay the reviewer's first line (`Context: ...`) with its findings, so the user can see whether the review ran fresh.

`scout` writes `context.md` and `planner` writes `plan.md`; `worker` reads both by default. `oracle` forks on purpose to check decisions for drift; it never stands in for `reviewer`.

## Offline use

Local models come from the `ollama` provider. Only the web tools (`web_search`, `fetch_content`) need the internet. When they fail, say so, fall back to installed documentation (`node_modules`, man pages, `--help` output), and label that fallback as the router requires.
