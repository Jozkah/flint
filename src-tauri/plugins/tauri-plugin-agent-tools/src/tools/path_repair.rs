//! Paths that lost a backslash to JSON (transcript audit #5).
//!
//! A model that writes `"C:\tmp\a.txt"` in its JSON arguments has written a
//! TAB: `\t` is a JSON escape, so the tool receives `C:<TAB>mp\a.txt` and the
//! call fails with "does not exist" -- a message that does not tell the model
//! what went wrong, so it tries the same spelling again.
//!
//! Before a path-taking tool runs, a path argument holding one of the control
//! characters a JSON escape produces (`\t \n \r \b \f`) is repaired when the
//! repair names something real: the character is put back as the backslash
//! and letter the model meant. Otherwise the call is refused with a message
//! that says what happened and how to write the path.

use serde_json::Value;
use std::path::Path;

/// The argument keys that carry a path, per tool, beyond `path_args`.
fn extra_path_keys(tool: &str) -> &'static [&'static str] {
    match tool {
        "git" | "git_inspect" => &["cwd", "path"],
        "git_clone" => &["dest"],
        "request_access" => &["path"],
        _ => &[],
    }
}

/// Every key of `tool` whose value is a path.
pub fn path_keys(tool: &str, path_args: &[&'static str]) -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = path_args.to_vec();
    for k in extra_path_keys(tool) {
        if !keys.contains(k) {
            keys.push(k);
        }
    }
    keys
}

fn is_escape_control(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{8}' | '\u{c}')
}

/// Put each control character back as the escape the model typed.
pub fn restore_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 4);
    for c in raw.chars() {
        match c {
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            other => out.push(other),
        }
    }
    out
}

fn named(c: char) -> &'static str {
    match c {
        '\t' => "a TAB (`\\t`)",
        '\n' => "a newline (`\\n`)",
        '\r' => "a carriage return (`\\r`)",
        '\u{8}' => "a backspace (`\\b`)",
        _ => "a form feed (`\\f`)",
    }
}

/// Repair one path. `Ok(None)`: nothing to do. `Ok(Some(p))`: use `p`.
/// `Err`: the message for the model.
///
/// `exists` answers for a spelling as the tool would resolve it. A spelling
/// that exists as written is kept (a Unix file name may hold a TAB). The
/// repaired spelling is taken when it, or the folder it would be created in,
/// exists.
pub fn repair(key: &str, raw: &str, exists: &dyn Fn(&str) -> bool) -> Result<Option<String>, String> {
    let Some(bad) = raw.chars().find(|c| is_escape_control(*c)) else {
        return Ok(None);
    };
    if exists(raw) {
        return Ok(None);
    }
    let restored = restore_escapes(raw);
    let parent_exists = Path::new(&restored)
        .parent()
        .and_then(|p| p.to_str())
        .filter(|p| !p.is_empty())
        .map(|p| exists(p))
        .unwrap_or(false);
    if exists(&restored) || parent_exists {
        return Ok(Some(restored));
    }
    Err(format!(
        "`{key}` contains {} -- it was written as `{}` in JSON, where a single backslash starts an escape. \
         Write Windows paths with doubled backslashes (\"C:\\\\tmp\\\\file.txt\") or forward slashes (\"C:/tmp/file.txt\") and call again.",
        named(bad),
        restored
    ))
}

/// Repair every path argument of one call in place. The error is the first
/// argument that could not be repaired.
pub fn repair_args(
    tool: &str,
    path_args: &[&'static str],
    args: &mut Value,
    exists: &dyn Fn(&str) -> bool,
) -> Result<(), String> {
    let Some(obj) = args.as_object_mut() else {
        return Ok(());
    };
    for key in path_keys(tool, path_args) {
        let Some(raw) = obj.get(key).and_then(Value::as_str) else {
            continue;
        };
        if let Some(fixed) = repair(key, raw, exists)? {
            obj.insert(key.to_string(), Value::String(fixed));
        }
    }
    Ok(())
}

/// [`repair_args`] against the real filesystem, relative paths resolved as
/// the tools resolve them.
pub fn repair_args_on_disk(
    tool: &str,
    path_args: &[&'static str],
    args: &mut Value,
    root: &Path,
    scratch: Option<&Path>,
) -> Result<(), String> {
    let exists = |p: &str| crate::tools::sandbox::resolve_path(root, scratch, p).exists();
    repair_args(tool, path_args, args, &exists)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_clean_path_is_left_alone() {
        assert_eq!(repair("path", "C:/tmp/a.txt", &|_| false), Ok(None));
    }

    #[test]
    fn a_tab_that_was_a_backslash_t_is_put_back_when_that_exists() {
        let exists = |p: &str| p == "C:\\tmp\\a.txt";
        assert_eq!(
            repair("path", "C:\tmp\\a.txt", &exists),
            Ok(Some("C:\\tmp\\a.txt".to_string()))
        );
    }

    #[test]
    fn a_new_file_in_an_existing_folder_is_repaired_too() {
        let exists = |p: &str| p == "C:\\tmp";
        assert_eq!(
            repair("path", "C:\tmp\\new.txt", &exists),
            Ok(Some("C:\\tmp\\new.txt".to_string()))
        );
    }

    #[test]
    fn every_json_escape_is_restored() {
        assert_eq!(restore_escapes("a\tb\nc\rd\u{8}e\u{c}f"), "a\\tb\\nc\\rd\\be\\ff");
    }

    #[test]
    fn an_unrepairable_path_says_what_happened_and_how_to_write_it() {
        let err = repair("path", "C:\tmp\\ws-demo", &|_| false).unwrap_err();
        assert!(err.contains("TAB"), "{err}");
        assert!(err.contains("C:\\tmp\\ws-demo"), "{err}");
        assert!(err.contains("forward slashes"), "{err}");
    }

    #[test]
    fn a_name_that_really_holds_a_tab_is_kept() {
        assert_eq!(repair("path", "odd\tname", &|p| p == "odd\tname"), Ok(None));
    }

    #[test]
    fn git_cwd_and_request_access_path_are_checked() {
        let mut args = json!({"args": ["status"], "cwd": "C:\tmp\\repo"});
        repair_args("git", &[], &mut args, &|p| p == "C:\\tmp\\repo").unwrap();
        assert_eq!(args["cwd"], "C:\\tmp\\repo");

        let mut args = json!({"path": "C:\tmp\\ws-demo"});
        let err = repair_args("request_access", &[], &mut args, &|_| false).unwrap_err();
        assert!(err.contains("`path`"), "{err}");
    }

    #[test]
    fn a_real_directory_on_disk_is_found() {
        let dir = std::env::temp_dir().join(format!("pr-{}", std::process::id()));
        let sub = dir.join("tmp");
        std::fs::create_dir_all(&sub).unwrap();
        // JSON made the separator and the `t` after it one TAB.
        let broken = format!("{}\tmp", dir.display());
        let mut args = json!({ "path": broken });
        let tool = crate::tools::lookup("ls").unwrap();
        let result = repair_args_on_disk("ls", tool.path_args, &mut args, &dir, None);
        if cfg!(windows) {
            result.unwrap();
            assert_eq!(args["path"].as_str().unwrap(), format!("{}\\tmp", dir.display()));
        } else {
            // Off Windows a backslash is not a separator; it is still refused
            // or repaired, never passed through with the TAB.
            assert!(result.is_err() || !args["path"].as_str().unwrap().contains('\t'));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
