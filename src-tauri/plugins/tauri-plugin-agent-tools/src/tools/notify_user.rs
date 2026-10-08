//! The `notify_user` tool: a desktop notification, for the end of something long.
//!
//! "Tell me when the build finishes" is a job a person walks away from. A toast
//! needs no approval, because it cannot read or change anything, but it is the
//! one tool that speaks to the user unprompted, so it is kept short and rare: a
//! title and a message of limited length, plain text only, and no more than one
//! every ten seconds and thirty an hour, which the tool says plainly when it
//! declines.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

const MAX_TITLE: usize = 80;
const MAX_MESSAGE: usize = 300;
const MIN_GAP: Duration = Duration::from_secs(10);
const PER_HOUR: usize = 30;

static RECENT: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub title: String,
    pub message: String,
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    let message = text("message").filter(|m| !m.is_empty()).ok_or("ERROR: notify_user needs a 'message'.")?;
    let title = text("title").filter(|t| !t.is_empty()).unwrap_or_else(|| "Flint".to_string());
    if message.chars().count() > MAX_MESSAGE {
        return Err(format!("ERROR: a notification message is at most {MAX_MESSAGE} characters."));
    }
    if title.chars().count() > MAX_TITLE {
        return Err(format!("ERROR: a notification title is at most {MAX_TITLE} characters."));
    }
    if message.chars().chain(title.chars()).any(|c| c.is_control()) {
        return Err("ERROR: a notification is plain text.".into());
    }
    Ok(Plan { title, message })
}

/// Whether another notification may be shown now, recording it if so.
fn allow(now: Instant) -> Result<(), String> {
    let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
    recent.retain(|t| now.duration_since(*t) < Duration::from_secs(3600));
    if let Some(last) = recent.last() {
        if now.duration_since(*last) < MIN_GAP {
            return Err("Not shown: another notification was shown less than 10 seconds ago. Send one when the whole thing is done.".into());
        }
    }
    if recent.len() >= PER_HOUR {
        return Err(format!("Not shown: {PER_HOUR} notifications were already shown in the last hour."));
    }
    recent.push(now);
    Ok(())
}

const TOAST: &str = r#"
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:NU_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:NU_MESSAGE)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
'Shown.'
"#;

#[cfg(windows)]
pub async fn notify_user(args: &Value) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    if let Err(message) = allow(Instant::now()) {
        return message;
    }
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &crate::tools::host_read::utf8_script(TOAST)])
        .env("NU_TITLE", &plan.title)
        .env("NU_MESSAGE", &plan.message);
    match crate::tools::host_read::capture(cmd, Duration::from_secs(20)).await {
        Ok(out) if out.success => format!("Notification shown: {}", plan.title),
        Ok(out) => format!("ERROR: the notification could not be shown: {}", out.stderr.lines().next().unwrap_or("").trim()),
        Err(_) => "ERROR: the notification could not be shown.".to_string(),
    }
}

#[cfg(not(windows))]
pub async fn notify_user(args: &Value) -> String {
    let _ = (args, plan(args), allow(Instant::now()), TOAST);
    "ERROR: notify_user works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_message_is_needed_and_the_title_defaults() {
        assert_eq!(plan(&json!({ "message": "Build done" })).unwrap(), Plan { title: "Flint".into(), message: "Build done".into() });
        assert_eq!(plan(&json!({ "title": "  CI ", "message": "all  green" })).unwrap().message, "all green");
        for bad in [json!({}), json!({ "message": "" }), json!({ "message": "x".repeat(MAX_MESSAGE + 1) }), json!({ "title": "x".repeat(MAX_TITLE + 1), "message": "m" })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn notifications_are_rare() {
        // Own recent list, so the other tests and the clock cannot interfere.
        RECENT.lock().unwrap().clear();
        let start = Instant::now();
        assert!(allow(start).is_ok());
        assert!(allow(start + Duration::from_secs(5)).unwrap_err().contains("10 seconds"));
        assert!(allow(start + Duration::from_secs(11)).is_ok());
        RECENT.lock().unwrap().clear();
        let mut t = start;
        for _ in 0..PER_HOUR {
            t += Duration::from_secs(11);
            assert!(allow(t).is_ok());
        }
        assert!(allow(t + Duration::from_secs(11)).unwrap_err().contains("last hour"));
        RECENT.lock().unwrap().clear();
    }
}
