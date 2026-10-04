//! The `host_ssh` tool: run one command on another machine over SSH.
//!
//! It uses the user's own SSH client, keys and `known_hosts`, which is the whole
//! risk: whatever those can reach, a command can. So it is asked about every
//! time, with the machine and the whole command shown, and the backend refuses a
//! call the app did not record a person approving.
//!
//! The call never prompts and never guesses: `BatchMode` means a password or
//! passphrase prompt fails instead of waiting, and a host the user has not
//! already trusted fails instead of being added silently (`StrictHostKeyChecking`
//! stays on its default, which asks, and with no one to ask refuses). The target
//! is checked so it can never be read as an option, and `--` ends the options.

use std::time::Duration;

use serde_json::Value;

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;
const MAX_COMMAND_CHARS: usize = 8_000;

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub target: String,
    pub port: Option<u16>,
    pub command: String,
    pub timeout: Duration,
}

/// `host`, `user@host` or an alias from the user's ssh config.
fn valid_target(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && !text.starts_with('-')
        && text.matches('@').count() <= 1
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | ':'))
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let target = args
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|h| valid_target(h))
        .ok_or("ERROR: host_ssh needs a 'host': a name, user@name or an alias from the user's ssh config.")?
        .to_string();
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .ok_or("ERROR: host_ssh needs a 'command'.")?;
    if command.chars().count() > MAX_COMMAND_CHARS || command.contains('\0') {
        return Err(format!("ERROR: a host_ssh command is at most {MAX_COMMAND_CHARS} characters and has no NUL."));
    }
    let port = match args.get("port") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|p| (1..=65_535).contains(p))
                .ok_or("ERROR: host_ssh 'port' must be a number from 1 to 65535.")? as u16,
        ),
    };
    let timeout = match args.get("timeout_secs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: host_ssh 'timeout_secs' must be a whole number.")?
            .clamp(5, MAX_TIMEOUT_SECS),
    };
    Ok(Plan { target, port, command: command.to_string(), timeout: Duration::from_secs(timeout) })
}

/// What the user is shown.
pub fn display(plan: &Plan) -> String {
    let port = plan.port.map(|p| format!(" port {p}")).unwrap_or_default();
    format!("On {}{port} over SSH:\n{}", plan.target, plan.command.trim())
}

pub fn argv(plan: &Plan) -> Vec<String> {
    let mut args: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "NumberOfPasswordPrompts=0", "-T"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(port) = plan.port {
        args.extend(["-p".to_string(), port.to_string()]);
    }
    args.extend(["--".to_string(), plan.target.clone(), plan.command.clone()]);
    args
}

pub async fn run(args: &Value) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    execute(&plan).await
}

async fn execute(plan: &Plan) -> String {
    let mut cmd = tokio::process::Command::new(if cfg!(windows) { "ssh.exe" } else { "ssh" });
    cmd.args(argv(plan));
    match crate::tools::host_read::capture(cmd, plan.timeout).await {
        Err(crate::tools::host_read::CaptureError::Timeout) => format!("ERROR: {} did not finish within {} seconds and was stopped.", plan.target, plan.timeout.as_secs()),
        Err(crate::tools::host_read::CaptureError::NotFound) => "ERROR: no ssh client was found on this computer's PATH.".to_string(),
        Err(crate::tools::host_read::CaptureError::Io(e)) => format!("ERROR: could not start ssh: {e}"),
        Ok(out) => {
            let mut log = out.stdout.trim().to_string();
            if !out.stderr.trim().is_empty() {
                log = format!("{log}\n{}", out.stderr.trim()).trim().to_string();
            }
            let log = crate::secrets::redact_secrets(&crate::tools::host_build::trimmed(&log));
            let code = out.code.map_or("none".to_string(), |c| c.to_string());
            if out.success {
                if log.is_empty() { format!("Finished (exit code {code}), no output.") } else { format!("Finished (exit code {code}).\n{log}") }
            } else if out.code == Some(255) {
                format!("ERROR: ssh could not connect or authenticate to {} (it never asks for a password or to trust a new host; use a key, and connect once yourself to trust the host).\n{log}", plan.target)
            } else {
                format!("ERROR: the command failed (exit code {code}).\n{log}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_target_and_command_are_needed() {
        let p = plan(&json!({ "host": "me@build-box.lan", "command": "uptime", "port": 2222 })).unwrap();
        assert_eq!((p.target.as_str(), p.port, p.command.as_str()), ("me@build-box.lan", Some(2222), "uptime"));
        assert!(plan(&json!({ "host": "devbox", "command": "ls" })).is_ok());
        for bad in [json!({}), json!({ "host": "x" }), json!({ "command": "ls" }), json!({ "host": "-oProxyCommand=calc", "command": "ls" }), json!({ "host": "a b", "command": "ls" }), json!({ "host": "a@b@c", "command": "ls" }), json!({ "host": "h;rm", "command": "ls" }), json!({ "host": "h", "command": " " }), json!({ "host": "h", "command": "a\0b" }), json!({ "host": "h", "command": "ls", "port": 0 }), json!({ "host": "h", "command": "ls", "port": 70000 })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_call_never_prompts_and_options_end_before_the_target() {
        let p = plan(&json!({ "host": "devbox", "command": "echo 'a b'; ls", "port": 22 })).unwrap();
        let args = argv(&p);
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|w| w == ["-o", "NumberOfPasswordPrompts=0"]));
        let dashes = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[dashes + 1..], ["devbox", "echo 'a b'; ls"]);
        assert!(!args.iter().any(|a| a.contains("StrictHostKeyChecking")));
    }

    #[test]
    fn the_user_sees_the_machine_and_the_command() {
        let p = plan(&json!({ "host": "devbox", "command": " uptime ", "port": 2200 })).unwrap();
        assert_eq!(display(&p), "On devbox port 2200 over SSH:\nuptime");
    }

    #[tokio::test]
    async fn a_missing_ssh_or_unreachable_host_is_said_plainly() {
        // A reserved, unroutable name: either ssh is missing or it cannot connect.
        let p = plan(&json!({ "host": "no-such-host.invalid", "command": "true", "timeout_secs": 20 })).unwrap();
        let out = execute(&p).await;
        assert!(out.starts_with("ERROR:"), "{out}");
    }
}
