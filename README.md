# claude-code-plugin

A Claude Code marketplace of mods.

| Mod | What it does |
| --- | --- |
| [`cachier`](mods/cachier/README.md) | Ca-ching! Let’s see if keeping your cache warm knocks a few tokens off the bill. |
| [`auditor`](mods/auditor/README.md) | Supreme judge, billing at Haiku rates. Live reviews for your orchestrator. |
| [`human-plugin`](mods/human-plugin/README.md) | Congrats human, you are now a claude code plugin. It changes how you interact with Claude agents. |

## Install

From a Claude Code terminal session:

```
/plugin install cachier --marketplace Lotonoro/claude-code-plugin
/plugin install auditor --marketplace Lotonoro/claude-code-plugin
/plugin install human-plugin --marketplace Lotonoro/claude-code-plugin
```

From a local clone, add the folder as a marketplace, then install by name:

```
claude plugin marketplace add <path-to-clone>
claude plugin install cachier@claude-code-plugin
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
