# Global Skills & Plugins Across All Workspaces — Design

**Date:** 2026-09-17
**Status:** Approved (design). Implementation plan to follow.

## Problem

Skills and plugins are effectively project-scoped:

- **Plugins** live only at `<project>/.jan/agent/plugins/<id>/`. There is no
  global store, so the Plugins manager demands a project folder and a plugin
  installed for one project is invisible to every other project, to Home, and
  to Rooms.
- **Skills** already have a global store (`<jan_data_folder>/agent-workspace/skills`,
  merged by `discover_user`), but that merge only runs when an agent run has a
  project root. A folderless Home run loads **zero** skills, and the Rooms
  engine never loads skills or plugins at all.

Users want skills and plugins to be installable once and usable everywhere —
Home, Cowork, and Rooms — with per-surface control over where each one is
active (e.g. "Caveman in Rooms but not in Cowork").

## Goals

1. A real global plugins store, mirroring the existing global skills store.
2. Every workspace type (Home, Cowork project, Rooms) loads global skills and
   plugins at runtime through **one** loader.
3. A per-item enablement matrix: each global skill/plugin can be turned on or
   off per surface — Home, Rooms, and each individual Cowork project.
4. A first-class `/extensions` UI route to browse, install, edit, and scope
   skills and plugins, reachable from any workspace.

## Non-goals

- Changing how **project-local** skills/plugins are stored or gated. A skill or
  plugin installed into a specific project keeps using that project's existing
  `[skills].enabled` whitelist. The new matrix governs **global** items only, so
  the two systems never overlap.
- A filesystem-path-free project registry beyond what is needed to give each
  project a stable id (see below).

## Architecture

Approach A: **Rust owns loading.** A single Rust resolver produces the merged,
matrix-filtered set of skills + plugin tool definitions for a given surface.
All three workspace types call it, so there is exactly one catalog-building
codepath and no drift between a Rust-built prompt block and a TS-built one.

### Component 1 — Global plugins store (Rust)

- New `user_plugins_dir()` → `<jan_data_folder>/agent-workspace/plugins`, the
  sibling of the existing `user_skills_dir()`.
- Merge global plugins into the three scanners that today take only
  `project_store(root)`:
  - `scan_plugin_skills` (`src-tauri/src/core/agent/skills.rs:314`)
  - plugin-commands `scan` (`src-tauri/src/core/agent/plugin_commands.rs:54`)
  - the plugin-agents scan
- **Shadow rule:** a project-local plugin shadows a global plugin of the same
  id, matching the existing `discover_user` rule where a project skill shadows a
  user skill.
- Plugin manager commands (`agent_plugin_list/install/remove/...`) gain a
  `scope` (`global` | `project`) so the `/extensions` route can install into and
  manage the global store without a project folder.

### Component 2 — Stable project identity (Rust)

The matrix needs a key for "this Cowork project" that survives the folder being
moved or renamed. Today's projects service returns thread-group ulids with **no
filesystem path**, and Cowork sessions key by folder path (unstable).

- New `<jan_data_folder>/agent-workspace/projects.json`: a map
  `projectId (generated ulid) → { folder: string, name: string }`.
- A folder is registered the first time it is opened as a Cowork session (or on
  demand from the `/extensions` route). Opening a moved/renamed folder updates
  the stored `folder` for the existing id rather than creating a new one, when
  the folder can be matched (e.g. by an id file dropped in `.jan/agent/`), else
  a new id is minted.
- Matrix per-project keys are `cowork:<projectId>`, never a raw path.

### Component 3 — Enablement matrix (Rust)

- New `<jan_data_folder>/agent-workspace/extensions.json`:

  ```json
  {
    "skills": { "<skillId>": { "surfaces": ["home", "rooms", "cowork:<projectId>"] } },
    "plugins": { "<pluginId>": { "surfaces": [ ... ] } }
  }
  ```

- **Unset item = enabled on every surface** (backward compatible with the
  "empty whitelist = all" convention). An entry present with a `surfaces` array
  restricts the item to exactly those surfaces.
- Governs **global** items only. Project-local items are untouched.

### Component 4 — Single resolver (Rust)

- `resolve_extensions(surface, project_id?) -> ResolvedExtensions` where
  `surface ∈ { home, rooms, cowork }` (cowork requires `project_id`).
- Returns the merged skill catalog + plugin tool definitions after:
  1. discovering global skills/plugins (and, for cowork, the project's own),
  2. applying the shadow rules,
  3. filtering by the matrix for the requested surface.
- Callers:
  - **Cowork run:** existing `build_system_prompt_for` path calls the resolver
    with `surface=cowork, project_id=<id>`; it now also sees global plugins.
  - **Home run:** the `None` branch at `src-tauri/src/core/agent/loop.rs:3870`
    calls the resolver with `surface=home` and emits the resulting
    skills/memory block instead of returning a bare prompt.
  - **Rooms:** a new Tauri command `agent_resolve_extensions(surface, projectId?)`
    exposes the same resolver. `context.ts buildSystemPrompt` appends the
    returned catalog block and `roomTools.ts buildRoomTools` adds `skill_read` +
    plugin tools. Rooms assemble **nothing** themselves — they render what the
    resolver returns.

### Component 5 — `/extensions` route (web-app)

- New app-rail item in `RAIL_ITEMS` (`web-app/src/components/shell/AppRail.tsx`),
  reachable from Home, Cowork, and Rooms.
- **Plugins tab:** global installed list, install (local / git / marketplace),
  marketplace **browse & read** (`agent_plugin_search`), details, remove.
  Reuses the internals of `PluginsManagerDialog` against `scope=global`.
- **Skills tab:** global skills list, editor, hub import (reuses
  `SkillsManagerDialog` internals); project-local skills shown grouped by
  project for visibility.
- **Enablement grid (per item):** columns = Home · Rooms · one per registered
  Cowork project. Toggling a cell writes `extensions.json` via a new command.
  Unset row renders as all-checked (the default).
- The existing dialogs remain and can deep-link into the route.

## Data flow

```
install (global)         -> agent-workspace/plugins|skills
open cowork folder       -> register in projects.json (stable id)
toggle checkbox          -> extensions.json surfaces[]
run turn (any workspace) -> resolve_extensions(surface, projectId?)
                              -> discover global (+project) -> shadow -> matrix filter
                              -> skills catalog + plugin tools
Home/Cowork: consumed in Rust prompt build
Rooms: returned via Tauri command, injected in context.ts + roomTools.ts
```

## Error handling

- Missing/corrupt `extensions.json` or `projects.json` → treat as empty
  (item enabled everywhere; no registered projects). Never block a run.
- A matrix entry referencing a deleted skill/plugin or a `cowork:<projectId>`
  whose project is gone → the entry matches nothing and is ignored (mirrors the
  existing stale-whitelist-entry behavior).
- Global plugin install failures surface exactly as the project-scoped ones do
  today (typed `PluginError`).

## Testing

- **Rust**
  - `user_plugins_dir` merge + project-shadows-global for skills, commands, agents.
  - Folderless (`surface=home`) resolver emits global skills and global plugin
    tools and no project-only items.
  - Matrix filtering: an item restricted to `rooms` is absent for `home`/`cowork`
    and present for `rooms`; unset item present on all.
  - `projects.json`: stable id survives a folder rename (path updated, id kept).
- **TS**
  - Rooms bridge injects the resolver's catalog block + tools; a skill excluded
    for `rooms` does not appear.
  - `/extensions` route renders both tabs; a checkbox toggle persists and
    round-trips through `extensions.json`.
  - App-rail item routes from Home/Cowork/Rooms.

## Risks / open items

- Per-project columns only exist for folders that have been registered (opened
  at least once). A never-opened folder has no column until first opened.
  Accepted.
- Moved/renamed folder id continuity depends on an id marker in `.jan/agent/`;
  without it a move mints a new id (its old per-project toggles fall back to the
  default = enabled). Acceptable for v1; documented.
