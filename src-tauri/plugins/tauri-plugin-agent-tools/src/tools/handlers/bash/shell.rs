//! Which shell a `bash` call runs in, and starting it.
//!
//! Every `Err` here is the text the tool returns as is: a refusal, or the
//! result of a read-only command split onto the host's git.

use super::*;

/// The shell for a confined call. Checks run in their historic order: the
/// null-device refusal first, then probing, then cmd-style `2>nul` in
/// PowerShell, then fitting the command to a shell that can parse it.
pub(super) async fn select_sandboxed_shell(
    args: &serde_json::Value,
    ctx: &ToolContext<'_>,
    command: &str,
    policy: &jail::Policy,
) -> Result<proc::ShellConfig, String> {
    // A program that opens NUL itself cannot run in a sandbox this
    // machine's null device refuses. Not run only to fail (and perhaps
    // half-run a chain): answered with the null-device refusal up front,
    // so the surface asks the user to run it outside the sandbox now.
    if jail::null_device_refuses_sandbox() {
        if let Some(program) =
            crate::tools::nul_programs::opens_null_device(command, ctx.nul_programs)
        {
            // Pure reading (`git status`, `git log`) needs no outside run:
            // the git steps go to the host's git, the rest stays here.
            if let Some(pieces) =
                crate::tools::nul_programs::split_for_host_git(command, ctx.nul_programs)
            {
                return Err(run_split_read_only(args, ctx, pieces).await);
            }
            ctx.null_refusal.set();
            return Err(crate::tools::nul_programs::not_run_refusal(&program));
        }
    }
    // Which shell can be confined is decided by probing, not by assuming.
    // A shell that starts fine on its own can still fail inside the
    // sandbox: on Windows, Git Bash is built on the MSYS2 runtime, which
    // cannot initialise inside an AppContainer however it was installed.
    // No confinement available means no shell either: running unsandboxed
    // would give the command the whole machine, which is never what the
    // caller asked for.
    // Probing launches the sandbox helper (and, the first time, sets up
    // the container and its folder ACLs): seconds of blocking work that
    // must not hold an async runtime thread.
    let probe_policy = policy.clone();
    let probed = tokio::task::spawn_blocking(move || jail::select_shell(&probe_policy))
        .await
        .unwrap_or_else(|e| Err(format!("the shell probe failed: {e}")));
    let selected = match probed {
        Ok(selected) => selected,
        Err(detail) => {
            return Err(format!(
                "ERROR: bash is unavailable because no shell could be started in a                      sandbox on this system. Use the read/ls/find/grep tools instead.
{detail}"
            ))
        }
    };
    // cmd's `2>nul` in PowerShell writes to a file named `nul`, which the
    // container refuses as `\\.\nul`. Refused before running: the fix is
    // mechanical, and running it would half-execute a `;` chain.
    if selected.report.cfg.flavor == proc::ShellFlavor::PowerShell {
        let redirects = crate::tools::shell_diag::cmd_nul_redirects(command);
        if !redirects.is_empty() {
            return Err(crate::tools::shell_diag::cmd_nul_refusal(&redirects));
        }
    }
    // A command written for bash is refused rather than handed to PowerShell
    // or cmd, which would not fail cleanly: `cmd` given `foo $(bar)` runs
    // something, just not what was asked for. A command that chains with
    // `&&`/`||` is moved onto a shell that keeps their short-circuit
    // semantics (see `sandbox_shell::fit_to_command`, shared with hooks).
    let fit_policy = policy.clone();
    let fit_command = command.to_string();
    let fitted = tokio::task::spawn_blocking(move || {
        crate::tools::sandbox_shell::fit_to_command(&fit_policy, selected, &fit_command)
    })
    .await;
    let fitted = match fitted {
        Ok(fitted) => fitted,
        Err(e) => return Err(format!("ERROR: the shell probe failed: {e}")),
    };
    match fitted {
        Ok(fitted) => Ok(fitted.wrapped),
        Err(crate::tools::sandbox_shell::Unfit::PosixOnly { construct, selected }) => {
            let mut refusal = proc::posix_unavailable_error(
                construct,
                &selected.report.cfg,
                selected
                    .posix_rejected
                    .as_deref()
                    .unwrap_or("no POSIX shell could be started in the sandbox"),
            );
            if let Some(hint) = proc::heredoc_script_hint(command) {
                refusal.push('\n');
                refusal.push_str(&hint);
            }
            Err(refusal)
        }
        // Unreachable in practice on Windows -- `cmd.exe` is always a
        // candidate -- but if even it cannot be confined, refuse clearly
        // rather than run a shell that cannot parse the command.
        Err(crate::tools::sandbox_shell::Unfit::NoChaining { operator, selected }) => {
            Err(proc::chaining_unavailable_error(operator, &selected.report.cfg))
        }
    }
}

/// The shell for an unconfined call.
///
/// With the sandbox off the shell is spawned bare, the way the user's own
/// terminal would: no wrapper, no policy, the real `$HOME` and `/tmp`. Only
/// a surface that opted in gets here (the CLI's `--sandbox`/`sandbox`
/// setting); the desktop never does, so `bash` there is still confined or
/// withheld.
pub(super) fn select_unsandboxed_shell(
    ctx: &ToolContext<'_>,
    command: &str,
    policy: &jail::Policy,
) -> Result<proc::ShellConfig, String> {
    // An approved null-device rerun keeps the shell the sandbox chose, so
    // the command means what the model wrote it to mean (see
    // `ToolContext::sandbox_shell_parity`). Everything else unconfined
    // gets the host's preferred shell.
    let parity = ctx.sandbox_shell_parity && (jail::backend().enforces() || cfg!(windows));
    let sandbox_choice = if parity {
        jail::select_shell(policy)
            .ok()
            .map(|s| s.report.cfg)
            // On Windows the model writes PowerShell for the sandbox. If
            // the sandbox cannot say which shell it would use, the rerun
            // still must not fall to Git Bash, where `Set-Location` and
            // `Push-Location` do not exist.
            .or_else(|| {
                if cfg!(windows) {
                    proc::candidates()
                        .into_iter()
                        .find(|c| c.flavor != proc::ShellFlavor::Posix)
                } else {
                    None
                }
            })
    } else {
        None
    };
    unsandboxed_shell(
        command,
        sandbox_choice,
        || {
            if parity {
                jail::select_chaining_capable(policy).map(|s| s.report.cfg)
            } else {
                None
            }
        },
        proc::shell().clone(),
        proc::candidates,
    )
}

/// Start the command. #9044: a POSIX shell can pass its sandbox probe and
/// still fail to start for the real command. A native shell is retried in
/// the same container before giving up, and the model is told which shell
/// it got. Returns the child, the shell that actually runs it, and the
/// fallback note when the retry was used.
pub(super) async fn spawn_with_fallback(
    sandboxed: bool,
    policy: &jail::Policy,
    shell: proc::ShellConfig,
    command: &str,
    start: &Path,
    sandbox_tmp: Option<&Path>,
) -> Result<(tokio::process::Child, proc::ShellConfig, Option<String>), String> {
    match proc::spawn(&shell, command, start, sandbox_tmp).await {
        Ok(c) => Ok((c, shell, None)),
        Err(e) if sandboxed && shell.flavor == proc::ShellFlavor::Posix => {
            match jail::select_native_fallback(policy, command) {
                Some(native) => match proc::spawn(&native, command, start, sandbox_tmp).await {
                    Ok(c) => {
                        let note = native_fallback_note(&e.to_string(), native.description);
                        Ok((c, native, Some(note)))
                    }
                    Err(e2) => Err(format!(
                        "ERROR: failed to run command: {e}; the {} fallback could not start either: {e2}",
                        native.description
                    )),
                },
                None => Err(format!("ERROR: failed to run command: {e}")),
            }
        }
        Err(e) => Err(format!("ERROR: failed to run command: {e}")),
    }
}
