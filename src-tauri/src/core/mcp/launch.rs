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
/// Rebuild a command so it runs inside the session's sandbox.
///
/// The policy is not invented here: it comes from the agent-tools plugin,
/// which is the one implementation of Jan's sandboxing and the same one the
/// agent's own shell runs under. A second, MCP-shaped imitation of it would
/// drift from the real boundary, and the drift would be invisible until
/// something escaped.
///
/// The environment is rebuilt rather than filtered. `Command` inherits the
/// parent's environment by default, and Jan's process holds the user's whole
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
        },
        None => McpAuthority::ReviewOnly {
            workspace: confinement.workspace.clone(),
            repository: confinement.repository.clone(),
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
        use std::os::windows::process::CommandExt;
        confined.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        confined.process_group(0);
    }
    confined.kill_on_drop(true);

    // Nothing inherited. Only the names the user approved, and only where the
    // configuration actually supplied a value for them.
    confined.env_clear();
    for name in &confinement.allowed_env {
        if let Some(value) = params.envs.get(name).and_then(Value::as_str) {
            confined.env(name, value);
        }
    }
    confined.current_dir(&confinement.workspace);
    Ok(confined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mcp::models::McpConfinement;

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
