//! The only way a local MCP server gets started.
//!
//! Confinement used to be a step a caller was expected to remember. That is a
//! weak guarantee for something whose failure mode is a program a repository
//! chose running with the user's whole filesystem in reach — and it had
//! already failed once here, when the desktop activation path was wired up
//! without attaching a confinement at all.
//!
//! So the capability is a type. [`ConfinedMcpLaunch`] holds a private
//! [`Command`] that nothing outside this module can construct, read, or
//! extract, and it is consumed by the one function that spawns. The
//! third-party process builder is called in exactly one place — inside
//! [`ConfinedMcpLaunch::spawn`] — so "start a local MCP server" and "go
//! through the confinement decision" are the same act rather than two
//! adjacent ones.
//!
//! Remote servers never come here: they start no process, and giving them a
//! path through this module would blur the one distinction that matters.

use std::process::Stdio;

use rmcp::transport::child_process::TokioChildProcess;
use tokio::process::{ChildStderr, Command};

use serde_json::Value;

use super::models::McpServerConfig;

/// A command that has been through the confinement decision and may be run.
///
/// The field is private to this module and there is no accessor, no `Deref`,
/// no `into_inner`, and no unchecked constructor. Outside code can hold one
/// and spawn it; it cannot look inside, rebuild it from a `Command` it made
/// itself, or reach the process builder directly.
pub struct ConfinedMcpLaunch {
    command: Command,
    /// Whether this launch is confined, for the log line only. Never a
    /// decision input: an unconfined launch only exists for a server the user
    /// configured themselves, and `prepare` is what decides that.
    confined: bool,
}

impl std::fmt::Debug for ConfinedMcpLaunch {
    /// Deliberately opaque. The argv can carry paths the user did not choose
    /// to display, and the environment is not anyone's to print.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfinedMcpLaunch")
            .field("confined", &self.confined)
            .finish_non_exhaustive()
    }
}

impl ConfinedMcpLaunch {
    /// The only constructor.
    ///
    /// An imported server is confined or it does not run. A server the user
    /// configured themselves keeps the behaviour it has always had — they
    /// chose the program — and is the only case that yields an unconfined
    /// launch.
    ///
    /// `build` supplies the command as the caller would otherwise have
    /// spawned it, including any npx/uvx resolution: what it returns is the
    /// program being confined, not a stand-in for it.
    pub fn prepare(
        params: &McpServerConfig,
        build: impl FnOnce() -> Command,
    ) -> Result<Self, String> {
        let command = build();
        match params.confinement.as_ref() {
            None if !params.imported => Ok(Self {
                command,
                confined: false,
            }),
            // Every start path reaches this, including the restart loop that
            // replays a stored config. An imported server whose confinement
            // was never attached stops here rather than starting because some
            // caller forgot.
            None => Err(
                "an imported MCP server was started without a confinement; refusing to run it \
                 unconfined"
                    .to_string(),
            ),
            Some(confinement) => Ok(Self {
                command: confined_mcp_command(command, params, confinement)?,
                confined: true,
            }),
        }
    }

    /// Is this launch confined? For reporting; never a branch on safety.
    pub fn is_confined(&self) -> bool {
        self.confined
    }

    /// Start the process. Consumes the capability, so one preparation is one
    /// launch and a command cannot be spawned twice from the same decision.
    pub fn spawn(
        self,
        stderr: Stdio,
    ) -> Result<(TokioChildProcess, Option<ChildStderr>), std::io::Error> {
        // The one call to the process builder for a local MCP server. Keeping
        // it here is what makes "spawn" and "confined" inseparable.
        TokioChildProcess::builder(self.command)
            .stderr(stderr)
            .spawn()
    }
}

/// Turn the entry's configured `headers` map into a `HeaderMap`, skipping any
/// pair that is not a valid header name/value. Shared by both remote transports.
/// The program to start for a configured MCP command (Jozkah/jan#224).
///
/// On Windows `npx`, `uvx`, `npm`, `pnpm` and most Node tools are `.cmd`
/// shims, and `CreateProcessW` only ever tries `.exe` for a bare name, so the
/// spawn failed with "file not found". A bare name (no directory, no
/// extension) is resolved here through PATH in PATHEXT order. Anything else,
/// and every name on other platforms, is returned as written.
pub(crate) fn launchable_program(command: &str) -> std::ffi::OsString {
    if !cfg!(windows) {
        return command.into();
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    resolve_bare_program(command, &path, &pathext)
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| command.into())
}

/// The first `<dir>/<name><ext>` that is a file, over `path`'s directories and
/// `pathext`'s extensions, for a bare `name`. `None` when `name` has a
/// directory or an extension of its own, or nothing matches.
fn resolve_bare_program(
    name: &str,
    path: &std::ffi::OsStr,
    pathext: &str,
) -> Option<std::path::PathBuf> {
    let as_path = std::path::Path::new(name);
    if name.is_empty()
        || name.contains(['/', '\\'])
        || as_path.extension().is_some()
    {
        return None;
    }
    std::env::split_paths(path).find_map(|dir| {
        pathext
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|ext| dir.join(format!("{name}{}", ext.to_ascii_lowercase())))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod launchable_tests {
    #[test]
    fn a_bare_name_finds_its_cmd_shim_on_path() {
        let dir = std::env::temp_dir().join(format!("jan_mcp_shim_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The extensionless script Node also installs must not be chosen.
        std::fs::write(dir.join("npx"), "#!/bin/sh").unwrap();
        std::fs::write(dir.join("npx.cmd"), "@echo off").unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        let found = super::resolve_bare_program("npx", &path, ".COM;.EXE;.BAT;.CMD").unwrap();
        assert_eq!(found, dir.join("npx.cmd"));
        // Names with a directory or an extension are left as written.
        assert!(super::resolve_bare_program("C:/tools/npx", &path, ".CMD").is_none());
        assert!(super::resolve_bare_program("npx.cmd", &path, ".CMD").is_none());
        assert!(super::resolve_bare_program("absent", &path, ".CMD").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real thing: where Node is installed, `npx` as configured now starts.
    #[cfg(windows)]
    #[test]
    fn npx_as_configured_actually_starts_on_windows() {
        let program = super::launchable_program("npx");
        if program == "npx" {
            eprintln!("skipped: npx is not on PATH here");
            return;
        }
        let out = std::process::Command::new(&program).arg("--version").output().expect("spawn");
        assert!(out.status.success(), "{:?}", out);
    }
}

/// Rebuild a command so it runs inside the session's sandbox.
///
/// The policy is not invented here: it comes from the agent-tools plugin,
/// which is the one implementation of Flint's sandboxing and the same one the
/// agent's own shell runs under. A second, MCP-shaped imitation of it would
/// drift from the real boundary, and the drift would be invisible until
/// something escaped.
///
/// The environment is rebuilt rather than filtered. `Command` inherits the
/// parent's environment by default, and Flint's process holds the user's whole
/// session — so `env_clear` first, then exactly the names the user approved.
pub(super) fn confined_mcp_command(
    cmd: Command,
    params: &crate::core::mcp::models::McpServerConfig,
    confinement: &crate::core::mcp::models::McpConfinement,
) -> Result<Command, String> {
    use tauri_plugin_agent_tools::tools::mcp_confine::{confined_command, McpAuthority};

    let program = cmd.as_std().get_program().to_os_string();
    let args: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    let authority = match confinement.writable_repository.clone() {
        Some(repository) => McpAuthority::EditFolder {
            workspace: confinement.workspace.clone(),
            repository,
            read_roots: confinement.read_roots.clone(),
        },
        None => McpAuthority::ReviewOnly {
            workspace: confinement.workspace.clone(),
            repository: confinement.repository.clone(),
            read_roots: confinement.read_roots.clone(),
        },
    };

    let wrapped = confined_command(
        std::path::Path::new(&program),
        &args,
        None,
        &authority,
        confinement.jan_data.as_deref(),
    )
    .map_err(|e| e.reason())?;

    let mut confined = Command::new(&wrapped.program);
    for arg in &wrapped.args {
        confined.arg(arg);
    }
    #[cfg(windows)]
    {
        use jan_process::CommandConsole;
        confined.background();
    }
    #[cfg(unix)]
    {
        confined.process_group(0);
    }
    confined.kill_on_drop(true);

    // Nothing inherited. Only the names the user approved, and only where the
    // configuration actually supplied a value for them. That deliberately
    // includes the bundled npx/uvx override's `BUN_INSTALL` / `UV_CACHE_DIR`
    // set on `cmd` (Jozkah/jan#73): both point under Flint's data folder,
    // which the policy hides from the server (`with_hide_root(jan_data)`), so
    // forwarding them would aim the package cache at a directory the server
    // cannot write. Without them the tools use their default cache under the
    // sandbox's own private home.
    confined.env_clear();
    // Except what the AppContainer helper itself needs to build the sandbox
    // (Jozkah/jan#284): it refuses to start without SystemRoot and
    // LOCALAPPDATA, so a cleared block stopped every imported server on
    // Windows. The helper builds the server's own environment from its
    // allowlist; these reach the helper, not the server as given.
    #[cfg(windows)]
    for name in tauri_plugin_agent_tools::tools::win_env::REQUIRED {
        if let Some(value) = std::env::var_os(name) {
            confined.env(name, value);
        }
    }
    for name in &confinement.allowed_env {
        if let Some(value) = params.envs.get(name).and_then(Value::as_str) {
            confined.env(name, value);
        }
    }
    confined.current_dir(&confinement.workspace);
    Ok(confined)
}

/// The session workspace whose sandbox container an imported server was
/// given a folder to edit in, read from its stored configuration.
///
/// `None` for every other server: a user-configured one, a review-only one, a
/// remote one. Those hold no folder grant to withdraw.
pub(super) fn folder_grant_workspace(config: &Value) -> Option<std::path::PathBuf> {
    let confinement = config.get("janConfinement")?.as_object()?;
    confinement.get("writableRepository")?.as_str()?;
    confinement
        .get("workspace")?
        .as_str()
        .map(std::path::PathBuf::from)
}

/// Withdraw the folder grants a stopped server held (AppContainer; a no-op
/// elsewhere). `pid` is its sandbox helper's, the process the grants were
/// recorded under. Only what no other live holder in the session's container
/// (its shell, another server) still needs is revoked, so a command running
/// in that session keeps its access.
pub(super) fn release_folder_grants(config: Option<&Value>, pid: Option<u32>) {
    if let (Some(workspace), Some(pid)) = (config.and_then(folder_grant_workspace), pid) {
        tauri_plugin_agent_tools::tools::appcontainer::release_holder(&workspace, pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mcp::models::McpConfinement;

    #[test]
    fn only_a_folder_editing_imported_server_has_a_grant_to_release() {
        let editing = serde_json::json!({
            "command": "node",
            "janConfinement": { "workspace": "/ws", "writableRepository": "/repo" }
        });
        assert_eq!(
            folder_grant_workspace(&editing),
            Some(std::path::PathBuf::from("/ws"))
        );
        let review = serde_json::json!({
            "command": "node",
            "janConfinement": { "workspace": "/ws", "repository": "/repo" }
        });
        assert_eq!(folder_grant_workspace(&review), None);
        assert_eq!(folder_grant_workspace(&serde_json::json!({ "command": "node" })), None);
    }

    fn params(imported: bool, confinement: Option<McpConfinement>) -> McpServerConfig {
        McpServerConfig {
            transport_type: Some("stdio".to_string()),
            url: None,
            command: "node".to_string(),
            args: vec![],
            envs: serde_json::Map::new(),
            timeout: None,
            headers: serde_json::Map::new(),
            confinement,
            imported,
        }
    }

    fn confinement() -> McpConfinement {
        McpConfinement {
            workspace: std::env::temp_dir(),
            repository: None,
            writable_repository: None,
            read_roots: vec![],
            jan_data: None,
            allowed_env: vec![],
        }
    }

    fn build() -> Command {
        let mut cmd = Command::new("/usr/bin/node");
        cmd.arg("server.js");
        cmd
    }

    /// The failure this type exists to make impossible.
    #[test]
    fn an_imported_server_without_a_confinement_cannot_be_prepared() {
        let err = ConfinedMcpLaunch::prepare(&params(true, None), build)
            .expect_err("an imported server must not be launchable unconfined");

        assert!(err.contains("unconfined"), "{err}");
    }

    #[test]
    fn a_user_configured_server_prepares_unconfined_and_says_so() {
        let launch = ConfinedMcpLaunch::prepare(&params(false, None), build)
            .expect("the user's own server is untouched");

        assert!(!launch.is_confined());
    }

    #[test]
    fn an_imported_server_with_a_confinement_prepares_confined() {
        if !tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            return;
        }
        let launch = ConfinedMcpLaunch::prepare(&params(true, Some(confinement())), build)
            .expect("a host with a backend must produce a confined launch");

        assert!(launch.is_confined());
    }

    /// Jozkah/jan#284: the AppContainer helper refuses to start without
    /// SystemRoot and LOCALAPPDATA, so a confined launch passes those two to
    /// it and nothing else from the host.
    #[cfg(windows)]
    #[test]
    fn the_confinement_helper_keeps_what_it_needs_to_start() {
        if !tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            eprintln!("skipped: no confinement backend here");
            return;
        }
        let cmd = confined_mcp_command(build(), &params(true, Some(confinement())), &confinement())
            .expect("confined");
        let names: Vec<String> = cmd
            .as_std()
            .get_envs()
            .filter(|(_, v)| v.is_some())
            .map(|(k, _)| k.to_string_lossy().to_ascii_uppercase())
            .collect();
        for required in tauri_plugin_agent_tools::tools::win_env::REQUIRED {
            if std::env::var_os(required).is_some() {
                assert!(names.contains(&required.to_ascii_uppercase()), "{names:?}");
            }
        }
        assert!(!names.contains(&"PATH".to_string()), "the host PATH leaked: {names:?}");
    }

    /// Jozkah/jan#73: env set on the incoming command (the bundled npx/uvx
    /// override's cache dirs, which live in the hidden Flint data folder) is
    /// not carried into the confined launch.
    #[test]
    fn internal_override_env_does_not_reach_the_confined_server() {
        if !tauri_plugin_agent_tools::tools::mcp_confine::confinement_available() {
            eprintln!("skipped: no confinement backend here");
            return;
        }
        let mut cmd = build();
        cmd.env("BUN_INSTALL", "/flint-data/.npx");
        cmd.env("UV_CACHE_DIR", "/flint-data/.uvx");
        let confined =
            confined_mcp_command(cmd, &params(true, Some(confinement())), &confinement())
                .expect("confined");
        let names: Vec<String> = confined
            .as_std()
            .get_envs()
            .filter(|(_, v)| v.is_some())
            .map(|(k, _)| k.to_string_lossy().to_ascii_uppercase())
            .collect();
        assert!(!names.contains(&"BUN_INSTALL".to_string()), "{names:?}");
        assert!(!names.contains(&"UV_CACHE_DIR".to_string()), "{names:?}");
    }

    /// Nothing about the command leaks through the debug output — the argv can
    /// carry paths the user never chose to display.
    #[test]
    fn the_capability_does_not_print_what_it_will_run() {
        let launch = ConfinedMcpLaunch::prepare(&params(false, None), build).expect("prepare");

        let shown = format!("{launch:?}");
        assert!(!shown.contains("node"), "{shown}");
        assert!(!shown.contains("server.js"), "{shown}");
    }

    /// The invariant, checked against the source of this module.
    ///
    /// Rust has no built-in compile-fail test without pulling in a new
    /// dependency, and the property that matters is not "does some snippet
    /// fail to compile" but "does this module expose a way to build the
    /// capability from a command the caller already has". That is a statement
    /// about this file, so it is checked against this file — the same approach
    /// the plugin's permission parity test takes.
    #[test]
    fn nothing_outside_this_module_can_build_or_open_the_capability() {
        let source = include_str!("launch.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test part of this module");

        // The command is private, and stays private.
        assert!(
            body.contains("    command: Command,"),
            "the inner command must remain a private field"
        );
        assert!(
            !body.contains("pub command"),
            "the inner command must never be public"
        );

        // No accessor, and nothing that hands it back out.
        for escape in [
            "pub fn into_inner",
            "pub fn command",
            "pub fn as_command",
            "impl Deref",
            "impl DerefMut",
            "impl From<Command>",
        ] {
            assert!(
                !body.contains(escape),
                "`{escape}` would let a caller reach the unconfined command"
            );
        }

        // The whole public surface, named. A new `pub fn` here has to be
        // added deliberately, which is the point: the next person to widen
        // this API has to change this list and say why.
        let public: Vec<String> = body
            .lines()
            .filter(|line| line.trim_start().starts_with("pub fn "))
            .map(|line| {
                line.trim()
                    .trim_start_matches("pub fn ")
                    .split('(')
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        assert_eq!(
            public,
            vec![
                // The one constructor, which is where the decision is made.
                "prepare".to_string(),
                // Reporting only.
                "is_confined".to_string(),
                // Consuming: one preparation is one launch.
                "spawn".to_string(),
            ],
            "the public surface of the capability changed"
        );

        // No escape hatch, however it is spelled. Declarations only: the
        // prose discusses these words, and the refusal message contains
        // "unconfined" precisely because that is what it refuses to do.
        let declarations = body
            .lines()
            .map(str::trim_start)
            .filter(|line| {
                line.starts_with("pub fn ")
                    || line.starts_with("pub struct ")
                    || line.starts_with("pub const ")
                    || line.starts_with("pub enum ")
                    || line.starts_with("impl ")
            })
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        for hatch in [
            "unchecked",
            "unconfined",
            "without_confinement",
            "trusted",
            "raw",
        ] {
            assert!(
                !declarations.contains(hatch),
                "an item named with `{hatch}` reads like a way around the confinement decision"
            );
        }
    }

    /// The process builder is called in one place, and that place is here.
    #[test]
    fn the_process_builder_is_reachable_only_through_this_module() {
        // Production code only: this test names the builder itself, and a
        // test's own text is not a call site.
        let production = |source: &'static str| {
            source
                .split("#[cfg(test)]")
                .next()
                .expect("the non-test part")
                .to_string()
        };

        for (name, source) in [
            ("mcp/helpers.rs", include_str!("helpers.rs")),
            ("cli/mcp.rs", include_str!("../cli/mcp.rs")),
        ] {
            assert!(
                !production(source).contains("TokioChildProcess::builder"),
                "{name} spawns a local MCP server without going through ConfinedMcpLaunch"
            );
        }
        assert_eq!(
            production(include_str!("launch.rs"))
                .matches("TokioChildProcess::builder")
                .count(),
            1,
            "the builder must be called exactly once, inside `spawn`"
        );
    }
}
