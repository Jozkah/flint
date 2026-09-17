# Global Skills & Plugins Across All Workspaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skills and plugins installable once into a global store and usable in every workspace type (Home, Cowork, Rooms), with per-surface enablement, surfaced through a new `/extensions` route.

**Architecture:** Rust owns loading. A global plugins store (`agent-workspace/plugins`) is added next to the existing global skills store. One resolver, `resolve_extensions(surface, project_id?)`, merges global + project items, applies shadow rules, and filters by a per-surface enablement matrix (`extensions.json`). Home, Cowork, and Rooms all consume that one resolver (Rooms via a Tauri command). A `/extensions` React route manages install/edit/scope.

**Tech Stack:** Rust (Tauri commands, `std::fs`), `serde`/`serde_json`, React + TanStack Router + Zustand, `@tauri-apps/api` `invoke`, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-17-global-skills-plugins-design.md`

## Global Constraints

- **Base branch:** `feat/global-skills-plugins` off fork `main` (`e0b5d005b`), which HAS the global skills store (`user_skills_dir`/`discover_user`, `skills.rs:37,64`). Do NOT branch off `origin/main` (upstream menloresearch) — it lacks that store.
- **Global root:** `permanent_store(jan_data_folder)` = `<jan_data_folder>/agent-workspace` (`tauri-plugin-agent-tools/src/workspace.rs:62`). Global skills = `store_dir(store,"skills")`; global plugins = `store_dir(store,"plugins")` (`workspace.rs:44`, `tauri-plugin-agent-tools/src/skills.rs:54,59`).
- **Data folder:** `crate::core::app::commands::resolve_jan_data_folder()` (`src-tauri/src/core/app/commands.rs:215`). May be relative; never assume absolute.
- **Shadow rule (verbatim from existing `discover_user`):** a project item shadows a global/user item of the same `name`. Apply identically to plugins.
- **Enablement default:** an item absent from the matrix is enabled on **every** surface (mirrors "empty `[skills].enabled` = all").
- **Matrix governs global items only.** Project-local skills/plugins keep their existing `[skills].enabled` whitelist untouched.
- **Surfaces:** `home`, `rooms`, `cowork:<projectId>`. Project ids are stable ulids from `projects.json`, never raw folder paths.
- **Commit style:** Conventional Commits; end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Pre-commit hook is broken in this repo** (`core.hooksPath` → main checkout's `.husky` wants a missing `scripts/pre-commit.mjs`). Run `yarn lint` / `cargo fmt` manually; commit with `--no-verify` when the hook errors on module-not-found (not to bypass a real lint failure).
- **Rust test harness in worktree:** per repo memory, `app_lib` tests need `--no-default-features --features test-tauri`; agent-tools tests need the sandbox helper built first. Prefer `cargo test -p <crate> <module> --no-default-features --features test-tauri` and cap jobs (`-j 4`).

---

## File Structure

**Rust (`src-tauri/src/core/agent/`)**
- `skills.rs` — add `user_plugins_dir()`, `discover_user_plugins()`, merge into `discover_all`/plugin scan; new `extensions` matrix module lives in its own file.
- `extensions.rs` *(new)* — matrix types, `extensions.json` read/write, `resolve_extensions`, surface filter.
- `projects_registry.rs` *(new)* — `projects.json` read/write, `register_folder`, `list_projects`, `resolve_project_id`.
- `plugin_commands.rs` — merge global plugins into `scan`.
- `plugins.rs` — global scope for install/list/remove (agents scan already routes through `plugins_dir`; add global scan).
- `commands.rs` — new Tauri commands: `agent_extensions_matrix_get/set`, `agent_projects_list`, `agent_resolve_extensions`; add `scope` to plugin/skill commands.
- `context.rs` — `load_skills`/`load_memory_catalog` gain a global-only path for folderless runs.
- `loop.rs` — `build_run_system_prompt` `None` branch (`:3870`) emits a global skills block.
- `src-tauri/src/lib.rs` — register new commands in `generate_handler!`.

**TS (`web-app/src/`)**
- `lib/extensionsStore.ts` *(new)* — typed wrappers over the new commands.
- `lib/rooms/context.ts` — append resolver catalog block in `buildSystemPrompt`.
- `lib/rooms/roomTools.ts` — add `skill_read` + plugin tools from the resolver.
- `routes/extensions.tsx` *(new)* — the `/extensions` route with Plugins + Skills tabs.
- `containers/extensions/PluginsTab.tsx`, `SkillsTab.tsx`, `EnablementGrid.tsx` *(new)* — reuse existing dialog internals.
- `components/shell/AppRail.tsx` — add `RAIL_ITEMS` entry.
- `constants/routes.ts` — add the route constant.

---

## Phase 1 — Global plugins store (Rust)

### Task 1: `user_plugins_dir()` + `discover_user_plugins()`

**Files:**
- Modify: `src-tauri/src/core/agent/skills.rs` (near `user_skills_dir` `:37` and `discover_plugins` `:300`)
- Test: same file `#[cfg(test)]` module

**Interfaces:**
- Produces: `pub(crate) fn user_plugins_dir() -> Option<PathBuf>`; `pub(crate) fn discover_user_plugins(project_and_user_project: &[SkillEntry]) -> Vec<SkillEntry>`

- [ ] **Step 1: Write the failing test** (append to the tests module; uses the existing `TEST_USER_SKILLS` pattern — add a sibling `TEST_USER_PLUGINS` thread-local mirroring it):

```rust
#[test]
fn discover_user_plugins_are_tagged_and_shadowed_by_project() {
    let data = tempfile::tempdir().unwrap();
    let store = tauri_plugin_agent_tools::workspace::permanent_store(data.path());
    let gdir = tauri_plugin_agent_tools::skills::plugins_dir(&store).join("caveman");
    std::fs::create_dir_all(gdir.join("skills")).unwrap();
    std::fs::write(gdir.join("skills").join("SKILL.md"), "---\ndescription: g\n---\nbody").unwrap();
    set_test_user_plugins(Some(store));

    let project: Vec<SkillEntry> = Vec::new();
    let got = discover_user_plugins(&project);
    assert!(got.iter().any(|e| e.plugin.as_deref() == Some("caveman")),
        "global plugin skill not discovered: {got:?}");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p app_lib core::agent::skills::tests::discover_user_plugins --no-default-features --features test-tauri -j 4`
Expected: FAIL — `discover_user_plugins`/`set_test_user_plugins` not found.

- [ ] **Step 3: Implement**

```rust
/// The user's own plugins, shared by every workspace:
/// `<jan_data_folder>/agent-workspace/plugins`. Sibling of `user_skills_dir`.
#[cfg(not(test))]
pub(crate) fn user_plugins_dir() -> Option<PathBuf> {
    user_skill_store().map(|store| tauri_plugin_agent_tools::skills::plugins_dir(&store))
}

#[cfg(test)]
thread_local! {
    static TEST_USER_PLUGINS: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_test_user_plugins(store: Option<PathBuf>) {
    TEST_USER_PLUGINS.with(|d| *d.borrow_mut() = store);
}
#[cfg(test)]
pub(crate) fn user_plugins_dir() -> Option<PathBuf> {
    TEST_USER_PLUGINS.with(|d| d.borrow().clone())
        .map(|store| tauri_plugin_agent_tools::skills::plugins_dir(&store))
}

/// Global plugins' skills, tagged like project plugin skills. A project (or
/// project-scoped) plugin of the same directory name shadows a global one.
pub(crate) fn discover_user_plugins(project: &[SkillEntry]) -> Vec<SkillEntry> {
    let Some(dir) = user_plugins_dir() else { return Vec::new() };
    scan_plugins_at(&dir)
        .into_iter()
        .filter(|u| !project.iter().any(|p| p.plugin == u.plugin && p.name == u.name))
        .collect()
}
```

Refactor: extract the per-directory scan loop currently inside `discover_plugins` (`:300`) into `fn scan_plugins_at(dir: &Path) -> Vec<SkillEntry>` and have `discover_plugins` call `scan_plugins_at(&plugins_dir(root))`, so the global path reuses identical logic.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(agent): discover global plugin skills from agent-workspace/plugins`

### Task 2: Merge global plugins into `discover_all`

**Files:** Modify `src-tauri/src/core/agent/skills.rs` `discover_all` (`:321`); Test: same file.

**Interfaces:** Consumes Task 1. `discover_all` now yields project skills + project plugins + user skills + user plugins, with shadowing.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn discover_all_includes_global_plugins_after_project() {
    let proj = scratch_project("gp");
    let data = tempfile::tempdir().unwrap();
    let store = tauri_plugin_agent_tools::workspace::permanent_store(data.path());
    let gdir = tauri_plugin_agent_tools::skills::plugins_dir(&store).join("caveman");
    std::fs::create_dir_all(gdir.join("skills")).unwrap();
    std::fs::write(gdir.join("skills").join("SKILL.md"), "---\ndescription: g\n---\nb").unwrap();
    set_test_user_plugins(Some(store));

    let all = discover_all(&proj);
    assert!(all.iter().any(|e| e.plugin.as_deref() == Some("caveman")));
    let _ = std::fs::remove_dir_all(&proj);
}
```

- [ ] **Step 2: Run — FAIL** (`discover_all` doesn't call `discover_user_plugins` yet).
- [ ] **Step 3: Implement** — extend `discover_all`:

```rust
pub(crate) fn discover_all(root: &Path) -> Vec<SkillEntry> {
    let mut out = discover(root);
    let project_plugins = discover_plugins(root);
    let user_skills = discover_user(&out);
    let user_plugins = discover_user_plugins(&project_plugins);
    out.extend(project_plugins);
    out.extend(user_skills);
    out.extend(user_plugins);
    out
}
```

(Confirm the existing `discover_all` already folds `discover_user`; if so, only add the two plugin lines and keep ordering project-before-user.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(agent): merge global plugins into skill discovery`

### Task 3: Global plugins in commands + agents scan

**Files:** Modify `src-tauri/src/core/agent/plugin_commands.rs` `scan` (`:53`); `src-tauri/src/core/agent/plugins.rs` agents scan (the `read_dir(plugins_dir(root))` loop near `:1283`). Test: each file.

**Interfaces:** Both scanners union `plugins_dir(root)` with `user_plugins_dir()`, project shadows global by `(plugin, name)`.

- [ ] **Step 1: Failing test (commands)** in `plugin_commands.rs`:

```rust
#[test]
fn scan_includes_global_plugin_commands() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let store = tauri_plugin_agent_tools::workspace::permanent_store(data.path());
    let cdir = tauri_plugin_agent_tools::skills::plugins_dir(&store).join("caveman").join("commands");
    std::fs::create_dir_all(&cdir).unwrap();
    std::fs::write(cdir.join("commit.md"), "do commit").unwrap();
    crate::core::agent::skills::set_test_user_plugins(Some(store));

    let got = discover(root.path());
    assert!(got.iter().any(|c| c.plugin == "caveman" && c.name == "commit"));
}
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — factor the inner directory loop of `scan` into `fn scan_dir(dir: &Path, out: &mut Vec<CommandEntry>)` and call it for both `plugins_dir(root)` and `user_plugins_dir()`; after collecting, drop any global entry whose `(plugin,name)` a project entry already provides. Mirror the same refactor in `plugins.rs` for the agents scan.
- [ ] **Step 4: Run — PASS** (add the analogous agents test in `plugins.rs`).
- [ ] **Step 5: Commit** — `feat(agent): load global plugin commands and agents`

### Task 4: `scope` on plugin manager commands

**Files:** Modify `src-tauri/src/core/agent/plugins.rs` install/list/remove entry points and `commands.rs` `agent_plugin_*`; Test: `plugins.rs`.

**Interfaces:** `PluginScope { Project(PathBuf), Global }`; a `fn plugin_root(scope) -> PathBuf` returning `project_store(root)` or `permanent_store(data)`. Commands accept `scope: "project" | "global"` + optional `folder`.

- [ ] **Step 1: Failing test** — install into global scope, assert the dir lands under `permanent_store`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — thread a `PluginScope` (default `Project` for backward compat) through install/list/remove; where code does `plugins_dir(root)`, compute the dir from the scope's store instead.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(agent): scope plugin install/list/remove to project or global`

---

## Phase 2 — Projects registry (Rust)

### Task 5: `projects.json` read/write + stable ids

**Files:** Create `src-tauri/src/core/agent/projects_registry.rs`; add `mod projects_registry;` to `src-tauri/src/core/agent/mod.rs`; Test: in the new file.

**Interfaces:**
- Produces: `struct ProjectEntry { id: String, folder: String, name: String }`; `fn registry_path() -> Option<PathBuf>` (= `permanent_store(data).join("projects.json")`); `fn list_projects() -> Vec<ProjectEntry>`; `fn register_folder(folder: &Path) -> ProjectEntry` (returns existing id if folder matches, else mints a ulid, persists, and writes `<folder>/.jan/agent/.project-id` marker); `fn resolve_project_id(folder: &Path) -> Option<String>` (marker first, else path match).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn register_is_idempotent_and_survives_rename() {
    let data = tempfile::tempdir().unwrap();
    set_test_registry_root(Some(data.path().to_path_buf()));
    let a = tempfile::tempdir().unwrap();
    let e1 = register_folder(a.path());
    let e2 = register_folder(a.path());
    assert_eq!(e1.id, e2.id, "same folder must reuse id");
    // Simulate rename: new path, but the .project-id marker carries the id.
    let b = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(b.path().join(".jan/agent")).unwrap();
    std::fs::copy(a.path().join(".jan/agent/.project-id"),
                  b.path().join(".jan/agent/.project-id")).unwrap();
    let e3 = register_folder(b.path());
    assert_eq!(e1.id, e3.id, "moved folder keeps id via marker");
    assert_eq!(e3.folder, b.path().to_string_lossy());
}
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the module. JSON shape `{ "projects": [ {id,folder,name} ] }`. `register_folder`: read marker `<folder>/.jan/agent/.project-id`; if present and known, update that entry's `folder`/`name` and return it; else if a stored entry has this exact path reuse it; else mint `ulid`, write marker, append, persist. Use a `#[cfg(test)] set_test_registry_root` thread-local like `TEST_USER_SKILLS`. Corrupt/missing file → empty list (never panic).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(agent): stable project-id registry (projects.json)`

---

## Phase 3 — Enablement matrix + resolver (Rust)

### Task 6: matrix module (`extensions.json`)

**Files:** Create `src-tauri/src/core/agent/extensions.rs`; `mod extensions;` in `mod.rs`; Test: in-file.

**Interfaces:**
- Produces: `enum Surface { Home, Rooms, Cowork(String /*projectId*/) }` with `fn key(&self) -> String` (`"home"`, `"rooms"`, `"cowork:<id>"`); `struct Matrix` with `fn load() -> Matrix`, `fn save(&self)`, `fn is_enabled(&self, kind: ItemKind, id: &str, surface: &Surface) -> bool` (absent id ⇒ true), `fn set(&mut self, kind, id, surface, on)`; `enum ItemKind { Skill, Plugin }`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn absent_item_enabled_everywhere_present_is_restricted() {
    let m = Matrix::default();
    assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
    let mut m = m;
    m.set(ItemKind::Skill, "caveman", &Surface::Rooms, true); // now restricted to listed surfaces
    assert!(m.is_enabled(ItemKind::Skill, "caveman", &Surface::Rooms));
    assert!(!m.is_enabled(ItemKind::Skill, "caveman", &Surface::Home));
}
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Storage: `{ "skills": { id: { "surfaces": ["home","rooms","cowork:ID"] } }, "plugins": {...} }`. Semantics: entry **absent** ⇒ enabled on all surfaces; entry **present** ⇒ enabled only for surfaces in its list. `set(..., on=true)` inserts the surface key (creating the entry, which flips it to restricted-mode); `set(..., on=false)` removes that surface key (empty list stays = enabled nowhere). Path = `permanent_store(data).join("extensions.json")`; `#[cfg(test)]` uses a temp root thread-local. Corrupt/missing ⇒ `Matrix::default()`.
- [ ] **Step 4: Run — PASS.** Add a round-trip `save`/`load` test.
- [ ] **Step 5: Commit** — `feat(agent): per-surface enablement matrix (extensions.json)`

### Task 7: `resolve_extensions(surface, project_id?)`

**Files:** Modify `src-tauri/src/core/agent/extensions.rs`; Test: in-file.

**Interfaces:**
- Consumes: Task 1–3 discovery, Task 6 `Matrix`.
- Produces: `struct ResolvedExtensions { skills: Vec<SkillMeta>, plugin_tool_defs: Vec<PluginToolDef> }` and `pub(crate) fn resolve_extensions(surface: &Surface, project_root: Option<&Path>) -> ResolvedExtensions`.

- [ ] **Step 1: Failing test** — global skill `caveman` restricted to `rooms`; `resolve_extensions(&Surface::Home, None)` omits it, `resolve_extensions(&Surface::Rooms, None)` includes it.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Build the base list: for `Cowork`/`Home` pass a root to the existing `catalog(root, &enabled)`; for `Home`/`Rooms` (no project) call a new `global_catalog()` that runs `side_catalog` over `discover_user` + `discover_user_plugins` only (extract from `discover_all`). Then filter each item by `matrix.is_enabled(kind, item_id, surface)`. Plugin tool defs: reuse the existing plugin-tool builder, filtered the same way. `item_id` for a skill = its `plugin` id if it is a plugin skill else its name; the matrix keys plugins by plugin id and standalone skills by skill name.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(agent): single resolve_extensions loader for all surfaces`

---

## Phase 4 — Home folderless wiring (Rust)

### Task 8: folderless global skills block

**Files:** Modify `src-tauri/src/core/agent/context.rs` (`load_skills` `:97`) to add `fn load_global_skills() -> Option<String>`; modify `src-tauri/src/core/agent/loop.rs` `build_run_system_prompt` `None` branch (`:3870`). Test: `context.rs`.

**Interfaces:** Consumes Task 7. `load_global_skills()` renders the same `## Skill: <name>` block `load_skills` produces, but from `resolve_extensions(&Surface::Home, None)`.

- [ ] **Step 1: Failing test** in `context.rs`:

```rust
#[test]
fn home_run_emits_global_skills_block() {
    let data = tempfile::tempdir().unwrap();
    let store = tauri_plugin_agent_tools::workspace::permanent_store(data.path());
    let sdir = tauri_plugin_agent_tools::skills::skills_dir(&store).join("caveman");
    std::fs::create_dir_all(&sdir).unwrap();
    std::fs::write(sdir.join("SKILL.md"), "---\ndescription: Talk terse\n---\nbody").unwrap();
    crate::core::agent::skills::set_test_user_skills(Some(store));
    let block = load_global_skills().expect("global skills block");
    assert!(block.contains("## Skill: caveman"), "block: {block}");
}
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `load_global_skills` (reuse the `entries.iter().map(...)` rendering from `load_skills`, sourced from `resolve_extensions(&Surface::Home, None).skills`). Change `loop.rs:3870`:

```rust
None => {
    let base = base.map(str::to_string);
    match crate::core::agent::context::load_global_skills() {
        Some(block) => Some(match base {
            Some(b) => format!("{b}\n\n{block}"),
            None => block,
        }),
        None => base,
    }
}
```

- [ ] **Step 4: Run — PASS.** Also run the existing `build_system_prompt_*` tests to confirm the `Some(root)` path is unchanged.
- [ ] **Step 5: Commit** — `feat(agent): load global skills for folderless Home runs`

---

## Phase 5 — Tauri commands + Rooms bridge

### Task 9: Tauri commands

**Files:** Modify `src-tauri/src/core/agent/commands.rs`; register in `src-tauri/src/lib.rs` `generate_handler!` (near `:148`). Test: a lightweight `commands.rs` test or rely on the module tests above.

**Interfaces (frontend contract):**
- `agent_resolve_extensions(surface: string, projectId?: string) -> { skills: SkillMeta[]; pluginTools: PluginToolDef[] }`
- `agent_extensions_matrix_get() -> MatrixJson`
- `agent_extensions_matrix_set(kind, id, surface, enabled) -> MatrixJson`
- `agent_projects_list() -> ProjectEntry[]`
- `agent_projects_register(folder: string) -> ProjectEntry`

- [ ] **Step 1** Write a smoke test invoking `resolve_extensions` through the command wrapper for `surface="home"` returns the global skill.
- [ ] **Step 2** Run — FAIL.
- [ ] **Step 3** Implement thin `#[tauri::command]` wrappers mapping `surface` string → `Surface` (`"cowork"` requires `projectId`), calling the Phase 2/3/7 functions; add each to `generate_handler!`.
- [ ] **Step 4** Run — PASS. Then `cargo build -p app_lib --no-default-features --features test-tauri -j 4` to confirm the handler list compiles.
- [ ] **Step 5** Commit — `feat(agent): expose extensions resolver, matrix, and projects commands`

### Task 10: TS store wrapper

**Files:** Create `web-app/src/lib/extensionsStore.ts`; Test: `web-app/src/lib/__tests__/extensionsStore.test.ts`.

**Interfaces:** typed `invoke` wrappers mirroring Task 9, with a `Surface` union `'home' | 'rooms' | { cowork: string }` normalized to the command args.

- [ ] **Step 1** Vitest with a mocked `@tauri-apps/api/core` `invoke` asserting `resolveExtensions('rooms')` calls `agent_resolve_extensions` with `{ surface: 'rooms' }`.
- [ ] **Step 2** Run `yarn vitest run extensionsStore` — FAIL.
- [ ] **Step 3** Implement the wrappers (follow `web-app/src/lib/pluginStore.ts` style: typed results, error normalization).
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(web): extensionsStore wrappers for the resolver and matrix`

### Task 11: Rooms inject skills + tools

**Files:** Modify `web-app/src/lib/rooms/context.ts` (`buildSystemPrompt`) and `web-app/src/lib/rooms/roomTools.ts` (`buildRoomTools`); Test: `web-app/src/lib/rooms/__tests__/`.

**Interfaces:** Consumes Task 10. `buildSystemPrompt` becomes async or takes a pre-fetched `ResolvedExtensions`; `buildRoomTools` appends `skill_read` + plugin tool defs from the resolver for `surface='rooms'`.

- [ ] **Step 1** Failing test: given a resolver stub returning a `caveman` skill, `buildSystemPrompt` output contains `## Skill: caveman` and `buildRoomTools` includes a `skill_read` tool.
- [ ] **Step 2** Run — FAIL.
- [ ] **Step 3** Implement: fetch `resolveExtensions('rooms')` at the room-turn build seam (`engine.ts` where `buildSystemPrompt`/`buildRoomTools` are called), thread the result in. Keep rooms assembling nothing itself — only render/attach what the resolver returns.
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(rooms): load global skills and plugin tools into room turns`

---

## Phase 6 — `/extensions` route (web-app)

### Task 12: route shell + app-rail entry

**Files:** Create `web-app/src/routes/extensions.tsx`; modify `web-app/src/components/shell/AppRail.tsx` (`RAIL_ITEMS`) and `web-app/src/constants/routes.ts`; regenerate `routeTree.gen.ts` via the dev/build step. Test: `web-app/src/__tests__` render test + AppRail test.

**Interfaces:** Produces route `/extensions` with two tabs (`plugins` | `skills`) via a `Tabs` component; a `scope` state (`global` default). App-rail item with a Puzzle icon and `labelKey: 'common:appRail.extensions'` (add the i18n key).

- [ ] **Step 1** Failing test: rendering `<ExtensionsRoute/>` shows both tab labels; `RAIL_ITEMS` contains an item whose `to === '/extensions'`.
- [ ] **Step 2** Run `yarn vitest run extensions` — FAIL.
- [ ] **Step 3** Implement the route (follow `routes/logs.tsx`/`artifacts.tsx` for structure) and the rail item (mirror an existing `RAIL_ITEMS` entry). Add the i18n key to `web-app/src/locales/en/common.json`.
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(web): /extensions route and app-rail entry`

### Task 13: Plugins tab (global) + marketplace browse

**Files:** Create `web-app/src/containers/extensions/PluginsTab.tsx`; Test: sibling `__tests__`.

**Interfaces:** Reuses `PluginsManagerDialog` internals against `scope='global'` (folder-independent). Adds a marketplace **browse** list from `agent_plugin_search`.

- [ ] **Step 1** Failing test: with a stubbed `listPlugins(scope:'global')` returning one plugin, the tab lists it; the Browse view calls `agent_plugin_search`.
- [ ] **Step 2** Run — FAIL.
- [ ] **Step 3** Implement: lift the list/details/install/remove logic out of `PluginsManagerDialog` into a shared hook or component that takes a `scope`, and render it here with `scope='global'`. Add a Browse panel that shows marketplace entries (name + description) with an Install action.
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(web): global Plugins tab with marketplace browse`

### Task 14: Skills tab grouped by project

**Files:** Create `web-app/src/containers/extensions/SkillsTab.tsx`; Test: sibling.

**Interfaces:** Global skills list (reuse `SkillsManagerDialog` internals with the global store); project-local skills grouped under each `ProjectEntry` from `agent_projects_list`.

- [ ] **Step 1** Failing test: two registered projects each with a local skill render under their group headers; global skills render under a "Global" group.
- [ ] **Step 2** Run — FAIL.
- [ ] **Step 3** Implement: fetch `agent_projects_list`, render a "Global" group plus one group per project; reuse the skills editor/hub-import from `SkillsManagerDialog`.
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(web): Skills tab grouped by project`

### Task 15: enablement grid

**Files:** Create `web-app/src/containers/extensions/EnablementGrid.tsx`; wire into both tabs' detail panes; Test: sibling.

**Interfaces:** Columns = Home, Rooms, one per `ProjectEntry`. A checkbox at (item, surface) reads `agent_extensions_matrix_get` and writes `agent_extensions_matrix_set`. Unset item renders all-checked.

- [ ] **Step 1** Failing test: toggling the Rooms cell for `caveman` calls `agent_extensions_matrix_set('skill','caveman','rooms', ...)`; an item absent from the matrix shows all boxes checked.
- [ ] **Step 2** Run — FAIL.
- [ ] **Step 3** Implement the grid with optimistic toggle + revert on error (mirror `PluginsManagerDialog`'s `toggle`). Surface key for a project column = `cowork:<project.id>`.
- [ ] **Step 4** Run — PASS.
- [ ] **Step 5** Commit — `feat(web): per-surface enablement grid for skills and plugins`

---

## Phase 7 — Integration & verification

### Task 16: end-to-end verification + pre-PR build

- [ ] **Step 1** `cargo test -p app_lib core::agent --no-default-features --features test-tauri -j 4` — all green.
- [ ] **Step 2** `yarn vitest run` for touched areas (`extensions`, `rooms`) — green.
- [ ] **Step 3** Full pre-PR build per user rule: `yarn build` (web) and `cargo build -p app_lib --no-default-features --features test-tauri -j 4`. Fix every error before proceeding. Record the exact commands + results in the PR body.
- [ ] **Step 4** Manual smoke via the `run` skill: open `/extensions`, install a global plugin, enable a skill for Rooms only, confirm it appears in a Room turn and not in a Cowork turn.
- [ ] **Step 5** Commit any fixes — `test: verify global skills/plugins across Home, Cowork, Rooms`

---

## Self-Review

**Spec coverage:** global plugins store → Tasks 1–4; single resolver → Task 7; Home folderless → Task 8; Rooms runtime → Task 11; stable project ids → Task 5; matrix (global-only, unset=all) → Tasks 6–7, 15; `/extensions` route with tabs/browse/grouping/grid → Tasks 12–15; per-surface checkboxes → Task 15. All spec sections mapped.

**Placeholder scan:** every code step carries real code or a precise refactor instruction with the exact function to extract and the exact call sites (`skills.rs:300/321`, `plugin_commands.rs:53`, `loop.rs:3870`, `context.rs:97`).

**Type consistency:** `Surface`/`ItemKind`/`Matrix`/`ResolvedExtensions`/`ProjectEntry` defined in Phases 2–3 and consumed unchanged in Phases 4–6; command names in Task 9 match the TS wrappers in Task 10 and their callers in Tasks 11–15.
