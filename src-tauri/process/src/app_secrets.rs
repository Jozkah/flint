//! Keep the app's own credentials out of programs it starts for someone else.
//!
//! `FLINT_API_KEY` (and the legacy `JAN_API_KEY`) is the key a session holds
//! for its gateway, and the llama.cpp worker's key lives under
//! `*_LLAMA_API_KEY`. A stdio MCP server is third-party code: it inherits the
//! parent's environment unless told otherwise, so these must be removed from
//! its child environment. A value the server's own config sets is applied
//! after this and still wins.

use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// Environment variables carrying Flint's own credentials, in both spellings
/// (`FLINT_` first, `JAN_` is the legacy name `compat_env` still honours).
pub const APP_SECRET_ENV: &[&str] = &[
    "FLINT_API_KEY",
    "JAN_API_KEY",
    "FLINT_LLAMA_API_KEY",
    "JAN_LLAMA_API_KEY",
];

/// Removes [`APP_SECRET_ENV`] from a child's inherited environment.
pub trait WithoutAppSecrets {
    /// Call before any explicit `.env(..)` from the server's own config, so a
    /// value the user set on purpose still wins.
    fn without_app_secrets(&mut self) -> &mut Self;
}

impl WithoutAppSecrets for StdCommand {
    fn without_app_secrets(&mut self) -> &mut Self {
        for var in APP_SECRET_ENV {
            self.env_remove(var);
        }
        self
    }
}

impl WithoutAppSecrets for TokioCommand {
    fn without_app_secrets(&mut self) -> &mut Self {
        for var in APP_SECRET_ENV {
            self.env_remove(var);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn removed(cmd: &StdCommand, var: &str) -> bool {
        cmd.get_envs().any(|(k, v)| k == OsStr::new(var) && v.is_none())
    }

    #[test]
    fn every_app_secret_is_removed_from_the_child_env() {
        let mut cmd = StdCommand::new("noop");
        cmd.without_app_secrets();
        for var in APP_SECRET_ENV {
            assert!(removed(&cmd, var), "{var} must be removed");
        }
        assert!(!removed(&cmd, "OPENAI_API_KEY"));
        assert!(!removed(&cmd, "GITHUB_TOKEN"));
    }

    #[test]
    fn a_servers_own_env_set_afterwards_wins() {
        let mut cmd = StdCommand::new("noop");
        cmd.without_app_secrets();
        cmd.env("JAN_API_KEY", "mine");
        assert!(cmd
            .get_envs()
            .any(|(k, v)| k == OsStr::new("JAN_API_KEY") && v == Some(OsStr::new("mine"))));
    }

    #[test]
    fn tokio_command_is_scrubbed_too() {
        let mut cmd = TokioCommand::new("noop");
        cmd.without_app_secrets();
        let std_cmd = cmd.as_std();
        for var in APP_SECRET_ENV {
            assert!(removed(std_cmd, var), "{var} must be removed");
        }
    }
}
