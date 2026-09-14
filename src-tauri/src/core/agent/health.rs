//! A one-shot look at whether a project is in working order (AH-072).
//!
//! Before changing a repository it is worth knowing what was already broken:
//! an agent that starts work in a tree whose tests were failing before it
//! arrived will spend the run fixing somebody else's problem, or -- worse --
//! conclude that its own change caused it.
//!
//! `flint cli agent health` finds the project's own checks, runs them, and says
//! what happened. The rules it keeps:
//!
//! * **Only commands the project declares.** A `package.json` script named
//!   `test` is a test command; a `Cargo.toml` means `cargo check` and `cargo
//!   test`. Nothing is guessed from the shape of the directory, and a project
//!   with no declared checks is reported as having none rather than having a
//!   command invented for it.
//! * **Every check is bounded**, and a check that runs past its deadline is
//!   reported as having done so -- never as a failure it did not report, and
//!   never left running.
//! * **What failed is quoted, not summarised.** The first lines the command
//!   actually printed are what a person needs; a paraphrase of a compiler
//!   error is a second thing to verify.
//! * **Dependency health is what can be known offline**: how many
//!   dependencies there are, which declare no licence, and which are present
//!   at more than one version. Anything that needs a registry is not claimed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

/// How long one check may run before it is stopped.
pub const CHECK_DEADLINE: Duration = Duration::from_secs(600);
/// How much of a failing command's output is quoted back.
pub const QUOTED_LINES: usize = 12;

/// What a check is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Build,
    Test,
    Lint,
    /// Not a command: what the dependency tree itself says.
    Dependencies,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Build => "build",
            Kind::Test => "test",
            Kind::Lint => "lint",
            Kind::Dependencies => "dependencies",
        }
    }

    /// Read a `--only` selection.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "build" => Ok(Kind::Build),
            "test" => Ok(Kind::Test),
            "lint" => Ok(Kind::Lint),
            "dependencies" | "deps" => Ok(Kind::Dependencies),
            other => Err(format!(
                "{other:?} is not a check; use build, test, lint or dependencies"
            )),
        }
    }
}

/// One check this project declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub kind: Kind,
    /// The program and its arguments, as they will be run.
    pub command: Vec<String>,
    /// What in the project says this is its check.
    pub evidence: String,
}

/// How a check ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "outcome", content = "detail")]
pub enum Outcome {
    Passed,
    Failed(String),
    /// It ran past its deadline and was stopped. Not a failure it reported.
    TimedOut,
    /// It could not be started at all.
    Unavailable(String),
}

/// One check, and what it did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Result_ {
    pub check: Check,
    pub outcome: Outcome,
    pub took_ms: u128,
}

/// The scan.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub results: Vec<Result_>,
    /// What the dependency tree says about itself, when it was looked at.
    pub dependencies: Option<DependencyHealth>,
}

/// What can be known about a dependency tree without asking a registry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyHealth {
    pub total: usize,
    /// Dependencies declaring no licence, by name.
    pub undeclared_licence: Vec<String>,
    /// Crates or packages present at more than one version, with the versions.
    pub duplicated: BTreeMap<String, Vec<String>>,
}

/// An absolute path without Windows' verbatim prefix.
///
/// `canonicalize` returns one, and it is correct but unreadable: a plan a
/// person is meant to read should show the path they would type.
fn plain_absolute(path: &Path) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical.clone(),
    }
}

fn failed(kind: ErrorKind, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message).at(Stage::Startup)
}

fn package_scripts(project_root: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(project_root.join("package.json")) else {
        return BTreeMap::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return BTreeMap::new();
    };
    json.get("scripts")
        .and_then(|s| s.as_object())
        .map(|scripts| {
            scripts
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Which package runner a project uses, on the evidence of its own lockfile.
///
/// Guessing wrong here is not harmless: `npm run` in a yarn project can
/// resolve a different dependency tree than the one the project installed.
fn package_runner(project_root: &Path) -> Option<(&'static str, &'static str)> {
    for (lockfile, program) in [
        ("yarn.lock", "yarn"),
        ("pnpm-lock.yaml", "pnpm"),
        ("package-lock.json", "npm"),
    ] {
        if project_root.join(lockfile).is_file() {
            return Some((program, lockfile));
        }
    }
    // A package.json with no lockfile still declares scripts; npm is the
    // runner that ships with node itself.
    project_root
        .join("package.json")
        .is_file()
        .then_some(("npm", "package.json"))
}

/// The checks this project declares (AH-072). Nothing is invented: a project
/// with no declared checks has none.
pub fn checks(project_root: &Path) -> Vec<Check> {
    let mut out = Vec::new();
    // Absolute, for the same reason the licence scan uses an absolute one:
    // each check runs with its working directory set to the project.
    let cargo_manifest = ["Cargo.toml", "src-tauri/Cargo.toml"]
        .iter()
        .map(|p| project_root.join(p))
        .find(|p| p.is_file())
        .map(|p| plain_absolute(&p));
    if let Some(manifest) = cargo_manifest {
        let relative = manifest
            .strip_prefix(plain_absolute(project_root))
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| manifest.clone())
            .to_string_lossy()
            .to_string();
        let at = |args: &[&str]| {
            let mut command: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            command.push("--manifest-path".to_string());
            command.push(manifest.to_string_lossy().to_string());
            command
        };
        out.push(Check {
            kind: Kind::Build,
            command: at(&["cargo", "check", "--all-targets"]),
            evidence: relative.clone(),
        });
        out.push(Check {
            kind: Kind::Test,
            // `--no-run` builds the tests without running them: a health scan
            // reports whether the project is in working order, and running an
            // unknown project's whole suite is a different, much longer thing
            // to have asked for.
            command: at(&["cargo", "test", "--no-run"]),
            evidence: relative.clone(),
        });
        out.push(Check {
            kind: Kind::Lint,
            command: at(&["cargo", "clippy", "--all-targets"]),
            evidence: relative,
        });
    }
    if let Some((runner, lockfile)) = package_runner(project_root) {
        let scripts = package_scripts(project_root);
        for (kind, names) in [
            (Kind::Build, ["build", "compile"].as_slice()),
            (Kind::Test, ["test"].as_slice()),
            (Kind::Lint, ["lint", "typecheck"].as_slice()),
        ] {
            for name in names {
                if scripts.contains_key(*name) {
                    out.push(Check {
                        kind,
                        command: vec![runner.to_string(), "run".to_string(), (*name).to_string()],
                        evidence: format!("package.json scripts.{name} ({lockfile})"),
                    });
                }
            }
        }
    }
    out
}

/// Run one check, bounded.
fn run(check: &Check, project_root: &Path) -> Result_ {
    let started = Instant::now();
    let mut command = std::process::Command::new(&check.command[0]);
    command
        .args(&check.command[1..])
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let spawned = command.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            return Result_ {
                check: check.clone(),
                outcome: Outcome::Unavailable(format!("{} could not be started: {e}", check.command[0])),
                took_ms: started.elapsed().as_millis(),
            }
        }
    };
    // Drained while it runs: a compiler is perfectly capable of filling a pipe
    // and stopping, which would show up as a timeout nobody could explain.
    let drain = |handle: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut handle) = handle {
                use std::io::Read;
                let _ = handle.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|h| Box::new(h) as Box<dyn std::io::Read + Send>));
    let stderr = drain(child.stderr.take().map(|h| Box::new(h) as Box<dyn std::io::Read + Send>));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= CHECK_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                return Result_ {
                    check: check.clone(),
                    outcome: Outcome::Unavailable(format!("it could not be waited on: {e}")),
                    took_ms: started.elapsed().as_millis(),
                }
            }
        }
    };
    let out = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).to_string();
    let outcome = match status {
        None => Outcome::TimedOut,
        Some(status) if status.success() => Outcome::Passed,
        Some(_) => {
            // Quoted, not summarised: a paraphrase of a compiler error is a
            // second thing to verify.
            let interesting: Vec<&str> = err
                .lines()
                .chain(out.lines())
                .filter(|l| !l.trim().is_empty())
                .take(QUOTED_LINES)
                .collect();
            Outcome::Failed(tauri_plugin_agent_tools::harness_error::scrub(
                &interesting.join("\n"),
            ))
        }
    };
    Result_ {
        check: check.clone(),
        outcome,
        took_ms: started.elapsed().as_millis(),
    }
}

/// What the dependency tree says about itself, offline.
fn dependency_health(project_root: &Path) -> Result<DependencyHealth, HarnessError> {
    // The same reader the licence scan uses, so the two can never disagree
    // about what is installed.
    let report = crate::core::agent::licenses::scan(project_root, &[])?;
    let mut versions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for dependency in &report.dependencies {
        versions
            .entry(dependency.name.clone())
            .or_default()
            .push(dependency.version.clone());
    }
    let duplicated = versions
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|(name, mut v)| {
            v.sort();
            v.dedup();
            (name, v)
        })
        .filter(|(_, v)| v.len() > 1)
        .collect();
    Ok(DependencyHealth {
        total: report.dependencies.len(),
        undeclared_licence: report.undeclared.iter().map(|d| d.name.clone()).collect(),
        duplicated,
    })
}

/// Run the project's own checks (AH-072).
///
/// `only` narrows what runs; empty runs everything declared.
pub fn scan(project_root: &Path, only: &[Kind]) -> Result<Report, HarnessError> {
    if !project_root.is_dir() {
        return Err(failed(
            ErrorKind::NotFound,
            format!("{} is not a directory", project_root.display()),
        ));
    }
    let wanted = |kind: Kind| only.is_empty() || only.contains(&kind);
    let mut report = Report::default();
    for check in checks(project_root) {
        if !wanted(check.kind) {
            continue;
        }
        report.results.push(run(&check, project_root));
    }
    if wanted(Kind::Dependencies) {
        report.dependencies = Some(dependency_health(project_root)?);
    }
    Ok(report)
}

/// What would run, without running it.
pub fn render_plan(checks: &[Check]) -> String {
    if checks.is_empty() {
        return "this project declares no checks\n".to_string();
    }
    let mut out = String::new();
    for check in checks {
        out.push_str(&format!(
            "  {:<12} {}   ({})\n",
            check.kind.label(),
            check.command.join(" "),
            check.evidence
        ));
    }
    out
}

/// The scan, as a person reads it.
pub fn render(report: &Report) -> String {
    let mut out = String::new();
    if report.results.is_empty() {
        out.push_str("no checks were run\n");
    }
    for result in &report.results {
        let (mark, detail) = match &result.outcome {
            Outcome::Passed => ("passed", None),
            Outcome::Failed(quoted) => ("FAILED", Some(quoted.as_str())),
            Outcome::TimedOut => ("timed out", None),
            Outcome::Unavailable(why) => ("not run", Some(why.as_str())),
        };
        out.push_str(&format!(
            "  {:<12} {mark}  ({} ms)  {}\n",
            result.check.kind.label(),
            result.took_ms,
            result.check.command.join(" ")
        ));
        if let Some(detail) = detail {
            for line in detail.lines() {
                out.push_str(&format!("      {line}\n"));
            }
        }
    }
    if let Some(dependencies) = &report.dependencies {
        out.push_str(&format!(
            "  {:<12} {} dependenc(ies), {} declaring no licence, {} at more than one version\n",
            "dependencies",
            dependencies.total,
            dependencies.undeclared_licence.len(),
            dependencies.duplicated.len()
        ));
        for (name, versions) in dependencies.duplicated.iter().take(10) {
            out.push_str(&format!("      {name}: {}\n", versions.join(", ")));
        }
    }
    out
}

/// Whether anything in the scan is a problem somebody should look at.
pub fn healthy(report: &Report) -> bool {
    report
        .results
        .iter()
        .all(|r| matches!(r.outcome, Outcome::Passed))
}

/// Where a scan's own record is kept, for the surfaces that want one.
pub fn report_path(project_root: &Path) -> PathBuf {
    project_root.join(".jan").join("agent").join("health.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_health_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("project");
        root
    }

    /// A project that declares no checks has none. Nothing is invented from
    /// the shape of the directory.
    #[test]
    fn a_project_that_declares_no_checks_has_none() {
        let root = temp_project("bare");
        std::fs::write(root.join("main.py"), "print(1)\n").unwrap();
        assert!(checks(&root).is_empty());
        assert_eq!(render_plan(&checks(&root)), "this project declares no checks\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The checks come from what the project declares: its manifest, and the
    /// scripts its package.json actually has.
    #[test]
    fn the_checks_are_the_ones_the_project_declares() {
        let root = temp_project("declared");
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"x","scripts":{"test":"vitest","lint":"eslint ."}}"#,
        )
        .unwrap();
        std::fs::write(root.join("yarn.lock"), "").unwrap();
        let found = checks(&root);
        let kinds: Vec<Kind> = found.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, vec![Kind::Test, Kind::Lint], "{found:#?}");
        // The runner follows the lockfile: `npm run` in a yarn project can
        // resolve a different tree than the one that was installed.
        assert_eq!(found[0].command[0], "yarn");
        assert!(found[0].evidence.contains("yarn.lock"), "{:?}", found[0]);
        // A script the project does not have is not a check it has.
        assert!(!found.iter().any(|c| c.command.contains(&"build".to_string())));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A Rust crate's checks are its own, and the test check builds the tests
    /// rather than running an unknown project's whole suite.
    #[test]
    fn a_crate_is_checked_with_cargo() {
        let root = temp_project("crate");
        std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        let found = checks(&root);
        assert_eq!(found.len(), 3, "{found:#?}");
        assert!(found[0].command.starts_with(&["cargo".to_string(), "check".to_string()]));
        assert!(found[1].command.contains(&"--no-run".to_string()), "{:?}", found[1]);
        assert!(found[2].command.contains(&"clippy".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A check that fails is reported with what it printed, not a paraphrase;
    /// one that cannot be started is reported as not run.
    #[test]
    fn a_failing_check_quotes_what_it_printed() {
        let root = temp_project("failing");
        let failing = Check {
            kind: Kind::Test,
            command: if cfg!(windows) {
                vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "import sys; print('the thing did not work'); sys.exit(3)".to_string(),
                ]
            } else {
                vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "echo 'the thing did not work'; exit 3".to_string(),
                ]
            },
            evidence: "the test".to_string(),
        };
        match run(&failing, &root).outcome {
            Outcome::Failed(quoted) => {
                assert!(quoted.contains("the thing did not work"), "{quoted}")
            }
            other => panic!("expected a failure, got {other:?}"),
        }

        let missing = Check {
            kind: Kind::Build,
            command: vec!["this-program-does-not-exist-anywhere".to_string()],
            evidence: "nothing".to_string(),
        };
        match run(&missing, &root).outcome {
            Outcome::Unavailable(why) => assert!(why.contains("could not be started"), "{why}"),
            other => panic!("expected unavailable, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Dependency health is what can be known offline: how many there are,
    /// which declare no licence, and which are here twice.
    #[test]
    fn dependency_health_is_what_can_be_known_without_a_registry() {
        let root = temp_project("deps");
        let write = |name: &str, dir: &str, version: &str, license: Option<&str>| {
            let path = root.join("node_modules").join(dir);
            std::fs::create_dir_all(&path).unwrap();
            let mut json = serde_json::json!({ "name": name, "version": version });
            if let Some(license) = license {
                json["license"] = serde_json::json!(license);
            }
            std::fs::write(path.join("package.json"), json.to_string()).unwrap();
        };
        write("one", "one", "1.0.0", Some("MIT"));
        write("two", "two", "2.0.0", None);
        // The same package, at a second version, the way a nested install
        // leaves one.
        write("one", "nested-one", "1.4.0", Some("MIT"));

        let health = dependency_health(&root).expect("read");
        assert_eq!(health.total, 3);
        assert_eq!(health.undeclared_licence, vec!["two".to_string()]);
        assert_eq!(
            health.duplicated.get("one").cloned(),
            Some(vec!["1.0.0".to_string(), "1.4.0".to_string()])
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A selection runs only what was selected, and a word that is not a check
    /// is refused by name.
    #[test]
    fn a_selection_runs_only_what_was_selected() {
        let root = temp_project("only");
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"x","scripts":{"test":"exit 0"}}"#,
        )
        .unwrap();
        let report = scan(&root, &[Kind::Dependencies]).expect("scanned");
        assert!(report.results.is_empty(), "no command was run");
        assert!(report.dependencies.is_some());

        assert_eq!(Kind::parse("deps"), Ok(Kind::Dependencies));
        let err = Kind::parse("everything").unwrap_err();
        assert!(err.contains("is not a check"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
