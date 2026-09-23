//! Destructive shell command detection.
//!
//! A small, deliberately conservative pattern check run before `bash`. A match
//! does not refuse the command: it forces the normal approval prompt even when
//! auto-approval is on, so a person sees `rm -rf ~` before it runs rather than
//! after. False positives cost one click; false negatives are what the OS
//! sandbox and the permission gate are still there for.
//!
//! The web app carries a port of the same rules (`web-app/src/lib/destructiveCommand.ts`);
//! keep the two in step.

use std::path::Path;

/// Why `command` looks destructive, or `None`. `workspace` is the project
/// root: deleting inside it is ordinary work, deleting outside it is not.
pub fn destructive_reason(command: &str, workspace: &Path) -> Option<String> {
    for segment in split_segments(command) {
        let words = strip_prefixes(&segment);
        if words.is_empty() {
            continue;
        }
        if let Some(reason) = check_segment(&words, workspace) {
            return Some(reason);
        }
    }
    let lower = command.to_ascii_lowercase();
    if lower.contains("drop database") || lower.contains("drop schema") {
        return Some("drops a database".to_string());
    }
    None
}

fn check_segment(words: &[String], workspace: &Path) -> Option<String> {
    let cmd = words[0].to_ascii_lowercase();
    let cmd = cmd.rsplit(['/', '\\']).next().unwrap_or(&cmd).to_string();
    let args = &words[1..];
    let lower_args: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    match cmd.as_str() {
        "rm" => {
            let (mut recursive, mut force) = (false, false);
            let mut targets = Vec::new();
            for a in args {
                if a == "--recursive" {
                    recursive = true;
                } else if a == "--force" {
                    force = true;
                } else if a.starts_with("--") {
                } else if let Some(flags) = a.strip_prefix('-') {
                    recursive |= flags.contains('r') || flags.contains('R');
                    force |= flags.contains('f');
                } else {
                    targets.push(a.as_str());
                }
            }
            if recursive && force {
                if let Some(t) = targets.iter().find(|t| outside_workspace(t, workspace)) {
                    return Some(format!("`rm -rf` on `{t}`, outside the workspace"));
                }
            }
            None
        }
        "git" => {
            let sub = lower_args.iter().find(|a| !a.starts_with('-'))?;
            let has = |f: &str| lower_args.iter().any(|a| a == f);
            match sub.as_str() {
                "reset" if has("--hard") => Some("`git reset --hard` discards uncommitted work".into()),
                "clean" => {
                    let short: String = lower_args
                        .iter()
                        .filter(|a| a.starts_with('-') && !a.starts_with("--"))
                        .map(|a| a.trim_start_matches('-'))
                        .collect();
                    let force = short.contains('f') || has("--force");
                    let dirs = short.contains('d');
                    let ignored = short.contains('x');
                    (force && (dirs || ignored))
                        .then(|| "`git clean` deletes untracked files".to_string())
                }
                "push" if has("--force") || has("-f") || lower_args.iter().any(|a| a.starts_with("--force-with-lease") || a.starts_with("--mirror")) =>
                {
                    Some("`git push --force` rewrites remote history".into())
                }
                _ => None,
            }
        }
        "dropdb" => Some("drops a database".into()),
        c if c == "mkfs" || c.starts_with("mkfs.") => Some("`mkfs` formats a filesystem".into()),
        "dd" if lower_args.iter().any(|a| a.starts_with("of=/dev/")) => {
            Some("`dd` writes to a raw device".into())
        }
        "remove-item" | "ri" => {
            let recurse = lower_args.iter().any(|a| a.starts_with("-r"));
            let force = lower_args.iter().any(|a| a == "-force");
            if recurse && force {
                let target = args
                    .iter()
                    .find(|a| !a.starts_with('-'))
                    .map(String::as_str)
                    .unwrap_or(".");
                if outside_workspace(target, workspace) {
                    return Some(format!(
                        "`Remove-Item -Recurse -Force` on `{target}`, outside the workspace"
                    ));
                }
            }
            None
        }
        "del" | "erase" if lower_args.iter().any(|a| a == "/s") => {
            Some("`del /s` deletes recursively".into())
        }
        "rd" | "rmdir" if lower_args.iter().any(|a| a == "/s") => {
            let target = args.iter().find(|a| !a.starts_with('/')).map(String::as_str).unwrap_or(".");
            outside_workspace(target, workspace)
                .then(|| format!("`{cmd} /s` on `{target}`, outside the workspace"))
        }
        "format" if args.first().is_some_and(|a| is_drive(a)) => {
            Some("`format` erases a drive".into())
        }
        _ => None,
    }
}

fn is_drive(a: &str) -> bool {
    let b = a.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// A deletion target that reaches beyond the project: the filesystem root,
/// home, a parent directory, a variable we cannot resolve, or an absolute path
/// not under `workspace`.
fn outside_workspace(target: &str, workspace: &Path) -> bool {
    let t = target.trim_matches(['"', '\'']);
    if t.is_empty() {
        return false;
    }
    if t.starts_with('~') || t.starts_with('$') || t.starts_with("%") {
        return true;
    }
    let norm = t.replace('\\', "/");
    if norm == ".." || norm.starts_with("../") || norm.contains("/../") || norm.ends_with("/..") {
        return true;
    }
    let absolute = norm.starts_with('/') || (norm.len() >= 2 && is_drive(&norm[..2]));
    if !absolute {
        return false;
    }
    let root = workspace.to_string_lossy().replace('\\', "/");
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return true;
    }
    let (n, r) = if cfg!(windows) || is_drive(&norm[..2.min(norm.len())]) {
        (norm.to_ascii_lowercase(), root.to_ascii_lowercase())
    } else {
        (norm.clone(), root.to_string())
    };
    let n = n.trim_end_matches(['/', '*']).to_string();
    !(n == r || n.starts_with(&format!("{r}/")))
}

/// Split a command line into simple commands on `;`, `&&`, `||`, `|` and
/// newlines, then into words. Quotes group words and are removed; this is not
/// a full shell parser, only enough to find a command and its arguments.
fn split_segments(command: &str) -> Vec<Vec<String>> {
    let mut segments = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    let flush_word = |cur: &mut String, words: &mut Vec<String>| {
        if !cur.is_empty() {
            words.push(std::mem::take(cur));
        }
    };
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None => match c {
                '"' | '\'' => quote = Some(c),
                ' ' | '\t' => flush_word(&mut cur, &mut words),
                ';' | '\n' | '|' | '&' => {
                    flush_word(&mut cur, &mut words);
                    if (c == '|' || c == '&') && chars.peek() == Some(&c) {
                        chars.next();
                    }
                    if !words.is_empty() {
                        segments.push(std::mem::take(&mut words));
                    }
                }
                _ => cur.push(c),
            },
        }
    }
    flush_word(&mut cur, &mut words);
    if !words.is_empty() {
        segments.push(words);
    }
    segments
}

/// Drop `sudo`, `env`, `VAR=value` and `command`/`exec` wrappers so the real
/// command is first.
fn strip_prefixes(words: &[String]) -> Vec<String> {
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let is_assignment = w.contains('=') && !w.starts_with('-') && !w.starts_with('=');
        if matches!(w, "sudo" | "env" | "command" | "exec" | "nohup" | "time") || is_assignment {
            i += 1;
            continue;
        }
        if w.starts_with('-') && i > 0 && words[i - 1] == "sudo" {
            i += 1;
            continue;
        }
        break;
    }
    words[i..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> &'static Path {
        Path::new("/home/me/project")
    }

    fn flagged(cmd: &str) -> bool {
        destructive_reason(cmd, ws()).is_some()
    }

    #[test]
    fn rm_rf_outside_the_workspace_is_flagged() {
        for cmd in [
            "rm -rf /",
            "rm -rf /*",
            "rm -fr ~",
            "rm -rf ~/Documents",
            "rm -r -f $HOME",
            "sudo rm -rf /etc",
            "rm --recursive --force ../other",
            "cd x && rm -Rf /var/lib",
            "rm -rf /home/me/project/../secrets",
        ] {
            assert!(flagged(cmd), "{cmd}");
        }
    }

    #[test]
    fn rm_inside_the_workspace_is_ordinary() {
        for cmd in [
            "rm -rf node_modules",
            "rm -rf ./target dist",
            "rm -rf /home/me/project/build",
            "rm file.txt",
            "rm -r build",
            "echo 'rm -rf /'",
        ] {
            assert!(!flagged(cmd), "{cmd}");
        }
    }

    #[test]
    fn git_history_and_worktree_destroyers_are_flagged() {
        assert!(flagged("git reset --hard HEAD~3"));
        assert!(flagged("git clean -fdx"));
        assert!(flagged("git clean -f -d"));
        assert!(flagged("git push --force origin main"));
        assert!(flagged("git push -f"));
        assert!(flagged("git push --force-with-lease"));
        assert!(!flagged("git reset HEAD file"));
        assert!(!flagged("git clean -n"));
        assert!(!flagged("git push origin main"));
        assert!(!flagged("git status"));
    }

    #[test]
    fn disks_and_databases_are_flagged() {
        assert!(flagged("mkfs.ext4 /dev/sdb1"));
        assert!(flagged("dd if=/dev/zero of=/dev/sda bs=1M"));
        assert!(!flagged("dd if=a.img of=b.img"));
        assert!(flagged("psql -c 'DROP DATABASE prod'"));
        assert!(flagged("dropdb prod"));
    }

    #[test]
    fn windows_commands_are_flagged() {
        let win = Path::new("C:\\work\\proj");
        let f = |c: &str| destructive_reason(c, win).is_some();
        assert!(f("Remove-Item -Recurse -Force C:\\Users\\me"));
        assert!(f("Remove-Item C:\\ -Recurse -Force"));
        assert!(!f("Remove-Item -Recurse -Force C:\\work\\proj\\bin"));
        assert!(!f("Remove-Item -Recurse -Force .\\bin"));
        assert!(f("format C: /q"));
        assert!(f("del /s /q *.*"));
        assert!(f("rd /s /q C:\\Windows"));
        assert!(!f("rd /s /q build"));
        assert!(!f("del file.txt"));
    }
}
