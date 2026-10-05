//! Host desktop input. Arguments are validated before any OS call; text is
//! data, never executable code. The ordinary host-tool gate asks every time.
use serde_json::Value;
#[cfg(any(windows, test))]
use serde_json::json;
use std::time::Duration;
use super::ImageContentPart;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Screenshot,
    Move { x: i32, y: i32 },
    Click { x: i32, y: i32, button: String, count: u8 },
    Type { x: i32, y: i32, text: String, replace: bool },
    Key { x: i32, y: i32, keys: Vec<String> },
    Scroll { x: i32, y: i32, amount: i32 },
}

// Canonical names, deliberately bounded: no script or arbitrary key expression.
const KEYS: &[&str] = &["ctrl", "alt", "shift", "meta", "enter", "tab", "escape", "backspace", "delete", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"];

pub fn plan(args: &Value) -> Result<Action, String> {
    let coordinate = |name: &str| -> Result<i32, String> {
        args.get(name).and_then(Value::as_i64).filter(|n| (-32768..=32767).contains(n))
            .map(|n| n as i32).ok_or_else(|| format!("computer needs integer '{name}' between -32768 and 32767"))
    };
    match args.get("action").and_then(Value::as_str) {
        Some("screenshot") => Ok(Action::Screenshot),
        Some("move") => Ok(Action::Move { x: coordinate("x")?, y: coordinate("y")? }),
        Some("click") => {
            let button = match args.get("button") { None => "left", Some(value) => value.as_str().ok_or("computer button must be a string")? };
            if !["left", "right", "middle"].contains(&button) { return Err("computer button must be left, right or middle".into()); }
            let count = match args.get("count") { None => 1, Some(n) => n.as_u64().filter(|n| (1..=2).contains(n)).ok_or("computer count must be 1 or 2")? as u8 };
            Ok(Action::Click { x: coordinate("x")?, y: coordinate("y")?, button: button.into(), count })
        }
        Some("type") => {
            let text = args.get("text").and_then(Value::as_str).ok_or("computer type needs text")?;
            if text.is_empty() || text.chars().count() > 12000 || text.contains('\0') { return Err("computer text must contain 1–12000 characters and no NUL".into()); }
            let replace = match args.get("replace") { None => false, Some(Value::Bool(value)) => *value, Some(_) => return Err("computer replace must be a boolean".into()) };
            Ok(Action::Type { x: coordinate("x")?, y: coordinate("y")?, text: text.into(), replace })
        }
        Some("key") => {
            let values = args.get("keys").and_then(Value::as_array).ok_or("computer key needs a keys array")?;
            if values.is_empty() || values.len() > 5 { return Err("computer keys needs 1–5 keys".into()); }
            let mut keys = Vec::new();
            for value in values {
                let key = value.as_str().ok_or("computer key names must be strings")?.to_ascii_lowercase();
                if !KEYS.contains(&key.as_str()) && !(key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric()) {
                    return Err(format!("unsupported computer key: {key}"));
                }
                if keys.contains(&key) { return Err("computer keys must not repeat".into()); }
                keys.push(key);
            }
            if keys.iter().filter(|k| !["ctrl", "alt", "shift", "meta"].contains(&k.as_str())).count() != 1 { return Err("computer key needs exactly one non-modifier key".into()); }
            keys.sort_by_key(|k| !["ctrl", "alt", "shift", "meta"].contains(&k.as_str()));
            Ok(Action::Key { x: coordinate("x")?, y: coordinate("y")?, keys })
        }
        Some("scroll") => {
            let amount = args.get("amount").and_then(Value::as_i64).filter(|n| *n != 0 && (-20..=20).contains(n)).ok_or("computer scroll amount must be -20..-1 or 1..20; positive scrolls down")?;
            Ok(Action::Scroll { x: coordinate("x")?, y: coordinate("y")?, amount: amount as i32 })
        }
        _ => Err("computer action must be screenshot, move, click, type, key or scroll".into()),
    }
}

static INPUT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn run(args: &Value) -> (String, Option<Vec<ImageContentPart>>) {
    let action = match plan(args) { Ok(p) => p, Err(e) => return (format!("ERROR: {e}"), None) };
    let _guard = INPUT_LOCK.lock().await;
    // Let the approval card disappear before a coordinate-based click.
    tokio::time::sleep(Duration::from_millis(250)).await;
    match perform(&action).await {
        Ok(Some(bytes)) => {
            if bytes.len() < 24 || bytes.len() > 20 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return ("ERROR: desktop capture was invalid or exceeded 20 MB".into(), None); }
            use base64::Engine as _;
            let width = u32::from_be_bytes(bytes.get(16..20).and_then(|s| s.try_into().ok()).unwrap_or([0;4]));
            let height = u32::from_be_bytes(bytes.get(20..24).and_then(|s| s.try_into().ok()).unwrap_or([0;4]));
            #[cfg(target_os = "macos")]
            let note = macos::capture_note(width, height);
            #[cfg(not(target_os = "macos"))]
            let note = format!("Captured desktop at {width} × {height} pixels. Screenshot origin is screen (0,0); input uses these pixel coordinates. Windows captures the primary display, Linux the X11 root. Verify the target before acting.");
            let image = ImageContentPart { name: "desktop.png".into(), data_url: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) };
            (note, Some(vec![image]))
        }
        Ok(None) => ("Desktop input sent. Take another screenshot to verify the resulting state.".into(), None),
        Err(e) => (format!("ERROR: computer: {e}"), None),
    }
}

async fn output(mut cmd: tokio::process::Command) -> Result<std::process::Output, String> {
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await
        .map_err(|_| "desktop command timed out; input may have been partially sent".to_string())?
        .map_err(|e| format!("could not start desktop helper: {e}"))?;
    if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).chars().take(1500).collect()); }
    Ok(result)
}

#[cfg(target_os = "linux")]
fn linux_command(action: &Action, capture: &std::path::Path) -> (String, Vec<String>) {
    let mut args: Vec<String> = Vec::new();
    match action {
        Action::Screenshot => return ("import".into(), vec!["-window".into(), "root".into(), capture.to_string_lossy().into()]),
        Action::Move { x, y } => args.extend(["mousemove".into(), "--sync".into(), x.to_string(), y.to_string()]),
        Action::Click { x, y, button, count } => args.extend(["mousemove".into(), "--sync".into(), x.to_string(), y.to_string(), "click".into(), "--clearmodifiers".into(), "--repeat".into(), count.to_string(), "--delay".into(), "100".into(), match button.as_str() { "right" => "3", "middle" => "2", _ => "1" }.into()]),
        Action::Type { x, y, text, replace } => {
            args.extend(["mousemove".into(), "--sync".into(), x.to_string(), y.to_string(), "click".into(), "1".into()]);
            if *replace { args.extend(["key".into(), "--clearmodifiers".into(), "ctrl+a".into()]); }
            args.extend(["type".into(), "--clearmodifiers".into(), "--delay".into(), "0".into(), "--".into(), text.clone()]);
        }
        Action::Key { x, y, keys } => {
            let names: Vec<&str> = keys.iter().map(|k| match k.as_str() { "meta" => "super", "enter" => "Return", "escape" => "Escape", "backspace" => "BackSpace", "delete" => "Delete", "tab" => "Tab", "up" => "Up", "down" => "Down", "left" => "Left", "right" => "Right", "home" => "Home", "end" => "End", "pageup" => "Prior", "pagedown" => "Next", k => k }).collect();
            args.extend(["mousemove".into(), "--sync".into(), x.to_string(), y.to_string(), "click".into(), "1".into(), "key".into(), "--clearmodifiers".into(), names.join("+")]);
        }
        Action::Scroll { x, y, amount } => args.extend(["mousemove".into(), "--sync".into(), x.to_string(), y.to_string(), "click".into(), "1".into(), "click".into(), "--clearmodifiers".into(), "--repeat".into(), amount.unsigned_abs().to_string(), "--delay".into(), "20".into(), if *amount > 0 { "5" } else { "4" }.into()]),
    }
    ("xdotool".into(), args)
}

#[cfg(target_os = "linux")]
async fn perform(action: &Action) -> Result<Option<Vec<u8>>, String> {
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Err("Wayland desktop control is not supported yet. Use an X11 session; XWayland cannot control native Wayland apps.".into());
    }
    if std::env::var_os("DISPLAY").is_none() { return Err("no graphical X11 display is available".into()); }
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let capture = dir.path().join("desktop.png");
    let (program, args) = linux_command(action, &capture);
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    output(cmd).await.map_err(|e| format!("{e}. Linux requires xdotool for input and ImageMagick (import) for screenshots."))?;
    if matches!(action, Action::Screenshot) { Ok(Some(std::fs::read(capture).map_err(|e| e.to_string())?)) } else { Ok(None) }
}

#[cfg(windows)]
async fn perform(action: &Action) -> Result<Option<Vec<u8>>, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let capture = dir.path().join("desktop.png");
    let payload = match action {
        Action::Screenshot => json!({"action":"screenshot"}),
        Action::Move { x, y } => json!({"action":"move", "x":x, "y":y}),
        Action::Click { x, y, button, count } => json!({"action":"click", "x":x, "y":y, "button":button, "count":count}),
        Action::Type { x, y, text, replace } => json!({"action":"type", "x":x, "y":y, "text":text, "replace":replace}),
        Action::Key { x, y, keys } => json!({"action":"key", "x":x, "y":y, "keys":keys}),
        Action::Scroll { x, y, amount } => json!({"action":"scroll", "x":x, "y":y, "amount":amount}),
    };
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("computer_windows.ps1")])
        .env("FLINT_COMPUTER_INPUT", payload.to_string()).env("FLINT_COMPUTER_CAPTURE", &capture).creation_flags(0x0800_0000);
    output(cmd).await?;
    if matches!(action, Action::Screenshot) { Ok(Some(std::fs::read(capture).map_err(|e| e.to_string())?)) } else { Ok(None) }
}

#[cfg(target_os = "macos")]
#[path = "computer_macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
async fn perform(action: &Action) -> Result<Option<Vec<u8>>, String> { macos::perform(action).await }

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn perform(_: &Action) -> Result<Option<Vec<u8>>, String> { Err("desktop control is unavailable on this platform".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_refuses_unbounded_input_and_key_injection() {
        for args in [json!({"action":"type","text":"x".repeat(12001)}), json!({"action":"key","keys":["ctrl+a;exec"]}), json!({"action":"key","keys":["ctrl","ctrl"]}), json!({"action":"click","x":0.5,"y":2}), json!({"action":"click","x":1,"y":2,"count":3}), json!({"action":"scroll","amount":21})] { assert!(plan(&args).is_err(), "{args}"); }
        assert_eq!(plan(&json!({"action":"key","x":1,"y":2,"keys":["CTRL","a"]})), Ok(Action::Key { x:1, y:2, keys: vec!["ctrl".into(),"a".into()] }));
        assert!(plan(&json!({"action":"type","x":1,"y":2,"text":"Olá 🐧"})).is_ok());
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn text_is_an_argument_not_shell_code_and_scroll_direction_is_correct() {
        let text = "--window $(touch /tmp/never); 'Olá'";
        let (program, args) = linux_command(&Action::Type { x:1, y:2, text: text.into(), replace:true }, std::path::Path::new("unused"));
        assert_eq!(program, "xdotool");
        assert_eq!(&args[args.len()-2..], &["--", text]);
        assert!(args.windows(4).any(|a| a == ["key", "--clearmodifiers", "ctrl+a", "type"]));
        for (amount, button) in [(3,"5"),(-3,"4")] { let (_, args) = linux_command(&Action::Scroll { x:1, y:2, amount }, std::path::Path::new("unused")); assert_eq!(args.last().unwrap(), button); }
    }
}
