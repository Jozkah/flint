//! "Start with the computer": an opt-in entry in the operating system's own
//! per-user startup list that launches Flint when the user signs in.
//!
//! Off by default; turning it on is confirmed in the app, which first shows
//! the exact entry from [`status`]. Nothing here needs administrator rights.
//!
//! * Windows: a value in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//! * macOS: a LaunchAgent plist in `~/Library/LaunchAgents`.
//! * Linux: an XDG autostart `.desktop` file in `~/.config/autostart`.
//!
//! "Start minimized" is not a stored setting: it is the `--minimized` argument
//! inside the entry itself, so the app knows at launch, before any page loads.
//! What gets written is rendered by pure functions and the machine is touched
//! through [`Installer`], so tests use a fake and write nothing real.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::schedule::os_scheduler::{Installer, Platform, SystemInstaller};

/// The command line flag the startup entry adds.
pub const MINIMIZED_ARG: &str = "--minimized";
/// Windows registry value name.
pub const WINDOWS_VALUE: &str = "Flint";
pub const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// launchd label, also the plist file name.
pub const LAUNCHD_LABEL: &str = "ai.flint.autostart";
/// XDG autostart file name.
pub const DESKTOP_FILE: &str = "flint.desktop";

/// True when the process was started with the startup entry's `--minimized`.
pub fn launched_minimized<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| a.as_ref() == MINIMIZED_ARG)
}

fn quote(text: &str) -> String {
    if text.is_empty() || text.contains(|c: char| c.is_whitespace() || c == '"') {
        format!("\"{}\"", text.replace('"', "\\\""))
    } else {
        text.to_string()
    }
}

/// Quote one argument for a freedesktop `Exec=` line. Reserved characters force
/// double quotes; inside them `"`, `` ` ``, `$` and `\` take a backslash, and
/// because the `.desktop` string layer unescapes `\\` first, each of those
/// backslashes is doubled in the file. `%` is a field code, so it becomes `%%`.
/// A newline cannot be represented and is an error.
fn desktop_quote(text: &str) -> Result<String, String> {
    if text.contains(['\n', '\r']) {
        return Err("the app path contains a line break".to_string());
    }
    let text = text.replace('%', "%%");
    const RESERVED: &[char] = &[
        ' ', '\t', '"', '\'', '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')', '`',
    ];
    if text.is_empty() || text.contains(RESERVED) {
        let mut out = String::from("\"");
        for c in text.chars() {
            match c {
                '\\' => out.push_str("\\\\\\\\"),
                '"' | '`' | '$' => {
                    out.push_str("\\\\");
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        out.push('"');
        Ok(out)
    } else {
        Ok(text)
    }
}

fn desktop_command_line(exe: &Path, minimized: bool) -> Result<String, String> {
    let parts = command_parts(exe, minimized)
        .iter()
        .map(|p| desktop_quote(p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join(" "))
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The program and its arguments the entry runs.
pub fn command_parts(exe: &Path, minimized: bool) -> Vec<String> {
    let mut parts = vec![exe.to_string_lossy().to_string()];
    if minimized {
        parts.push(MINIMIZED_ARG.to_string());
    }
    parts
}

/// The command as one readable line (the registry value / Exec line).
pub fn command_line(exe: &Path, minimized: bool) -> String {
    command_parts(exe, minimized)
        .iter()
        .map(|p| quote(p))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn launchd_plist(exe: &Path, minimized: bool) -> String {
    let items: String = command_parts(exe, minimized)
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{items}  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
}

pub fn desktop_entry(exe: &Path, minimized: bool) -> Result<String, String> {
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Flint\nComment=Start Flint when you sign in\nExec={}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        desktop_command_line(exe, minimized)?
    ))
}

pub fn entry_path(platform: Platform, home: &Path) -> Option<PathBuf> {
    match platform {
        Platform::Windows => None,
        Platform::MacOs => Some(
            home.join("Library")
                .join("LaunchAgents")
                .join(format!("{LAUNCHD_LABEL}.plist")),
        ),
        Platform::Linux => Some(home.join(".config").join("autostart").join(DESKTOP_FILE)),
    }
}

/// The lines shown in the confirmation dialog: exactly what will be written.
pub fn preview(platform: Platform, exe: &Path, minimized: bool, home: &Path) -> Vec<String> {
    let cmd = if platform == Platform::Linux {
        desktop_command_line(exe, minimized).unwrap_or_else(|e| format!("({e})"))
    } else {
        command_line(exe, minimized)
    };
    let file = entry_path(platform, home)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    match platform {
        Platform::Windows => vec![
            format!("Registry key: {WINDOWS_RUN_KEY}"),
            format!("Value name: {WINDOWS_VALUE}"),
            format!("Value data: {cmd}"),
        ],
        Platform::MacOs => vec![format!("File: {file}"), format!("Runs at sign-in: {cmd}")],
        Platform::Linux => vec![format!("File: {file}"), format!("Exec: {cmd}")],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub platform: Platform,
    pub platform_label: &'static str,
    pub enabled: bool,
    /// Whether the entry (or the one a confirmation would write) starts hidden.
    pub minimized: bool,
    pub preview: Vec<String>,
    pub detail: Option<String>,
}

fn platform_label(platform: Platform) -> &'static str {
    match platform {
        Platform::Windows => "Windows startup (registry Run key)",
        Platform::MacOs => "macOS LaunchAgent",
        Platform::Linux => "XDG autostart entry",
    }
}

fn windows_query_args() -> Vec<String> {
    ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE]
        .map(String::from)
        .to_vec()
}

/// Whether an entry exists and whether it carries `--minimized`.
pub fn read_state(platform: Platform, home: &Path, installer: &dyn Installer) -> (bool, bool) {
    match platform {
        Platform::Windows => match installer.run("reg", &windows_query_args()) {
            Ok(out) => (true, out.contains(MINIMIZED_ARG)),
            Err(_) => (false, false),
        },
        _ => {
            let Some(path) = entry_path(platform, home) else {
                return (false, false);
            };
            if !installer.file_exists(&path) {
                return (false, false);
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            (true, text.contains(MINIMIZED_ARG))
        }
    }
}

pub fn status(
    platform: Platform,
    exe: &Path,
    minimized_if_enabled: bool,
    home: &Path,
    installer: &dyn Installer,
    detail: Option<String>,
) -> AutostartStatus {
    let (enabled, minimized) = read_state(platform, home, installer);
    let shown = if enabled {
        minimized
    } else {
        minimized_if_enabled
    };
    AutostartStatus {
        platform,
        platform_label: platform_label(platform),
        enabled,
        minimized: shown,
        preview: preview(platform, exe, shown, home),
        detail,
    }
}

pub fn enable(
    platform: Platform,
    exe: &Path,
    minimized: bool,
    home: &Path,
    installer: &dyn Installer,
) -> Result<(), String> {
    let cmd = command_line(exe, minimized);
    match platform {
        Platform::Windows => installer
            .run(
                "reg",
                &[
                    "add",
                    WINDOWS_RUN_KEY,
                    "/v",
                    WINDOWS_VALUE,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &cmd,
                    "/f",
                ]
                .map(String::from),
            )
            .map(|_| ()),
        Platform::MacOs => {
            let path = entry_path(platform, home).ok_or("no entry path")?;
            installer.write_file(&path, launchd_plist(exe, minimized).as_bytes())
        }
        Platform::Linux => {
            let path = entry_path(platform, home).ok_or("no entry path")?;
            installer.write_file(&path, desktop_entry(exe, minimized)?.as_bytes())
        }
    }
}

pub fn disable(platform: Platform, home: &Path, installer: &dyn Installer) -> Result<(), String> {
    match platform {
        Platform::Windows => {
            if installer.run("reg", &windows_query_args()).is_err() {
                return Ok(());
            }
            installer
                .run(
                    "reg",
                    &["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE, "/f"].map(String::from),
                )
                .map(|_| ())
        }
        _ => {
            let path = entry_path(platform, home).ok_or("no entry path")?;
            installer.remove_file(&path)
        }
    }
}

/// The path the startup entry should launch. Inside an AppImage `current_exe`
/// is the temporary mount, gone after exit; `$APPIMAGE` is the real file.
fn resolve_exe(
    appimage: Option<String>,
    current: PathBuf,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    match appimage {
        Some(p) if !p.is_empty() && exists(Path::new(&p)) => PathBuf::from(p),
        _ => current,
    }
}

fn context() -> Result<(PathBuf, PathBuf), String> {
    let current = std::env::current_exe().map_err(|e| format!("cannot find the app: {e}"))?;
    let exe = resolve_exe(std::env::var("APPIMAGE").ok(), current, |p| p.is_file());
    let home = dirs::home_dir().ok_or_else(|| "this user has no home folder".to_string())?;
    Ok((exe, home))
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Whether the startup entry exists, and what turning it on would write.
#[tauri::command]
pub async fn autostart_get(minimized: Option<bool>) -> Result<AutostartStatus, String> {
    let (exe, home) = context()?;
    blocking(move || {
        Ok(status(
            Platform::current(),
            &exe,
            minimized.unwrap_or(false),
            &home,
            &SystemInstaller,
            None,
        ))
    })
    .await
}

/// Write (`enabled`) or remove the entry. The page asks for confirmation
/// before turning it on; turning it off applies at once.
#[tauri::command]
pub async fn autostart_set(
    enabled: bool,
    minimized: Option<bool>,
) -> Result<AutostartStatus, String> {
    let (exe, home) = context()?;
    blocking(move || {
        let platform = Platform::current();
        let minimized = minimized.unwrap_or(false);
        let result = if enabled {
            enable(platform, &exe, minimized, &home, &SystemInstaller)
        } else {
            disable(platform, &home, &SystemInstaller)
        };
        Ok(status(
            platform,
            &exe,
            minimized,
            &home,
            &SystemInstaller,
            result.err(),
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        fail_query: bool,
    }

    impl Installer for Fake {
        fn write_file(&self, _p: &Path, _b: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn remove_file(&self, _p: &Path) -> Result<(), String> {
            Ok(())
        }
        fn file_exists(&self, _p: &Path) -> bool {
            false
        }
        fn run(&self, program: &str, args: &[String]) -> Result<String, String> {
            self.calls
                .borrow_mut()
                .push((program.to_string(), args.to_vec()));
            if args.first().map(String::as_str) == Some("query") && self.fail_query {
                return Err("not found".into());
            }
            Ok("Flint REG_SZ \"C:\\Flint\\flint.exe\" --minimized".into())
        }
    }

    #[test]
    fn minimized_flag_is_parsed_from_args() {
        assert!(launched_minimized(["flint.exe", "--minimized"]));
        assert!(!launched_minimized(["flint.exe"]));
        assert!(!launched_minimized(["flint.exe", "--minimized-ish"]));
    }

    #[test]
    fn command_line_quotes_paths_with_spaces_and_adds_the_flag() {
        let exe = Path::new(r"C:\Program Files\Flint\flint.exe");
        assert_eq!(
            command_line(exe, false),
            r#""C:\Program Files\Flint\flint.exe""#
        );
        assert_eq!(
            command_line(exe, true),
            r#""C:\Program Files\Flint\flint.exe" --minimized"#
        );
    }

    #[test]
    fn rendered_entries_carry_the_flag_only_when_asked() {
        let exe = Path::new("/opt/flint/flint");
        assert!(desktop_entry(exe, true)
            .unwrap()
            .contains("Exec=/opt/flint/flint --minimized"));
        assert!(!desktop_entry(exe, false).unwrap().contains(MINIMIZED_ARG));
        let plist = launchd_plist(exe, true);
        assert!(plist.contains("<string>--minimized</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn windows_enable_runs_one_reg_add_to_the_run_key() {
        let fake = Fake::default();
        enable(
            Platform::Windows,
            Path::new(r"C:\f\flint.exe"),
            true,
            Path::new("C:/h"),
            &fake,
        )
        .unwrap();
        let calls = fake.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "reg");
        assert!(calls[0].1.contains(&"add".to_string()));
        assert!(calls[0].1.contains(&WINDOWS_RUN_KEY.to_string()));
        assert!(calls[0].1.iter().any(|a| a.contains("--minimized")));
    }

    #[test]
    fn windows_disable_is_a_no_op_when_no_entry_exists() {
        let fake = Fake {
            fail_query: true,
            ..Default::default()
        };
        disable(Platform::Windows, Path::new("C:/h"), &fake).unwrap();
        assert_eq!(fake.calls.borrow().len(), 1);
    }

    #[test]
    fn preview_names_the_registry_key_on_windows_and_a_file_elsewhere() {
        let exe = Path::new("/x/flint");
        let win = preview(Platform::Windows, exe, false, Path::new("/h"));
        assert!(win[0].contains(WINDOWS_RUN_KEY));
        let linux = preview(Platform::Linux, exe, false, Path::new("/h"));
        assert!(linux[0].contains("autostart"));
    }

    #[test]
    fn desktop_quote_follows_the_desktop_entry_spec() {
        assert_eq!(
            desktop_quote("/opt/flint/flint").unwrap(),
            "/opt/flint/flint"
        );
        assert_eq!(desktop_quote("/opt/my app/f").unwrap(), "\"/opt/my app/f\"");
        assert_eq!(desktop_quote("/a/$HOME/f").unwrap(), "\"/a/\\\\$HOME/f\"");
        assert_eq!(desktop_quote("/a/`x`").unwrap(), "\"/a/\\\\`x\\\\`\"");
        assert_eq!(desktop_quote("/a/\"q\"").unwrap(), "\"/a/\\\\\"q\\\\\"\"");
        assert_eq!(desktop_quote("/a\\b c").unwrap(), "\"/a\\\\\\\\b c\"");
        assert_eq!(desktop_quote("/a/100%/f").unwrap(), "/a/100%%/f");
        assert!(desktop_quote("/a/\nb").is_err());
        assert!(desktop_entry(Path::new("/a/\nb"), false).is_err());
    }

    #[test]
    fn linux_enable_refuses_a_path_with_a_newline() {
        let fake = Fake::default();
        let r = enable(
            Platform::Linux,
            Path::new("/a/\nb"),
            false,
            Path::new("/h"),
            &fake,
        );
        assert!(r.is_err());
    }

    #[test]
    fn appimage_env_wins_only_when_the_file_exists() {
        let cur = PathBuf::from("/tmp/.mount_x/usr/bin/flint");
        let img = "/home/u/Flint.AppImage".to_string();
        assert_eq!(
            resolve_exe(Some(img.clone()), cur.clone(), |_| true),
            PathBuf::from(&img)
        );
        assert_eq!(resolve_exe(Some(img.clone()), cur.clone(), |_| false), cur);
        assert_eq!(resolve_exe(None, cur.clone(), |_| true), cur);
        assert_eq!(resolve_exe(Some(String::new()), cur.clone(), |_| true), cur);
    }
}
