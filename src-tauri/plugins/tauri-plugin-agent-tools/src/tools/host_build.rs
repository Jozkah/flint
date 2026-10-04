//! The `host_build` tool: run Gradle, Maven or .NET in the project folder,
//! outside the sandbox.
//!
//! These cannot run in the `bash` AppContainer. Gradle and Maven run a JVM
//! installed under the user's profile, keep a cache in `~/.gradle` or `~/.m2`
//! the container cannot write, and Gradle talks to its daemon over loopback,
//! which the container blocks. `dotnet` needs its SDK folders and NuGet cache
//! the same way. So an agent could read a build file but never build.
//!
//! A build runs the project's own scripts, which is arbitrary code with the
//! user's rights. So the gate asks about every call, each time, and the app
//! shows the exact command and folder in the question. What this module adds is
//! confinement: the program is one of a short list, the arguments are an argv
//! array (never a shell string), and the folder must be one the run may write
//! to, so a build cannot be pointed at some other part of the disk. Output is
//! redacted and bounded, and a build that has not finished by its limit is
//! stopped.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::tools::git_tool::{canon, in_jan_dir, inside, Roots};

const DEFAULT_TIMEOUT_SECS: u64 = 600;
const MAX_TIMEOUT_SECS: u64 = 1800;
const MAX_ARGS: usize = 40;
const HEAD_BYTES: usize = 8 * 1024;
const TAIL_BYTES: usize = 48 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    Gradle,
    Gradlew,
    Mvn,
    Mvnw,
    Dotnet,
}

impl Program {
    pub fn parse(word: &str) -> Option<Self> {
        Some(match word {
            "gradle" => Program::Gradle,
            "gradlew" => Program::Gradlew,
            "mvn" => Program::Mvn,
            "mvnw" => Program::Mvnw,
            "dotnet" => Program::Dotnet,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Program::Gradle => "gradle",
            Program::Gradlew => "gradlew",
            Program::Mvn => "mvn",
            Program::Mvnw => "mvnw",
            Program::Dotnet => "dotnet",
        }
    }

    fn is_gradle(self) -> bool {
        matches!(self, Program::Gradle | Program::Gradlew)
    }

    /// The wrapper script a project carries, which must be in the folder.
    fn wrapper(self) -> Option<&'static str> {
        match (self, cfg!(windows)) {
            (Program::Gradlew, true) => Some("gradlew.bat"),
            (Program::Gradlew, false) => Some("gradlew"),
            (Program::Mvnw, true) => Some("mvnw.cmd"),
            (Program::Mvnw, false) => Some("mvnw"),
            _ => None,
        }
    }

    /// The installed program's file name, found on PATH.
    fn installed(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Program::Gradle, true) => "gradle.bat",
            (Program::Mvn, true) => "mvn.cmd",
            (Program::Dotnet, true) => "dotnet.exe",
            (Program::Gradle, false) => "gradle",
            (Program::Mvn, false) => "mvn",
            _ => "dotnet",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub program: Program,
    pub args: Vec<String>,
    pub timeout: Duration,
}

impl Plan {
    /// The command as the user is shown it.
    pub fn display(&self) -> String {
        std::iter::once(self.program.name().to_string())
            .chain(self.args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn plan(args: &Value) -> Result<Plan, String> {
    let program = args
        .get("program")
        .and_then(Value::as_str)
        .and_then(Program::parse)
        .ok_or("ERROR: host_build needs a 'program': gradle, gradlew, mvn, mvnw or dotnet.")?;
    let list = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err("ERROR: host_build 'args' must be a list of strings.".into()),
    };
    if list.len() > MAX_ARGS {
        return Err(format!("ERROR: host_build takes at most {MAX_ARGS} arguments."));
    }
    let mut words = Vec::new();
    for item in &list {
        let word = item.as_str().ok_or("ERROR: every host_build argument must be a string.")?;
        if word.is_empty() || word.len() > 500 || word.chars().any(|c| c.is_control()) {
            return Err("ERROR: a host_build argument is empty, too long or holds a control character.".into());
        }
        words.push(word.to_string());
    }
    let timeout = match args.get("timeout_secs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(v) => v
            .as_u64()
            .ok_or("ERROR: host_build 'timeout_secs' must be a whole number.")?
            .clamp(10, MAX_TIMEOUT_SECS),
    };
    Ok(Plan { program, args: words, timeout: Duration::from_secs(timeout) })
}

/// The folder the build runs in: one of the run's writable folders.
pub fn resolve_cwd(raw: Option<&str>, roots: &Roots) -> Result<PathBuf, String> {
    let base = roots
        .default_base()
        .cloned()
        .ok_or_else(|| "no project folder is available for this run".to_string())?;
    let wanted = match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => base.join(p),
        None => base,
    };
    let cwd = canon(&wanted).ok_or_else(|| format!("`{}` does not exist", wanted.display()))?;
    if !cwd.is_dir() {
        return Err(format!("`{}` is not a folder", cwd.display()));
    }
    if in_jan_dir(&cwd) {
        return Err("the agent's own `.jan` folder is not a place to build".into());
    }
    if inside(&cwd, &roots.write()) {
        return Ok(cwd);
    }
    Err(format!(
        "`{}` is not a folder this run may write to; builds run only in the project folder, worktree or workspace. Ask the user for write access to it.",
        cwd.display()
    ))
}

/// The head and the tail of a long build log: the start says what ran, the end
/// says whether it worked.
fn trimmed(text: &str) -> String {
    let text = text.trim();
    if text.len() <= HEAD_BYTES + TAIL_BYTES {
        return text.to_string();
    }
    let mut head = HEAD_BYTES;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n[... {} bytes of the log left out ...]\n{}", &text[..head], tail - head, &text[tail..])
}

pub async fn run(args: &Value, ctx: &crate::tools::ToolContext<'_>) -> String {
    let plan = match plan(args) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let roots = Roots::from_ctx(ctx);
    let cwd = match resolve_cwd(args.get("cwd").and_then(Value::as_str), &roots) {
        Ok(c) => c,
        Err(e) => return format!("ERROR: host_build: {e}"),
    };
    execute(&plan, &cwd).await
}

async fn execute(plan: &Plan, cwd: &Path) -> String {
    use std::process::Stdio;
    let program: PathBuf = match plan.program.wrapper() {
        Some(wrapper) => {
            let script = cwd.join(wrapper);
            if !script.is_file() {
                return format!(
                    "ERROR: host_build: {} is not in {}. Use `{}` for an installed copy, or run it from the folder that has the wrapper.",
                    wrapper,
                    cwd.display(),
                    plan.program.name().trim_end_matches('w')
                );
            }
            script
        }
        None => PathBuf::from(plan.program.installed()),
    };
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&plan.args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Nothing here should wait for a keypress or draw a progress bar.
        .env("TERM", "dumb")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_NOLOGO", "1");
    if plan.program.is_gradle() {
        // The daemon would keep the output pipes open after the build ends, and
        // the call would wait for it until the time limit.
        let existing = std::env::var("GRADLE_OPTS").unwrap_or_default();
        cmd.env("GRADLE_OPTS", format!("{existing} -Dorg.gradle.daemon=false").trim().to_string());
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let shown = plan.display();
    match tokio::time::timeout(plan.timeout, cmd.output()).await {
        Err(_) => format!(
            "ERROR: `{shown}` had not finished after {} seconds and was stopped. Run a smaller task, or raise timeout_secs (up to {MAX_TIMEOUT_SECS}).",
            plan.timeout.as_secs()
        ),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => format!(
            "ERROR: `{}` was not found. It is not installed on this computer, or not on its PATH.",
            program.display()
        ),
        Ok(Err(e)) => format!("ERROR: could not start `{shown}`: {e}"),
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let mut log = stdout.trim().to_string();
            if !stderr.trim().is_empty() {
                log = format!("{log}\n{}", stderr.trim()).trim().to_string();
            }
            let log = crate::secrets::redact_secrets(&trimmed(&log));
            let code = out.status.code().map_or("none".to_string(), |c| c.to_string());
            if out.status.success() {
                format!("`{shown}` finished (exit code {code}).\n{log}")
            } else {
                format!("ERROR: `{shown}` failed (exit code {code}).\n{log}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_listed_programs_run() {
        for p in ["gradle", "gradlew", "mvn", "mvnw", "dotnet"] {
            assert!(plan(&json!({ "program": p })).is_ok(), "{p}");
        }
        for p in ["bash", "cmd", "powershell", "npm", "java", "gradle.bat", "../gradlew", ""] {
            assert!(plan(&json!({ "program": p })).is_err(), "{p}");
        }
        assert!(plan(&json!({})).is_err());
    }

    #[test]
    fn arguments_are_an_argv_list() {
        let p = plan(&json!({ "program": "gradlew", "args": ["build", "-x", "test", "--info"] })).unwrap();
        assert_eq!(p.args, ["build", "-x", "test", "--info"]);
        assert_eq!(p.display(), "gradlew build -x test --info");
        assert!(plan(&json!({ "program": "gradle", "args": "build" })).is_err());
        assert!(plan(&json!({ "program": "gradle", "args": [1] })).is_err());
        assert!(plan(&json!({ "program": "gradle", "args": [""] })).is_err());
        assert!(plan(&json!({ "program": "gradle", "args": ["a\nb"] })).is_err());
        assert!(plan(&json!({ "program": "gradle", "args": vec!["x"; 41] })).is_err());
    }

    #[test]
    fn the_time_limit_is_bounded() {
        assert_eq!(plan(&json!({ "program": "mvn" })).unwrap().timeout, Duration::from_secs(600));
        assert_eq!(plan(&json!({ "program": "mvn", "timeout_secs": 999999 })).unwrap().timeout, Duration::from_secs(1800));
        assert_eq!(plan(&json!({ "program": "mvn", "timeout_secs": 1 })).unwrap().timeout, Duration::from_secs(10));
    }

    #[test]
    fn a_long_log_keeps_its_start_and_its_end() {
        let log = format!("START{}END", "x".repeat(HEAD_BYTES + TAIL_BYTES + 10_000));
        let out = trimmed(&log);
        assert!(out.starts_with("START") && out.ends_with("END") && out.contains("left out"));
        assert!(out.len() < log.len());
    }

    #[test]
    fn a_build_runs_only_in_a_writable_folder() {
        let dir = std::env::temp_dir().join(format!("flint-host-build-{}", std::process::id()));
        let inner = dir.join("app");
        let outside = std::env::temp_dir().join(format!("flint-host-build-out-{}", std::process::id()));
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let roots = Roots { granted: vec![dir.clone()], workspace: vec![], read: vec![] };
        assert!(resolve_cwd(None, &roots).is_ok());
        assert!(resolve_cwd(Some("app"), &roots).is_ok());
        assert!(resolve_cwd(Some("missing"), &roots).is_err());
        assert!(resolve_cwd(Some(&outside.to_string_lossy()), &roots).unwrap_err().contains("may write to"));
        assert!(resolve_cwd(Some("../"), &roots).is_err());
        let read_only = Roots { granted: vec![], workspace: vec![], read: vec![dir.clone()] };
        assert!(resolve_cwd(None, &read_only).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn a_missing_wrapper_is_said_plainly() {
        let dir = std::env::temp_dir().join(format!("flint-host-build-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = plan(&json!({ "program": "gradlew", "args": ["build"] })).unwrap();
        let out = execute(&p, &dir).await;
        assert!(out.contains("is not in"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
