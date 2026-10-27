//! `[mcp] allow_commands` in `agent.toml`: which programs a stdio MCP server
//! may be started with.
//!
//! MCP servers are configured once for the whole app, not per project, so the
//! list is read from the global agent config (`<store>/agent.toml`). Absent
//! or empty means no restriction; a wrong-typed list or an unreadable file
//! is an error (fail closed). Every local
//! launch goes through `ConfinedMcpLaunch::prepare`, which calls [`enforce`],
//! so the desktop, the CLI and imported servers share one check.

use std::path::Path;

/// A command reduced to the name that is compared: the file name without any
/// directory, lowercased, without one trailing `.exe` / `.cmd` / `.bat` /
/// `.com`. `C:\Tools\NPX.CMD`, `/usr/bin/npx` and `npx` are all `npx`.
pub(crate) fn command_stem(command: &str) -> String {
    let command = command.trim().trim_matches(|c| c == '"' || c == '\'');
    let file = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = file.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            if !stem.is_empty() {
                return stem.to_string();
            }
        }
    }
    lower
}

fn has_separator(s: &str) -> bool {
    s.contains(['/', '\\'])
}

fn clean(s: &str) -> &str {
    s.trim().trim_matches(|c| c == '"' || c == '\'').trim()
}

/// Two paths compared as written: separators unified, and case-insensitive on
/// Windows only.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.replace('\\', "/");
        if cfg!(windows) { s.to_ascii_lowercase() } else { s }
    };
    norm(clean(a)) == norm(clean(b))
}

/// The program a bare `command` name resolves to on `PATH`. The current
/// directory is never searched. On Windows the `.exe/.cmd/.bat/.com`
/// extensions are tried, but only here, for PATH-resolved results.
pub(crate) fn resolve_on_path(command: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat", ".com"] } else { &[""] };
    for dir in std::env::split_paths(&path) {
        if !dir.is_absolute() {
            continue;
        }
        for ext in exts {
            let candidate = dir.join(format!("{command}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `Ok` when `allow` is empty (no restriction) or names `command`; otherwise an
/// error that says what was refused and lists what is allowed. A bare command
/// is resolved on `PATH` and matches a bare entry by the resolved file's stem;
/// a command with a directory part matches only a path entry, exactly.
pub(crate) fn check_command(command: &str, allow: &[String]) -> Result<(), String> {
    check_command_with(command, allow, resolve_on_path)
}

pub(crate) fn check_command_with(
    command: &str,
    allow: &[String],
    resolve: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> Result<(), String> {
    let entries: Vec<&str> = allow.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect();
    if entries.is_empty() {
        return Ok(());
    }
    let list = entries.join(", ");
    let command_clean = clean(command);
    let refuse = |why: &str| {
        Err(format!(
            "MCP server command {command:?} is not allowed{why}: agent.toml [mcp] allow_commands only permits {list}"
        ))
    };
    if has_separator(command_clean) {
        if entries.iter().any(|e| has_separator(e) && same_path(e, command_clean)) {
            return Ok(());
        }
        return refuse(" (a path must be listed in full)");
    }
    let Some(resolved) = resolve(command_clean) else {
        return refuse(" (not found on PATH)");
    };
    let resolved_str = resolved.to_string_lossy();
    let stem = command_stem(&resolved_str);
    for e in &entries {
        let ok = if has_separator(e) {
            same_path(e, &resolved_str)
        } else {
            command_stem(e) == stem
        };
        if ok {
            return Ok(());
        }
    }
    refuse("")
}

/// The string list at `[mcp].<key>` of the agent.toml text `raw`. Absent key
/// (or absent section) is an empty list; a file that is not TOML, a key that
/// is not an array, or an element that is not a string is an error, because a
/// restriction the user wrote must never quietly stop restricting.
pub(crate) fn mcp_string_list(raw: &str, key: &str) -> Result<Vec<String>, String> {
    let doc = match raw.parse::<toml::Value>() {
        Ok(d) => d,
        Err(e) => {
            return if raw.contains(key) {
                Err(format!("[mcp] {key} cannot be read: the file is not valid TOML ({e})"))
            } else {
                Ok(Vec::new())
            };
        }
    };
    let Some(value) = doc.get("mcp").and_then(|m| m.get(key)) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("[mcp] {key} must be an array of strings"))?;
    items
        .iter()
        .map(|v| {
            v.as_str()
                .map(|s| s.trim().to_string())
                .ok_or_else(|| format!("[mcp] {key} must contain only strings"))
        })
        .filter(|r| !matches!(r, Ok(s) if s.is_empty()))
        .collect()
}

/// Read the agent.toml at `path`: a missing file is `None`, any other read
/// failure an error.
pub(crate) fn read_agent_toml(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} cannot be read ({e})", path.display())),
    }
}

/// The `[mcp].allow_commands` list of the agent.toml text `raw`.
pub(crate) fn allow_commands_from_toml(raw: &str) -> Result<Vec<String>, String> {
    mcp_string_list(raw, "allow_commands")
}

/// [`check_command`] against the allowlist in the agent.toml at `path`.
pub(crate) fn enforce_at(command: &str, path: &Path) -> Result<(), String> {
    let cannot = |e: String| format!("MCP server command {command:?} cannot be checked: {e} ({})", path.display());
    let Some(raw) = read_agent_toml(path).map_err(cannot)? else {
        return Ok(());
    };
    let allow = allow_commands_from_toml(&raw).map_err(cannot)?;
    check_command(command, &allow).map_err(|e| format!("{e} ({})", path.display()))
}

/// The launch-time check: the command against the global agent.toml.
pub(crate) fn enforce(command: &str) -> Result<(), String> {
    enforce_at(command, &crate::core::agent::plugins::global_agent_toml_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn stem_drops_directory_case_and_extension() {
        assert_eq!(command_stem("npx"), "npx");
        assert_eq!(command_stem("NPX.CMD"), "npx");
        assert_eq!(command_stem("C:\\Program Files\\nodejs\\Node.exe"), "node");
        assert_eq!(command_stem("/usr/local/bin/python"), "python");
        assert_eq!(command_stem("\"C:\\x\\uvx.exe\""), "uvx");
        assert_eq!(command_stem("python3.11"), "python3.11");
        assert_eq!(command_stem(".exe"), ".exe");
    }

    #[test]
    fn an_empty_or_blank_list_changes_nothing() {
        assert!(check_command("anything", &[]).is_ok());
        assert!(check_command("anything", &list(&["", "  "])).is_ok());
    }

    fn fake(cmd: &str) -> Option<std::path::PathBuf> {
        match cmd {
            "npx" => Some("/usr/bin/npx".into()),
            "uvx" => Some("/usr/bin/uvx.exe".into()),
            "node" => Some("/usr/bin/node".into()),
            "bash" => Some("/usr/bin/bash".into()),
            _ => None,
        }
    }

    #[test]
    fn matching_bare_names_resolve_on_path() {
        let allow = list(&["npx", "UVX.exe", "node"]);
        for ok in ["npx", "uvx", "node"] {
            assert!(check_command_with(ok, &allow, fake).is_ok(), "{ok}");
        }
        for bad in ["bash", "missing"] {
            assert!(check_command_with(bad, &allow, fake).is_err(), "{bad}");
        }
    }

    #[test]
    fn allow_commands_rejects_path_with_allowed_stem() {
        let allow = list(&["npx"]);
        for bad in ["./npx", "C:\\evil\\npx.exe", "/tmp/npx", "../npx"] {
            assert!(check_command_with(bad, &allow, fake).is_err(), "{bad}");
        }
    }

    #[test]
    fn allow_commands_accepts_path_resolved_npx() {
        assert!(check_command_with("npx", &list(&["npx"]), fake).is_ok());
        assert!(check_command_with("/opt/x/tool", &list(&["/opt/x/tool"]), fake).is_ok());
        assert!(check_command_with("/opt/x/other", &list(&["/opt/x/tool"]), fake).is_err());
        assert!(check_command_with("npx", &list(&["/usr/bin/npx"]), fake).is_ok());
    }

    #[test]
    fn allow_commands_bare_name_not_on_path_errors() {
        let err = check_command_with("ghost", &list(&["ghost"]), fake).unwrap_err();
        assert!(err.contains("PATH"), "{err}");
    }

    #[test]
    fn allow_commands_non_string_array_errors() {
        assert!(allow_commands_from_toml("[mcp]\nallow_commands = [\"npx\", 5]\n").is_err());
        assert!(allow_commands_from_toml("[mcp]\nallow_commands = \"npx\"\n").is_err());
    }

    #[test]
    fn the_refusal_names_the_command_and_the_list() {
        let err = check_command_with("bash", &list(&["npx", "uvx"]), fake).unwrap_err();
        assert!(err.contains("\"bash\""), "{err}");
        assert!(err.contains("allow_commands"), "{err}");
        assert!(err.contains("npx, uvx"), "{err}");
    }

    #[test]
    fn the_section_parses_and_absent_means_no_restriction() {
        assert_eq!(
            allow_commands_from_toml("[mcp]\nallow_commands = [\"npx\", \" uvx \", \"\"]\n").unwrap(),
            ["npx", "uvx"]
        );
        for none in ["", "[tools]\ndefault = \"ask\"\n", "[mcp]\n", "[mcp]\nallow_commands = []\n", "not = [toml"] {
            assert!(allow_commands_from_toml(none).unwrap().is_empty(), "{none}");
        }
    }

    #[test]
    fn a_bad_unrelated_section_does_not_switch_the_restriction_off() {
        let raw = "[tools]\ndefault = 5\n[mcp]\nallow_commands = [\"npx\"]\n";
        assert_eq!(allow_commands_from_toml(raw).unwrap(), ["npx"]);
    }

    #[test]
    fn the_typed_agent_toml_section_parses_too() {
        let cfg: crate::core::agent::project::AgentToml =
            toml::from_str("[mcp]\nallow_commands = [\"npx\"]\nlater = 1\n").expect("parses");
        assert_eq!(cfg.mcp.allow_commands, ["npx"]);
        let none: crate::core::agent::project::AgentToml = toml::from_str("").unwrap();
        assert!(none.mcp.allow_commands.is_empty());
    }

    #[test]
    fn enforcing_against_a_file_refuses_and_a_missing_file_allows() {
        let dir = std::env::temp_dir().join(format!("flint_mcp_allow_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agent.toml");
        assert!(enforce_at("bash", &file).is_ok(), "no file, no restriction");
        std::fs::write(&file, "[mcp]\nallow_commands = [\"npx\"]\n").unwrap();
        let err = enforce_at("bash", &file).unwrap_err();
        assert!(err.contains("npx") && err.contains("agent.toml"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
