//! The `windows_events` tool: read the Windows Event Log from outside the
//! sandbox.
//!
//! On Windows the `bash` tool runs in an AppContainer. The Event Log service
//! does not admit an AppContainer to its channels, so `wevtutil` and
//! `Get-WinEvent` inside the sandbox are refused, and an agent asked why an app
//! crashed or a service failed could not look. This tool runs `wevtutil qe` as
//! the host (the user's own account), read-only.
//!
//! Nothing here takes a shell string. The channel name is validated, every
//! filter is a typed value, and the XPath query is built from those values, so
//! a model cannot make this run anything but a bounded read of one channel. The
//! host's own access still decides what is readable: `Security` needs an
//! administrator, and the refusal is passed back as it is.

use std::time::Duration;

use serde_json::Value;

/// Longest output handed back to the model, in bytes.
pub const OUTPUT_CAP: usize = 48 * 1024;
const DEFAULT_COUNT: u64 = 30;
const MAX_COUNT: u64 = 200;
const TIMEOUT_SECS: u64 = 30;
const MAX_SINCE_MINUTES: u64 = 60 * 24 * 90;

/// A channel name: `Application`, `System`, or a path such as
/// `Microsoft-Windows-PowerShell/Operational`.
fn valid_channel(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | '/'))
}

/// A provider name: the same characters, without a slash, so it can sit inside
/// the XPath string literal it is quoted into.
fn valid_provider(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

fn whole(args: &Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("ERROR: windows_events '{key}' must be a whole number.")),
    }
}

/// The level word the model may use, as the highest Level number to include
/// (Level 1 is critical, 4 informational; a lower number is worse).
fn level_limit(text: &str) -> Option<u64> {
    match text.trim().to_ascii_lowercase().as_str() {
        "critical" => Some(1),
        "error" | "errors" => Some(2),
        "warning" | "warnings" => Some(3),
        "information" | "info" | "all" => Some(4),
        _ => None,
    }
}

/// The `wevtutil qe` argument list for a call, or the reason it is refused.
pub fn plan(args: &Value) -> Result<Vec<String>, String> {
    let channel = args.get("log").and_then(Value::as_str).unwrap_or("Application").trim().to_string();
    if !valid_channel(&channel) {
        return Err("ERROR: windows_events 'log' must be a channel name such as Application, System or Microsoft-Windows-PowerShell/Operational.".into());
    }
    let count = whole(args, "max_events")?.unwrap_or(DEFAULT_COUNT).clamp(1, MAX_COUNT);

    let mut conditions: Vec<String> = Vec::new();
    if let Some(level) = args.get("level").and_then(Value::as_str) {
        let limit = level_limit(level)
            .ok_or("ERROR: windows_events 'level' must be critical, error, warning or information.")?;
        if limit < 4 {
            conditions.push(format!("(Level>=1 and Level<={limit})"));
        }
    }
    if let Some(minutes) = whole(args, "since_minutes")? {
        let minutes = minutes.clamp(1, MAX_SINCE_MINUTES);
        conditions.push(format!("TimeCreated[timediff(@SystemTime) <= {}]", minutes * 60_000));
    }
    if let Some(ids) = args.get("event_ids") {
        let list = ids
            .as_array()
            .ok_or("ERROR: windows_events 'event_ids' must be a list of whole numbers.")?;
        if list.is_empty() || list.len() > 20 {
            return Err("ERROR: windows_events 'event_ids' takes 1 to 20 numbers.".into());
        }
        let mut parts = Vec::new();
        for id in list {
            let n = id
                .as_u64()
                .filter(|n| *n <= 65_535)
                .ok_or("ERROR: windows_events 'event_ids' must be whole numbers from 0 to 65535.")?;
            parts.push(format!("EventID={n}"));
        }
        conditions.push(format!("({})", parts.join(" or ")));
    }
    if let Some(provider) = args.get("provider").and_then(Value::as_str) {
        let provider = provider.trim();
        if !valid_provider(provider) {
            return Err("ERROR: windows_events 'provider' may hold letters, digits, spaces, dots, dashes and underscores.".into());
        }
        conditions.push(format!("Provider[@Name='{provider}']"));
    }

    // Level and EventID live under System; TimeCreated and Provider too.
    let query = if conditions.is_empty() {
        "*".to_string()
    } else {
        format!("*[System[{}]]", conditions.join(" and "))
    };

    Ok(vec![
        "qe".into(),
        channel,
        format!("/c:{count}"),
        "/rd:true".into(),
        "/f:text".into(),
        format!("/q:{query}"),
    ])
}

/// Cut `text` to the output cap on a character boundary, saying so.
fn bounded(text: &str) -> String {
    if text.len() <= OUTPUT_CAP {
        return text.to_string();
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output cut at {} KB; narrow it with level, since_minutes, event_ids or provider]", &text[..end], OUTPUT_CAP / 1024)
}

#[cfg(windows)]
pub async fn windows_events(args: &Value) -> String {
    let argv = match plan(args) {
        Ok(argv) => argv,
        Err(message) => return message,
    };
    let mut cmd = tokio::process::Command::new("wevtutil.exe");
    cmd.args(&argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(0x0800_0000);
    let run = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await;
    match run {
        Err(_) => format!("ERROR: windows_events did not finish in {TIMEOUT_SECS} seconds and was stopped. Narrow the query."),
        Ok(Err(e)) => format!("ERROR: could not run wevtutil: {e}"),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !out.status.success() {
                let reason = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
                return format!("ERROR: wevtutil refused the query: {}", bounded(reason));
            }
            if stdout.trim().is_empty() {
                return "No events matched.".to_string();
            }
            bounded(stdout.trim())
        }
    }
}

#[cfg(not(windows))]
pub async fn windows_events(args: &Value) -> String {
    let _ = (args, Duration::from_secs(TIMEOUT_SECS));
    "ERROR: windows_events reads the Windows Event Log and only works on Windows.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_read_the_newest_application_events() {
        let argv = plan(&json!({})).unwrap();
        assert_eq!(argv, ["qe", "Application", "/c:30", "/rd:true", "/f:text", "/q:*"]);
    }

    #[test]
    fn filters_become_one_xpath_query() {
        let argv = plan(&json!({
            "log": "System",
            "level": "error",
            "since_minutes": 60,
            "event_ids": [41, 6008],
            "provider": "Service Control Manager",
            "max_events": 5,
        }))
        .unwrap();
        assert_eq!(argv[1], "System");
        assert_eq!(argv[2], "/c:5");
        assert_eq!(
            argv[5],
            "/q:*[System[(Level>=1 and Level<=2) and TimeCreated[timediff(@SystemTime) <= 3600000] and (EventID=41 or EventID=6008) and Provider[@Name='Service Control Manager']]]"
        );
    }

    #[test]
    fn the_count_is_capped() {
        assert_eq!(plan(&json!({ "max_events": 100000 })).unwrap()[2], "/c:200");
        assert_eq!(plan(&json!({ "max_events": 0 })).unwrap()[2], "/c:1");
    }

    #[test]
    fn a_channel_or_provider_cannot_carry_a_query_or_an_option() {
        for log in ["", "System /e:x", "Application' or 1=1", "a;b", "..\\x"] {
            assert!(plan(&json!({ "log": log })).is_err(), "{log}");
        }
        for provider in ["x'] or Level=1 or Provider[@Name='", "a/b", ""] {
            assert!(plan(&json!({ "provider": provider })).is_err(), "{provider}");
        }
        assert!(plan(&json!({ "log": "Microsoft-Windows-PowerShell/Operational" })).is_ok());
    }

    #[test]
    fn bad_values_are_refused_plainly() {
        assert!(plan(&json!({ "level": "loud" })).is_err());
        assert!(plan(&json!({ "event_ids": "41" })).is_err());
        assert!(plan(&json!({ "event_ids": [70000] })).is_err());
        assert!(plan(&json!({ "since_minutes": "soon" })).is_err());
    }

    #[test]
    fn long_output_is_cut_on_a_character_boundary() {
        let text = "é".repeat(OUTPUT_CAP);
        let out = bounded(&text);
        assert!(out.contains("output cut"));
        assert!(out.len() < OUTPUT_CAP + 200);
    }
}
