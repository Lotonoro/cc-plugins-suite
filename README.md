# flea-market

A Claude Code marketplace of mods.

| Mod | What it does |
| --- | --- |
| [`cachier`](mods/cachier/README.md) | The prompt cache's time left on the footer as a pie, an opt-in keepalive that keeps an idle cache warm, costs in dollars or tokens, and a time on every message. |
| [`auditor`](mods/auditor/README.md) | A persistent reviewer subagent that audits each worker turn and hands its corrections back to the worker, like the navigator in a pair. |
| [`human-plugin`](mods/human-plugin/README.md) | A to-do list for you, kept by the agent: each ask the agent has of the human is pinned above the prompt until you mark it done. |

## Install

From a terminal session, with `<owner>/<repo>` the GitHub repository that holds this marketplace:

```
/plugin install cachier --marketplace <owner>/<repo>
/plugin install auditor --marketplace <owner>/<repo>
/plugin install human-plugin --marketplace <owner>/<repo>
```

From a local clone, add the folder as a marketplace, then install by name:

```
claude plugin marketplace add <path-to-clone>
claude plugin install cachier@flea-market
```

A mod's folder is read in place when the marketplace is a folder, so an edit is picked up by `/reload-plugins`.

## Develop

Each mod is a hooks module under `mods/<name>/`. From the repository root:

```
claude plugin validate .                 # the marketplace, then each mod: claude plugin validate mods/<name>
claude plugin test mods/<name>
claude --plugin-dir mods/<name>          # run one mod from its folder
```

`tsc -p mods/<name>` needs `.claude-plugin/types/`, which the engine writes the first time it loads a mod from a folder.

Versions follow semver. Every mod is at 0.0.1.
