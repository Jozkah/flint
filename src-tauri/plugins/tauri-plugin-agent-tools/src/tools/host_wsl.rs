//! The `host_wsl` tool: run a command inside a WSL distribution.
//!
//! The `bash` sandbox cannot reach `wsl.exe`, and a WSL distribution is a whole
//! Linux machine with the user's files mounted, so a command in it is as
//! powerful as `host_powershell`. It is shaped the same way: asked about every
//! time with the whole command shown, refused by the backend unless a person
//! approved it, run from a folder the run may write to, with a time limit.
//!
//! The command travels base64-encoded and is decoded inside the distribution,
//! so no quoting layer between Windows, `wsl.exe` and the shell can change what
//! the user was shown. The distribution name is checked; a name that starts with
//! a dash can never be read as an option.

use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;

use crate::tools::git_tool::Roots;

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 900;
const MAX_COMMAND_CHARS: usize = 8_000;

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub distro: Option<String>,
    pub command: String,
    pub timeout: Duration,
}

fn valid_distro(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .ok_or("ERROR: host_wsl needs a 'command' for the Linux shell.")?;
    if command.chars().count() > MAX_COMMAND_CHARS || command.contains('\0') {
        return Err(format!("ERROR: a host_wsl command is at most {MAX_COMMAND_CHARS} characters and has no NUL; put a longer script in a file."));
    }
    let distro = match args.get("distro") {
        None | Some(Value::Null) => None,
        Some(Value::String(d)) if valid_distro(d.trim()) => Some(d.trim().to_string()),
        Some(_) => return Err("ERROR: 'distro' is a distribution name such as Ubuntu (letters, digits, dots, dashes, underscores). List them with host_query wsl_distros.".into()),
    };
    let timeout = match args.get("timeout_secs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: host_wsl 'timeout_secs' must be a whole number.")?
            .clamp(5, MAX_TIMEOUT_SECS),
    };
    Ok(Plan { distro, command: command.to_string(), timeout: Duration::from_secs(timeout) })
}

/// What the user is shown.
pub fn display(plan: &Plan) -> String {
    let where_ = plan.distro.as_deref().unwrap_or("the default distribution");
    format!("In WSL ({where_}):\n{}", plan.command.trim())
}

/// The arguments after `wsl.exe`.
pub fn argv(plan: &Plan, cwd: Option<&str>) -> Vec<String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(plan.command.as_bytes());
    let mut args: Vec<String> = Vec::new();
    if let Some(d) = &plan.distro {
        args.extend(["-d".to_string(), d.clone()]);
    }
    if let Some(dir) = cwd {
        args.extend(["--cd".to_string(), dir.to_string()]);
    }
    args.extend(["--exec".into(), "bash".into(), "-c".into(), format!("echo {encoded} | base64 -d | bash")]);
    args
}

pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let roots = Roots::from_ctx(ctx);
    let cwd = match crate::tools::host_build::resolve_cwd(args.get("cwd").and_then(Value::as_str), &roots) {
        Ok(c) => c,
        Err(e) => return format!("ERROR: host_wsl: {e}"),
    };
    execute(&plan, &cwd).await
}

#[cfg(windows)]
async fn execute(plan: &Plan, cwd: &std::path::Path) -> String {
    let shown = crate::tools::gate::strip_verbatim(cwd);
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(argv(plan, Some(&shown.to_string_lossy())));
    match crate::tools::host_read::capture(cmd, plan.timeout).await {
        Err(crate::tools::host_read::CaptureError::Timeout) => format!("ERROR: the command had not finished after {} seconds and was stopped.", plan.timeout.as_secs()),
        Err(crate::tools::host_read::CaptureError::NotFound) => "ERROR: WSL is not installed on this computer.".to_string(),
        Err(crate::tools::host_read::CaptureError::Io(e)) => format!("ERROR: could not start WSL: {e}"),
        Ok(out) => {
            // wsl.exe's own messages (no such distribution, virtualization off)
            // are UTF-16 on either stream; the command's output is UTF-8.
            let plain = |text: &str| text.chars().filter(|c| !matches!(c, '\0' | '\u{feff}' | '\u{fffd}')).collect::<String>();
            let stderr = plain(&out.stderr);
            let mut log = plain(&out.stdout).trim().to_string();
            if !stderr.trim().is_empty() {
                log = format!("{log}\n{}", stderr.trim()).trim().to_string();
            }
            let log = crate::secrets::redact_secrets(&crate::tools::host_build::trimmed(&log));
            let code = out.code.map_or("none".to_string(), |c| c.to_string());
            if out.success {
                if log.is_empty() { format!("Finished (exit code {code}), no output.") } else { format!("Finished (exit code {code}).\n{log}") }
            } else {
                format!("ERROR: the command failed (exit code {code}).\n{log}")
            }
        }
    }
}

#[cfg(not(windows))]
async fn execute(plan: &Plan, cwd: &std::path::Path) -> String {
    let _ = (plan, cwd, argv(plan, None), Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    "ERROR: host_wsl works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_command_is_needed_and_the_distro_is_checked() {
        assert!(plan(&json!({ "command": "uname -a" })).is_ok());
        assert_eq!(plan(&json!({ "command": "ls", "distro": "Ubuntu-22.04" })).unwrap().distro.as_deref(), Some("Ubuntu-22.04"));
        for bad in [json!({}), json!({ "command": "" }), json!({ "command": "  " }), json!({ "command": "a\0b" }), json!({ "command": "x".repeat(MAX_COMMAND_CHARS + 1) }), json!({ "command": "ls", "distro": "-d x" }), json!({ "command": "ls", "distro": "a b" }), json!({ "command": "ls", "distro": "" }), json!({ "command": "ls", "distro": 5 })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_command_travels_encoded_so_quoting_cannot_change_it() {
        let nasty = "echo \"a $HOME\" ; rm -rf 'x'\nuname";
        let plan = plan(&json!({ "command": nasty, "distro": "Ubuntu" })).unwrap();
        let args = argv(&plan, Some("C:\\work"));
        assert_eq!(&args[..4], ["-d", "Ubuntu", "--cd", "C:\\work"]);
        assert_eq!(&args[4..7], ["--exec", "bash", "-c"]);
        let line = &args[7];
        assert!(line.starts_with("echo ") && line.ends_with("| base64 -d | bash"));
        let b64 = line.trim_start_matches("echo ").trim_end_matches(" | base64 -d | bash");
        assert!(b64.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(b64).unwrap(), nasty.as_bytes());
        assert!(!line.contains("rm -rf"));
    }

    #[tokio::test]
    async fn wsl_exes_utf16_messages_are_readable() {
        // What wsl.exe prints when it cannot start: UTF-16 on stdout.
        let utf16: Vec<u8> = "WSL 2 is unable to start\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let text = String::from_utf8_lossy(&utf16).into_owned();
        let plain: String = text.chars().filter(|c| !matches!(c, '\0' | '\u{feff}' | '\u{fffd}')).collect();
        assert_eq!(plain.trim(), "WSL 2 is unable to start");
    }

    #[test]
    fn the_user_sees_the_command_and_where_it_runs() {
        let p = plan(&json!({ "command": " ls -la " })).unwrap();
        assert_eq!(display(&p), "In WSL (the default distribution):\nls -la");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_in_a_real_distribution() {
        // Skipped quietly where WSL cannot start a distribution (none installed,
        // or virtualization is off).
        let probe = std::process::Command::new("wsl.exe").args(["--exec", "true"]).output();
        if !probe.map(|o| o.status.success()).unwrap_or(false) {
            return;
        }
        let out = execute(&plan(&json!({ "command": "echo olá; echo err >&2; exit 0" })).unwrap(), &std::env::temp_dir()).await;
        assert!(out.starts_with("Finished (exit code 0).") && out.contains("olá"), "{out}");
    }
}
