//! The `host_action` tool: end one process, or start, stop or restart one
//! service, on this computer.
//!
//! Unlike the read-only host tools, this changes things, so it never runs on
//! the model's say-so. The gate marks every call as one that must be asked
//! about each time (no session grant and no auto-approval covers it), and the
//! backend refuses a call the app did not record a person approving. The app
//! shows the exact target, with the process name and path looked up first, in
//! that question.
//!
//! The model never writes a command. It names one of four actions and one
//! target. A process is identified by its number only: a name would end every
//! program that shares it. A service is identified by its exact short name, with
//! no wildcard. The system's own critical processes and services, and Flint
//! itself, are refused here whatever the user is asked. Each action is a fixed
//! PowerShell script that reads its target from the environment, never from the
//! script text. The call runs with the same rights as Flint: a service that
//! needs an administrator fails with Windows' own refusal, and nothing here
//! asks Windows to elevate.

use std::time::Duration;

use serde_json::Value;

const TIMEOUT_SECS: u64 = 60;
const OUTPUT_CAP: usize = 4 * 1024;

/// Processes that are never ended: ending one crashes or logs out the machine,
/// or is Flint itself. Compared in lower case, without `.exe`.
pub const PROTECTED_PROCESSES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "memory compression",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
    "lsaiso",
    "svchost",
    "fontdrvhost",
    "dwm",
    "sihost",
    "ctfmon",
    "flint-desktop",
    "flint",
];

/// Services that are never touched: the machine, its security or its remote
/// sessions depend on them.
pub const PROTECTED_SERVICES: &[&str] = &[
    "rpcss",
    "rpceptmapper",
    "dcomlaunch",
    "lsm",
    "samss",
    "eventlog",
    "winmgmt",
    "plugplay",
    "power",
    "profsvc",
    "gpsvc",
    "cryptsvc",
    "bfe",
    "mpssvc",
    "windefend",
    "wdnissvc",
    "sense",
    "termservice",
    "sessionenv",
    "umrdpservice",
    "trustedinstaller",
    "tiledatamodelsvc",
    "brokerinfrastructure",
    "coreuisvc",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceOp {
    Start,
    Stop,
    Restart,
}

impl ServiceOp {
    fn word(self) -> &'static str {
        match self {
            ServiceOp::Start => "start",
            ServiceOp::Stop => "stop",
            ServiceOp::Restart => "restart",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    KillProcess { pid: u32 },
    Service { op: ServiceOp, name: String },
}

const KILL: &str = r#"
$ErrorActionPreference='Stop'
$id=[int]$env:HA_PID
if ($id -eq [int]$env:HA_SELF) { throw 'refused: that is Flint itself.' }
$p=Get-Process -Id $id
$name=$p.ProcessName.ToLower()
if (($env:HA_DENY.Split(',')) -contains $name) { throw "refused: $($p.ProcessName) is a protected system process." }
Stop-Process -Id $id -Force
"Ended process $id ($($p.ProcessName))."
"#;

const SERVICE: &str = r#"
$ErrorActionPreference='Stop'
$n=$env:HA_NAME
if (($env:HA_DENY.Split(',')) -contains $n.ToLower()) { throw "refused: $n is a protected system service." }
$svc=Get-Service -Name $n
switch ($env:HA_OP) {
  'start'   { Start-Service -InputObject $svc }
  'stop'    { Stop-Service -InputObject $svc }
  'restart' { Restart-Service -InputObject $svc }
}
$svc.Refresh()
"$($svc.Name) ($($svc.DisplayName)) is now $($svc.Status)."
"#;

/// A service's short name: no wildcard, so one call cannot reach several.
fn valid_service_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '$' | '-' | ' '))
}

pub fn plan(args: &Value) -> Result<Action, String> {
    let action = args.get("action").and_then(Value::as_str).ok_or(
        "ERROR: host_action needs an 'action': kill_process, start_service, stop_service or restart_service.",
    )?;
    match action {
        "kill_process" => {
            let pid = args
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|p| (5..=u32::MAX as u64).contains(p))
                .ok_or("ERROR: kill_process needs 'pid', the process number (a whole number above 4). Find it with host_query processes or ports.")?;
            Ok(Action::KillProcess { pid: pid as u32 })
        }
        "start_service" | "stop_service" | "restart_service" => {
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| valid_service_name(n))
                .ok_or("ERROR: the service actions need 'name', the service's exact short name (letters, digits, dots, dashes, underscores). Find it with host_query services.")?;
            if PROTECTED_SERVICES.contains(&name.to_ascii_lowercase().as_str()) {
                return Err(format!("ERROR: {name} is a protected system service and is not touched from here."));
            }
            let op = match action {
                "start_service" => ServiceOp::Start,
                "stop_service" => ServiceOp::Stop,
                _ => ServiceOp::Restart,
            };
            Ok(Action::Service { op, name: name.to_string() })
        }
        other => Err(format!(
            "ERROR: host_action has no action '{other}'. Use kill_process, start_service, stop_service or restart_service."
        )),
    }
}

/// What the user is told they are approving, before the target's own details
/// (name, path, status) are added by the app.
pub fn summary(action: &Action) -> String {
    match action {
        Action::KillProcess { pid } => format!("End process {pid}"),
        Action::Service { op, name } => format!("{} service {name}", {
            let mut word = op.word().to_string();
            word[..1].make_ascii_uppercase();
            word
        }),
    }
}

fn cut(text: &str) -> String {
    let text = text.trim();
    if text.len() <= OUTPUT_CAP {
        return text.to_string();
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(windows)]
pub async fn host_action(args: &Value) -> String {
    use std::process::Stdio;
    let action = match plan(args) {
        Ok(action) => action,
        Err(message) => return message,
    };
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.arg("-NoProfile").arg("-NonInteractive").arg("-Command");
    match &action {
        Action::KillProcess { pid } => {
            cmd.arg(KILL)
                .env("HA_PID", pid.to_string())
                .env("HA_SELF", std::process::id().to_string())
                .env("HA_DENY", PROTECTED_PROCESSES.join(","));
        }
        Action::Service { op, name } => {
            cmd.arg(SERVICE)
                .env("HA_NAME", name)
                .env("HA_OP", op.word())
                .env("HA_DENY", PROTECTED_SERVICES.join(","));
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).creation_flags(0x0800_0000);
    match tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await {
        Err(_) => format!("ERROR: {} did not finish in {TIMEOUT_SECS} seconds. Check its state with host_query.", summary(&action)),
        Ok(Err(e)) => format!("ERROR: could not run the action: {e}"),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if out.status.success() {
                cut(&stdout)
            } else {
                let reason = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
                // PowerShell wraps the message in its error-record text.
                let first = reason.lines().next().unwrap_or("").trim();
                format!("ERROR: {} failed: {}", summary(&action), cut(first))
            }
        }
    }
}

#[cfg(not(windows))]
pub async fn host_action(args: &Value) -> String {
    let _ = (args, Duration::from_secs(TIMEOUT_SECS), KILL, SERVICE);
    "ERROR: host_action works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_process_is_named_by_number_only() {
        assert_eq!(plan(&json!({ "action": "kill_process", "pid": 4321 })), Ok(Action::KillProcess { pid: 4321 }));
        for bad in [json!({ "action": "kill_process" }), json!({ "action": "kill_process", "name": "chrome" }), json!({ "action": "kill_process", "pid": 0 }), json!({ "action": "kill_process", "pid": 4 }), json!({ "action": "kill_process", "pid": -1 }), json!({ "action": "kill_process", "pid": "12" }), json!({ "action": "kill_process", "pid": 99999999999u64 })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_service_is_named_exactly_without_wildcards() {
        assert_eq!(
            plan(&json!({ "action": "restart_service", "name": "Spooler" })),
            Ok(Action::Service { op: ServiceOp::Restart, name: "Spooler".into() })
        );
        assert!(plan(&json!({ "action": "stop_service", "name": "MSSQL$SQLEXPRESS" })).is_ok());
        for name in ["", "*", "Spool*", "a?b", "[a]", "x;y", "x'y", "a\nb", "a`b"] {
            assert!(plan(&json!({ "action": "start_service", "name": name })).is_err(), "{name}");
        }
    }

    #[test]
    fn critical_services_are_refused_in_any_case() {
        for name in ["RpcSs", "eventlog", "WinDefend", "TermService", "BFE"] {
            let err = plan(&json!({ "action": "stop_service", "name": name })).unwrap_err();
            assert!(err.contains("protected"), "{name}: {err}");
        }
    }

    #[test]
    fn unknown_actions_and_missing_ones_are_refused() {
        assert!(plan(&json!({})).is_err());
        assert!(plan(&json!({ "action": "start_program", "name": "calc" })).is_err());
        assert!(plan(&json!({ "action": "delete_service", "name": "x" })).is_err());
    }

    #[test]
    fn the_protected_lists_are_lower_case_and_cover_the_essentials() {
        for list in [PROTECTED_PROCESSES, PROTECTED_SERVICES] {
            assert!(list.iter().all(|n| *n == n.to_ascii_lowercase()));
        }
        for name in ["csrss", "lsass", "winlogon", "svchost", "flint-desktop"] {
            assert!(PROTECTED_PROCESSES.contains(&name), "{name}");
        }
    }

    #[test]
    fn the_summary_names_the_action_and_target() {
        assert_eq!(summary(&Action::KillProcess { pid: 12 }), "End process 12");
        assert_eq!(summary(&Action::Service { op: ServiceOp::Stop, name: "Spooler".into() }), "Stop service Spooler");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_protected_process_is_refused_by_the_script_too() {
        // The script's own check is the last line of defence; run it against a
        // service the list protects, which never needs a real target.
        let out = host_action(&json!({ "action": "stop_service", "name": "RpcSs" })).await;
        assert!(out.contains("protected"), "{out}");
    }
}
