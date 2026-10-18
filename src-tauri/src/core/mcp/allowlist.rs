//! `[mcp] allow_commands` in `agent.toml`: which programs a stdio MCP server
//! may be started with.
//!
//! MCP servers are configured once for the whole app, not per project, so the
//! list is read from the global agent config (`<store>/agent.toml`). Absent,
//! empty or unreadable means no restriction -- today's behaviour. Every local
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

/// `Ok` when `allow` is empty (no restriction) or names `command`; otherwise an
/// error that says what was refused and lists what is allowed.
pub(crate) fn check_command(command: &str, allow: &[String]) -> Result<(), String> {
    let allowed: Vec<String> = allow
        .iter()
        .map(|a| command_stem(a))
        .filter(|a| !a.is_empty())
        .collect();
    if allowed.is_empty() {
        return Ok(());
    }
    let stem = command_stem(command);
    if allowed.contains(&stem) {
        return Ok(());
    }
    Err(format!(
        "MCP server command {command:?} is not allowed: agent.toml [mcp] allow_commands only permits {}",
        allow
            .iter()
            .map(|a| a.trim())
            .filter(|a| !a.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// The `[mcp].allow_commands` list of the agent.toml text `raw`. Read from a
/// loose `toml::Value` so a mistake in an unrelated section cannot switch the
/// restriction off; only a file that is not TOML at all yields nothing.
pub(crate) fn allow_commands_from_toml(raw: &str) -> Vec<String> {
    let Ok(doc) = raw.parse::<toml::Value>() else {
        return Vec::new();
    };
    doc.get("mcp")
        .and_then(|m| m.get("allow_commands"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// [`check_command`] against the allowlist in the agent.toml at `path`.
pub(crate) fn enforce_at(command: &str, path: &Path) -> Result<(), String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    // A file that is not TOML at all but mentions the list is a restriction the
    // user wrote and cannot be read: refuse rather than quietly allow anything.
    if raw.contains("allow_commands") && raw.parse::<toml::Value>().is_err() {
        return Err(format!(
            "MCP server command {command:?} cannot be checked: {} mentions allow_commands but is not valid TOML",
            path.display()
        ));
    }
    let allow = allow_commands_from_toml(&raw);
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

    #[test]
    fn matching_ignores_path_prefix_case_and_extension_on_both_sides() {
        let allow = list(&["npx", "UVX.exe", "node"]);
        for ok in ["npx", "NPX", "npx.cmd", "C:\\n\\npx.CMD", "/usr/bin/node", "uvx", "./node.exe"] {
            assert!(check_command(ok, &allow).is_ok(), "{ok}");
        }
        for bad in ["python", "bash", "node-gyp", "npx2", "C:\\evil\\powershell.exe"] {
            assert!(check_command(bad, &allow).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_refusal_names_the_command_and_the_list() {
        let err = check_command("bash", &list(&["npx", "uvx"])).unwrap_err();
        assert!(err.contains("\"bash\""), "{err}");
        assert!(err.contains("allow_commands"), "{err}");
        assert!(err.contains("npx, uvx"), "{err}");
    }

    #[test]
    fn the_section_parses_and_absent_means_no_restriction() {
        assert_eq!(
            allow_commands_from_toml("[mcp]\nallow_commands = [\"npx\", \" uvx \", \"\"]\n"),
            ["npx", "uvx"]
        );
        for none in ["", "[tools]\ndefault = \"ask\"\n", "[mcp]\n", "[mcp]\nallow_commands = []\n", "not = [toml"] {
            assert!(allow_commands_from_toml(none).is_empty(), "{none}");
        }
    }

    #[test]
    fn a_bad_unrelated_section_does_not_switch_the_restriction_off() {
        let raw = "[tools]\ndefault = 5\n[mcp]\nallow_commands = [\"npx\"]\n";
        assert_eq!(allow_commands_from_toml(raw), ["npx"]);
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
        assert!(enforce_at("npx.cmd", &file).is_ok());
        let err = enforce_at("bash", &file).unwrap_err();
        assert!(err.contains("npx") && err.contains("agent.toml"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
