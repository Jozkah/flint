//! Assembles system-prompt additions from a project's context. Today this is
//! skill loading: markdown files under `.jan/agent/skills/` concatenated
//! Claude-style into a single block appended to the agent's system prompt.

use std::path::Path;

use chrono::Local;

use crate::core::agent::git;
use tauri_plugin_agent_tools::{memory, workspace};

/// Default persona used only when no assistant instructions are supplied, so a
/// bare project run still opens with a role statement instead of "# Working
/// Directory". An assistant's own instructions replace this entirely.
const DEFAULT_IDENTITY: &str = "You're currently running on Jan agent harness";

/// Always-on behavioral guidelines. Kept short and model-facing.
const GUIDELINES: &str =
    "# Guidelines\n\n- Be concise in your responses.\n- Show file paths clearly when working with files.\n\
- Reach for `todo` only when work genuinely needs tracking: several independent steps, or a task long enough that you or the user would otherwise lose the thread. When you do keep it current as tasks start, finish, or are abandoned. Most requests do not need one -- greetings, questions, single-file edits, and anything you can finish in a step or two are better done directly, and a plan for small work is noise the user has to read past.\n\
- Call `ask` when the user's answer would materially change scope, behavior, or an irreversible action and it cannot be safely inferred from the request or project context. Ask concise, decision-ready questions; otherwise make the reasonable choice and proceed.\n\
- Tool output is complete and verbatim. Trust it. Do not re-run a command to check for hidden or \
missing output: when output is cut it always carries an explicit `[output truncated ...]` notice, so \
its absence means you have everything. A command's `[exit N]` line is the authoritative result -- \
`[exit 0]` is success even if there is text on stderr (many tools write normal status there).";

/// The one instructions file Jan reads, discovered by walking from the project
/// root up to the filesystem root. Another agent's file (`AGENTS.md`,
/// `CLAUDE.md`) is deliberately not ingested: only what a user wrote for Jan --
/// by hand or through `/init` -- becomes authoritative project context.
const CONTEXT_FILE_NAME: &str = "JAN.md";

/// Ingest `JAN.md` from the project root and its ancestors, wrapped in a
/// `<project_context>` block so the model treats them as authoritative project
/// instructions. Returns None when none exist.
pub(crate) fn load_context_files(project_root: &Path) -> Option<String> {
    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    let mut dir = Some(project_root);
    while let Some(current) = dir {
        let path = current.join(CONTEXT_FILE_NAME);
        if let Ok(content) = std::fs::read_to_string(&path) {
            if !content.trim().is_empty() {
                files.push((path, content));
            }
        }
        dir = current.parent();
    }
    if files.is_empty() {
        return None;
    }
    // Ancestors are collected nearest-first; reverse so the nearest (most
    // specific) instructions appear last and take precedence.
    files.reverse();
    let mut block =
        String::from("<project_context>\n\nProject-specific instructions and guidelines:\n\n");
    for (path, content) in files {
        block.push_str(&format!(
            "<project_instructions path=\"{}\">\n{}\n</project_instructions>\n\n",
            path.display(),
            content.trim()
        ));
    }
    block.push_str("</project_context>");
    Some(block)
}

/// Whether this project has usable instructions, by the same rule the system
/// prompt uses: a non-empty `JAN.md` at the root or in any ancestor. Drives the
/// `/init` invitation on the CLI splash, so an ancestor's file (a monorepo root)
/// correctly counts as already onboarded.
#[cfg(feature = "cli")]
pub(crate) fn has_context_file(project_root: &Path) -> bool {
    load_context_files(project_root).is_some()
}

/// Built-in guide teaching the model the skills/memory file conventions. Always
/// injected for project runs so the model can read and maintain both without
/// prior knowledge. Embedded in the binary at compile time.
const DEFAULT_SKILL_GUIDE: &str = include_str!("default_skill.md");

/// Build the skills catalog for the system prompt: one `## Skill: <name>` entry
/// per skill with its one-line description only — NOT the full body. Progressive
/// disclosure: the model calls `skill_read` to pull a skill's full instructions
/// on demand, so a large skill library costs ~a description each, not full text.
/// Skills with `disable-model-invocation: true` are excluded (user-invoked
/// skills pay no context load). Covers folder skills (`<name>/SKILL.md`) and
/// legacy flat `<name>.md`. Returns None when no advertisable skill exists.
pub(crate) fn load_skills(project_root: &Path) -> Option<String> {
    let enabled = crate::core::agent::project::enabled_skills(project_root);
    let entries = crate::core::agent::skills::catalog(project_root, &enabled);
    if entries.is_empty() {
        return None;
    }
    let list = entries
        .iter()
        .map(|m| {
            // AH-123: a skill that declares a version is named with it, so a
            // request for "deploy 2.x" can be matched against what is here.
            let name = match &m.version {
                Some(version) => format!("{} (v{version})", m.name),
                None => m.name.clone(),
            };
            if m.description.is_empty() {
                format!("## Skill: {name}")
            } else {
                format!("## Skill: {name}\n\n{}", m.description)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(format!(
        "# Available Skills\n\nEach skill below lists its name and purpose. Before applying a skill, call `skill_read` with its name to load its full instructions.\n\n{list}"
    ))
}

/// Always-on guidance teaching the model that web access is a native built-in
/// capability. Per jan-internal#196 the tools are provider-neutral: the model
/// must call `web_search`/`web_fetch`, never a provider-branded name like
/// `exa_search`, and should cite the URLs it relies on.
const WEB_TOOLS_GUIDE: &str = "# Web Access\n\nYou have two native, built-in tools for the live web. They are provider-neutral \
(the search backend is configured by Jan) and work out of the box — do NOT look for, ask for, or call a \
provider-branded tool such as `exa_search`, and do not say you lack internet access.\n\n\
## When to use them\n\n\
Reach for the web whenever the answer depends on current, external, or fast-changing information: recent events, \
library/API versions and docs, error messages, prices, people, or anything you are unsure about or that is outside \
your training data. Prefer verifying over guessing.\n\n\
## How to call them\n\n\
- `web_search` — find sources. Arguments: `query` (required string; write a specific, natural-language description \
of the ideal page, not just keywords) and optional `count` (integer, default 5, max 20). Returns a numbered list of \
results with title, URL, and a snippet.\n\
- `web_fetch` — read one page. Argument: `url` (required http(s) string, typically a URL returned by `web_search`). \
Returns the page's readable text with its title and source URL (bounded in length).\n\n\
## Workflow\n\n\
1. Call `web_search` with a focused query.\n\
2. Pick the most relevant result(s) and call `web_fetch` on their URLs to read the full content — don't rely on \
snippets alone for anything important.\n\
3. Base your answer on what you read and cite the source URLs you used. If results are thin, refine the query and \
search again. If a tool returns text starting with `ERROR`, read it, adjust your arguments, and retry or tell the \
user what's wrong.";

/// Guidance injected only when subagent tools are actually available, so the
/// model delegates context-heavy exploration instead of exhausting its own
/// (limited) context window reading files and tool output directly.
const SUBAGENT_GUIDE: &str = "# Subagents\n\nYour own context window is limited. For open-ended exploration \
that could pull in a lot of file content or tool output (broad codebase search, reading files, many \
multi-step research), prefer `dispatch_subagent` over doing it inline: the subagent absorbs that context \
in its own window and returns only the distilled answer. Dispatch independent subagents in parallel when \
their work doesn't depend on each other, then `await_subagent` each. Do inline work yourself for small, \
targeted tasks where delegating would cost more than it saves.";

/// System-prompt addendum for a `/goal` run with no staged plan: an unattended
/// loop that keeps firing turns until a condition is met needs the phased list
/// up front, both to work through and for the user to read on return. Paired
/// with a forced `tool_choice` on that turn (see `should_force_goal_todo_plan`
/// and its caller), so this is a real requirement, not a suggestion the model
/// can silently skip -- the imperative wording matches that guarantee. Normal
/// turns never get it: there the model decides when a list is worth keeping.
pub(crate) const EAGER_TODO_PROMPT_ADDENDUM: &str =
    "Before substantial work on this request, create a \
phased todo. You MUST call `todo` first in this turn with a single `init` op covering \
investigation through implementation and verification, not just the next step. Keep each task \
to a concise, specific 5-10 word label; `init` only accepts phase names and task-label strings, \
passed as the `list` argument (e.g. `list: [{phase: \"Setup\", items: [\"...\"]}]`) -- never as \
top-level `phase`/`task` strings, which are for later ops (start/done/drop), not init. After \
`todo` succeeds, continue the request in the same turn.";

/// Upkeep half of the todo guidance, applied on every turn that has a non-empty
/// list, in every mode -- including a list the model staged on its own. The
/// init addendum above only ever fires under `/goal`, so a normal or resumed
/// session would otherwise carry a list the model was never told to maintain --
/// which is exactly how a run ends reading 0/N with every task finished but
/// still marked pending.
pub(crate) const TODO_UPKEEP_PROMPT_ADDENDUM: &str =
    "You have an active todo list. Keep it honest as you \
work: the moment you finish a task call `todo` with `done` for it (or `drop` if you are skipping \
it), before moving on to the next one. Do not leave finished work sitting as pending, and do not \
batch the close-out to the end of the turn.";

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Build a compact runtime environment block injected into the system prompt at
/// session start so the agent is grounded from turn one. Mirrors the
/// `<workstation>` / cwd / date context blocks that harnesses like this one
/// already inject. Fields: working directory, OS/platform/arch, date, shell, and
/// git state (branch name when the project is inside a git repo). Kept short —
/// a few lines, not a wall of text.
fn runtime_environment_block(project_root: &Path, scratch: Option<&Path>) -> String {
    let cwd = display_path(project_root);

    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    let now = Local::now();
    let date = now.format("%Y-%m-%d").to_string();

    let shell = std::env::var("SHELL")
        .or_else(|_| std::env::var("COMSPEC"))
        .unwrap_or_else(|_| "unknown".to_string());

    let git_branch = git::current_branch(project_root);
    let git_line = match &git_branch {
        Some(branch) => format!("Git branch: `{branch}`"),
        None => "Git: not a git repository (or no commits yet)".to_string(),
    };

    // Where to do temporary work. Named by the one spelling that resolves from
    // both `bash` and the filesystem tools on this platform: `/tmp` where the
    // sandbox binds the scratch over it, the real path where nothing is mounted
    // there. Same directory either way, and the shell's `TMPDIR`/`TMP`/`TEMP`
    // point at it too.
    let scratch_line = match scratch {
        Some(scratch) => format!(
            "\nScratch: `{}` is a writable scratch space for temporary work; it persists for this session.",
            tauri_plugin_agent_tools::tools::sandbox::scratch_display_path(Some(scratch), scratch)
        ),
        None => String::new(),
    };

    format!(
        "# Runtime Environment\n\n\
Work directory: `{cwd}`\n\
OS: `{os}`\n\
Date: `{date}`\n\
Shell: `{shell}`\n\
{git_line}{scratch_line}"
    )
}

/// A catalog of curated memory notes (names + one-line summaries), injected so
/// the model can read a note on demand with `memory_read`. None when no note
/// exists. Mirrors `load_skills`: progressive disclosure, not full bodies.
pub(crate) fn load_memory_catalog(project_root: &Path) -> Option<String> {
    let entries = memory::catalog(&workspace::project_store(project_root));
    if entries.is_empty() {
        return None;
    }
    let list = entries
        .iter()
        .map(|(name, description)| {
            if description.is_empty() {
                format!("- `{name}` - no summary")
            } else {
                format!("- `{name}` - {description}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "# Available Memories\n\nDurable facts recorded in this project. Read a note's full contents with `memory_read` when it is relevant to the current task.\n\n{list}"
    ))
}

/// Assemble the project system prompt: the optional base prompt, the always-on
/// built-in skills/memory guide, then any project-authored skills. The guide is
/// always present for project runs, so this never returns None.
pub(crate) fn build_system_prompt(
    base: Option<&str>,
    project_root: &Path,
    scratch: Option<&Path>,
    subagents_enabled: bool,
) -> Option<String> {
    build_system_prompt_for(base, project_root, scratch, subagents_enabled, None, false).0
}

/// Roughly how much of the prompt remembered facts may occupy.
///
/// Characters, converted from a token budget by the usual
/// four-characters-to-a-token rule of thumb, because this crate has no
/// tokeniser. A ceiling rather than a target: what matters is that memory can
/// never crowd out the conversation, and that when the cap bites it drops the
/// least specific record rather than whichever happened to be last.
// Shared with the desktop's own retrieval command, so the same conversation
// cannot remember different things depending on which surface asked.
use tauri_plugin_agent_tools::memory::retrieve::DEFAULT_BUDGET_CHARS as MEMORY_BUDGET_CHARS;

/// The permanent store root, or `None` when the data folder cannot be resolved.
///
/// `None` costs user and session memory for this turn. It never falls back to a
/// guessed directory, which could read another profile's records.
fn permanent_store_root() -> Option<std::path::PathBuf> {
    let data = crate::core::app::commands::resolve_jan_data_folder();
    (!data.as_os_str().is_empty()).then(|| workspace::permanent_store(&data))
}

/// Remembered facts for this session and project: filtered, ranked and capped.
///
/// Returns the block *and* the selection, so a caller can report the exact
/// memory ids the model received rather than re-deriving them from the rendered
/// text, which could disagree with it.
///
/// Session and user records live in the permanent store; project records live
/// with the project, so moving a checkout takes its memories along. A project
/// that cannot be identified retrieves nothing rather than everything.
/// The instruction text above memory for this project: `JAN.md` and the
/// descriptions of the enabled skills. A memory contradicting either is
/// withheld (AH-084). Skill bodies are not read here; the catalog the model
/// sees is descriptions, so that is what memory is checked against.
fn instructions_above_memory(project_root: &Path) -> Vec<memory::precedence::Instruction> {
    use memory::precedence::{Instruction, Source};
    let mut out = Vec::new();
    if let Some(context) = load_context_files(project_root) {
        out.push(Instruction { source: Source::JanMd, name: CONTEXT_FILE_NAME.to_string(), text: context });
    }
    let enabled = crate::core::agent::project::enabled_skills(project_root);
    for skill in crate::core::agent::skills::catalog(project_root, &enabled) {
        if !skill.description.trim().is_empty() {
            out.push(Instruction {
                source: Source::Skill,
                name: skill.name.clone(),
                text: skill.description.clone(),
            });
        }
    }
    out
}

pub(crate) fn load_memories(
    project_root: &Path,
    session_id: Option<&str>,
    temporary: bool,
) -> (Option<String>, memory::retrieve::Selection) {
    use memory::record::Scope;

    let project_id = memory::identity::project_id(project_root);
    let project_store = workspace::project_store(project_root);

    // Bring the legacy `<name>.md` notes across, once. Idempotent and keyed by
    // content, so this is a no-op on every run after the first and does not
    // re-import a note that was renamed in between. The legacy files are never
    // touched, so nothing is lost if this fails -- and if it does fail, that is
    // logged and retrieval continues with whatever is already canonical, rather
    // than costing the user their memories over a failed copy.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    match memory::migrate::migrate_project_notes(&project_store, project_id.as_deref(), now) {
        Ok(report) if report.changed_anything() => log::info!("{}", report.summary()),
        Ok(_) => {}
        Err(e) => log::warn!("memory migration skipped: {e}"),
    }

    let mut records = memory::store::load(&project_store, Scope::Project).records;
    if let Some(permanent) = permanent_store_root() {
        records.extend(memory::store::load(&permanent, Scope::User).records);
        records.extend(memory::store::load(&permanent, Scope::Session).records);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let instructions = instructions_above_memory(project_root);
    let selection = memory::retrieve::select(
        &records,
        &memory::retrieve::RetrievalContext {
            session_id,
            project_id: project_id.as_deref(),
            now,
            budget_chars: MEMORY_BUDGET_CHARS,
            temporary,
            instructions: &instructions,
        },
    );
    (selection.render(), selection)
}

/// [`build_system_prompt`] with the session it is being built for.
///
/// Split out rather than widening the old signature, so every existing caller
/// keeps compiling and keeps its behaviour. This is the path production
/// dispatch takes, and it hands back the memory selection alongside the prompt
/// so the injected ids can be recorded against the invocation.
pub(crate) fn build_system_prompt_for(
    base: Option<&str>,
    project_root: &Path,
    scratch: Option<&Path>,
    subagents_enabled: bool,
    session_id: Option<&str>,
    temporary: bool,
) -> (Option<String>, memory::retrieve::Selection) {
    let mut blocks: Vec<String> = Vec::new();
    match base {
        Some(b) => blocks.push(b.to_string()),
        None => blocks.push(DEFAULT_IDENTITY.to_string()),
    }
    blocks.push(GUIDELINES.to_string());
    blocks.push(format!(
        "# Working Directory\n\nCurrent project directory: `{}`\n\nAll relative paths in tool calls resolve against this directory unless stated otherwise.",
        project_root.display()
    ));
    blocks.push(runtime_environment_block(project_root, scratch));
    // How the project builds and tests, so the model does not rediscover it
    // with `ls` every run, or guess. AH-068 / AH-069 / AH-070. A detection
    // that cannot run is logged with its reason; the prompt goes without.
    let no_cancel = std::sync::atomic::AtomicBool::new(false);
    match crate::core::agent::tooling::detect(project_root, &no_cancel) {
        Ok(tooling) => {
            if let Some(block) = tooling.render() {
                blocks.push(block);
            }
        }
        Err(e) => log::warn!("{e}"),
    }
    if subagents_enabled {
        blocks.push(SUBAGENT_GUIDE.to_string());
    }
    blocks.push(DEFAULT_SKILL_GUIDE.trim().to_string());
    blocks.push(WEB_TOOLS_GUIDE.to_string());
    if let Some(context) = load_context_files(project_root) {
        blocks.push(context);
    }
    if let Some(skills) = load_skills(project_root) {
        blocks.push(skills);
    }
    if let Some(memory) = load_memory_catalog(project_root) {
        blocks.push(memory);
    }
    // The chain that ranks everything above, stated once (AH-084), then the
    // remembered facts last: nothing already in the prompt is displaced by
    // them, and the block sits closest to the conversation it describes.
    blocks.push(memory::precedence::STATEMENT.to_string());
    let (remembered, selection) = load_memories(project_root, session_id, temporary);
    if let Some(remembered) = remembered {
        blocks.push(remembered);
    }
    (Some(blocks.join("\n\n")), selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch_project(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jan_ctx_test_{tag}_{n}"))
    }

    /// Save a canonical memory record the way production reads it back.
    fn save_memory(
        store_root: &Path,
        id: &str,
        content: &str,
        scope: memory::record::Scope,
        project_id: Option<&str>,
        session_id: Option<&str>,
    ) {
        use memory::record::{Creator, MemoryId, MemoryRecord, Origin};
        let mut record = MemoryRecord::new(
            MemoryId::new(id),
            content,
            scope,
            Creator::User,
            Origin::Explicit,
            1_000,
        );
        record.project_id = project_id.map(str::to_string);
        record.session_id = session_id.map(str::to_string);
        memory::store::upsert(store_root, &record).expect("save memory");
    }

    /// Point the permanent store (user and session memory) at a scratch tree,
    /// so a test never reads or writes the developer's real Jan data folder.
    fn with_temp_data_folder<T>(f: impl FnOnce(&Path) -> T) -> T {
        // The shared environment lock: a private one excluded only the other
        // callers of this helper, not the tests that point the same variable
        // somewhere else.
        let _guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();

        let dir = scratch_project("data");
        std::fs::create_dir_all(&dir).unwrap();
        let previous = std::env::var_os("JAN_DATA_FOLDER");
        std::env::set_var("JAN_DATA_FOLDER", &dir);

        let permanent = workspace::permanent_store(&dir);
        let out = f(&permanent);

        match previous {
            Some(p) => std::env::set_var("JAN_DATA_FOLDER", p),
            None => std::env::remove_var("JAN_DATA_FOLDER"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    fn write_skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(".jan").join("agent").join("skills");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn write_memory(root: &Path, name: &str, body: &str) {
        let dir = root.join(".jan").join("agent").join("memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn built_in_jan_skill_is_advertised_without_project_skills() {
        let root = scratch_project("nodir");
        let block = load_skills(&root).expect("built-in skills block");
        assert!(block.contains("## Skill: jan"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skills_concatenate_sorted_by_filename() {
        let root = scratch_project("concat");
        write_skill(&root, "b_second.md", "Second skill body.");
        write_skill(&root, "a_first.md", "First skill body.");
        write_skill(&root, "ignored.txt", "not markdown");
        write_skill(&root, "empty.md", "   ");

        let block = load_skills(&root).expect("skills block");
        assert!(block.starts_with("# Available Skills"));
        assert!(block.contains("## Skill: a_first"));
        assert!(block.contains("## Skill: b_second"));
        assert!(!block.contains("not markdown"));
        assert!(!block.contains("## Skill: empty"));
        // Alphabetical: a_first precedes b_second.
        assert!(block.find("a_first").unwrap() < block.find("b_second").unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn catalog_advertises_description_not_full_body() {
        let root = scratch_project("catalog");
        write_skill(
            &root,
            "deploy.md",
            "---\ndescription: How to deploy\n---\n\nSECRET_BODY_MARKER run ./deploy.sh",
        );
        let block = load_skills(&root).expect("skills block");
        assert!(block.contains("## Skill: deploy"));
        assert!(block.contains("How to deploy"));
        // Progressive disclosure: the body stays out of the prompt until read.
        assert!(!block.contains("SECRET_BODY_MARKER"));
        assert!(block.contains("skill_read"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_catalog_advertises_summary_not_full_body() {
        let root = scratch_project("memcatalog");
        write_memory(
            &root,
            "decisions.md",
            "We use Yarn not npm.\nSECRET_BODY_MARKER follow-up detail.",
        );
        write_memory(&root, "prefs.md", "Keep it minimal.");
        write_memory(&root, "ignored.txt", "not markdown");

        let block = load_memory_catalog(&root).expect("memory block");
        assert!(block.starts_with("# Available Memories"));
        assert!(block.contains("- `decisions` - We use Yarn not npm."));
        assert!(block.contains("- `prefs` - Keep it minimal."));
        // Progressive disclosure: only the first line is advertised; the rest
        // of the body stays out until memory_read.
        assert!(!block.contains("SECRET_BODY_MARKER"));
        assert!(block.contains("memory_read"));
        assert!(!block.contains("ignored.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_catalog_is_none_when_no_notes() {
        let root = scratch_project("memnone");
        assert!(load_memory_catalog(&root).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn catalog_respects_invocation_sides() {
        let root = scratch_project("sides");
        // Agent-invoked (user-invocable: false) stays advertised to the model.
        write_skill(
            &root,
            "agent-only.md",
            "---\ndescription: Agent fires this\ndisable-model-invocation: false\nuser-invocable: false\n---\nagent body",
        );
        // User-invoked (disable-model-invocation: true) costs the model nothing.
        write_skill(
            &root,
            "user-only.md",
            "---\ndescription: Human fires this\ndisable-model-invocation: true\n---\nuser body",
        );
        let block = load_skills(&root).expect("skills block");
        assert!(block.contains("## Skill: agent-only"), "block: {block}");
        assert!(
            !block.contains("## Skill: user-only"),
            "user-only leaked: {block}"
        );
        assert!(!block.contains("user body"), "body leaked: {block}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The property persistent memory exists for: something remembered in one
    /// conversation is present in the prompt a *different* conversation sends.
    ///
    /// Asserted on the serialized prompt rather than on the store, because the
    /// store having a record proves nothing about what the model receives.
    #[test]
    fn a_memory_saved_across_chats_reaches_a_different_chat() {
        with_temp_data_folder(|permanent| {
            let root = scratch_project("cross-chat");
            std::fs::create_dir_all(&root).unwrap();

            // Chat A remembers something "across chats".
            save_memory(
                permanent,
                "m-user",
                "The user prefers yarn over npm",
                memory::record::Scope::User,
                None,
                None,
            );

            // Chat B is a different session and has never seen chat A.
            let (prompt, selection) =
                build_system_prompt_for(Some("You are Jan."), &root, None, false, Some("chat-b"), false);
            let prompt = prompt.expect("prompt");

            assert!(
                prompt.contains("The user prefers yarn over npm"),
                "the memory never reached the second chat's prompt"
            );
            assert!(prompt.contains("[m-user]"), "the block must name the memory id");
            assert_eq!(
                selection.injected_ids(),
                vec![&memory::record::MemoryId::new("m-user")],
                "the selection must report exactly what was injected"
            );
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// Session memory is the opposite promise: it must not travel.
    #[test]
    fn session_memory_does_not_reach_another_chat() {
        with_temp_data_folder(|permanent| {
            let root = scratch_project("session-iso");
            std::fs::create_dir_all(&root).unwrap();

            save_memory(
                permanent,
                "m-session",
                "Only chat A should know this",
                memory::record::Scope::Session,
                None,
                Some("chat-a"),
            );

            let (in_a, _) =
                build_system_prompt_for(None, &root, None, false, Some("chat-a"), false);
            assert!(in_a.unwrap().contains("Only chat A should know this"));

            let (in_b, selection) =
                build_system_prompt_for(None, &root, None, false, Some("chat-b"), false);
            assert!(
                !in_b.unwrap().contains("Only chat A should know this"),
                "session memory leaked into another chat"
            );
            assert!(selection.injected.is_empty());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// Project memory reaches another chat in the same project, and no other
    /// project -- checked through the real prompt, with real project identity.
    #[test]
    fn project_memory_is_shared_within_a_project_and_nowhere_else() {
        with_temp_data_folder(|_| {
            let mine = scratch_project("proj-mine");
            let other = scratch_project("proj-other");
            std::fs::create_dir_all(&mine).unwrap();
            std::fs::create_dir_all(&other).unwrap();

            let id = memory::identity::project_id(&mine).expect("project id");
            save_memory(
                &workspace::project_store(&mine),
                "m-proj",
                "This project builds with make",
                memory::record::Scope::Project,
                Some(&id),
                None,
            );

            let (here, _) =
                build_system_prompt_for(None, &mine, None, false, Some("chat-b"), false);
            assert!(
                here.unwrap().contains("This project builds with make"),
                "another chat in the same project did not get project memory"
            );

            let (elsewhere, _) =
                build_system_prompt_for(None, &other, None, false, Some("chat-b"), false);
            assert!(
                !elsewhere.unwrap().contains("This project builds with make"),
                "project memory leaked into a different project"
            );
            let _ = std::fs::remove_dir_all(&mine);
            let _ = std::fs::remove_dir_all(&other);
        });
    }

    /// A temporary chat is memory-free in the backend, not merely in the UI.
    #[test]
    fn a_temporary_chat_gets_no_memory_in_its_prompt() {
        with_temp_data_folder(|permanent| {
            let root = scratch_project("temp-chat");
            std::fs::create_dir_all(&root).unwrap();
            save_memory(
                permanent,
                "m-user",
                "Remembered across chats",
                memory::record::Scope::User,
                None,
                None,
            );

            let (prompt, selection) =
                build_system_prompt_for(None, &root, None, false, Some("chat-t"), true);
            assert!(
                !prompt.unwrap().contains("Remembered across chats"),
                "a temporary chat received memory"
            );
            assert!(selection.injected.is_empty());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// The legacy notes AH-080 already wrote must keep working after the
    /// canonical store arrives -- through the real prompt, not a unit call.
    #[test]
    fn a_legacy_note_is_migrated_and_reaches_the_prompt() {
        with_temp_data_folder(|_| {
            let root = scratch_project("legacy");
            let dir = root.join(".jan").join("agent").join("memory");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("conventions.md"), "# Conventions
We build with make.")
                .unwrap();

            let (prompt, selection) =
                build_system_prompt_for(None, &root, None, false, Some("chat-a"), false);
            let prompt = prompt.unwrap();
            assert!(
                prompt.contains("We build with make."),
                "a legacy note did not reach the prompt after migration"
            );
            assert_eq!(selection.injected.len(), 1);

            // The legacy file is still there: migration copies, never moves.
            assert!(dir.join("conventions.md").exists());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// Running the prompt twice must not import the note twice.
    #[test]
    fn migration_through_the_prompt_is_idempotent() {
        with_temp_data_folder(|_| {
            let root = scratch_project("legacy-twice");
            let dir = root.join(".jan").join("agent").join("memory");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("a.md"), "one fact").unwrap();

            let _ = build_system_prompt_for(None, &root, None, false, Some("s"), false);
            let (_, second) =
                build_system_prompt_for(None, &root, None, false, Some("s"), false);
            assert_eq!(
                second.injected.len(),
                1,
                "the note was imported more than once"
            );
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// Memory is context, not instruction. The prompt has to say so, or a
    /// remembered line reads as an order that outranks the user's request.
    #[test]
    fn the_memory_block_does_not_present_itself_as_authority() {
        with_temp_data_folder(|permanent| {
            let root = scratch_project("authority");
            std::fs::create_dir_all(&root).unwrap();
            save_memory(
                permanent,
                "m-user",
                "Prefer concise answers",
                memory::record::Scope::User,
                None,
                None,
            );
            let (prompt, _) = build_system_prompt_for(None, &root, None, false, None, false);
            let prompt = prompt.unwrap();
            assert!(prompt.contains("not instructions that override the current request"));
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    /// AH-084 through the real prompt path: a project skill says pnpm, a user
    /// memory says npm. The prompt states the chain, the memory is not sent,
    /// and the selection reports the skill as the winner.
    #[test]
    fn a_skill_outranks_a_contradicting_memory_in_the_prompt() {
        with_temp_data_folder(|permanent| {
            let root = scratch_project("precedence-skill");
            std::fs::create_dir_all(&root).unwrap();
            write_skill(&root, "installer.md", "Install dependencies with pnpm.");
            save_memory(
                permanent,
                "m-npm",
                "Install dependencies with npm.",
                memory::record::Scope::User,
                None,
                None,
            );
            let (prompt, selection) =
                build_system_prompt_for(None, &root, None, false, Some("s"), false);
            let prompt = prompt.unwrap();
            assert!(prompt.contains("# Instruction precedence"));
            assert!(prompt.contains("6. Skills."));
            assert!(!prompt.contains("[m-npm]"), "a contradicted memory was sent");
            assert_eq!(selection.overridden.len(), 1, "{:?}", selection.overridden);
            assert_eq!(
                selection.overridden[0].winner,
                memory::precedence::Source::Skill
            );
            // The chain comes before the facts it ranks.
            assert!(
                prompt.find("# Instruction precedence").unwrap()
                    < prompt.find("Install dependencies with pnpm").unwrap_or(usize::MAX)
                    || !prompt.contains("# Remembered")
            );
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn build_system_prompt_orders_base_guide_then_skills() {
        let root = scratch_project("merge");
        write_skill(&root, "s.md", "Do the thing.");
        let out = build_system_prompt(Some("You are Jan."), &root, None, false).expect("prompt");
        assert!(out.starts_with("You are Jan."));
        assert!(out.contains("Do the thing."));
        // Guide sits between the base prompt and the project skills.
        let guide = out.find("Skills and Project Memory").unwrap();
        assert!(out.find("You are Jan.").unwrap() < guide);
        assert!(guide < out.find("Do the thing.").unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_system_prompt_advertises_native_web_tools() {
        let root = scratch_project("web");
        let out = build_system_prompt(None, &root, None, false).expect("prompt");
        assert!(out.contains("# Web Access"));
        assert!(out.contains("web_search"));
        assert!(out.contains("web_fetch"));
        // Provider-neutral: the model must not be told to call a branded tool.
        assert!(
            out.contains("exa_search"),
            "guide names the anti-pattern to avoid"
        );
        // Teaches how to call the tools, not just that they exist.
        assert!(out.contains("query"), "documents the web_search query arg");
        assert!(out.contains("count"), "documents the web_search count arg");
        assert!(out.contains("url"), "documents the web_fetch url arg");
        assert!(
            out.contains("Workflow"),
            "describes the search->fetch->cite flow"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_system_prompt_always_includes_guide() {
        let root = scratch_project("guide");
        // No base and no project skills: the built-in guide is still injected.
        let out = build_system_prompt(None, &root, None, false).expect("guide always present");
        assert!(out.contains("Skills and Project Memory"));
        assert!(out.contains("skill_write"));
        assert!(out.contains("memory_write"));

        // Base is preserved and precedes the guide.
        let with_base = build_system_prompt(Some("base"), &root, None, false).expect("prompt");
        assert!(with_base.starts_with("base"));
        assert!(with_base.contains("Skills and Project Memory"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-068 / AH-069 / AH-070. The model is told how the project builds and
    /// tests, from its manifests, and a project with none gets no block.
    #[test]
    fn build_system_prompt_names_the_project_tooling() {
        let root = scratch_project("tooling");
        std::fs::create_dir_all(root.join("web")).unwrap();
        std::fs::write(root.join("web").join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(
            root.join("web").join("package.json"),
            r#"{"scripts":{"build":"vite build","test":"vitest"},"devDependencies":{"vitest":"3"}}"#,
        )
        .unwrap();
        let out = build_system_prompt(None, &root, None, false).expect("prompt");
        assert!(out.contains("# Project Tooling"), "{out}");
        assert!(out.contains("- Vitest [unit] `pnpm test` in `web/` -- high; web/package.json"), "{out}");
        assert!(out.contains("`pnpm run build` in `web/`"), "{out}");
        let _ = std::fs::remove_dir_all(&root);

        let bare = scratch_project("tooling-none");
        std::fs::create_dir_all(&bare).unwrap();
        let out = build_system_prompt(None, &bare, None, false).expect("prompt");
        assert!(!out.contains("# Project Tooling"), "{out}");
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn default_identity_and_guidelines_present_without_base() {
        let root = scratch_project("identity");
        let out = build_system_prompt(None, &root, None, false).expect("prompt");
        assert!(out.starts_with("You're currently running on Jan agent harness"));
        assert!(out.contains("# Guidelines"));
        assert!(out.contains("Be concise"));
        assert!(out.contains("Reach for `todo` only when work genuinely needs tracking"));
        assert!(out.contains("Most requests do not need one"));
        assert!(out.contains("Call `ask` when the user's answer would materially change"));
        assert!(out.contains("Tool output is complete and verbatim"));
        assert!(out.contains("Do not re-run a command to check"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn context_files_ingested_nearest_last() {
        let root = scratch_project("ctxfiles");
        let nested = root.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("JAN.md"), "ROOT_RULES").unwrap();
        std::fs::write(nested.join("JAN.md"), "NESTED_RULES").unwrap();

        let block = load_context_files(&nested).expect("context block");
        assert!(block.starts_with("<project_context>"));
        assert!(block.contains("ROOT_RULES"));
        assert!(block.contains("NESTED_RULES"));
        assert!(block.contains("<project_instructions path="));
        // Nearest (nested) file wins by appearing last.
        assert!(block.find("ROOT_RULES").unwrap() < block.find("NESTED_RULES").unwrap());

        let prompt = build_system_prompt(None, &nested, None, false).expect("prompt");
        // Context files precede the skills catalog position and follow the guide.
        assert!(prompt.contains("NESTED_RULES"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_context_files_yields_none() {
        let root = scratch_project("noctx");
        std::fs::create_dir_all(&root).unwrap();
        assert!(load_context_files(&root).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_system_prompt_advertises_subagents_only_when_enabled() {
        let root = scratch_project("subagents");
        let without = build_system_prompt(None, &root, None, false).expect("prompt");
        assert!(!without.contains("dispatch_subagent"));
        let with = build_system_prompt(None, &root, None, true).expect("prompt");
        assert!(with.contains("dispatch_subagent"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Runtime environment block ────────────────────────────────────────

    #[test]
    fn runtime_environment_block_is_compact() {
        let root = scratch_project("env");
        std::fs::create_dir_all(&root).unwrap();
        let block = runtime_environment_block(&root, None);
        // Must be a handful of lines, not a wall of text.
        let lines: Vec<_> = block.lines().filter(|l| !l.is_empty()).collect();
        assert!(
            lines.len() <= 15,
            "env block is too large: {} lines",
            lines.len()
        );
        // Must contain the key sections.
        assert!(block.contains("# Runtime Environment"));
        assert!(block.contains("Work directory:"));
        assert!(block.contains("OS:"));
        assert!(block.contains("Date:"));
        assert!(block.contains("Shell:"));
        assert!(block.contains("Git:"));
        // Must reference actual compile-time constants.
        assert!(block.contains(std::env::consts::OS));
        assert!(block.contains(std::env::consts::ARCH));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn runtime_environment_block_injected_into_system_prompt() {
        let root = scratch_project("inject");
        std::fs::create_dir_all(&root).unwrap();
        let out = build_system_prompt(None, &root, None, false).expect("prompt");
        assert!(out.contains("# Runtime Environment"));
        assert!(out.contains("Work directory:"));
        // The block sits right after the Working Directory section.
        let work_dir_pos = out.find("# Working Directory").unwrap();
        let env_pos = out.find("# Runtime Environment").unwrap();
        assert!(
            work_dir_pos < env_pos,
            "env block must come after working directory"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn runtime_environment_block_answers_os_date_cwd() {
        let root = scratch_project("answer");
        std::fs::create_dir_all(&root).unwrap();
        let block = runtime_environment_block(&root, None);
        // The date field must be a real-looking ISO date.
        assert!(block.contains("Date: `20"), "date should be a 20xx year");
        // The OS field must identify the host platform.
        assert!(block.contains(format!("OS: `{}", std::env::consts::OS).as_str()));
        // Work directory should be present and non-empty.
        assert!(!block.contains("Work directory: ``"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The scratch must be advertised under the name that resolves from both
    /// `bash` and the filesystem tools: `/tmp` where the sandbox binds it there,
    /// the real path where nothing is mounted over `/tmp`. Naming the host path
    /// on Linux (or `/tmp` anywhere else) would send the model to a directory
    /// one of the two surfaces cannot reach.
    #[test]
    fn runtime_environment_block_advertises_the_scratch_the_tools_share() {
        let root = scratch_project("scratch");
        std::fs::create_dir_all(&root).unwrap();
        let scratch = root.join("agent-scratch");
        let block = runtime_environment_block(&root, Some(&scratch));
        let expected = if cfg!(target_os = "linux") {
            "/tmp".to_string()
        } else {
            scratch.to_string_lossy().into_owned()
        };
        assert!(
            block.contains(&format!("Scratch: `{expected}`")),
            "want {expected}: {block}"
        );
        assert!(block.contains("persists for this session"), "{block}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A run with no scratch (the server proxy path) must not promise one.
    #[test]
    fn runtime_environment_block_omits_the_scratch_when_there_is_none() {
        let root = scratch_project("noscratch");
        std::fs::create_dir_all(&root).unwrap();
        let block = runtime_environment_block(&root, None);
        assert!(!block.contains("Scratch:"), "{block}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn work_directory_is_the_project_root_not_the_process_cwd() {
        let root = scratch_project("cwd_is_root");
        std::fs::create_dir_all(&root).unwrap();
        let process_cwd = std::env::current_dir().expect("cwd");
        assert_ne!(
            root, process_cwd,
            "the test is meaningless unless the two differ"
        );

        let block = runtime_environment_block(&root, None);
        let expected = root.to_string_lossy().replace('\\', "/");
        assert!(
            block.contains(&format!("Work directory: `{expected}`")),
            "block should report the project root, got: {block}"
        );
        let cwd_shown = process_cwd.to_string_lossy().replace('\\', "/");
        assert!(
            !block.contains(&format!("Work directory: `{cwd_shown}`")),
            "block must not report the process cwd"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn work_directory_is_written_with_forward_slashes() {
        let root = scratch_project("cwd_slashes");
        std::fs::create_dir_all(&root).unwrap();
        let block = runtime_environment_block(&root, None);
        let line = block
            .lines()
            .find(|l| l.starts_with("Work directory:"))
            .expect("work directory line");
        assert!(
            !line.contains('\\'),
            "path should be slash-normalised: {line}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
