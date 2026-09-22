//! What the project's own compiler says, without the model shelling out.
//! AH-063, AH-064.
//!
//! A model that has just edited a file learns whether it broke something in
//! one of two ways: it runs the build itself, in a `bash` call it has to think
//! to make and a user has to approve, or it does not and finds out three turns
//! later. The first is noisy and skipped under pressure; the second is how a
//! run ends with a confident summary of code that does not compile.
//!
//! So the harness can run the check itself and hand back the diagnostics for
//! the files the run touched.
//!
//! The rules that keep that from being a liability:
//!
//! * **Opt-in, per project.** `[tools] diagnostics = true` in
//!   `.jan/agent/agent.toml`. Running a compiler after every edit costs real
//!   time on a large project, and a harness that silently does it is a harness
//!   that feels broken. Off by default.
//! * **The project's own command, or nothing.** `cargo check` where there is a
//!   `Cargo.toml`, the project's TypeScript compiler where there is a
//!   `tsconfig.json` and a dependency that provides one. Where neither is
//!   true there is no command and no diagnostics -- never a guess at what a
//!   project might respond to.
//! * **Bounded and stoppable.** One command, a deadline, a capped amount of
//!   output kept, and the process tree killed when the run is cancelled. A
//!   check that hangs must not hang the run.
//! * **Only what the run touched.** The compiler reports the whole project;
//!   what goes back to the model is the diagnostics for the files this run
//!   edited, because everything else is noise it cannot act on and did not
//!   cause.
//!
//! Nothing here fixes anything. It reports.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

/// The most diagnostics kept from one run of a check.
pub const MAX_DIAGNOSTICS: usize = 200;
/// The most output bytes read from the checker.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// How long a check may take, whatever the project says.
pub const MAX_SECONDS: u64 = 180;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticsErrorKind {
    /// The path is not a directory that can be read.
    NoProject,
    /// This project does not say how it is checked.
    NoChecker,
    /// The checker could not be started.
    CheckerUnavailable,
    /// The check outlived its deadline and was stopped.
    TimedOut,
    /// The run was cancelled while the check was going.
    Cancelled,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsError {
    pub kind: DiagnosticsErrorKind,
    pub message: String,
}

impl DiagnosticsError {
    fn new(kind: DiagnosticsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&DiagnosticsError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &DiagnosticsError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            DiagnosticsErrorKind::NoProject => ErrorKind::NotFound,
            // Not a failure of the check: there is nothing here to run, and
            // no amount of retrying makes one appear.
            DiagnosticsErrorKind::NoChecker => ErrorKind::Unsupported,
            DiagnosticsErrorKind::CheckerUnavailable => ErrorKind::ToolUnavailable,
            DiagnosticsErrorKind::TimedOut => ErrorKind::Timeout,
            DiagnosticsErrorKind::Cancelled => ErrorKind::Cancelled,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// Relative to the project, `/`-separated, when it could be made relative.
    pub path: String,
    pub line: usize,
    #[serde(default)]
    pub column: Option<usize>,
    pub severity: Severity,
    /// The compiler's own code, where it gave one (`E0432`, `TS2304`).
    #[serde(default)]
    pub code: Option<String>,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The command that produced this, as it was run.
    pub command: String,
    pub diagnostics: Vec<Diagnostic>,
    /// Set when more diagnostics were produced than are listed.
    pub truncated: bool,
    pub took_ms: u128,
}

impl Report {
    /// The diagnostics for the files a run touched (AH-064).
    ///
    /// Everything else is noise the model cannot act on and did not cause.
    /// Paths are compared after normalising separators, so a Windows path and
    /// the compiler's `/` spelling are the same file.
    pub fn for_files(&self, touched: &[String]) -> Vec<Diagnostic> {
        let wanted: BTreeSet<String> =
            touched.iter().map(|p| p.replace('\\', "/")).collect();
        self.diagnostics
            .iter()
            .filter(|d| wanted.contains(&d.path))
            .cloned()
            .collect()
    }

    /// What the model is told, or `None` when there is nothing to say.
    pub fn render_for(&self, touched: &[String]) -> Option<String> {
        let mine = self.for_files(touched);
        if mine.is_empty() {
            return None;
        }
        let mut out = format!("`{}` reports on the files this turn changed:\n", self.command);
        for d in mine.iter().take(50) {
            out.push_str(&format!(
                "{}:{}{} {}{}: {}\n",
                d.path,
                d.line,
                d.column.map(|c| format!(":{c}")).unwrap_or_default(),
                match d.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                },
                d.code.as_ref().map(|c| format!("[{c}]")).unwrap_or_default(),
                d.message
            ));
        }
        Some(out)
    }
}

/// Whether this project asked for its checks to be run (AH-063).
pub fn enabled(project_root: &Path) -> bool {
    let path = project_root.join(".jan").join("agent").join("agent.toml");
    let Ok(raw) = std::fs::read_to_string(path) else { return false };
    let Ok(doc) = raw.parse::<toml::Value>() else { return false };
    doc.get("tools")
        .and_then(|t| t.get("diagnostics"))
        .and_then(toml::Value::as_bool)
        .unwrap_or(false)
}

/// The command this project is checked with, or nothing.
///
/// Read from what is actually in the repository. A project that provides no
/// checker gets no diagnostics rather than a guess at one: a command invented
/// here would be run, by the harness, on somebody's machine.
pub fn checker(project_root: &Path) -> Option<String> {
    if project_root.join("Cargo.toml").is_file() {
        // Short messages: the JSON format carries a spans structure this does
        // not need, and the human format repeats every message three times.
        return Some("cargo check --message-format=short".to_string());
    }
    if project_root.join("tsconfig.json").is_file() {
        let package = std::fs::read_to_string(project_root.join("package.json")).ok()?;
        // Only where the project actually depends on a compiler: `npx tsc`
        // downloads one, which is not something to do behind a user's back.
        if !package.contains("\"typescript\"") {
            return None;
        }
        let manager = if project_root.join("yarn.lock").is_file() {
            "yarn"
        } else if project_root.join("pnpm-lock.yaml").is_file() {
            "pnpm"
        } else {
            "npm"
        };
        return Some(match manager {
            "npm" => "npm exec --no -- tsc --noEmit".to_string(),
            other => format!("{other} exec tsc --noEmit"),
        });
    }
    None
}

/// Run the project's check and read what it said.
pub fn collect(
    project_root: &Path,
    cancel: &AtomicBool,
    seconds: u64,
) -> Result<Report, DiagnosticsError> {
    if !project_root.is_dir() {
        return Err(DiagnosticsError::new(
            DiagnosticsErrorKind::NoProject,
            "there is no project directory to check here",
        ));
    }
    let command = checker(project_root).ok_or_else(|| {
        DiagnosticsError::new(
            DiagnosticsErrorKind::NoChecker,
            "this project does not say how it is checked, so nothing was run",
        )
    })?;
    run_and_parse(project_root, &command, cancel, seconds.min(MAX_SECONDS))
}

/// Run one command in the project and parse what it printed.
///
/// Separate from [`collect`] so a test can drive it with a command whose
/// output it controls, rather than needing a compiler installed.
pub fn run_and_parse(
    project_root: &Path,
    command: &str,
    cancel: &AtomicBool,
    seconds: u64,
) -> Result<Report, DiagnosticsError> {
    use tauri_plugin_agent_tools::tools::proc;

    let started = std::time::Instant::now();
    let shell = proc::shell();
    let mut checker = std::process::Command::new(shell.program.clone());
    checker
        .args(shell.args.clone())
        .arg(command)
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    jan_utils::system::hide_console_window(&mut checker);
    let mut child = checker
        .spawn()
        .map_err(|e| {
            DiagnosticsError::new(
                DiagnosticsErrorKind::CheckerUnavailable,
                format!("the checker could not be started: {e}"),
            )
        })?;
    let pid = child.id();
    proc::register(pid);

    // Drained while the child runs, not after it exits. A compiler with many
    // errors fills the pipe buffer and blocks on write, and a reader that only
    // starts after `wait` would then always report a timeout -- on exactly the
    // input this feature exists for.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let drain = |pipe: Option<std::process::ChildStdout>| {
        std::thread::spawn(move || {
            use std::io::Read as _;
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout_reader = drain(out_pipe.take());
    let stderr_reader = {
        let pipe = err_pipe.take();
        std::thread::spawn(move || {
            use std::io::Read as _;
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };

    // Waited on in slices so cancellation and the deadline are both answered
    // promptly, and so the process tree is killed rather than left behind.
    let deadline = started + std::time::Duration::from_secs(seconds.max(1));
    let stopped = loop {
        match child.try_wait() {
            Ok(Some(_)) => break None,
            Ok(None) => {}
            Err(e) => {
                proc::unregister(pid);
                return Err(DiagnosticsError::new(
                    DiagnosticsErrorKind::CheckerUnavailable,
                    format!("the checker could not be waited on: {e}"),
                ));
            }
        }
        if cancel.load(Ordering::Relaxed) {
            break Some(DiagnosticsErrorKind::Cancelled);
        }
        if std::time::Instant::now() >= deadline {
            break Some(DiagnosticsErrorKind::TimedOut);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    if let Some(kind) = stopped {
        proc::kill_tree(pid);
        proc::unregister(pid);
        let _ = child.wait();
        // The readers end when the pipes close with the process.
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        return Err(DiagnosticsError::new(
            kind,
            match kind {
                DiagnosticsErrorKind::Cancelled => {
                    format!("the check (`{command}`) was cancelled with the run")
                }
                _ => format!("the check (`{command}`) outlived its {seconds}s limit"),
            },
        ));
    }
    proc::unregister(pid);
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&stderr));
    if text.len() > MAX_OUTPUT_BYTES {
        // On a character boundary: compilers echo source, source is not
        // always ASCII, and `String::truncate` panics in the middle of a
        // character -- which would lose the diagnostics rather than cut them.
        let cut = (0..=MAX_OUTPUT_BYTES)
            .rev()
            .find(|at| text.is_char_boundary(*at))
            .unwrap_or(0);
        text.truncate(cut);
    }
    let (diagnostics, truncated) = parse(project_root, &text);
    Ok(Report {
        command: command.to_string(),
        diagnostics,
        truncated,
        took_ms: started.elapsed().as_millis(),
    })
}

/// Read diagnostics out of a checker's output.
///
/// Handles the two shapes the checkers above produce -- rustc's short format
/// (`src/a.rs:3:5: error[E0432]: ...`) and the TypeScript compiler's
/// (`src/a.ts(3,5): error TS2304: ...`) -- and nothing else, because a parser
/// that guesses turns a line of prose into a diagnostic pointing at a file
/// that is fine.
pub fn parse(project_root: &Path, text: &str) -> (Vec<Diagnostic>, bool) {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut truncated = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed = parse_rust(project_root, line).or_else(|| parse_tsc(project_root, line));
        let Some(diagnostic) = parsed else { continue };
        if out.contains(&diagnostic) {
            continue;
        }
        if out.len() >= MAX_DIAGNOSTICS {
            truncated = true;
            break;
        }
        out.push(diagnostic);
    }
    out.sort();
    (out, truncated)
}

fn severity_of(word: &str) -> Option<Severity> {
    match word {
        "error" => Some(Severity::Error),
        "warning" => Some(Severity::Warning),
        _ => None,
    }
}

/// `src/a.rs:3:5: error[E0432]: unresolved import`
fn parse_rust(project_root: &Path, line: &str) -> Option<Diagnostic> {
    let (path, rest) = line.split_once(':')?;
    // A Windows drive letter (`C:\...`) splits at the wrong colon.
    let (path, rest) = if path.len() == 1 && rest.starts_with('\\') {
        let (drive_rest, after) = rest[1..].split_once(':')?;
        (format!("{path}:\\{drive_rest}"), after)
    } else {
        (path.to_string(), rest)
    };
    let (line_no, rest) = rest.split_once(':')?;
    let line_no: usize = line_no.trim().parse().ok()?;
    let (column, rest) = match rest.split_once(':') {
        Some((maybe_column, rest)) => match maybe_column.trim().parse::<usize>() {
            Ok(column) => (Some(column), rest),
            Err(_) => (None, rest),
        },
        None => (None, rest),
    };
    let rest = rest.trim();
    let (head, message) = rest.split_once(':')?;
    let head = head.trim();
    let (word, code) = match head.split_once('[') {
        Some((word, code)) => (word, Some(code.trim_end_matches(']').to_string())),
        None => (head, None),
    };
    Some(Diagnostic {
        path: relative(project_root, &path),
        line: line_no,
        column,
        severity: severity_of(word.trim())?,
        code,
        message: message.trim().to_string(),
    })
}

/// `src/a.ts(3,5): error TS2304: cannot find name`
fn parse_tsc(project_root: &Path, line: &str) -> Option<Diagnostic> {
    let (path, rest) = line.split_once('(')?;
    let (position, rest) = rest.split_once(british_close())?;
    let (line_no, column) = position.split_once(',')?;
    let rest = rest.trim_start_matches(':').trim();
    let (head, message) = rest.split_once(':')?;
    let mut words = head.split_whitespace();
    let severity = severity_of(words.next()?)?;
    Some(Diagnostic {
        path: relative(project_root, path),
        line: line_no.trim().parse().ok()?,
        column: column.trim().parse().ok(),
        severity,
        code: words.next().map(str::to_string),
        message: message.trim().to_string(),
    })
}

fn british_close() -> char {
    ')'
}

/// The compiler's path, as the project spells it.
fn relative(project_root: &Path, raw: &str) -> String {
    let raw = raw.trim();
    let path = PathBuf::from(raw);
    path.strip_prefix(project_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| raw.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan-diagnostics-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        for (path, body) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        root
    }

    #[test]
    fn a_compilers_own_lines_are_read_and_anything_else_is_left_alone() {
        let root = project("parse", &[("src/a.rs", "")]);
        let text = "\
src/a.rs:3:5: error[E0432]: unresolved import `foo`
src/a.rs:9:1: warning: unused variable: `x`
src/b.ts(12,7): error TS2304: Cannot find name 'Thing'.
   Compiling jan v0.1.0
warning: 1 warning emitted
this line is prose and points at nothing
";
        let (found, truncated) = parse(&root, text);
        assert!(!truncated);
        assert_eq!(found.len(), 3, "{found:?}");

        let rust_error = found.iter().find(|d| d.code.as_deref() == Some("E0432")).unwrap();
        assert_eq!(rust_error.path, "src/a.rs");
        assert_eq!((rust_error.line, rust_error.column), (3, Some(5)));
        assert_eq!(rust_error.severity, Severity::Error);
        assert!(rust_error.message.contains("unresolved import"));

        let warning = found.iter().find(|d| d.severity == Severity::Warning).unwrap();
        assert_eq!(warning.line, 9);
        assert!(warning.code.is_none(), "a warning with no code does not invent one");

        let ts = found.iter().find(|d| d.path == "src/b.ts").unwrap();
        assert_eq!((ts.line, ts.column), (12, Some(7)));
        assert_eq!(ts.code.as_deref(), Some("TS2304"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_diagnostic_twice_is_reported_once() {
        let root = project("dedupe", &[("src/a.rs", "")]);
        let line = "src/a.rs:3:5: error[E0432]: unresolved import `foo`\n";
        let (found, _) = parse(&root, &line.repeat(5));
        assert_eq!(found.len(), 1);
        // And past the bound it says it was cut.
        let many: String = (1..=MAX_DIAGNOSTICS + 10)
            .map(|n| format!("src/a.rs:{n}:1: error: broken\n"))
            .collect();
        let (found, truncated) = parse(&root, &many);
        assert_eq!(found.len(), MAX_DIAGNOSTICS);
        assert!(truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// AH-064: what goes back to the model is what this run touched.
    #[test]
    fn only_the_files_the_run_changed_are_handed_back() {
        let root = project("touched", &[("src/a.rs", "")]);
        let text = "\
src/a.rs:3:5: error[E0432]: unresolved import `foo`
src/elsewhere.rs:1:1: error: something the run never touched
";
        let (diagnostics, _) = parse(&root, text);
        let report = Report {
            command: "cargo check".into(),
            diagnostics,
            truncated: false,
            took_ms: 1,
        };
        let mine = report.for_files(&["src/a.rs".to_string()]);
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].path, "src/a.rs");

        let rendered = report.render_for(&["src/a.rs".to_string()]).expect("something to say");
        assert!(rendered.contains("src/a.rs:3:5"), "{rendered}");
        assert!(!rendered.contains("elsewhere"), "{rendered}");
        // Nothing touched, nothing said -- rather than an empty heading.
        assert!(report.render_for(&[]).is_none());
        assert!(report.render_for(&["src/untouched.rs".to_string()]).is_none());
        // A Windows spelling of the same file is the same file.
        assert_eq!(report.for_files(&["src\\a.rs".to_string()]).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A compiler with a great deal to say does not deadlock the reader, and
    /// a cut in the middle of a character does not lose what was read.
    #[test]
    fn a_very_noisy_check_is_read_rather_than_timing_out() {
        let root = project("noisy", &[("src/a.rs", "")]);
        // Far more than a pipe buffer (~64KB), printed by a shell either
        // flavour of host can run.
        // Chosen by the shell that will actually run it, not by the host: on
        // Windows this host still selects git-bash where it can.
        let posix = tauri_plugin_agent_tools::tools::proc::shell().flavor
            == tauri_plugin_agent_tools::tools::proc::ShellFlavor::Posix;
        let command = if !posix {
            "for($i=0; $i -lt 4000; $i++) { echo \"src/a.rs:$($i+1):1: error: broken thing number $i with padding padding padding padding padding\" }"
        } else {
            "for i in $(seq 1 4000); do echo \"src/a.rs:$i:1: error: broken thing number $i with padding padding padding padding padding\"; done"
        };
        let started = std::time::Instant::now();
        let report = run_and_parse(&root, command, &AtomicBool::new(false), 60)
            .expect("a noisy check still finishes");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(55),
            "the reader deadlocked and the deadline stopped it"
        );
        assert_eq!(report.diagnostics.len(), MAX_DIAGNOSTICS, "{}", report.diagnostics.len());
        assert!(report.truncated);

        // And a cut that lands inside a character keeps what came before it.
        let mut text = "é".repeat(MAX_OUTPUT_BYTES);
        if text.len() > MAX_OUTPUT_BYTES {
            let cut = (0..=MAX_OUTPUT_BYTES)
                .rev()
                .find(|at| text.is_char_boundary(*at))
                .unwrap_or(0);
            text.truncate(cut);
        }
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_that_does_not_say_how_it_is_checked_gets_no_command() {
        let bare = project("bare", &[("README.md", "# nothing here\n")]);
        assert_eq!(checker(&bare), None);
        let refused = collect(&bare, &AtomicBool::new(false), 5).unwrap_err();
        assert_eq!(refused.kind, DiagnosticsErrorKind::NoChecker);
        let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&refused).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::Unsupported
        );

        // A TypeScript project that does not depend on a compiler is not told
        // to download one.
        let no_dep = project(
            "no-dep",
            &[("tsconfig.json", "{}"), ("package.json", "{\"name\":\"x\"}")],
        );
        assert_eq!(checker(&no_dep), None);

        let with_dep = project(
            "with-dep",
            &[
                ("tsconfig.json", "{}"),
                ("package.json", "{\"devDependencies\":{\"typescript\":\"5.0.0\"}}"),
                ("yarn.lock", "# yarn lockfile v1\n"),
            ],
        );
        assert_eq!(checker(&with_dep).as_deref(), Some("yarn exec tsc --noEmit"));

        let rust = project("rust", &[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        assert!(checker(&rust).unwrap().starts_with("cargo check"));

        for dir in [bare, no_dep, with_dep, rust] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn a_project_has_to_ask_before_its_compiler_is_run() {
        let off = project("off", &[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        assert!(!enabled(&off), "diagnostics must be off unless asked for");

        let asked = project(
            "on",
            &[
                ("Cargo.toml", "[package]\nname = \"x\"\n"),
                (".jan/agent/agent.toml", "[tools]\ndiagnostics = true\n"),
            ],
        );
        assert!(enabled(&asked));

        let said_no = project(
            "said-no",
            &[(".jan/agent/agent.toml", "[tools]\ndiagnostics = false\n")],
        );
        assert!(!enabled(&said_no));
        for dir in [off, asked, said_no] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// A real command, really run, with its output really parsed.
    #[test]
    fn a_check_that_prints_diagnostics_is_read_and_one_that_hangs_is_stopped() {
        let root = project("run", &[("src/a.rs", "")]);
        // Printed by the shell, in a way both a POSIX shell and PowerShell
        // agree on.
        let report = run_and_parse(
            &root,
            "echo src/a.rs:3:5: error[E0432]: unresolved import",
            &AtomicBool::new(false),
            30,
        )
        .expect("the command runs");
        assert_eq!(report.diagnostics.len(), 1, "{report:?}");
        assert_eq!(report.diagnostics[0].line, 3);

        // And one that does not finish is stopped, not waited out.
        let started = std::time::Instant::now();
        let stopped = run_and_parse(&root, "sleep 30", &AtomicBool::new(false), 1).unwrap_err();
        assert_eq!(stopped.kind, DiagnosticsErrorKind::TimedOut);
        assert!(started.elapsed() < std::time::Duration::from_secs(20));

        // A cancelled run stops it too, and says which of the two it was.
        let cancel = AtomicBool::new(true);
        let cancelled = run_and_parse(&root, "sleep 30", &cancel, 60).unwrap_err();
        assert_eq!(cancelled.kind, DiagnosticsErrorKind::Cancelled);
        let _ = std::fs::remove_dir_all(&root);
    }
}
