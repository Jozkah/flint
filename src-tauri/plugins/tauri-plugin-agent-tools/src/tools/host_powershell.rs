//! The `host_powershell` tool: run a PowerShell script as the user, outside the
//! sandbox.
//!
//! The `bash` AppContainer cannot reach most of what PowerShell is used for on
//! Windows: the registry, services, the Event Log, WMI, another program's
//! window, a profile-installed module. The dedicated host tools cover the
//! common reads and a few changes by name. This is the general one, so it is the
//! most trusted tool in the set: a script can do anything the user can.
//!
//! That is why it is shaped the way it is. The gate asks about every call, each
//! time (no grant, mode or "always" covers it), the backend refuses a call the
//! app did not record a person approving, and the question shows the whole
//! script. The script runs non-interactively with no profile, from a folder the
//! run may write to, with a time limit; it is passed as an encoded command, so
//! no quoting of the script can change what the user was shown. Output is
//! redacted for credentials and bounded.

use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;

use crate::tools::git_tool::Roots;

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 900;
const MAX_SCRIPT_CHARS: usize = 20_000;
const HEAD_BYTES: usize = 6 * 1024;
const TAIL_BYTES: usize = 40 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub script: String,
    pub timeout: Duration,
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let script = args
        .get("script")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("ERROR: host_powershell needs a 'script'.")?;
    if script.chars().count() > MAX_SCRIPT_CHARS {
        return Err(format!("ERROR: host_powershell takes a script of at most {MAX_SCRIPT_CHARS} characters; put a longer one in a file."));
    }
    if script.contains('\0') {
        return Err("ERROR: a host_powershell script may not contain a NUL character.".into());
    }
    let timeout = match args.get("timeout_secs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: host_powershell 'timeout_secs' must be a whole number.")?
            .clamp(5, MAX_TIMEOUT_SECS),
    };
    Ok(Plan { script: script.to_string(), timeout: Duration::from_secs(timeout) })
}

/// What the user is shown: the complete script that will execute.
pub fn display(plan: &Plan) -> String {
    plan.script.clone()
}

/// `-EncodedCommand` takes the script as base64 of UTF-16LE.
pub fn encode(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn trimmed(text: &str) -> String {
    let text = text.trim();
    if text.len() <= HEAD_BYTES + TAIL_BYTES {
        return text.to_string();
    }
    let mut head = HEAD_BYTES;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n[... {} bytes of output left out ...]\n{}", &text[..head], tail - head, &text[tail..])
}

pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let roots = Roots::from_ctx(ctx);
    let cwd = match crate::tools::host_build::resolve_cwd(args.get("cwd").and_then(Value::as_str), &roots) {
        Ok(c) => c,
        Err(e) => return format!("ERROR: host_powershell: {e}"),
    };
    execute(&plan, &cwd).await
}

#[cfg(windows)]
async fn execute(plan: &Plan, cwd: &Path) -> String {
    use std::process::Stdio;
    // Output as UTF-8, then the user's script.
    let script = format!(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n\
         $ErrorActionPreference='Stop'\n\
         $ProgressPreference='SilentlyContinue'\n\
         try {{\n{}\n}} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}",
        plan.script
    );
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encode(&script)])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(0x0800_0000);
    match tokio::time::timeout(plan.timeout, cmd.output()).await {
        Err(_) => format!(
            "ERROR: the script had not finished after {} seconds and was stopped. Run less at once, or raise timeout_secs (up to {MAX_TIMEOUT_SECS}).",
            plan.timeout.as_secs()
        ),
        Ok(Err(e)) => format!("ERROR: could not start PowerShell: {e}"),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let mut log = stdout.trim().to_string();
            if !stderr.trim().is_empty() {
                log = format!("{log}\n{}", stderr.trim()).trim().to_string();
            }
            let log = crate::secrets::redact_secrets(&trimmed(&log));
            let code = out.status.code().map_or("none".to_string(), |c| c.to_string());
            if out.status.success() {
                if log.is_empty() { format!("Finished (exit code {code}), no output.") } else { format!("Finished (exit code {code}).\n{log}") }
            } else {
                format!("ERROR: the script failed (exit code {code}).\n{log}")
            }
        }
    }
}

#[cfg(not(windows))]
async fn execute(plan: &Plan, cwd: &Path) -> String {
    let _ = (plan, cwd, TAIL_BYTES, trimmed("").len());
    "ERROR: host_powershell works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_script_is_needed_and_bounded() {
        assert!(plan(&json!({ "script": "Get-Date" })).is_ok());
        for bad in [json!({}), json!({ "script": "" }), json!({ "script": "   " }), json!({ "script": "a\0b" }), json!({ "script": "x".repeat(MAX_SCRIPT_CHARS + 1) }), json!({ "script": 5 })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
        assert!(plan(&json!({ "script": "x".repeat(MAX_SCRIPT_CHARS) })).is_ok());
    }

    #[test]
    fn the_time_limit_is_bounded() {
        assert_eq!(plan(&json!({ "script": "x" })).unwrap().timeout, Duration::from_secs(120));
        assert_eq!(plan(&json!({ "script": "x", "timeout_secs": 99999 })).unwrap().timeout, Duration::from_secs(900));
        assert_eq!(plan(&json!({ "script": "x", "timeout_secs": 1 })).unwrap().timeout, Duration::from_secs(5));
        assert!(plan(&json!({ "script": "x", "timeout_secs": "soon" })).is_err());
    }

    #[test]
    fn the_script_is_encoded_as_utf16_base64() {
        // "Get-Date" as UTF-16LE, base64: a known PowerShell -EncodedCommand value.
        assert_eq!(encode("Get-Date"), "RwBlAHQALQBEAGEAdABlAA==");
        let decoded = base64::engine::general_purpose::STANDARD.decode(encode("é日")).unwrap();
        assert_eq!(decoded, [0xE9, 0x00, 0xE5, 0x65]);
    }

    #[test]
    fn the_user_sees_the_whole_script() {
        let short = plan(&json!({ "script": "  Get-Process | Sort CPU  " })).unwrap();
        assert_eq!(display(&short), "  Get-Process | Sort CPU  ");
        let long = plan(&json!({ "script": "x".repeat(2000) })).unwrap();
        assert_eq!(display(&long), "x".repeat(2000));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_a_script_and_reports_output_exit_and_utf8() {
        let dir = std::env::temp_dir();
        let ok = execute(&plan(&json!({ "script": "Write-Output 'olá 日本'; $PWD.Path" })).unwrap(), &dir).await;
        assert!(ok.starts_with("Finished (exit code 0).") && ok.contains("olá 日本"), "{ok}");
        let failed = execute(&plan(&json!({ "script": "Write-Output hi; exit 3" })).unwrap(), &dir).await;
        assert!(failed.starts_with("ERROR: the script failed (exit code 3)."), "{failed}");
        let missing = execute(&plan(&json!({ "script": "Get-Item -LiteralPath 'C:\\flint-file-that-does-not-exist'; Write-Output ok" })).unwrap(), &dir).await;
        assert!(missing.starts_with("ERROR: the script failed"), "{missing}");
        assert!(!missing.contains("CLIXML"), "{missing}");
        let timed = execute(&plan(&json!({ "script": "Start-Sleep 30", "timeout_secs": 5 })).unwrap(), &dir).await;
        assert!(timed.contains("had not finished after 5 seconds"), "{timed}");
    }
}
