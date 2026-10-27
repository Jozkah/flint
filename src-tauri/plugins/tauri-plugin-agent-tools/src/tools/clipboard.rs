//! The `clipboard` tool: read or replace the text on the user's clipboard.
//!
//! The `bash` sandbox has no clipboard, and the clipboard is the one place a
//! person routinely holds something private for a moment: a password from a
//! manager, a token, a message they have not sent. So both directions are asked
//! about every time (the gate returns an always-ask decision and the backend
//! refuses a call the app did not record a person approving), and the prompt says
//! which direction it is. Reading returns text only, bounded and redacted for
//! credentials; writing replaces the clipboard with the given text, which is
//! kept small enough to pass to PowerShell through the environment.

use std::time::Duration;

use serde_json::Value;

/// Longest text written, in characters. The text travels in an environment
/// variable, and Windows limits the whole environment block to 32 KB.
pub const MAX_WRITE_CHARS: usize = 12_000;
/// Longest text returned from a read, in bytes.
pub const MAX_READ_BYTES: usize = 32 * 1024;
const TIMEOUT_SECS: u64 = 15;

/// Saved clipboard images older than this are deleted on the next read.
const IMAGE_MAX_AGE: Duration = Duration::from_secs(3600);

fn image_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("flint-clipboard")
}

/// Deletes `*.png` files in `dir` last modified more than `max_age` ago;
/// returns how many went. Best effort: a file that cannot be removed stays.
#[cfg_attr(not(windows), allow(dead_code))]
fn sweep_old_images(dir: &std::path::Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Read,
    Write { text: String },
}

// Text first. With no text, an image is saved as a PNG in the temp folder (swept
// after an hour) and its path reported (the model can open it with its file tools); copied files
// are listed. Asking for the text of an image is what used to fail.
const READ: &str = r#"
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $t = [System.Windows.Forms.Clipboard]::GetText()
  if ($t.Length -gt $env:CB_MAX) { $t = $t.Substring(0, [int]$env:CB_MAX) }
  if ($t.Length -gt 0) { $t; return }
}
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $dir = $env:CB_DIR
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $dir ("clipboard-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".png")
  $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  "The clipboard holds an image ($($img.Width)x$($img.Height)). Saved as PNG: $file"
  return
}
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  "The clipboard holds copied files:"
  [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }
  return
}
''
"#;

const WRITE: &str = r#"
$ErrorActionPreference='Stop'
Set-Clipboard -Value $env:CB_TEXT
"Copied $($env:CB_TEXT.Length) characters to the clipboard."
"#;

pub fn plan(args: &Value) -> Result<Action, String> {
    match args.get("action").and_then(Value::as_str) {
        Some("read") => Ok(Action::Read),
        Some("write") => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or("ERROR: clipboard write needs 'text'.")?;
            if text.is_empty() {
                return Err("ERROR: clipboard write needs some text; use read to look.".into());
            }
            if text.chars().count() > MAX_WRITE_CHARS {
                return Err(format!("ERROR: clipboard write takes at most {MAX_WRITE_CHARS} characters; put longer text in a file."));
            }
            if text.contains('\0') {
                return Err("ERROR: clipboard text may not contain a NUL character.".into());
            }
            Ok(Action::Write { text: text.to_string() })
        }
        _ => Err("ERROR: clipboard needs 'action': read or write.".into()),
    }
}

/// What the user is told they are approving.
pub fn summary(action: &Action) -> String {
    match action {
        Action::Read => "Read the text on the clipboard".to_string(),
        Action::Write { text } => {
            format!("Replace the clipboard with {} characters:\n{text}", text.chars().count())
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn bounded(text: &str) -> String {
    if text.len() <= MAX_READ_BYTES {
        return text.to_string();
    }
    let mut end = MAX_READ_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[clipboard text cut at {} KB]", &text[..end], MAX_READ_BYTES / 1024)
}

#[cfg(windows)]
pub async fn clipboard(args: &Value) -> String {
    use std::process::Stdio;
    let action = match plan(args) {
        Ok(action) => action,
        Err(message) => return message,
    };
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.arg("-NoProfile").arg("-NonInteractive").arg("-STA").arg("-Command");
    match &action {
        Action::Read => {
            let dir = image_dir();
            sweep_old_images(&dir, IMAGE_MAX_AGE);
            cmd.arg(crate::tools::host_read::utf8_script(READ)).env("CB_DIR", &dir).env("CB_MAX", MAX_READ_BYTES.to_string());
        }
        Action::Write { text } => {
            cmd.arg(crate::tools::host_read::utf8_script(WRITE)).env("CB_TEXT", text);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).creation_flags(0x0800_0000);
    match tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), cmd.output()).await {
        Err(_) => format!("ERROR: the clipboard did not answer within {TIMEOUT_SECS} seconds."),
        Ok(Err(e)) => format!("ERROR: could not reach the clipboard: {e}"),
        Ok(Ok(out)) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return format!("ERROR: the clipboard call failed: {}", stderr.lines().next().unwrap_or("").trim());
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            match action {
                Action::Write { .. } => stdout.trim().to_string(),
                Action::Read => {
                    let text = stdout.trim_end_matches(['\r', '\n']);
                    if text.is_empty() {
                        "The clipboard holds no text (it may hold an image or files).".to_string()
                    } else {
                        bounded(&crate::secrets::redact_secrets(text))
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
pub async fn clipboard(args: &Value) -> String {
    let _ = (args, Duration::from_secs(TIMEOUT_SECS), READ, WRITE);
    "ERROR: clipboard works on Windows only.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_and_write_are_the_only_actions() {
        assert_eq!(plan(&json!({ "action": "read" })), Ok(Action::Read));
        assert_eq!(plan(&json!({ "action": "write", "text": "hi" })), Ok(Action::Write { text: "hi".into() }));
        for bad in [json!({}), json!({ "action": "clear" }), json!({ "action": "write" }), json!({ "action": "write", "text": "" }), json!({ "action": "write", "text": "a\0b" })] {
            assert!(plan(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn writing_is_bounded() {
        assert!(plan(&json!({ "action": "write", "text": "x".repeat(MAX_WRITE_CHARS) })).is_ok());
        assert!(plan(&json!({ "action": "write", "text": "x".repeat(MAX_WRITE_CHARS + 1) })).is_err());
    }

    #[test]
    fn the_summary_says_which_way_it_goes() {
        assert_eq!(summary(&Action::Read), "Read the text on the clipboard");
        let text = format!("line one\nline two {}DANGEROUS_TAIL", "x".repeat(100));
        let long = summary(&Action::Write { text: text.clone() });
        assert!(long.starts_with("Replace the clipboard with ") && long.contains(&text));
    }

    #[test]
    fn clipboard_image_cleanup() {
        let dir = std::env::temp_dir().join(format!("flint-clip-clean-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.png");
        let fresh = dir.join("fresh.png");
        let other = dir.join("keep.txt");
        for f in [&old, &fresh, &other] {
            std::fs::write(f, "x").unwrap();
        }
        let two_hours_ago = std::time::SystemTime::now() - Duration::from_secs(7200);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(two_hours_ago).unwrap();
        assert_eq!(sweep_old_images(&dir, IMAGE_MAX_AGE), 1);
        assert!(!old.exists() && fresh.exists() && other.exists());
        assert_eq!(sweep_old_images(&dir.join("missing"), IMAGE_MAX_AGE), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_read_is_cut_on_a_character_boundary() {
        let out = bounded(&"é".repeat(MAX_READ_BYTES));
        assert!(out.contains("cut at"));
    }
}
