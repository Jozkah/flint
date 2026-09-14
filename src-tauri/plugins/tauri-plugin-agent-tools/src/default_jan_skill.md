---
name: jan
description: Use when onboarding users to Flint Agent or explaining project and global configuration, skills, memory, providers, and MCP servers.
---
# Flint Agent
When enabled, Flint lists this skill's name and purpose. The model loads its body with `skill_read`
only when the task needs it.


Run `jan` in a folder. That CWD is the project root; `--project DIR` selects another root.

## Project files

Flint reads non-empty `FLINT.md` files (and legacy `JAN.md` files, for projects created before
the rename) from the project root and its ancestors. The nearest file wins, and a `FLINT.md`
wins over a `JAN.md` in the same folder. Flint creates this separate state tree on first use:

```text
<project>/
|-- FLINT.md               # always-loaded project instructions (legacy name: JAN.md)
`-- .jan/
    `-- agent/
        |-- agent.toml       # model, provider, budget, tools, skills
        |-- skills/
        |   `-- <name>/
        |       `-- SKILL.md # procedure, plus optional scripts/templates
        |-- memory/          # durable project facts
        |-- threads/         # saved conversations
        `-- subagents/       # reusable agent definitions
```

`agent.toml` has `[agent]`, `[provider]`, `[budget]`, `[tools]`, and `[skills]` sections.
A simple skill can be `skills/<name>.md`. Commit `FLINT.md` (or a legacy `JAN.md`), `agent.toml`,
`skills/`, and `subagents/`; gitignore `threads/`. Run `flint cli agent status --project .` to
scaffold the tree. The `.jan/` directory name is kept unchanged so existing projects keep working.

## User-global files

`~/.jan/` is separate from a project's `.jan/` (the directory name is retained for compatibility):

```text
~/.jan/
`-- config.toml              # CLI provider configuration and credentials
```

Flint Desktop stores its settings and shared MCP configuration under the platform support folder:

```text
<support-folder>/Jan/
|-- settings.json             # Desktop settings, including an optional data_folder
`-- data/                     # default JAN_DATA_FOLDER
    |-- mcp_config.json       # shared MCP server definitions
    `-- agent-workspace/      # Desktop-global agent store
        |-- skills/
        |-- memory/
        `-- threads/
```

Default `<support-folder>`:

```text
macOS:   ~/Library/Application Support
Linux:   $XDG_DATA_HOME, or ~/.local/share
Windows: %APPDATA%
```

`FLINT_DATA_FOLDER` (or the legacy `JAN_DATA_FOLDER`, still honoured) overrides the `data/`
location; `FLINT_DATA_FOLDER` takes precedence when both are set. Otherwise Flint uses
`settings.json`'s `data_folder`, then `<support-folder>/Jan/data`. The `Jan` support-folder name
is retained so existing installations keep loading. Add MCP servers in Desktop at
`Settings > MCP Servers`; Flint writes `<data folder>/mcp_config.json`.
