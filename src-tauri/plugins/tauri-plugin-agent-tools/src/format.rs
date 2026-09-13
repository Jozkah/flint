//! Finding a project's formatter, and running it on a file the agent just
//! changed (AH-150, AH-149).
//!
//! Every project already has an opinion about how its files are laid out, and
//! it is written down: a `rustfmt.toml`, a `.prettierrc`, a `[tool.black]`
//! table, a `go.mod`. A model's edit that ignores it produces a diff whose
//! noise is half whitespace, and a commit that the next `cargo fmt` will
//! rewrite anyway.
//!
//! Two rules keep this from becoming a guess:
//!
//! * **Evidence, not convention.** A formatter is only claimed when the
//!   project says so *and* the program is actually there -- on `PATH`, or in
//!   `node_modules/.bin`. A file extension alone is not evidence: plenty of
//!   repositories hold a `.py` and no Python formatter, and running one
//!   nobody asked for is a change nobody asked for. What the evidence was is
//!   carried on the result, so a person can be told why.
//! * **The file, never the project.** The formatter is invoked on the one file
//!   that was edited, with a deadline, inside the project. A formatter that
//!   fails, is slow, or rewrites something else leaves the edit exactly as the
//!   model wrote it, and says so.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a single-file format may take before it is abandoned. A formatter
/// is a fast program; one that has not finished by now is not going to help,
/// and the edit must not wait on it.
pub const FORMAT_DEADLINE: Duration = Duration::from_secs(20);

/// A formatter this project uses, and how to run it on one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formatter {
    /// What to call it when telling somebody what happened.
    pub name: String,
    /// The program, resolved to a path that exists.
    pub program: PathBuf,
    /// Its arguments, with the file appended last.
    pub args: Vec<String>,
    /// Why this project is believed to use it, in the words of the file that
    /// says so.
    pub evidence: String,
}

/// Whether `program` can be run here: `node_modules/.bin` first (a project's
/// own copy is the one it means), then `PATH`.
///
/// Windows needs the extensions too: `prettier` there is `prettier.cmd`, and a
/// check for the bare name finds nothing.
fn resolve_program(project_root: &Path, program: &str) -> Option<PathBuf> {
    let candidates = |dir: &Path| -> Vec<PathBuf> {
        let mut out = vec![dir.join(program)];
        if cfg!(windows) {
            for ext in ["exe", "cmd", "bat"] {
                out.push(dir.join(format!("{program}.{ext}")));
            }
        }
        out
    };
    let local = project_root.join("node_modules").join(".bin");
    for candidate in candidates(&local) {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for candidate in candidates(&dir) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Whether any of these files exist in the project root.
fn first_existing(project_root: &Path, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find(|n| project_root.join(n).is_file())
        .map(|n| n.to_string())
}

/// The Rust edition a crate declares, which `rustfmt` needs to parse anything
/// written after 2015. Read rather than assumed: formatting a 2021 crate as
/// 2015 fails on the first `async fn`.
fn rust_edition(project_root: &Path) -> Option<String> {
    let manifest = read(&project_root.join("Cargo.toml"))?;
    manifest.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("edition")?.trim_start().strip_prefix('=')?;
        let value = rest.trim().trim_matches('"').trim_matches('\'');
        (!value.is_empty() && value.chars().all(|c| c.is_ascii_digit()))
            .then(|| value.to_string())
    })
}

/// Whether `package.json` mentions prettier at all -- as a dependency or as a
/// `"prettier"` configuration key, which is where a project with no separate
/// config file puts it.
fn package_json_mentions_prettier(project_root: &Path) -> bool {
    let Some(raw) = read(&project_root.join("package.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    if json.get("prettier").is_some() {
        return true;
    }
    ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|k| json.get(*k))
        .any(|deps| deps.get("prettier").is_some())
}

/// Whether `pyproject.toml` declares a tool's configuration table.
fn pyproject_declares(project_root: &Path, tool: &str) -> bool {
    read(&project_root.join("pyproject.toml")).is_some_and(|raw| {
        raw.lines()
            .map(str::trim)
            .any(|line| line == format!("[tool.{tool}]") || line.starts_with(&format!("[tool.{tool}.")))
    })
}

/// The formatter this project uses for `file`, or `None` when nothing here
/// says it has one.
///
/// `file` is what decides the language; the project is what decides whether
/// there is a formatter for it. Both have to agree.
pub fn detect(project_root: &Path, file: &Path) -> Option<Formatter> {
    let extension = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "rs" => {
            // An edition is required, and is evidence in itself: a directory
            // with a .rs file and no manifest is not a crate anybody formats.
            let edition = rust_edition(project_root)?;
            let config = first_existing(project_root, &["rustfmt.toml", ".rustfmt.toml"]);
            let program = resolve_program(project_root, "rustfmt")?;
            Some(Formatter {
                name: "rustfmt".to_string(),
                program,
                args: vec!["--edition".to_string(), edition.clone()],
                evidence: match config {
                    Some(file) => format!("{file} and Cargo.toml (edition {edition})"),
                    None => format!("Cargo.toml (edition {edition})"),
                },
            })
        }
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "css" | "scss" | "html" | "json"
        | "yaml" | "yml" | "md" => {
            let config = first_existing(
                project_root,
                &[
                    ".prettierrc",
                    ".prettierrc.json",
                    ".prettierrc.yaml",
                    ".prettierrc.yml",
                    ".prettierrc.js",
                    "prettier.config.js",
                    "prettier.config.mjs",
                    ".prettierrc.cjs",
                ],
            );
            let mentioned = package_json_mentions_prettier(project_root);
            if config.is_none() && !mentioned {
                return None;
            }
            let program = resolve_program(project_root, "prettier")?;
            Some(Formatter {
                name: "prettier".to_string(),
                program,
                args: vec!["--write".to_string()],
                evidence: config.unwrap_or_else(|| "package.json".to_string()),
            })
        }
        "py" => {
            // Ruff first: a project that declares both runs ruff as the
            // formatter and black as history.
            for (tool, name, args) in [
                ("ruff", "ruff format", vec!["format".to_string(), "-q".to_string()]),
                ("black", "black", vec!["-q".to_string()]),
            ] {
                if !pyproject_declares(project_root, tool) {
                    continue;
                }
                let Some(program) = resolve_program(project_root, tool) else {
                    continue;
                };
                return Some(Formatter {
                    name: name.to_string(),
                    program,
                    args,
                    evidence: format!("pyproject.toml [tool.{tool}]"),
                });
            }
            None
        }
        "go" => {
            if !project_root.join("go.mod").is_file() {
                return None;
            }
            let program = resolve_program(project_root, "gofmt")?;
            Some(Formatter {
                name: "gofmt".to_string(),
                program,
                args: vec!["-w".to_string()],
                evidence: "go.mod".to_string(),
            })
        }
        _ => None,
    }
}

/// What running a formatter did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Formatted {
    /// The file was rewritten; the new contents are here.
    Changed(String),
    /// The formatter ran and left the file as it was.
    Unchanged,
    /// It could not be run, or refused the file. The edit stands as written;
    /// the reason is for saying so.
    Failed(String),
}

/// Run `formatter` on one file inside `project_root`.
///
/// Blocking, and deliberately so: it is called from the edit path, which has
/// just written the file and must not show a diff of something the formatter
/// is still rewriting.
pub fn run(formatter: &Formatter, project_root: &Path, file: &Path) -> Formatted {
    let before = match std::fs::read_to_string(file) {
        Ok(text) => text,
        // A file that is not text is not a file a formatter reads.
        Err(e) => return Formatted::Failed(format!("the file could not be read: {e}")),
    };
    let mut command = std::process::Command::new(&formatter.program);
    command
        .args(&formatter.args)
        .arg(file)
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window on the desktop.
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return Formatted::Failed(format!("{} could not be started: {e}", formatter.name)),
    };
    let deadline = std::time::Instant::now() + FORMAT_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Formatted::Failed(format!(
                    "{} did not finish within {}s and was stopped",
                    formatter.name,
                    FORMAT_DEADLINE.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Formatted::Failed(format!("{} could not be waited on: {e}", formatter.name)),
        }
    };
    if !status.success() {
        // A formatter that refuses is usually refusing the *syntax*, which is
        // worth saying plainly: the edit is still there, and it may not parse.
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            use std::io::Read;
            let mut buffer = Vec::new();
            let _ = pipe.read_to_end(&mut buffer);
            stderr = String::from_utf8_lossy(&buffer).trim().to_string();
        }
        let detail = stderr.lines().next().unwrap_or("no output").to_string();
        return Formatted::Failed(format!("{} refused the file: {detail}", formatter.name));
    }
    match std::fs::read_to_string(file) {
        Ok(after) if after != before => Formatted::Changed(after),
        Ok(_) => Formatted::Unchanged,
        Err(e) => Formatted::Failed(format!("the formatted file could not be read back: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_format_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    /// A directory with a Rust file and nothing that says how it is formatted
    /// has no formatter. Convention is not evidence.
    #[test]
    fn a_language_alone_is_not_evidence_of_a_formatter() {
        let root = temp_root("bare");
        std::fs::write(root.join("a.rs"), "fn  main(){}\n").unwrap();
        assert_eq!(detect(&root, &root.join("a.rs")), None);
        std::fs::write(root.join("a.py"), "x=1\n").unwrap();
        assert_eq!(detect(&root, &root.join("a.py")), None);
        std::fs::write(root.join("a.ts"), "const x=1\n").unwrap();
        assert_eq!(detect(&root, &root.join("a.ts")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A crate says which edition it is, and the formatter is invoked with it:
    /// formatting a 2021 crate as 2015 fails on the first `async fn`.
    #[test]
    fn a_rust_crate_is_formatted_at_the_edition_it_declares() {
        let root = temp_root("rust");
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(root.join("a.rs"), "fn  main(){}\n").unwrap();
        match detect(&root, &root.join("a.rs")) {
            // rustfmt is on PATH wherever Rust is, which is wherever this test
            // runs; assert what it was asked to do.
            Some(formatter) => {
                assert_eq!(formatter.name, "rustfmt");
                assert_eq!(formatter.args, vec!["--edition", "2021"]);
                assert!(formatter.evidence.contains("2021"), "{}", formatter.evidence);
            }
            None => panic!("rustfmt should be resolvable where Rust builds"),
        }
        // A manifest with no edition is a manifest that has not said, and a
        // guessed edition is a wrong one.
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        assert_eq!(detect(&root, &root.join("a.rs")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Prettier is claimed only when the project says it uses it *and* the
    /// program is there. A config with no installed prettier is not a
    /// formatter this run can use.
    #[test]
    fn prettier_needs_both_a_config_and_a_program() {
        let root = temp_root("prettier");
        std::fs::write(root.join("a.ts"), "const x=1\n").unwrap();
        std::fs::write(root.join(".prettierrc"), "{}\n").unwrap();
        // Nothing installed: no formatter, however loudly the config asks.
        if resolve_program(&root, "prettier").is_none() {
            assert_eq!(detect(&root, &root.join("a.ts")), None);
        }

        // A project's own copy is the one it means.
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "prettier.cmd" } else { "prettier" };
        std::fs::write(bin.join(name), "#!/bin/sh\nexit 0\n").unwrap();
        let found = detect(&root, &root.join("a.ts")).expect("a local prettier is a formatter");
        assert_eq!(found.name, "prettier");
        assert!(found.program.starts_with(&bin), "{:?}", found.program);
        assert_eq!(found.args, vec!["--write"]);
        assert_eq!(found.evidence, ".prettierrc");

        // Without the config or a package.json mention, the same binary is not
        // evidence: it may be there for something else entirely.
        std::fs::remove_file(root.join(".prettierrc")).unwrap();
        assert_eq!(detect(&root, &root.join("a.ts")), None);
        std::fs::write(
            root.join("package.json"),
            r#"{"devDependencies":{"prettier":"3.0.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            detect(&root, &root.join("a.ts")).map(|f| f.evidence),
            Some("package.json".to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Python: the declared tool decides, and ruff wins where both are
    /// declared, because that is the one such a project formats with.
    #[test]
    fn python_follows_what_pyproject_declares() {
        let root = temp_root("python");
        std::fs::write(root.join("a.py"), "x=1\n").unwrap();
        std::fs::write(root.join("pyproject.toml"), "[tool.pytest.ini_options]\n").unwrap();
        assert_eq!(detect(&root, &root.join("a.py")), None);

        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        for tool in ["ruff", "black"] {
            let name = if cfg!(windows) {
                format!("{tool}.cmd")
            } else {
                tool.to_string()
            };
            std::fs::write(bin.join(name), "#!/bin/sh\nexit 0\n").unwrap();
        }
        std::fs::write(root.join("pyproject.toml"), "[tool.black]\nline-length = 88\n").unwrap();
        assert_eq!(
            detect(&root, &root.join("a.py")).map(|f| f.name),
            Some("black".to_string())
        );
        std::fs::write(
            root.join("pyproject.toml"),
            "[tool.black]\n[tool.ruff.format]\nquote-style = \"double\"\n",
        )
        .unwrap();
        let found = detect(&root, &root.join("a.py")).expect("ruff");
        assert_eq!(found.name, "ruff format");
        assert_eq!(found.args, vec!["format", "-q"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Running one: the file is rewritten, and what it now holds comes back.
    #[test]
    fn running_a_formatter_reports_what_it_changed() {
        let root = temp_root("run");
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let file = root.join("a.rs");
        std::fs::write(&file, "fn  main( ) {let  x=1;}\n").unwrap();
        let formatter = detect(&root, &file).expect("rustfmt");
        match run(&formatter, &root, &file) {
            Formatted::Changed(after) => {
                assert!(after.contains("fn main()"), "{after}");
                assert_eq!(std::fs::read_to_string(&file).unwrap(), after);
            }
            other => panic!("expected a change, got {other:?}"),
        }
        // Running it again changes nothing, and says so rather than claiming a
        // change it did not make.
        assert_eq!(run(&formatter, &root, &file), Formatted::Unchanged);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A formatter that refuses the file leaves the file alone and says why.
    #[test]
    fn a_formatter_that_refuses_leaves_the_edit_as_written() {
        let root = temp_root("refuse");
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2021\"\n",
        )
        .unwrap();
        let file = root.join("a.rs");
        let broken = "fn main( { this is not rust\n";
        std::fs::write(&file, broken).unwrap();
        let formatter = detect(&root, &file).expect("rustfmt");
        match run(&formatter, &root, &file) {
            Formatted::Failed(why) => assert!(why.contains("rustfmt"), "{why}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), broken);
        let _ = std::fs::remove_dir_all(&root);
    }
}
