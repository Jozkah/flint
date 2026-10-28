//! The one place a confined shell is chosen for a command, shared by the
//! `bash` tool and hooks so both start from the same sandbox policy and walk
//! the same probe chain: the probed shell, a POSIX-only command refused on a
//! native shell, and a `&&`/`||` command moved onto a shell that chains.
//! Each caller keeps its own wording for a refusal.

use std::path::Path;

use crate::tools::jail::{self, Policy, SelectedShell};
use crate::tools::proc;

/// The policy both start from: the root, network, a read-only home, the
/// project's own `.jan` hidden while confined, and the data-folder mask.
/// Callers add what only they have (the bash tool's write and read roots).
pub(crate) fn base_policy(
    root: &Path,
    allow_network: bool,
    home_readonly: bool,
    sandbox: bool,
    mask: Option<&Path>,
) -> Policy {
    let mut policy = Policy::new(root, allow_network).with_home_readonly(home_readonly);
    // The project's own `.jan` is where the harness keeps what it was told to
    // do; a confined shell or hook does not see it. Unconfined there is no
    // mount to layer the hide on, and the agent should see its own state.
    if sandbox {
        policy = policy.with_hide_root(&root.join(crate::tools::sandbox::JAN_DIR));
    }
    if let Some(mask) = mask {
        policy = policy.with_mask_root(mask);
    }
    policy
}

/// Why the probed shell cannot run this command, with the shell it was.
pub(crate) enum Unfit {
    /// The command needs a POSIX shell (`$(...)`, a heredoc) and the shell is
    /// not one: running it anyway would run something, just not what was asked.
    PosixOnly { construct: &'static str, selected: SelectedShell },
    /// The command chains with `&&`/`||` and no confinable shell can.
    NoChaining { operator: &'static str, selected: SelectedShell },
}

/// Fit an already-probed shell to `command`: refuse a POSIX-only command on a
/// native shell, and move a chaining command onto a shell that keeps
/// `&&`/`||` short-circuit semantics. Blocking (the re-probe launches the
/// sandbox helper): async callers run it off the runtime.
pub(crate) fn fit_to_command(
    policy: &Policy,
    selected: SelectedShell,
    command: &str,
) -> Result<SelectedShell, Unfit> {
    if selected.report.cfg.flavor != proc::ShellFlavor::Posix {
        if let Some(construct) = proc::requires_posix_shell_for(command, selected.report.cfg.flavor) {
            return Err(Unfit::PosixOnly { construct, selected });
        }
    }
    if proc::requires_and_or_chaining(command).is_some()
        && !proc::supports_and_or_chaining(&selected.report.cfg)
    {
        return match jail::select_chaining_capable(policy) {
            Some(capable) => Ok(capable),
            None => Err(Unfit::NoChaining {
                operator: proc::requires_and_or_chaining(command).unwrap_or("&&"),
                selected,
            }),
        };
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bash tool and hooks build the same base policy for the same inputs.
    #[test]
    fn base_policy_hides_jan_only_when_confined() {
        let root = std::env::temp_dir();
        let confined = format!("{:?}", base_policy(&root, false, true, true, None));
        let open = format!("{:?}", base_policy(&root, false, true, false, None));
        assert!(confined.contains(".jan"));
        assert!(!open.contains(".jan"));
    }

    /// A plain command is left on the shell the probe chose.
    #[test]
    fn a_plain_command_keeps_the_probed_shell() {
        let root = std::env::temp_dir();
        let policy = base_policy(&root, false, true, true, None);
        let Ok(selected) = jail::select_shell(&policy) else { return };
        let before = format!("{:?}", selected.wrapped.program);
        let fitted = fit_to_command(&policy, selected, "echo hi").ok().unwrap();
        assert_eq!(format!("{:?}", fitted.wrapped.program), before);
    }
}
