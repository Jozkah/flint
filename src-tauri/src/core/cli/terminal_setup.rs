//! `/terminal-setup`: make the composer's modified keys reachable on terminals
//! that do not deliver them out of the box.
//!
//! Two separate problems, both terminal-side:
//!
//! - **`Shift+Enter`.** Legacy encoding has no room for a modifier on `Enter` --
//!   it sends a bare `\r` that is byte-identical to a plain `Enter` -- so the
//!   keystroke only arrives when the terminal opts into a protocol that carries
//!   modifiers. Where it does not, the fix is a terminal-side binding that sends
//!   `ESC` + `\r`: crossterm reports any `ESC`-prefixed legacy byte as that key
//!   plus `ALT`, so it lands on the composer's existing `Alt+Enter` newline arm
//!   with no decoding on our side.
//! - **`Option` on macOS.** By default several terminals treat `Option` as an
//!   accent-composition modifier rather than `Alt`, so `Option+Delete` arrives
//!   as a bare `DEL` and deletes one character instead of a word. kitty and
//!   Ghostty both ship with it off.
//!
//! The terminal is identified once ([`identify`]); the two questions are then
//! separate tables over that identity, because the answers differ per terminal.
//! Nothing here depends on a TTY, so detection and the file rewrites are
//! testable in isolation; only [`apply`] touches the filesystem.

use std::path::{Path, PathBuf};

/// Which terminal this is, as far as the environment says. Identity only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Kitty,
    Ghostty,
    WezTerm,
    Foot,
    Rio,
    Konsole,
    ITerm2,
    AppleTerminal,
    VsCode,
    WindowsTerminal,
    Alacritty,
    /// gnome-terminal, Tilix, Terminator: anything on VTE.
    Vte,
    Unknown,
}

/// Whether `Shift+Enter` can reach us, and what it would take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShiftEnter {
    /// Already arrives: the terminal reports modifiers.
    Works(&'static str),
    /// No protocol support, but `keybindings.json` can send an arbitrary
    /// sequence to the integrated terminal.
    VsCodeBinding,
    /// No protocol support, but `alacritty.toml` can bind the key; the file is
    /// TOML, so it is edited structurally rather than appended to.
    AlacrittyBinding,
    /// Configurable, but not by us. Carries the steps.
    Manual(&'static str, &'static [&'static str]),
    /// No per-key sequence configuration exists at all.
    Hopeless(&'static str, &'static [&'static str]),
    Unknown,
}

/// Where a terminal keeps its "treat `Option` as `Alt`" setting on macOS.
/// Irrelevant anywhere else, since `Option` has no meaning off macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionAsAlt {
    /// A plain-text config we can append a line to.
    Config {
        /// The setting name, for detecting that it is already set.
        key: &'static str,
        line: &'static str,
        /// Candidate paths relative to `$HOME`, most conventional first.
        files: &'static [&'static str],
    },
    /// `window.option_as_alt` in `alacritty.toml`, set by a structural edit
    /// because a blind append would land in whichever section came last.
    AlacrittyToml,
    /// Reachable only through the app's own settings. Carries the step verbatim.
    ByHand(&'static str),
    /// `Option` already arrives as `ALT`, or the platform has no `Option` key.
    NotNeeded,
}

/// What `/terminal-setup` did or could not do. One outcome per thing that
/// needed attention: a session inside tmux inside VS Code needs both halves.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do: the keystroke already reaches us.
    Works(String),
    Wrote {
        path: PathBuf,
        detail: String,
    },
    AlreadyDone(PathBuf),
    /// We will not rewrite this file, but the user can. Carries the exact steps.
    Manual {
        title: String,
        steps: Vec<String>,
    },
    Failed {
        path: PathBuf,
        error: String,
    },
}

/// The sequence a terminal must send for `Shift+Enter`: `ESC` then carriage
/// return, which crossterm decodes as `Enter` with `ALT`.
pub const NEWLINE_SEQUENCE: &str = "\\u001b\\r";

/// [`NEWLINE_SEQUENCE`] as the characters themselves, for a TOML string value.
const NEWLINE_CHARS: &str = "\u{1b}\r";

/// Identify the host terminal from the environment. `get` is injected so the
/// mapping can be tested without touching the process environment.
pub fn identify(get: impl Fn(&str) -> Option<String>) -> Kind {
    let var = |k: &str| get(k).filter(|v| !v.is_empty());
    let term = var("TERM").unwrap_or_default();

    // `TERM_PROGRAM` is the most specific signal when it is set at all.
    match var("TERM_PROGRAM").unwrap_or_default().as_str() {
        "vscode" => return Kind::VsCode,
        "iTerm.app" => return Kind::ITerm2,
        "Apple_Terminal" => return Kind::AppleTerminal,
        "WezTerm" => return Kind::WezTerm,
        "ghostty" => return Kind::Ghostty,
        "rio" => return Kind::Rio,
        _ => {}
    }

    if var("KITTY_WINDOW_ID").is_some() || term.contains("kitty") {
        return Kind::Kitty;
    }
    if var("GHOSTTY_RESOURCES_DIR").is_some() {
        return Kind::Ghostty;
    }
    if var("WEZTERM_PANE").is_some() {
        return Kind::WezTerm;
    }
    if var("WT_SESSION").is_some() {
        return Kind::WindowsTerminal;
    }
    if var("KONSOLE_VERSION").is_some() {
        return Kind::Konsole;
    }
    if term.starts_with("foot") {
        return Kind::Foot;
    }
    if var("ALACRITTY_WINDOW_ID").is_some() || term.starts_with("alacritty") {
        return Kind::Alacritty;
    }
    if var("VTE_VERSION").is_some() {
        return Kind::Vte;
    }
    Kind::Unknown
}

const APPLE_TERMINAL_STEPS: &[&str] = &[
    "Shift+Enter cannot be delivered at all: use Option+Enter or Ctrl-J for a newline",
    "Settings > Profiles > Keyboard: tick 'Use Option as Meta key', which also makes Option+Delete delete a word (at the cost of Option-composed characters)",
    "or switch to kitty, Ghostty, WezTerm or iTerm2 3.5+",
];

const VTE_STEPS: &[&str] = &[
    "Alt+Enter and Ctrl-J insert a newline; Alt+Backspace and Ctrl-W already delete a word",
    "or switch to kitty, Ghostty, WezTerm or foot",
];

/// What to do by hand when `alacritty.toml` cannot be edited for us.
const ALACRITTY_STEPS: &[&str] = &[
    "Alacritty 0.14 and later need nothing; check with `alacritty --version`",
    "otherwise add under [[keyboard.bindings]] in alacritty.toml: key = \"Return\", mods = \"Shift\", chars = \"\\u001B\\r\"",
];

/// Whether `Shift+Enter` reaches us on this terminal.
pub fn shift_enter(kind: Kind) -> ShiftEnter {
    match kind {
        Kind::Kitty => ShiftEnter::Works("kitty"),
        Kind::Ghostty => ShiftEnter::Works("Ghostty"),
        Kind::WezTerm => ShiftEnter::Works("WezTerm"),
        Kind::Foot => ShiftEnter::Works("foot"),
        Kind::Rio => ShiftEnter::Works("Rio"),
        Kind::Konsole => ShiftEnter::Works("Konsole 24+"),
        // iTerm2 has spoken the protocol since 3.5, and the version is not in
        // the environment; an older build falls back to Alt+Enter.
        Kind::ITerm2 => ShiftEnter::Works("iTerm2 3.5+"),
        Kind::WindowsTerminal => ShiftEnter::Works("Windows Terminal"),
        Kind::VsCode => ShiftEnter::VsCodeBinding,
        Kind::Alacritty => ShiftEnter::AlacrittyBinding,
        Kind::AppleTerminal => ShiftEnter::Hopeless(
            "Terminal.app has no per-key sequence setting and no CSI-u support",
            APPLE_TERMINAL_STEPS,
        ),
        Kind::Vte => ShiftEnter::Hopeless(
            "VTE terminals (gnome-terminal, Tilix) cannot rebind keys",
            VTE_STEPS,
        ),
        Kind::Unknown => ShiftEnter::Unknown,
    }
}

/// Whether `Option` arrives as `ALT` on macOS, and where to change it.
///
/// Only the terminals whose setting is documented are named. kitty and Ghostty
/// keep theirs in a plain-text config, so those can be written; Alacritty's
/// lives inside a TOML table, so it is set through a TOML editor instead.
pub fn option_as_alt(kind: Kind) -> OptionAsAlt {
    match kind {
        Kind::Kitty => OptionAsAlt::Config {
            key: "macos_option_as_alt",
            line: "macos_option_as_alt yes",
            files: &[".config/kitty/kitty.conf"],
        },
        Kind::Ghostty => OptionAsAlt::Config {
            key: "macos-option-as-alt",
            line: "macos-option-as-alt = true",
            files: &[
                "Library/Application Support/com.mitchellh.ghostty/config",
                ".config/ghostty/config",
            ],
        },
        Kind::AppleTerminal => {
            OptionAsAlt::ByHand("Settings > Profiles > Keyboard: tick 'Use Option as Meta key'")
        }
        Kind::ITerm2 => OptionAsAlt::ByHand(
            "Settings > Profiles > Keys: set the Left Option key to 'Esc+' (Option+Delete works without this; Option+B and Option+F do not)",
        ),
        Kind::VsCode => {
            OptionAsAlt::ByHand("settings.json: set \"terminal.integrated.macOptionIsMeta\": true")
        }
        Kind::Alacritty => OptionAsAlt::AlacrittyToml,
        _ => OptionAsAlt::NotNeeded,
    }
}

/// True when this session is inside tmux, which swallows the protocol unless
/// `extended-keys` is on -- independent of which terminal is outside it.
pub fn in_tmux(get: impl Fn(&str) -> Option<String>) -> bool {
    get("TMUX").is_some_and(|v| !v.is_empty())
}

/// The VS Code-family `keybindings.json` locations, most conventional first.
/// A fork keeps VS Code's layout under its own application-support directory,
/// so the flavour is whichever one exists.
fn vscode_keybinding_paths(home: &Path, appdata: Option<&Path>) -> Vec<PathBuf> {
    const FLAVOURS: [&str; 5] = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = appdata {
        roots.extend(FLAVOURS.iter().map(|f| appdata.join(f)));
    }
    let mac: Vec<PathBuf> = FLAVOURS
        .iter()
        .map(|f| home.join("Library/Application Support").join(f))
        .collect();
    let xdg: Vec<PathBuf> = FLAVOURS.iter().map(|f| home.join(".config").join(f)).collect();
    // Without %APPDATA% the first guess is this OS's own layout, so a fresh
    // Linux setup does not default to a macOS path.
    if cfg!(target_os = "macos") {
        roots.extend(mac);
        roots.extend(xdg);
    } else {
        roots.extend(xdg);
        roots.extend(mac);
    }
    roots
        .into_iter()
        .map(|r| r.join("User/keybindings.json"))
        .collect()
}

/// The first candidate that exists, or the first candidate when none do.
fn preferred_path(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|p| p.exists())
        .or_else(|| candidates.first())
        .cloned()
        .unwrap_or_default()
}

/// The VS Code-family file to edit: an existing `keybindings.json`, else the
/// first flavour whose `User` directory exists (so an editor that is installed
/// but has no keybindings yet is not skipped), else the first candidate.
fn preferred_vscode_path(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|p| p.exists())
        .or_else(|| candidates.iter().find(|p| p.parent().is_some_and(|d| d.exists())))
        .or_else(|| candidates.first())
        .cloned()
        .unwrap_or_default()
}

/// The VS Code-family editor whose integrated terminal this is, from the
/// environment it hands its shell. Every fork sets `TERM_PROGRAM=vscode`, so
/// the flavour comes from the editor's own executable path (the git askpass
/// helper) or a fork-only variable. `None` when it cannot be told.
fn running_vscode_flavour(get: &impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    if get("CURSOR_TRACE_ID").is_some_and(|v| !v.is_empty()) {
        return Some("Cursor");
    }
    let exe = get("VSCODE_GIT_ASKPASS_NODE")?.to_ascii_lowercase();
    if exe.contains("cursor") {
        Some("Cursor")
    } else if exe.contains("codium") {
        Some("VSCodium")
    } else if exe.contains("windsurf") {
        Some("Windsurf")
    } else if exe.contains("insiders") {
        Some("Code - Insiders")
    } else if exe.contains("code") {
        Some("Code")
    } else {
        None
    }
}

/// `preferred_vscode_path`, but the editor this terminal runs in wins when its
/// `User` directory exists: a Cursor user who also has VS Code installed must
/// not get the binding written to VS Code's file.
fn preferred_vscode_path_for(
    candidates: &[PathBuf],
    get: &impl Fn(&str) -> Option<String>,
) -> PathBuf {
    if let Some(flavour) = running_vscode_flavour(get) {
        let own: Vec<PathBuf> = candidates
            .iter()
            .filter(|p| {
                // `<root>/<flavour>/User/keybindings.json`
                p.parent()
                    .and_then(Path::parent)
                    .and_then(Path::file_name)
                    .is_some_and(|n| n == flavour)
            })
            .cloned()
            .collect();
        if own.iter().any(|p| p.parent().is_some_and(|d| d.exists())) {
            return preferred_vscode_path(&own);
        }
    }
    preferred_vscode_path(candidates)
}

/// The binding VS Code needs, as the JSON object we append.
fn vscode_entry() -> serde_json::Value {
    serde_json::json!({
        "key": "shift+enter",
        "command": "workbench.action.terminal.sendSequence",
        "args": { "text": "\u{1b}\r" },
        "when": "terminalFocus"
    })
}

/// True when `entries` already binds `shift+enter` to a sequence, whoever wrote
/// it: re-adding one would leave two rules fighting over the same key.
fn binds_shift_enter(entries: &[serde_json::Value]) -> bool {
    entries.iter().any(|e| {
        e.get("key").and_then(|k| k.as_str()) == Some("shift+enter")
            && e.get("command").and_then(|c| c.as_str())
                == Some("workbench.action.terminal.sendSequence")
    })
}

/// Add the binding to a VS Code `keybindings.json`, returning the file's new
/// contents. `None` means the file is already bound.
///
/// The file is JSON with comments, which no strict parser will read. Rather
/// than risk dropping a user's comments we only rewrite what parses as a plain
/// array; anything else is reported as a manual step instead.
fn add_vscode_binding(current: &str) -> Result<Option<String>, String> {
    let trimmed = current.trim();
    let mut entries: Vec<serde_json::Value> = if trimmed.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(trimmed)
            .map_err(|e| format!("{e} (comments or trailing commas must be edited by hand)"))?
    };
    if binds_shift_enter(&entries) {
        return Ok(None);
    }
    entries.push(vscode_entry());
    let mut out = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(Some(out))
}

/// True when `key` is set in a line-oriented config. A commented-out setting is
/// not a setting, which is exactly how a user parks one they are not using.
fn setting_present(current: &str, key: &str) -> bool {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    current.lines().any(|line| {
        // A `#` that starts the line or follows whitespace begins a comment.
        let mut code = line;
        if let Some(at) = line.char_indices().find_map(|(i, c)| {
            (c == '#' && line[..i].chars().last().is_none_or(char::is_whitespace)).then_some(i)
        }) {
            code = &line[..at];
        }
        // The key as a whole token, so `terminal-features-x` or a longer name
        // that merely contains it does not count as the setting being present.
        code.match_indices(key).any(|(i, _)| {
            let before = code[..i].chars().last();
            let after = code[i + key.len()..].chars().next();
            !before.is_some_and(word) && !after.is_some_and(word)
        })
    })
}

/// Append the line for each `(key, line)` whose key is not already set, under
/// one explanatory header. `None` when they are all present.
fn append_missing_settings(current: &str, settings: &[(&str, &str)]) -> Option<String> {
    let missing: Vec<&str> = settings
        .iter()
        .filter(|(key, _)| !setting_present(current, key))
        .map(|(_, line)| *line)
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = current.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("\n# jan: deliver modified keys (Shift+Enter, Option+Delete)\n");
    for line in missing {
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

/// The tmux settings that let extended keys through. `extended-keys` is what
/// makes tmux ask the outer terminal for them; the terminal-features line is
/// what makes it believe the outer terminal can supply them.
const TMUX_SETTINGS: [(&str, &str); 2] = [
    ("extended-keys", "set -s extended-keys on"),
    (
        "terminal-features",
        "set -as terminal-features 'xterm*:extkeys'",
    ),
];

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    // Write through a symlinked dotfile (e.g. one managed by a dotfiles repo)
    // instead of replacing the link with a plain file.
    let resolved = std::fs::canonicalize(path).ok();
    let path = resolved.as_deref().unwrap_or(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    // The whole name plus a suffix: `with_extension` would turn `.tmux.conf`
    // and `tmux.conf` into the same staging file.
    let mut staging = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    staging.push(".jan-tmp");
    let tmp = path.with_file_name(staging);
    std::fs::write(&tmp, contents).map_err(|e| format!("{}: {e}", tmp.display()))?;
    // The user's mode (a 0600 config, say) survives the replacement.
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/// Read a config file; a missing file is empty, any other error is reported so
/// an unreadable config is never overwritten with only our additions.
fn read_config(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Apply `settings` to a line-oriented config at `path`.
fn configure_lines(path: PathBuf, settings: &[(&str, &str)], detail: &str) -> Outcome {
    let current = match read_config(&path) {
        Ok(s) => s,
        Err(error) => return Outcome::Failed { path, error },
    };
    match append_missing_settings(&current, settings) {
        None => Outcome::AlreadyDone(path),
        Some(next) => match write_atomic(&path, &next) {
            Ok(()) => Outcome::Wrote {
                path,
                detail: detail.to_string(),
            },
            Err(error) => Outcome::Failed { path, error },
        },
    }
}

/// Where Alacritty looks for `alacritty.toml`, most conventional first. The
/// first that exists is edited; with none, the first is created.
fn alacritty_config_paths(
    home: &Path,
    appdata: Option<&Path>,
    get: &impl Fn(&str) -> Option<String>,
) -> Vec<PathBuf> {
    let xdg = get("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let mut paths = Vec::new();
    if let Some(appdata) = appdata {
        paths.push(appdata.join("alacritty/alacritty.toml"));
    }
    paths.push(xdg.join("alacritty/alacritty.toml"));
    paths.push(xdg.join("alacritty.toml"));
    paths.push(home.join(".config/alacritty/alacritty.toml"));
    paths.push(home.join(".alacritty.toml"));
    paths
}

/// True when `[[keyboard.bindings]]` already binds `Shift+Return`, whatever it
/// sends: a second rule on the same key would leave two fighting over it.
fn alacritty_binds_shift_enter(doc: &toml_edit::DocumentMut) -> bool {
    fn is_shift_enter(t: &dyn toml_edit::TableLike) -> bool {
        let is = |name: &str, want: &[&str]| {
            t.get(name)
                .and_then(|v| v.as_str())
                .is_some_and(|v| want.iter().any(|w| v.eq_ignore_ascii_case(w)))
        };
        is("key", &["Return", "Enter"]) && is("mods", &["Shift"])
    }
    let Some(bindings) = doc
        .get("keyboard")
        .and_then(|k| k.as_table_like())
        .and_then(|k| k.get("bindings"))
    else {
        return false;
    };
    if let Some(tables) = bindings.as_array_of_tables() {
        tables.iter().any(|t| is_shift_enter(t))
    } else if let Some(array) = bindings.as_array() {
        array
            .iter()
            .any(|v| v.as_inline_table().is_some_and(|t| is_shift_enter(t)))
    } else {
        false
    }
}

/// An implicit (header-less) empty table for `name`, unless one is there.
fn ensure_table(doc: &mut toml_edit::DocumentMut, name: &str) {
    if doc.get(name).is_none() {
        let mut table = toml_edit::Table::new();
        table.set_implicit(true);
        doc[name] = toml_edit::Item::Table(table);
    }
}

/// Add the `Shift+Enter` binding and/or `window.option_as_alt` to an
/// `alacritty.toml`, returning its new contents. `None` means everything asked
/// for is already there. Comments and layout are kept (`toml_edit`); a file
/// that does not parse, or has these keys of an unexpected shape, is an error
/// so it is reported as a manual step rather than rewritten.
fn edit_alacritty(current: &str, binding: bool, option_alt: bool) -> Result<Option<String>, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};
    let mut doc: DocumentMut = current.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let mut changed = false;

    if binding && !alacritty_binds_shift_enter(&doc) {
        let mut entry = Table::new();
        entry["key"] = value("Return");
        entry["mods"] = value("Shift");
        entry["chars"] = value(NEWLINE_CHARS);
        ensure_table(&mut doc, "keyboard");
        let keyboard = doc["keyboard"]
            .as_table_like_mut()
            .ok_or("[keyboard] is not a table")?;
        if !keyboard.contains_key("bindings") {
            keyboard.insert("bindings", Item::ArrayOfTables(ArrayOfTables::new()));
        }
        let bindings = keyboard.get_mut("bindings").ok_or("keyboard.bindings vanished")?;
        if let Some(tables) = bindings.as_array_of_tables_mut() {
            tables.push(entry);
        } else if let Some(array) = bindings.as_array_mut() {
            array.push(entry.into_inline_table());
        } else {
            return Err("keyboard.bindings is not a list".to_string());
        }
        changed = true;
    }

    if option_alt {
        let already = match doc.get("window") {
            None => false,
            Some(w) => w
                .as_table_like()
                .ok_or("[window] is not a table")?
                .contains_key("option_as_alt"),
        };
        if !already {
            ensure_table(&mut doc, "window");
            let window = doc["window"].as_table_like_mut().ok_or("[window] is not a table")?;
            window.insert("option_as_alt", value("Both"));
            changed = true;
        }
    }

    Ok(changed.then(|| doc.to_string()))
}

fn configure_alacritty(
    home: &Path,
    appdata: Option<&Path>,
    get: &impl Fn(&str) -> Option<String>,
    binding: bool,
    option_alt: bool,
) -> Outcome {
    let path = preferred_path(&alacritty_config_paths(home, appdata, get));
    let current = match read_config(&path) {
        Ok(s) => s,
        Err(error) => return Outcome::Failed { path, error },
    };
    match edit_alacritty(&current, binding, option_alt) {
        Ok(None) => Outcome::AlreadyDone(path),
        Ok(Some(next)) => match write_atomic(&path, &next) {
            Ok(()) => Outcome::Wrote {
                path,
                detail: "Shift+Enter now sends ESC+CR and Option arrives as Alt (restart Alacritty if it does not reload)".to_string(),
            },
            Err(error) => Outcome::Failed { path, error },
        },
        Err(error) => Outcome::Manual {
            title: format!("{} could not be edited: {error}", path.display()),
            steps: ALACRITTY_STEPS.iter().map(|s| s.to_string()).collect(),
        },
    }
}

fn configure_vscode(
    home: &Path,
    appdata: Option<&Path>,
    get: &impl Fn(&str) -> Option<String>,
) -> Outcome {
    let path = preferred_vscode_path_for(&vscode_keybinding_paths(home, appdata), get);
    let current = match read_config(&path) {
        Ok(s) => s,
        Err(error) => return Outcome::Failed { path, error },
    };
    match add_vscode_binding(&current) {
        Ok(None) => Outcome::AlreadyDone(path),
        Ok(Some(next)) => match write_atomic(&path, &next) {
            Ok(()) => Outcome::Wrote {
                path,
                detail: "shift+enter now sends ESC+CR to the integrated terminal".to_string(),
            },
            Err(error) => Outcome::Failed { path, error },
        },
        Err(error) => Outcome::Manual {
            title: format!("{} could not be parsed: {error}", path.display()),
            steps: vec![
                "open it with 'Preferences: Open Keyboard Shortcuts (JSON)'".to_string(),
                format!(
                    "add this entry: {}",
                    serde_json::to_string(&vscode_entry()).unwrap_or_default()
                ),
            ],
        },
    }
}

fn tmux_conf(home: &Path, get: &impl Fn(&str) -> Option<String>) -> PathBuf {
    let xdg = get("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let xdg_conf = xdg.join("tmux/tmux.conf");
    if xdg_conf.exists() {
        xdg_conf
    } else {
        home.join(".tmux.conf")
    }
}

/// The config file that owns the Option-as-Alt setting, with its setting pair,
/// when it is one we can write.
fn option_as_alt_file(home: &Path, kind: Kind) -> Option<(PathBuf, &'static str, &'static str)> {
    match option_as_alt(kind) {
        OptionAsAlt::Config { key, line, files } => {
            let candidates: Vec<PathBuf> = files.iter().map(|f| home.join(f)).collect();
            Some((preferred_path(&candidates), key, line))
        }
        _ => None,
    }
}

/// Run the setup, returning one outcome per thing that needed attention.
/// `macos` gates the `Option` half, which has no meaning on other platforms.
pub fn apply(home: &Path, macos: bool, get: impl Fn(&str) -> Option<String>) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    let appdata = get("APPDATA").filter(|v| !v.is_empty()).map(PathBuf::from);
    let kind = identify(&get);

    let mut alacritty_binding = false;
    let mut alacritty_alt = false;
    match shift_enter(kind) {
        ShiftEnter::Works(name) => outcomes.push(Outcome::Works(format!(
            "Shift+Enter already works -- {name} reports modifiers"
        ))),
        ShiftEnter::VsCodeBinding => outcomes.push(configure_vscode(home, appdata.as_deref(), &get)),
        // One file holds both Alacritty halves, so it is written once below.
        ShiftEnter::AlacrittyBinding => alacritty_binding = true,
        ShiftEnter::Manual(name, steps) => outcomes.push(Outcome::Manual {
            title: format!("{name} needs one line of config for Shift+Enter"),
            steps: steps.iter().map(|s| s.to_string()).collect(),
        }),
        ShiftEnter::Hopeless(why, steps) => outcomes.push(Outcome::Manual {
            title: format!("Shift+Enter cannot be fixed here: {why}"),
            steps: steps.iter().map(|s| s.to_string()).collect(),
        }),
        ShiftEnter::Unknown => outcomes.push(Outcome::Manual {
            title: "could not tell which terminal this is".to_string(),
            steps: vec![
                "if Shift+Enter already inserts a newline, nothing is needed".to_string(),
                format!("otherwise bind Shift+Enter to send {NEWLINE_SEQUENCE}"),
                "Alt+Enter and Ctrl-J always work".to_string(),
            ],
        }),
    }

    // The Option key is a separate question: kitty and Ghostty report modifiers
    // for Shift+Enter and still swallow Option+Delete.
    if macos {
        match option_as_alt(kind) {
            OptionAsAlt::Config { .. } => {
                if let Some((path, key, line)) = option_as_alt_file(home, kind) {
                    outcomes.push(configure_lines(
                        path,
                        &[(key, line)],
                        "Option+Delete now deletes a word (Option-composed characters stop working)",
                    ));
                }
            }
            OptionAsAlt::AlacrittyToml => alacritty_alt = true,
            OptionAsAlt::ByHand(step) => outcomes.push(Outcome::Manual {
                title: "Option+Delete needs Option delivered as Alt".to_string(),
                steps: vec![step.to_string()],
            }),
            OptionAsAlt::NotNeeded => {}
        }
    }

    if alacritty_binding || alacritty_alt {
        outcomes.push(configure_alacritty(
            home,
            appdata.as_deref(),
            &get,
            alacritty_binding,
            alacritty_alt,
        ));
    }

    if in_tmux(&get) {
        outcomes.push(configure_lines(
            tmux_conf(home, &get),
            &TMUX_SETTINGS,
            "run `tmux source-file` on it, or restart tmux, to load it",
        ));
    }
    outcomes
}

/// A one-line nudge for the opening notes, or `None` when there is nothing to
/// say. Deliberately limited to checks backed by a file we can read: a hint we
/// cannot see the user act on would print on every launch, and a nag is worse
/// than a missing hint. `/terminal-setup` itself reports the rest.
pub fn setup_hint(
    home: &Path,
    macos: bool,
    get: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let unset = |path: &Path, key: &str| {
        !setting_present(&std::fs::read_to_string(path).unwrap_or_default(), key)
    };
    let kind = identify(&get);

    if macos {
        if let Some((path, key, _)) = option_as_alt_file(home, kind) {
            if unset(&path, key) {
                return Some(format!(
                    "Option+Delete deletes one character here ({key} is unset) -- run /terminal-setup"
                ));
            }
        }
    }

    if matches!(shift_enter(kind), ShiftEnter::VsCodeBinding) {
        let path = preferred_vscode_path_for(
            &vscode_keybinding_paths(
                home,
                get("APPDATA")
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
                    .as_deref(),
            ),
            &get,
        );
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        // The file is JSONC in practice (comments, trailing commas): a parse
        // failure means "unknown", and an unknown state earns no nag.
        let bound = match text.trim() {
            "" => false,
            t => serde_json::from_str::<Vec<serde_json::Value>>(t)
                .map(|e| binds_shift_enter(&e))
                .unwrap_or(true),
        };
        if !bound {
            return Some(
                "Shift+Enter is not bound in this terminal -- run /terminal-setup".to_string(),
            );
        }
    }

    if in_tmux(&get) && unset(&tmux_conf(home, &get), "extended-keys") {
        return Some("tmux is dropping modified keys -- run /terminal-setup".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(name, _)| *name == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn identifies_protocol_capable_terminals_as_needing_nothing() {
        for (pairs, expect) in [
            (vec![("TERM", "xterm-kitty")], Kind::Kitty),
            (vec![("KITTY_WINDOW_ID", "1")], Kind::Kitty),
            (vec![("TERM_PROGRAM", "ghostty")], Kind::Ghostty),
            (
                vec![("GHOSTTY_RESOURCES_DIR", "/usr/share/ghostty")],
                Kind::Ghostty,
            ),
            (vec![("TERM_PROGRAM", "WezTerm")], Kind::WezTerm),
            (vec![("WEZTERM_PANE", "0")], Kind::WezTerm),
            (vec![("TERM_PROGRAM", "iTerm.app")], Kind::ITerm2),
            (vec![("TERM", "foot-extra")], Kind::Foot),
            (vec![("KONSOLE_VERSION", "240800")], Kind::Konsole),
            (vec![("WT_SESSION", "abc")], Kind::WindowsTerminal),
        ] {
            assert_eq!(identify(env(&pairs)), expect, "{pairs:?}");
            assert!(
                matches!(shift_enter(expect), ShiftEnter::Works(_)),
                "{expect:?} should need no Shift+Enter setup"
            );
        }
    }

    #[test]
    fn identifies_the_terminals_that_need_help() {
        assert_eq!(identify(env(&[("TERM_PROGRAM", "vscode")])), Kind::VsCode);
        assert_eq!(
            shift_enter(Kind::VsCode),
            ShiftEnter::VsCodeBinding,
            "VS Code takes a binding"
        );
        assert!(matches!(
            shift_enter(identify(env(&[("TERM_PROGRAM", "Apple_Terminal")]))),
            ShiftEnter::Hopeless(..)
        ));
        assert!(matches!(
            shift_enter(identify(env(&[("VTE_VERSION", "7600")]))),
            ShiftEnter::Hopeless(..)
        ));
        assert!(matches!(
            shift_enter(identify(env(&[("TERM", "alacritty")]))),
            ShiftEnter::AlacrittyBinding
        ));
        assert_eq!(
            shift_enter(identify(env(&[("TERM", "xterm-256color")]))),
            ShiftEnter::Unknown
        );
    }

    /// An empty variable is not a signal: exported-but-unset is common in
    /// login shells and would otherwise misclassify the terminal.
    #[test]
    fn empty_variables_are_ignored() {
        assert_eq!(
            identify(env(&[("TERM_PROGRAM", ""), ("KITTY_WINDOW_ID", "")])),
            Kind::Unknown
        );
        assert!(!in_tmux(env(&[("TMUX", "")])));
        assert!(in_tmux(env(&[("TMUX", "/tmp/tmux-1000/default,123,0")])));
    }

    /// Terminal.app cannot deliver `Shift+Enter`, but its `Option` key is still
    /// fixable, so the dead end has to stay actionable.
    #[test]
    fn the_dead_end_still_names_the_option_key_fix() {
        let ShiftEnter::Hopeless(_, steps) = shift_enter(Kind::AppleTerminal) else {
            panic!("Terminal.app cannot do Shift+Enter");
        };
        let joined = steps.join(" ");
        assert!(joined.contains("Use Option as Meta key"), "{joined}");
        assert!(joined.contains("Option+Delete"), "{joined}");
        assert!(
            joined.contains("Ctrl-J"),
            "the universal fallback must be named: {joined}"
        );
    }

    /// The two questions are independent: a terminal can report modifiers and
    /// still swallow `Option`. kitty and Ghostty are exactly that case, which is
    /// why word deletion appears broken on macOS in terminals that do everything
    /// else right.
    #[test]
    fn option_as_alt_is_separate_from_shift_enter() {
        for kind in [Kind::Kitty, Kind::Ghostty] {
            assert!(matches!(shift_enter(kind), ShiftEnter::Works(_)));
            assert!(
                matches!(option_as_alt(kind), OptionAsAlt::Config { .. }),
                "{kind:?} defaults Option to composition, and it is writable"
            );
        }
        // A TOML table is not safe to blind-append to, so Alacritty is edited
        // structurally.
        assert_eq!(option_as_alt(Kind::Alacritty), OptionAsAlt::AlacrittyToml);
        // Terminals with no documented setting are left alone rather than
        // guessed at.
        assert_eq!(option_as_alt(Kind::Vte), OptionAsAlt::NotNeeded);
        assert_eq!(option_as_alt(Kind::Foot), OptionAsAlt::NotNeeded);
    }

    #[test]
    fn alacritty_binding_and_option_are_added_to_an_empty_file() {
        let out = edit_alacritty("", true, true).unwrap().expect("changed");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let binding = doc["keyboard"]["bindings"].as_array_of_tables().unwrap().get(0).unwrap();
        assert_eq!(binding["key"].as_str(), Some("Return"));
        assert_eq!(binding["mods"].as_str(), Some("Shift"));
        assert_eq!(binding["chars"].as_str(), Some("\u{1b}\r"));
        assert_eq!(doc["window"]["option_as_alt"].as_str(), Some("Both"));
        // Idempotent: a second run has nothing to do.
        assert_eq!(edit_alacritty(&out, true, true).unwrap(), None);
    }

    /// A user's comments, other sections and their own bindings survive, and
    /// the new entry lands under `keyboard`, not in whatever section was last.
    #[test]
    fn alacritty_edit_keeps_what_the_user_wrote() {
        let current = "# my config\n[font]\nsize = 12 # big\n\n[[keyboard.bindings]]\nkey = \"K\"\nmods = \"Command\"\nchars = \"x\"\n\n[colors.primary]\nbackground = \"#000000\"\n";
        let out = edit_alacritty(current, true, false).unwrap().expect("changed");
        assert!(out.contains("# my config") && out.contains("size = 12 # big"), "{out}");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        let bindings = doc["keyboard"]["bindings"].as_array_of_tables().unwrap();
        assert_eq!(bindings.len(), 2, "their binding stays, ours is added: {out}");
        assert_eq!(doc["colors"]["primary"]["background"].as_str(), Some("#000000"));
        assert!(doc.get("window").is_none(), "option_as_alt was not asked for");
    }

    #[test]
    fn an_existing_alacritty_binding_or_option_setting_is_left_alone() {
        let bound = "[[keyboard.bindings]]\nkey = \"Return\"\nmods = \"Shift\"\nchars = \"\\n\"\n\n[window]\noption_as_alt = \"OnlyLeft\"\n";
        assert_eq!(edit_alacritty(bound, true, true).unwrap(), None);
        let inline = "keyboard.bindings = [{ key = \"Return\", mods = \"Shift\", chars = \"\\n\" }]\n";
        assert_eq!(edit_alacritty(inline, true, false).unwrap(), None);
    }

    #[test]
    fn an_inline_alacritty_binding_list_is_appended_to() {
        let current = "keyboard.bindings = [{ key = \"K\", mods = \"Command\", chars = \"x\" }]\n";
        let out = edit_alacritty(current, true, false).unwrap().expect("changed");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["keyboard"]["bindings"].as_array().unwrap().len(), 2, "{out}");
    }

    #[test]
    fn an_unparseable_alacritty_file_is_reported_not_rewritten() {
        assert!(edit_alacritty("[window\nbroken", true, true).is_err());
        assert!(edit_alacritty("keyboard = 3\n", true, false).is_err());
    }

    #[test]
    fn apply_writes_alacritty_once_for_both_halves() {
        let dir = tempfile::tempdir().unwrap();
        let outcomes = apply(dir.path(), true, env(&[("TERM", "alacritty")]));
        assert_eq!(outcomes.len(), 1, "{outcomes:?}");
        let Outcome::Wrote { path, .. } = &outcomes[0] else {
            panic!("expected a write: {outcomes:?}");
        };
        assert!(path.ends_with("alacritty/alacritty.toml"), "{path:?}");
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("option_as_alt") && text.contains("[[keyboard.bindings]]"), "{text}");
        assert!(matches!(
            apply(dir.path(), true, env(&[("TERM", "alacritty")]))[0],
            Outcome::AlreadyDone(_)
        ));
    }

    #[test]
    fn vscode_binding_is_added_once() {
        let added = add_vscode_binding("").expect("empty file").expect("added");
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&added).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["key"], "shift+enter");
        assert_eq!(parsed[0]["args"]["text"], "\u{1b}\r");
        assert_eq!(parsed[0]["when"], "terminalFocus");

        assert_eq!(add_vscode_binding(&added).expect("reparse"), None);
    }

    #[test]
    fn vscode_binding_keeps_existing_entries() {
        let existing = r#"[{"key": "ctrl+shift+p", "command": "workbench.action.showCommands"}]"#;
        let added = add_vscode_binding(existing).unwrap().unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&added).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["key"], "ctrl+shift+p");
        assert_eq!(parsed[1]["key"], "shift+enter");
    }

    /// A commented `keybindings.json` (VS Code's own default file has a comment
    /// header) must be reported, never rewritten: serde would drop the comments.
    #[test]
    fn a_commented_keybindings_file_is_left_alone() {
        let commented = "// Place your key bindings in this file\n[\n]\n";
        assert!(add_vscode_binding(commented).is_err());
    }

    /// A user's own `shift+enter` sequence binding wins: two rules on one key
    /// is worse than not helping.
    #[test]
    fn an_existing_shift_enter_binding_is_not_duplicated() {
        let existing = r#"[{"key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": {"text": "\n"}}]"#;
        assert_eq!(add_vscode_binding(existing).unwrap(), None);
    }

    #[test]
    fn line_settings_are_appended_once_and_survive_a_missing_newline() {
        let added = append_missing_settings("set -g mouse on", &TMUX_SETTINGS).expect("appended");
        assert!(added.starts_with("set -g mouse on\n"), "{added:?}");
        for (_, line) in TMUX_SETTINGS {
            assert!(added.contains(line), "missing {line:?} in {added:?}");
        }
        assert_eq!(
            append_missing_settings(&added, &TMUX_SETTINGS),
            None,
            "second run is a no-op"
        );
    }

    /// A commented-out setting is not a setting: the append must still happen.
    #[test]
    fn commented_settings_do_not_count_as_set() {
        let added =
            append_missing_settings("# set -s extended-keys on\n", &TMUX_SETTINGS).expect("append");
        assert!(added.contains("\nset -s extended-keys on\n"));
        assert!(!setting_present(
            "# macos_option_as_alt yes",
            "macos_option_as_alt"
        ));
        assert!(setting_present(
            "macos_option_as_alt yes",
            "macos_option_as_alt"
        ));
    }

    #[test]
    fn a_setting_is_matched_as_a_whole_token() {
        assert!(!setting_present("set -g terminal-features-x on", "terminal-features"));
        assert!(!setting_present("macos_option_as_alt_extra yes", "macos_option_as_alt"));
        assert!(setting_present("set -s extended-keys on # keep", "extended-keys"));
        assert!(!setting_present("set -s mouse on # extended-keys", "extended-keys"));
    }

    #[test]
    fn linux_without_appdata_uses_dot_config() {
        if cfg!(target_os = "macos") {
            return;
        }
        let home = Path::new("/home/u");
        let paths = vscode_keybinding_paths(home, None);
        assert!(paths[0].starts_with(home.join(".config")), "{paths:?}");
    }

    #[test]
    fn cursor_user_dir_preferred_when_only_it_exists() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".config/Cursor/User")).unwrap();
        std::fs::create_dir_all(home.path().join("Library/Application Support/Cursor/User")).ok();
        let paths = vscode_keybinding_paths(home.path(), None);
        let chosen = preferred_vscode_path(&paths);
        assert!(
            chosen.components().any(|c| c.as_os_str() == "Cursor"),
            "{chosen:?}"
        );
        assert!(chosen.ends_with("User/keybindings.json"), "{chosen:?}");
    }

    #[test]
    fn the_running_fork_wins_over_an_installed_vs_code() {
        let home = tempfile::tempdir().unwrap();
        for flavour in ["Code", "Cursor", "VSCodium"] {
            for root in [".config", "Library/Application Support"] {
                std::fs::create_dir_all(home.path().join(root).join(flavour).join("User")).unwrap();
            }
        }
        // VS Code already has a keybindings file; the fork does not.
        for root in [".config", "Library/Application Support"] {
            std::fs::write(home.path().join(root).join("Code/User/keybindings.json"), "[]").unwrap();
        }
        let paths = vscode_keybinding_paths(home.path(), None);
        let flavour_of = |p: &Path| {
            p.parent().and_then(Path::parent).and_then(Path::file_name).unwrap().to_owned()
        };
        let env = |k: &'static str, v: &'static str| move |q: &str| (q == k).then(|| v.to_string());
        let cursor = preferred_vscode_path_for(&paths, &env("CURSOR_TRACE_ID", "abc"));
        assert_eq!(flavour_of(&cursor), "Cursor", "{cursor:?}");
        let codium = preferred_vscode_path_for(
            &paths,
            &env("VSCODE_GIT_ASKPASS_NODE", "/usr/share/codium/codium"),
        );
        assert_eq!(flavour_of(&codium), "VSCodium", "{codium:?}");
        // Unknown editor: the existing file is still the choice.
        let unknown = preferred_vscode_path_for(&paths, &|_: &str| None);
        assert_eq!(flavour_of(&unknown), "Code", "{unknown:?}");
        // A detected fork that is not installed falls back the same way.
        let windsurf = preferred_vscode_path_for(
            &paths,
            &env("VSCODE_GIT_ASKPASS_NODE", "C:/Program Files/Windsurf/Windsurf.exe"),
        );
        assert_eq!(flavour_of(&windsurf), "Code", "{windsurf:?}");
    }

    #[test]
    fn vscode_paths_cover_the_forks_and_prefer_appdata() {
        let home = Path::new("/home/u");
        let appdata = PathBuf::from("C:/Users/u/AppData/Roaming");
        let paths = vscode_keybinding_paths(home, Some(&appdata));
        assert!(paths[0].starts_with(&appdata), "{paths:?}");
        for flavour in ["Code", "Cursor", "Windsurf", "VSCodium", "Code - Insiders"] {
            assert!(
                paths
                    .iter()
                    .any(|p| p.components().any(|c| c.as_os_str() == flavour)),
                "no candidate for {flavour}"
            );
        }
        assert!(paths.iter().all(|p| p.ends_with("User/keybindings.json")));
    }

    /// tmux is orthogonal to the outer terminal: a kitty session inside tmux
    /// still needs `extended-keys`, so both outcomes are reported.
    #[test]
    fn tmux_is_reported_alongside_a_capable_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let outcomes = apply(
            dir.path(),
            false,
            env(&[("TERM", "xterm-kitty"), ("TMUX", "/tmp/t,1,0")]),
        );
        assert_eq!(outcomes.len(), 2, "{outcomes:?}");
        assert!(matches!(outcomes[0], Outcome::Works(_)));
        assert!(
            matches!(&outcomes[1], Outcome::Wrote { path, .. } if path.ends_with(".tmux.conf")),
            "{:?}",
            outcomes[1]
        );
    }

    #[test]
    fn vscode_setup_writes_the_file_it_found() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join(".config/Cursor/User/keybindings.json");
        std::fs::create_dir_all(existing.parent().unwrap()).unwrap();
        std::fs::write(&existing, "[]").unwrap();

        let outcomes = apply(dir.path(), false, env(&[("TERM_PROGRAM", "vscode")]));
        assert!(
            matches!(&outcomes[0], Outcome::Wrote { path, .. } if path == &existing),
            "{outcomes:?}"
        );
        let written = std::fs::read_to_string(&existing).unwrap();
        assert!(written.contains("shift+enter"), "{written}");
        assert!(
            !dir.path()
                .join(".config/Code/User/keybindings.json")
                .exists(),
            "only the flavour that exists is touched"
        );
    }

    /// On macOS a kitty session gets the Option fix written even though
    /// Shift+Enter already works; off macOS the same session gets nothing.
    #[test]
    fn the_option_key_is_only_configured_on_macos() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join(".config/kitty/kitty.conf");

        let outcomes = apply(dir.path(), false, env(&[("TERM", "xterm-kitty")]));
        assert_eq!(outcomes.len(), 1, "no Option outcome off macOS");
        assert!(!conf.exists());

        let outcomes = apply(dir.path(), true, env(&[("TERM", "xterm-kitty")]));
        assert_eq!(outcomes.len(), 2, "{outcomes:?}");
        assert!(
            matches!(&outcomes[1], Outcome::Wrote { path, .. } if path == &conf),
            "{:?}",
            outcomes[1]
        );
        assert!(std::fs::read_to_string(&conf)
            .unwrap()
            .contains("macos_option_as_alt yes"));

        let outcomes = apply(dir.path(), true, env(&[("TERM", "xterm-kitty")]));
        assert_eq!(outcomes[1], Outcome::AlreadyDone(conf));
    }

    #[test]
    fn hint_names_the_unset_option_key_and_clears_once_written() {
        let dir = tempfile::tempdir().unwrap();
        let kitty = env(&[("TERM", "xterm-kitty")]);

        let hint = setup_hint(dir.path(), true, &kitty).expect("kitty on macOS needs the fix");
        assert!(hint.contains("Option+Delete"), "{hint}");
        assert!(hint.contains("/terminal-setup"), "{hint}");
        assert_eq!(setup_hint(dir.path(), false, &kitty), None, "not on Linux");

        apply(dir.path(), true, &kitty);
        assert_eq!(
            setup_hint(dir.path(), true, &kitty),
            None,
            "the hint must clear itself once the setting is written"
        );
    }

    #[test]
    fn hint_covers_vscode_and_tmux_and_stays_quiet_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let vscode = env(&[("TERM_PROGRAM", "vscode")]);
        assert!(setup_hint(dir.path(), false, &vscode)
            .expect("unbound")
            .contains("Shift+Enter"));
        apply(dir.path(), false, &vscode);
        assert_eq!(setup_hint(dir.path(), false, &vscode), None);

        let tmux = env(&[("TERM", "xterm-kitty"), ("TMUX", "/tmp/t,1,0")]);
        assert!(setup_hint(dir.path(), false, &tmux)
            .expect("tmux unset")
            .contains("tmux"));
        apply(dir.path(), false, &tmux);
        assert_eq!(setup_hint(dir.path(), false, &tmux), None);

        // A capable terminal with nothing to fix says nothing at all.
        assert_eq!(
            setup_hint(dir.path(), false, env(&[("TERM", "xterm-kitty")])),
            None
        );
        // So does one we cannot check: a nag every launch is worse than silence.
        assert_eq!(
            setup_hint(dir.path(), true, env(&[("TERM_PROGRAM", "Apple_Terminal")])),
            None
        );
    }
}
