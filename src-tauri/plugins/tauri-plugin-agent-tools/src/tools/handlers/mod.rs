//! Native execution of the built-in tools. Sandbox escape is enforced by the
//! gate before these run; handlers only resolve paths and perform the operation.
//! Errors are returned as a String starting with "ERROR" (matching
//! `execute_mcp_tool_calls`) so the loop flags `is_error` correctly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use ignore::WalkBuilder;
use tokio::sync::oneshot;

use crate::memory;
use crate::skills;
use crate::tools::jail;
use crate::tools::nofollow;
use crate::tools::proc;
use crate::tools::sandbox::{
    canonicalize_lenient, escapes_write_roots, in_scratch, is_hidden_jan_path_in, lexical_normalize,
    refuse_windows_name, resolve_path, scratch_display_path, symlink_escapes_any_root, symlink_escapes_root,
};
use crate::tools::{BuiltinTool, ImageContentPart, ToolContext};

mod jobs;
#[allow(unused_imports)]
use jobs::*;
pub use jobs::BashJob;
pub use jobs::BashJobStatus;
pub use jobs::BashJobKillOutcome;
pub use jobs::BashJobKill;
pub use jobs::list_bash_jobs;
pub use jobs::inspect_bash_job;
pub use jobs::bash_job_output_since;
pub use jobs::kill_bash_job;

mod skills_memory;
#[allow(unused_imports)]
use skills_memory::*;

mod messages;
#[allow(unused_imports)]
use messages::*;

mod files;
#[allow(unused_imports)]
use files::*;
pub use files::with_read_success;

mod bash;
#[allow(unused_imports)]
use bash::*;
pub use bash::direct_edit_shell_start;
pub use bash::working_folder;
pub use bash::rebase_relative_paths;
pub use bash::bash_result_failed;
pub use bash::strip_ansi;

const MAX_BYTES: usize = 64 * 1024;
const MAX_LINES: usize = 2000;
/// Cap on the base64 data URL a `read` image becomes. Providers refuse larger
/// images (5 MiB is the strictest common limit), and a base64 blob is a third
/// bigger than the file, so the cap is on the encoded size, not the raw one.
const MAX_IMAGE_ENCODED_BYTES: usize = 5 * 1024 * 1024;
/// Largest raw image whose base64 form fits [`MAX_IMAGE_ENCODED_BYTES`], so an
/// oversized raster (or a large text file whose name ends in an image
/// extension) cannot flood the model context.
const MAX_IMAGE_BYTES: usize = MAX_IMAGE_ENCODED_BYTES / 4 * 3;
/// bash output caps, matching the `read` tool. Overflow is not lost: it spills
/// to a temp file the `read` tool can page through, so the cap is tuned for
/// context economy (~16k tokens worst case) rather than for fitting everything.
const BASH_MAX_BYTES: usize = MAX_BYTES;
/// Most of a command's output kept in its spill file.
const BASH_SPILL_MAX_BYTES: usize = 256 * 1024 * 1024;
const BASH_MAX_LINES: usize = MAX_LINES;
const GREP_MAX_LINE: usize = 500;
const LS_DEFAULT_LIMIT: usize = 500;
const FIND_DEFAULT_LIMIT: usize = 1000;
const GREP_DEFAULT_LIMIT: usize = 300;
/// Hard ceiling on grep matches returned to the model, whatever `limit` asks.
const GREP_MAX_RESULTS: usize = 300;
/// How long a `bash` call waits for the command before backgrounding it, when
/// the caller doesn't specify `timeout`.
const DEFAULT_BASH_TIMEOUT_SECS: u64 = 30;
/// Longest a foreground `bash` call may wait (the schema maximum).
const MAX_FOREGROUND_BASH_TIMEOUT_SECS: u64 = 120;

/// Counter for unique temp-file names for truncated bash output.
static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);
fn arg_str<'a>(args: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str())
}

fn arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

fn arg_bool(args: &serde_json::Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Single-quote a value for a POSIX shell. Single quotes disable `$`/backtick
/// expansion and globbing, and the only escape (closing quote) is handled by
/// the `'\''` idiom. Used when launching headless Chrome through the shell.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn rel_to(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// How a mutated path is named back to the model: relative inside the project,
/// absolute once it escapes. Normalizes first, since `root/../x` strips to a
/// misleading `../x` against an un-normalized root. A target inside the session
/// scratch is named by whichever spelling the shell can also use there.
fn display_path(root: &Path, scratch: Option<&Path>, target: &Path) -> String {
    if in_scratch(scratch, target) {
        return scratch_display_path(scratch, target);
    }
    rel_to(&lexical_normalize(root), &lexical_normalize(target))
}

/// Truncate `s` to the smaller of `max_lines` or `max_bytes`, appending
/// `note` when truncation occurred.
fn cap_output(s: &str, max_lines: usize, max_bytes: usize, note: &str) -> String {
    let mut out = String::new();
    let mut truncated = false;
    for (lines, line) in s.split_inclusive('\n').enumerate() {
        if lines >= max_lines || out.len() + line.len() > max_bytes {
            truncated = true;
            break;
        }
        out.push_str(line);
    }
    if truncated {
        out.push_str(note);
    }
    out
}

/// Collapse carriage-return redraws (`git`/`curl`-style progress lines) to what
/// a terminal would actually show: text after the last `\r` on each line wins.
/// Without this, thousands of `\r`-separated progress frames read as one giant
/// line and blow past the byte cap, so tiny visible output looks truncated.
fn collapse_carriage_returns(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for line in s.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        let body = body.strip_suffix('\r').unwrap_or(body);
        out.push_str(body.rsplit('\r').next().unwrap_or(body));
        out.push_str(nl);
    }
    out
}

/// The text the shared-folder guard must read for `host_powershell`: its
/// argument is `script`; `command` is accepted too for a model that guesses.
fn powershell_guard_text(args: &serde_json::Value) -> Option<&str> {
    arg_str(args, "script").or_else(|| arg_str(args, "command"))
}

/// Execute a built-in tool. Returns the tool-result text plus, for a `read` of
/// an image file, the base64 `image_url` content parts the model needs to see
/// the image. Errors are returned as a String STARTING WITH "ERROR" rather than
/// as Err.
pub async fn execute_builtin(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<Vec<ImageContentPart>>) {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;

    // AH-020/AH-023. Every built-in runs under a deadline and a cancellation
    // token, not just `bash`. A filesystem call that wedges on a stale network
    // mount, or a web fetch to a host that accepts and never answers, used to
    // hang the whole run with nothing able to interrupt it.
    //
    // `bash` keeps its own inner deadline: it owns a process tree and has to
    // kill it, which the generic wrapper cannot do. The wrapper is still the
    // outer bound, so a bash call whose own handling stalls is not exempt.
    let token = ctx
        .cancel
        .clone()
        .unwrap_or_else(crate::lifecycle::Token::detached);
    let limit = crate::lifecycle::Timeouts::default().for_tool(tool.name);

    // AH-127/AH-129. The project's own hooks run around the call. They are
    // read per call rather than cached: the file is small, and a user who
    // fixes a hook mid-run means the fixed one, not the one that was read
    // when the run started.
    let hook_ctx = crate::hooks::Context {
        project_root,
        allow_network: ctx.allow_network,
        home_readonly: ctx.home_readonly,
        sandbox: ctx.sandbox,
        // The same folder `bash` has masked from it on this surface.
        mask_root: ctx.mask_root,
        cancel: ctx.cancel.clone(),
    };
    let hooks = match crate::hooks::load(project_root) {
        Ok(hooks) => hooks,
        // A hooks file that cannot be read is not silently no hooks: a
        // project that declared a policy and got none would be the worst of
        // the three outcomes.
        Err(error) => {
            let harness: crate::harness_error::HarnessError = (&error).into();
            return (
                format!(
                    "ERROR [{}]: this project's hooks could not be read, so no tool ran: {}",
                    harness.kind().tag(),
                    error.message
                ),
                None,
            );
        }
    };
    let mut hook_input = crate::hooks::HookInput {
        tool_name: tool.name.to_string(),
        tool_input: args.clone(),
        tool_response: None,
        session_id: ctx.session_id.map(str::to_string),
        run_id: ctx.run_id.map(str::to_string),
        last_assistant_message: None,
    };
    let before = crate::hooks::run_with_input(
        &hooks,
        crate::hooks::Event::PreTool,
        Some(tool.name),
        &hook_ctx,
        &hook_input,
    )
    .await;
    if let Some(blocked) = before.blocked {
        let harness: crate::harness_error::HarnessError = (&blocked).into();
        return (
            format!(
                "ERROR [{}]: a pre-tool hook refused this call: {}",
                harness.kind().tag(),
                blocked.message
            ),
            None,
        );
    }

    // Shared-folder coordination: a branch moved under this session since its
    // last step is said once, on this call's result.
    let branch_moved = crate::shared_folder::tools::before_tool(ctx);

    let work = async {
        match tool.name {
            "read" => read_or_list(args, ctx).await,
            "screenshot" => screenshot(args, project_root, scratch, ctx.read_roots).await,
            "browser" => crate::tools::browser_tool::run(args, ctx).await,
            "computer" => crate::tools::computer::run(args).await,
            _ => (execute_text(tool, args, ctx).await, None),
        }
    };

    let (mut content, images) = match crate::lifecycle::run_with_deadline(&token, limit, work).await {
        Ok(pair) => pair,
        // Named, and distinguishable: a person reading the transcript needs to
        // know whether they stopped this or it ran out of time.
        Err(reason) => (
            format!(
                "ERROR: tool '{}' {} after {}s and was stopped. No result is available.",
                tool.name,
                match reason {
                    crate::lifecycle::StopReason::Timeout => "exceeded its time limit",
                    crate::lifecycle::StopReason::Cancelled => "was cancelled",
                },
                limit.as_secs()
            ),
            None,
        ),
    };

    crate::shared_folder::tools::after_tool(ctx);
    if let Some(notice) = branch_moved {
        content.push_str("\n\n");
        content.push_str(&notice);
    }

    // A post-tool hook cannot undo what the tool did, so it never blocks. What
    // it can do is say something went wrong, where the model and the person
    // reading the transcript will both see it.
    hook_input.tool_response = Some(content.clone());
    let after = crate::hooks::run_with_input(
        &hooks,
        crate::hooks::Event::PostTool,
        Some(tool.name),
        &hook_ctx,
        &hook_input,
    )
    .await;
    for warning in &after.warnings {
        content.push_str(&format!("\n\n[post-tool hook] {}", warning.message));
    }
    for warning in &before.warnings {
        content.push_str(&format!("\n\n[pre-tool hook] {}", warning.message));
    }
    // A project whose hooks are off because its folder is not trusted says so,
    // once per run, where the model and the person reading will both see it:
    // a policy that silently does not apply is worse than one that is refused.
    if hooks.is_empty() {
        if let Some(note) = crate::hooks::untrusted_note(project_root) {
            let run = ctx.session_id.or(ctx.run_id).unwrap_or("-");
            if crate::folder_trust::first_notice(run, project_root) {
                content.push_str(&format!("\n\n{note}"));
            }
        }
    }
    (content, images)
}

/// The text result for every tool except `read`. Split out so `read` can also
/// return image parts without duplicating the remaining tool dispatch.
pub(crate) async fn execute_text(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> String {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;
    match tool.name {
        // Read tools consult the attached read-only roots; `write`/`edit`
        // deliberately do not, which is what keeps an attached folder
        // readable and unwritable.
        "read" => read_or_list(args, ctx).await.0,
        "ls" => {
            let out = ls(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
        "write" | "edit" => {
            let verb = if tool.name == "write" { "overwrite" } else { "edit" };
            // Another live session on this folder is editing the file: hold.
            // Advisory; see the shared-folder coordination design.
            if let Some(target) = tracked_path(args, ctx) {
                let shown = arg_str(args, "path").unwrap_or_default();
                if let Some(held) = crate::shared_folder::tools::write_gate(ctx, &target, shown) {
                    return held;
                }
            }
            if let Some(refusal) = stale_edit_refusal(verb, args, ctx).await {
                return refusal;
            }
            let out = if tool.name == "write" {
                write(args, project_root, scratch, ctx.confine_writes, ctx.write_roots).await
            } else {
                edit(args, project_root, scratch, ctx.confine_writes, ctx.write_roots).await
            };
            if !out.starts_with("ERROR") {
                if let Some((path, _)) = record_seen(args, ctx).await {
                    crate::shared_folder::tools::record_write(ctx, &path);
                }
            }
            out
        }
        "bash" => {
            // A tree-changing git command while another live session shares
            // this folder is held, same as the `git` tool.
            if let Some(command) = arg_str(args, "command") {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            bash(args, ctx).await
        }
        "find" => {
            let out = find(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
        "grep" => {
            let out = grep(args, project_root, scratch, ctx.sandbox, ctx.read_roots, ctx.write_roots).await;
            with_project_hint(crate::invisible::clean(out), ctx, args)
        }
        // Memory and skills live in the store root, not the sandbox: they must
        // outlive the conversation the filesystem tools are scoped to.
        "memory_list" => memory_list(ctx.store_root).await,
        "memory_read" => memory_read(args, ctx.store_root).await,
        "memory_write" => memory_write(args, ctx.store_root).await,
        "memory_propose" => memory_propose(args, ctx).await,
        "message_send" => message_send(args, ctx),
        "message_check" => message_check(ctx),
        // Skills go through the skills module so the tool honors the folder form
        // (`<name>/SKILL.md`) and frontmatter, matching what the UI writes.
        "skill_list" => skill_list(args, ctx),
        "skill_read" => skill_read(args, ctx),
        "skill_write" => skill_write(args, ctx),
        // Native web tools: compiled into the agent core, not an MCP server.
        "web_search" => crate::invisible::clean(crate::tools::web::web_search(args).await),
        "web_fetch" => {
            crate::invisible::clean(crate::tools::web::web_fetch(args, ctx.read_roots).await)
        }
        "git_inspect" => crate::tools::git_native::git_inspect(args, ctx.read_roots).await,
        "windows_events" => crate::tools::win_events::windows_events(args).await,
        "host_query" => crate::tools::host_read::host_query(args).await,
        "host_action" => crate::tools::host_action::host_action(args).await,
        "host_build" => crate::tools::host_build::run(args, ctx).await,
        "clipboard" => crate::tools::clipboard::clipboard(args).await,
        "ocr" => crate::tools::ocr::run(args, project_root, scratch, ctx.read_roots).await,
        "computer" => crate::tools::computer::run(args).await.0,
        "open_path" => crate::tools::open_path::run(args, ctx).await,
        "host_powershell" => {
            if let Some(command) = powershell_guard_text(args) {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            crate::tools::host_powershell::run(args, ctx).await
        }
        "host_package" => crate::tools::host_package::host_package(args).await,
        "host_wsl" => {
            if let Some(command) = arg_str(args, "command") {
                if let Some(held) =
                    crate::shared_folder::tools::guard_command(ctx, command, ctx.project_root)
                {
                    return held;
                }
            }
            crate::tools::host_wsl::run(args, ctx).await
        }
        "host_ssh" => crate::tools::host_ssh::run(args).await,
        "notify_user" => crate::tools::notify_user::notify_user(args).await,
        "local_http" => crate::tools::local_http::local_http(args).await,
        "docker" => crate::tools::docker_tool::docker(args, project_root).await,
        "git_clone" => crate::tools::git_native::git_clone(args, ctx).await,
        "git" => crate::tools::git_tool::run(args, ctx).await,
        // The interactive confined browser; its screenshot image travels only
        // through `execute_builtin`, so this text-only path drops it.
        "browser" => crate::tools::browser_tool::run(args, ctx).await.0,
        // Cross-session messaging. Refuses unless the dispatcher bound this
        // call to a session and a mailbox (desktop, session scope only).
        "list_sessions" | "send_message" | "read_messages" | "wait_for_reply" | "stop_session" => {
            crate::session_mailbox::run_tool(tool.name, args, ctx).await
        }
        "request_access" => request_access_without_prompt(args, ctx),
        "list_plugins" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "Plugin state is read by the Flint desktop app; this surface \
                            cannot see it. Ask the user, or check the Plugins panel.",
            }),
        ),
        "open_in_browser" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "The browser is opened by the Flint desktop app; this surface                             cannot open one. Give the user the address instead.",
            }),
        ),
        "image_gen" | "image_edit" | "image_view" => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "message": "Images are made by the image engine in the Flint desktop app;                             this surface has no access to it. Tell the user what you                             wanted to generate.",
            }),
        ),
        // Reaching this arm means the call came from a surface with no browser
        // pane (the CLI, a durable job, an MCP peer). It is refused plainly and
        // never forwarded: a headless run must not drive, or silently skip, a
        // browser that is not there.
        name if crate::tools::is_browser_tool(name) => crate::tools::browser_unavailable_result(),
        other => format!("ERROR: unknown built-in tool '{other}'"),
    }
}

/// `request_access` reached the tool core, which has no way to ask anyone:
/// the desktop answers it with a prompt before it gets here, so this is a
/// headless surface. The path is still vetted, so a request that could never
/// be granted says why rather than "nobody can answer".
fn request_access_without_prompt(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let path = arg_str(args, "path").unwrap_or("");
    let env = crate::access::Env::host(ctx.mask_root, Some(ctx.project_root));
    let prepared = crate::access::AccessMode::parse(arg_str(args, "access_mode"))
        .and_then(|mode| crate::access::prepare(path, mode, &env));
    match prepared {
        Err(refusal) => crate::access::refusal_result(&refusal),
        Ok(p) => crate::access::result_json(
            "unavailable",
            serde_json::json!({
                "path": p.display,
                "message": "Nothing was granted: this surface keeps no standing folder grants. \
                            A read or write on a path outside the workspace is put to the \
                            user when you make that call, if someone is attached.",
                "next": "Retry the call you need on that path; the user is asked then. If \
                         it is refused because no one is attached, say so in your reply, or \
                         ask the user to paste or attach what you need.",
            }),
        ),
    }
}

/// Apply `edits` to `content` in order, each against the result of the last.
///
/// Shared by `edit` and by [`stage_change`], so the change a person reviews is
/// computed by the same code that later makes it. Two implementations would be
/// two answers to "what will this edit do".
fn apply_edits(
    content: &str,
    edits: &[serde_json::Value],
    shown: &str,
) -> Result<String, String> {
    let mut content = content.to_string();
    for (i, e) in edits.iter().enumerate() {
        let Some(old_string) = e.get("old_string").and_then(|v| v.as_str()) else {
            return Err(format!("ERROR: {shown}: edit {}: missing 'old_string'", i + 1));
        };
        let Some(new_string) = e.get("new_string").and_then(|v| v.as_str()) else {
            return Err(format!("ERROR: {shown}: edit {}: missing 'new_string'", i + 1));
        };
        let replace_all = e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
        if old_string.is_empty() {
            return Err(format!("ERROR: {shown}: edit {}: old_string must not be empty", i + 1));
        }
        let count = content.matches(old_string).count();
        if count == 0 {
            // No exact hit: fall back to tolerant matching (line endings,
            // typographic characters, indentation, near-identical text).
            // replace_all stays exact-only apart from line endings.
            if replace_all {
                let eol_old = super::fuzzy_edit::in_file_ending(&content, old_string);
                if eol_old != old_string && content.contains(&eol_old) {
                    let eol_new = super::fuzzy_edit::in_file_ending(&content, new_string);
                    content = content.replace(&eol_old, &eol_new);
                    continue;
                }
                return Err(format!("ERROR: {shown}: edit {}: old_string not found", i + 1));
            }
            match super::fuzzy_edit::resolve(&content, old_string, new_string) {
                Ok(r) => {
                    content.replace_range(r.range, &r.replacement);
                    continue;
                }
                Err(e) => return Err(format!("ERROR: {shown}: edit {}: {e}", i + 1)),
            }
        }
        if replace_all {
            // Rename-style replacement: every occurrence, no uniqueness guard.
            content = content.replace(old_string, new_string);
        } else {
            if count > 1 {
                return Err(format!(
                    "ERROR: {shown}: edit {}: old_string not unique ({count} matches)",
                    i + 1
                ));
            }
            content = content.replacen(old_string, new_string, 1);
        }
    }
    Ok(content)
}

/// The change a `write` or `edit` call would make, staged as reviewable hunks
/// against the file as it is now. AH-146/AH-148.
///
/// Returns the resolved target alongside the patch, because the patch is only
/// meaningful against the file it was computed from: the caller keeps both,
/// and before acting on an approval checks that the file is still that file.
/// `None` for every other tool, for a call that would change nothing, and for
/// a call whose own arguments are invalid -- the tool reports that itself.
pub async fn stage_change(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<(PathBuf, crate::patch::StagedPatch)> {
    let path = arg_str(args, "path")?;
    let target = resolve_path(ctx.project_root, ctx.scratch_root, path);
    let prior = match tokio::fs::read(&target).await {
        // Text only. A binary file has no lines to review, and refusing to
        // stage it is not refusing the write -- the prompt still shows it.
        Ok(bytes) => Some(String::from_utf8(bytes).ok()?),
        Err(_) => None,
    };
    let proposed = match tool.name {
        "write" => arg_str(args, "content")?.to_string(),
        "edit" => {
            let edits = args.get("edits").and_then(|v| v.as_array())?;
            apply_edits(prior.as_deref()?, edits, path).ok()?
        }
        _ => return None,
    };
    let patch = crate::patch::StagedPatch::stage(prior.as_deref(), &proposed);
    (!patch.is_empty()).then_some((target, patch))
}

/// Focused diff previewing what a `write`/`edit` call would change, without
/// running it. Line-prefixed (`-`/`+`) hunk text with each line numbered against
/// its position in the file; `None` for other tools or when nothing would
/// change. Used to show the change in the permission prompt. Both variants read
/// the prior file: `write` to show its `created`/`overwrote` header, `edit` to
/// locate `old_string` and number the hunk against real file lines.
pub async fn preview_diff(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Option<String> {
    let project_root = ctx.project_root;
    let scratch = ctx.scratch_root;
    match tool.name {
        "edit" => {
            let edits = args.get("edits").and_then(|v| v.as_array())?;
            if edits.is_empty() {
                return None;
            }
            let prior = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(project_root, scratch, p))
                    .await
                    .unwrap_or_default(),
                None => String::new(),
            };
            let d = render_edit_diff(edits, &prior);
            (!d.is_empty()).then_some(d)
        }
        "write" => {
            let prior = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(project_root, scratch, p))
                    .await
                    .ok(),
                None => None,
            };
            let new = arg_str(args, "content").unwrap_or("");
            // A rewrite with identical content changes nothing; showing a full
            // `+` block would misrepresent it as an overwrite.
            if prior.as_deref() == Some(new) {
                return None;
            }
            Some(render_write_diff(prior.as_deref(), new))
        }
        _ => None,
    }
}

/// The credential scan's findings in the change a `write`/`edit` would make,
/// each with the file it is in. `diff` is the display diff `preview_diff` drew.
pub fn secret_findings_in(diff: &str, args: &serde_json::Value) -> Vec<crate::secrets::SecretFinding> {
    let mut findings = crate::secrets::scan_diff(diff);
    for f in findings.iter_mut() {
        if f.file.is_empty() {
            f.file = arg_str(args, "path").unwrap_or("the file").to_string();
        }
    }
    findings
}

/// One finding as a person reads it: where, which rule, the masked match. Never
/// the value.
pub fn describe_secret_finding(f: &crate::secrets::SecretFinding) -> String {
    format!("{}:{} rule \"{}\" matched `{}`", f.file, f.line, f.kind.as_str(), f.hint)
}

/// What the credential scan would find if this call ran now. Empty for any tool
/// but `write`/`edit`, and for a change that adds nothing suspicious. Reads the
/// file the call would change, writes nothing.
pub async fn secret_findings(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> Vec<crate::secrets::SecretFinding> {
    if !matches!(tool.name, "write" | "edit") {
        return Vec::new();
    }
    match preview_diff(tool, args, ctx).await {
        Some(diff) => secret_findings_in(&diff, args),
        None => Vec::new(),
    }
}

/// Run a built-in tool and, for `write`/`edit`, also produce a focused diff.
/// Returns `(content, diff)`. The diff is line-prefixed (`-`/`+`) hunk text for
/// **display only**: the model gets the concise summary in `content`, since the
/// hunk merely replays an edit it just authored and would cost context on every
/// mutating call. Diffs are computed against the pre-execution file so line
/// numbers match the file as the model saw it. `None` for non-mutating tools
/// and on error.
pub async fn execute_builtin_with_diff(
    tool: &BuiltinTool,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> (String, Option<String>, Option<Vec<ImageContentPart>>) {
    match tool.name {
        "write" | "edit" => {
            let diff = preview_diff(tool, args, ctx).await;
            // Kept from before the call so the post-format diff can be drawn
            // against the file as the model saw it, rather than against what
            // the model wrote and the formatter then rewrote.
            let before = match arg_str(args, "path") {
                Some(p) => tokio::fs::read_to_string(resolve_path(
                    ctx.project_root,
                    ctx.scratch_root,
                    p,
                ))
                .await
                .ok(),
                None => None,
            };

            // A credential in what this change *adds* stops it before it
            // lands. AH-157. Catching it afterwards is not the same thing: a
            // key that reaches the working tree is a key that has to be
            // rotated, and by then it may already be in a commit.
            //
            // The removals are ignored on purpose -- a secret on a deleted
            // line is someone taking it out, and refusing that would fire the
            // warning on the fix.
            if let Some(preview) = diff.as_deref() {
                let findings = if ctx.credential_override {
                    Vec::new()
                } else {
                    secret_findings_in(preview, args)
                };
                if !findings.is_empty() {
                    let where_ = findings
                        .iter()
                        .map(describe_secret_finding)
                        .collect::<Vec<_>>()
                        .join("; ");
                    return (
                        format!(
                            "ERROR: this change was not written: it adds what looks like a real credential: {where_}. \
                             Nothing was changed. Only the matched line is the problem; every other line is fine. \
                             If the value is a real secret, use a placeholder and read it from the environment. \
                             If it is not (a test fixture, an example), tell the user which line it is and why: \
                             where the user can be asked they are asked before this refusal, otherwise they can \
                             allow it by switching to Bypass permissions or add that line themselves. \
                             Do not reword the code to get past this check."
                        ),
                        None,
                        None,
                    );
                }
            }

            let (content, images) = execute_builtin(tool, args, ctx).await;
            if content.starts_with("ERROR") || crate::shared_folder::is_hold(&content) {
                return (content, None, None);
            }
            // AH-149: the project's own formatter has the last word on layout,
            // and the diff a person reviews should be what the file now holds
            // -- not a version the next `cargo fmt` will rewrite.
            let diff = format_after_edit(args, ctx, before.as_deref(), diff).await;
            // The formatter may have rewritten the file: what the model saw
            // last is what is there now, so its next edit is not "stale".
            record_seen(args, ctx).await;
            let content = append_syntax_warning(content, args, ctx).await;
            (content, diff, images)
        }
        // Tools that can hand the model an image. `screenshot` and `browser`
        // were missing here, so their pictures were dropped on this path.
        "read" | "screenshot" | "browser" | "computer" => {
            let (content, images) = execute_builtin(tool, args, ctx).await;
            (content, None, images)
        }
        _ => (execute_builtin(tool, args, ctx).await.0, None, None),
    }
}

/// Append a one-line warning to the result of a `write`/`edit` when the file
/// is a `.json`/`.toml`/`.yaml` document that no longer parses. Never fails the
/// call: any problem reading the file just means no warning.
async fn append_syntax_warning(
    content: String,
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
) -> String {
    if !ctx.check_syntax {
        return content;
    }
    let Some(path) = arg_str(args, "path") else {
        return content;
    };
    let file = resolve_path(ctx.project_root, ctx.scratch_root, path);
    if !super::syntax_check::is_checked(&file) {
        return content;
    }
    match tokio::fs::metadata(&file).await {
        Ok(m) if m.len() as usize <= super::syntax_check::MAX_CHECK_BYTES => {}
        _ => return content,
    }
    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return content;
    };
    match super::syntax_check::check(&file, &text) {
        Some(warning) => format!("{}\n{warning}", content.trim_end()),
        None => content,
    }
}

/// Hand the edited file to the project's formatter, and redraw the diff
/// against what the file now holds (AH-149, AH-150).
///
/// The diff is redrawn rather than annotated because the point of showing one
/// is that it is what happened. A formatter that could not run, or refused the
/// file, leaves the original diff exactly as it was and says so underneath:
/// silence there would read as "nothing to format".
async fn format_after_edit(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
    before: Option<&str>,
    diff: Option<String>,
) -> Option<String> {
    if !ctx.format_on_edit {
        return diff;
    }
    let path = arg_str(args, "path")?;
    let file = resolve_path(ctx.project_root, ctx.scratch_root, path);
    let formatter = crate::format::detect(ctx.project_root, &file)?;
    let project_root = ctx.project_root.to_path_buf();
    let running = formatter.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        crate::format::run(&running, &project_root, &file)
    })
    .await
    .unwrap_or_else(|e| crate::format::Formatted::Failed(format!("the formatter could not be run: {e}")));
    match outcome {
        crate::format::Formatted::Unchanged => diff,
        crate::format::Formatted::Failed(why) => Some(format!(
            "{}\n[{}]",
            diff.unwrap_or_default().trim_end(),
            why
        )),
        crate::format::Formatted::Changed(after) => {
            let redrawn = render_hunk_diff(before.unwrap_or(""), &after, 1);
            Some(format!(
                "{}\n[formatted with {} ({})]",
                redrawn.trim_end(),
                formatter.name,
                formatter.evidence
            ))
        }
    }
}

/// 1-based line number of the start of `pos` within `text`.
fn line_number_at(text: &str, pos: usize) -> usize {
    text[..pos].matches('\n').count() + 1
}

/// Lines of surrounding file context kept around a change, and the threshold
/// past which one edit's hunk is split with a `...` gap. Matches the feel of a
/// unified diff without the `@@ -a,b +c,d @@` range header (the existing
/// `@@ edit i/n @@` marker already identifies the hunk).
const DIFF_CONTEXT: usize = 2;

/// Per-edit hunks computed with a real line-level diff (`similar`), so a
/// one-line change inside a large `old_string`/`new_string` pair shows only the
/// lines that actually differ instead of the whole block as removed and
/// re-added. The compared blocks are widened from the raw arguments to whole
/// lines plus up to `DIFF_CONTEXT` unchanged lines taken from the file, so a
/// change is shown in place even when `old_string` carries no context of its
/// own. Deleted lines are numbered against the file before the edit, kept and
/// inserted lines against the file after it. Multiple edits are separated by
/// `@@ edit i/n @@` and applied in order so later edits number against the
/// state left by earlier ones, matching what `edit()` does.
fn render_edit_diff(edits: &[serde_json::Value], prior: &str) -> String {
    let n = edits.len();
    let mut working = prior.to_string();
    let mut out = String::new();
    for (i, e) in edits.iter().enumerate() {
        let old = e.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
        let new = e.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
        if n > 1 {
            out.push_str(&format!("@@ edit {}/{} @@\n", i + 1, n));
        }
        let replace_all = e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
        match working.find(old) {
            Some(pos) => {
                let (old_block, new_block, start) = expand_hunk(&working, pos, old, new);
                out.push_str(&render_hunk_diff(&old_block, &new_block, start));
                // Keep `working` consistent for later edits in the same call: a
                // replace_all edit rewrites every occurrence, not just the first.
                if replace_all {
                    working = working.replace(old, new);
                } else {
                    working.replace_range(pos..pos + old.len(), new);
                }
            }
            // `edit()` will reject this call, but the arguments are still worth
            // showing; there is no file position to number them against.
            None => match (replace_all, super::fuzzy_edit::resolve(&working, old, new)) {
                (false, Ok(r)) => {
                    let found = working[r.range.clone()].to_string();
                    let (ob, nb, start) = expand_hunk(&working, r.range.start, &found, &r.replacement);
                    out.push_str(&render_hunk_diff(&ob, &nb, start));
                    working.replace_range(r.range, &r.replacement);
                }
                _ => out.push_str(&render_hunk_diff(old, new, 1)),
            },
        }
    }
    out.trim_end().to_string()
}

/// Widen the replacement of `old` at `pos` in `text` to whole lines plus
/// `DIFF_CONTEXT` lines of surrounding file context, returning the before and
/// after blocks and the 1-based line the blocks start at. Both blocks share the
/// context verbatim, so the diff renders it as unchanged lines; whole-line
/// bounds keep a match that starts or ends mid-line from being diffed against a
/// line fragment.
fn expand_hunk(text: &str, pos: usize, old: &str, new: &str) -> (String, String, usize) {
    let end = pos + old.len();
    let mut ctx_start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    for _ in 0..DIFF_CONTEXT {
        if ctx_start == 0 {
            break;
        }
        ctx_start = text[..ctx_start - 1].rfind('\n').map_or(0, |i| i + 1);
    }
    let mut ctx_end = text[end..].find('\n').map_or(text.len(), |i| end + i);
    for _ in 0..DIFF_CONTEXT {
        if ctx_end >= text.len() {
            break;
        }
        ctx_end = text[ctx_end + 1..]
            .find('\n')
            .map_or(text.len(), |i| ctx_end + 1 + i);
    }
    let old_block = text[ctx_start..ctx_end].to_string();
    let new_block = format!("{}{new}{}", &text[ctx_start..pos], &text[end..ctx_end]);
    (old_block, new_block, line_number_at(text, ctx_start))
}

/// Line-diff `old` against `new`, rendering each changed/context line with its
/// real line number (`start`-based on both sides, since old and new begin at
/// the same position). Groups distant changes with a `...` gap.
fn render_hunk_diff(old: &str, new: &str, start: usize) -> String {
    use similar::{ChangeTag, TextDiff};

    // `old_string`/`new_string` are exact source snippets and often lack a
    // trailing newline on their last line. `from_lines` tokenizes by keeping
    // each line's newline, so a shared last line would otherwise mismatch
    // (`"b"` vs `"b\n"`) and show as a spurious delete+insert instead of
    // context. Padding both sides equally doesn't change indices or output,
    // since `\n` is stripped again before each line is printed.
    let pad = |s: &str| {
        if s.is_empty() || s.ends_with('\n') {
            s.to_string()
        } else {
            format!("{s}\n")
        }
    };
    let (old, new) = (pad(old), pad(new));
    let diff = TextDiff::from_lines(&old, &new);
    let mut out = String::new();
    for (gi, group) in diff.grouped_ops(DIFF_CONTEXT).iter().enumerate() {
        if gi > 0 {
            out.push_str("      ...\n");
        }
        for op in group {
            for change in diff.iter_changes(op) {
                let text = change.value();
                let text = text.strip_suffix('\n').unwrap_or(text);
                match change.tag() {
                    // Numbered on the new side: context below an insertion or
                    // deletion has moved, and an old-side number there would
                    // run backwards against the `+` lines just above it.
                    ChangeTag::Equal => {
                        let line = start + change.new_index().unwrap_or(0);
                        out.push_str(&format!("  {line:>4} | {text}\n"));
                    }
                    ChangeTag::Delete => {
                        let line = start + change.old_index().unwrap_or(0);
                        out.push_str(&format!("- {line:>4} | {text}\n"));
                    }
                    ChangeTag::Insert => {
                        let line = start + change.new_index().unwrap_or(0);
                        out.push_str(&format!("+ {line:>4} | {text}\n"));
                    }
                }
            }
        }
    }
    out
}

/// Preview for a write, headed by created/overwrote. A new file is shown
/// whole as `+` lines; an overwrite is diffed against what it replaced, so
/// the change counts the summary derives from `+`/`-` lines are real rather
/// than "every line added, none removed". Display-only; the TUI collapses
/// long output.
fn render_write_diff(prior: Option<&str>, content: &str) -> String {
    let Some(prior) = prior else {
        let mut out = String::from("@@ created file @@\n");
        for (i, line) in content.lines().enumerate() {
            out.push_str(&format!("+ {:>4} | {line}\n", i + 1));
        }
        return out.trim_end().to_string();
    };
    let mut out = String::from("@@ overwrote file @@\n");
    out.push_str(&render_hunk_diff(prior, content, 1));
    out.trim_end().to_string()
}

mod screenshot;
#[allow(unused_imports)]
use screenshot::*;
pub use screenshot::render_html_png;
pub use screenshot::render_html_png_noted;

#[cfg(test)]
mod find_cap_tests;

#[cfg(test)]
mod bash_job_registry_tests;

#[cfg(test)]
mod bash_split_tests;

#[cfg(test)]
mod tests;

/// A model that used a project-relative path (`lib/db.ts`) in a session whose
/// workspace is scratch space, or whose worktree root sits above the app.
#[cfg(test)]
mod project_path_hint_tests;
