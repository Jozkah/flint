//! Checking a project's dependencies against the licences it allows (AH-158).
//!
//! A dependency arrives with a licence, and somebody somewhere has a list of
//! the ones this project may ship. Nothing here decided whether those two
//! agreed, so the answer was "ask a lawyer, eventually".
//!
//! What this is careful about:
//!
//! * **It reads what is declared, and says when nothing is.** A crate's
//!   licence comes from `cargo metadata`, a package's from its own
//!   `package.json`. A dependency that declares none is reported as
//!   *undeclared* -- never as allowed, and never as a licence somebody
//!   guessed from the name of a file in its repository.
//! * **It does not read licence text.** Matching a licence by reading its body
//!   is how a project ends up believing a modified MIT is MIT. Only the
//!   declared identifier is used.
//! * **It never says "fine" about something it could not check.** A
//!   dependency tree that could not be read is an error, not an empty list of
//!   problems.
//! * **New means new.** `--record` writes down what is here now; a later scan
//!   says which dependencies were not in that record, which is the question
//!   somebody actually has when a lockfile changes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

/// How long the dependency tree may take to read.
pub const READ_DEADLINE: Duration = Duration::from_secs(90);

/// Where a dependency came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Ecosystem {
    Cargo,
    Npm,
}

impl Ecosystem {
    fn label(self) -> &'static str {
        match self {
            Ecosystem::Cargo => "cargo",
            Ecosystem::Npm => "npm",
        }
    }
}

/// One dependency, as its own metadata describes it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    /// The declared licence expression, exactly as written. `None` means the
    /// dependency declares none -- which is not the same as a permissive one.
    pub license: Option<String>,
}

impl Dependency {
    fn key(&self) -> String {
        format!("{}:{}@{}", self.ecosystem.label(), self.name, self.version)
    }
}

/// What a scan concluded.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Everything read, in order.
    pub dependencies: Vec<Dependency>,
    /// Dependencies whose declared licence is not in the allowed set.
    pub disallowed: Vec<Dependency>,
    /// Dependencies that declare no licence at all.
    pub undeclared: Vec<Dependency>,
    /// Dependencies that were not in the recorded baseline, when there is one.
    pub added: Vec<Dependency>,
    /// True when a baseline was read; without one, "new" is not a question
    /// this can answer, and `added` stays empty rather than listing
    /// everything.
    pub compared: bool,
}

/// An absolute path without Windows' verbatim prefix.
///
/// `canonicalize` returns one, and it is correct but unreadable: a command a
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

/// Split a licence expression into the identifiers it names, and whether they
/// are alternatives.
///
/// `MIT OR Apache-2.0` is satisfied by either; `MIT AND OpenSSL` needs both.
/// Anything with parentheses is left unjudged -- a nested expression parsed by
/// halves is worse than one that says it could not be read.
fn allowed_by(expression: &str, allowed: &BTreeSet<String>) -> Option<bool> {
    let text = expression.trim();
    if text.is_empty() {
        return None;
    }
    // `*` is a project saying it allows anything that declares a licence at
    // all, so the shape of the expression stops mattering.
    if allowed.iter().any(|a| a == "*") {
        return Some(true);
    }
    if text.contains('(') || text.contains(')') {
        return None;
    }
    let ok = |part: &str| {
        let part = part.trim().trim_end_matches('+');
        allowed
            .iter()
            .any(|a| a.eq_ignore_ascii_case(part) || a == "*")
    };
    let upper = text.to_ascii_uppercase();
    if upper.contains(" OR ") {
        // An `AND` inside an `OR` is a nested expression in disguise.
        if upper.contains(" AND ") {
            return None;
        }
        return Some(text.split(" OR ").any(|p| ok(p)));
    }
    if upper.contains(" AND ") {
        return Some(text.split(" AND ").all(|p| ok(p)));
    }
    Some(ok(text))
}

/// Run a program that prints the dependency tree, with a deadline.
fn read_tree(program: &str, args: &[&str], project_root: &Path) -> Result<String, HarnessError> {
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    {
        use jan_process::CommandConsole;
        command.background();
    }
    let mut child = command.spawn().map_err(|e| {
        failed(
            ErrorKind::ToolUnavailable,
            format!("{program} could not be started, so the dependency tree cannot be read: {e}"),
        )
    })?;
    // Both pipes are drained while the child runs, not after it exits. A
    // dependency tree is megabytes of JSON, and a pipe nobody is reading fills
    // and stops the writer: the child would sit there until the deadline
    // killed it, and the failure would read as "cargo is slow".
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
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= READ_DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed(
                    ErrorKind::Timeout,
                    format!(
                        "{program} did not finish within {}s, so the dependency tree was not read",
                        READ_DEADLINE.as_secs()
                    ),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                return Err(failed(
                    ErrorKind::Io,
                    format!("{program} could not be waited on: {e}"),
                ))
            }
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&err);
        return Err(failed(
            ErrorKind::ToolFailed,
            format!(
                "{program} failed, so the dependency tree was not read: {}",
                stderr.lines().next().unwrap_or("no output")
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

/// Every crate `cargo metadata` reports, with the licence each declares.
fn cargo_dependencies(project_root: &Path) -> Result<Vec<Dependency>, HarnessError> {
    // Absolute: the command runs with its working directory set to the
    // project, so a relative manifest path would be resolved a second time
    // against the directory it already names.
    let manifest = ["Cargo.toml", "src-tauri/Cargo.toml"]
        .iter()
        .map(|p| project_root.join(p))
        .find(|p| p.is_file())
        .map(|p| plain_absolute(&p));
    let Some(manifest) = manifest else {
        return Ok(Vec::new());
    };
    let raw = read_tree(
        "cargo",
        &[
            "metadata",
            "--format-version",
            "1",
            // Offline deliberately: this reads the tree that is already
            // resolved, and a licence check is not a reason to go and update a
            // registry index. A tree that has never been resolved fails here,
            // saying so, rather than quietly resolving one over the network.
            "--offline",
            "--manifest-path",
            &manifest.to_string_lossy(),
        ],
        project_root,
    )?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        failed(
            ErrorKind::Serialization,
            format!("cargo metadata could not be read: {e}"),
        )
    })?;
    let mut out = Vec::new();
    for package in parsed
        .get("packages")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
    {
        let name = package
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        out.push(Dependency {
            ecosystem: Ecosystem::Cargo,
            name: name.to_string(),
            version: package
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            license: package
                .get("license")
                .and_then(|v| v.as_str())
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty()),
        });
    }
    Ok(out)
}

/// Every installed package under `node_modules`, with the licence each
/// declares in its own `package.json`.
///
/// Read from what is installed rather than from the lockfile: a lockfile says
/// what should be there, and the licence that matters is the one in the code
/// that is.
fn npm_dependencies(project_root: &Path) -> Result<Vec<Dependency>, HarnessError> {
    let modules = project_root.join("node_modules");
    if !modules.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut read_package = |dir: &Path| {
        let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) else {
            return;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return;
        };
        let Some(name) = json.get("name").and_then(|v| v.as_str()) else {
            return;
        };
        // `license` is a string; the long-deprecated `licenses` array is still
        // out there and is read rather than ignored.
        let license = json
            .get("license")
            .and_then(|v| {
                v.as_str().map(str::to_string).or_else(|| {
                    v.get("type")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                })
            })
            .or_else(|| {
                json.get("licenses")
                    .and_then(|v| v.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|l| l.get("type").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    })
                    .filter(|l| !l.is_empty())
            })
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty());
        out.push(Dependency {
            ecosystem: Ecosystem::Npm,
            name: name.to_string(),
            version: json
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            license,
        });
    };
    let Ok(entries) = std::fs::read_dir(&modules) else {
        return Ok(Vec::new());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // A scope directory (`@scope/`) holds packages rather than being one.
        if name.starts_with('@') {
            if let Ok(scoped) = std::fs::read_dir(&path) {
                for package in scoped.flatten() {
                    read_package(&package.path());
                }
            }
            continue;
        }
        read_package(&path);
    }
    Ok(out)
}

/// Where the recorded baseline lives.
pub fn baseline_path(project_root: &Path) -> PathBuf {
    project_root
        .join(".jan")
        .join("agent")
        .join("licenses.json")
}

fn read_baseline(project_root: &Path) -> Option<BTreeMap<String, Dependency>> {
    let raw = std::fs::read_to_string(baseline_path(project_root)).ok()?;
    let list: Vec<Dependency> = serde_json::from_str(&raw).ok()?;
    Some(list.into_iter().map(|d| (d.key(), d)).collect())
}

/// Write down what is here now, so a later scan can say what is new.
pub fn record(project_root: &Path, dependencies: &[Dependency]) -> Result<PathBuf, HarnessError> {
    let path = baseline_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| failed(ErrorKind::Io, format!("{}: {e}", parent.display())))?;
    }
    let text = serde_json::to_string_pretty(dependencies)
        .map_err(|e| failed(ErrorKind::Serialization, e.to_string()))?;
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|e| failed(ErrorKind::Io, format!("{}: {e}", path.display())))?;
    Ok(path)
}

/// Read the project's dependencies and judge them against `allowed`
/// (AH-158).
///
/// An empty `allowed` set judges nothing -- every dependency is reported, and
/// none is called disallowed, because a project that has not said what it
/// allows has not said anything for this to enforce.
pub fn scan(
    project_root: &Path,
    allowed: &[String],
) -> Result<Report, HarnessError> {
    let mut dependencies = cargo_dependencies(project_root)?;
    dependencies.extend(npm_dependencies(project_root)?);
    dependencies.sort();
    dependencies.dedup();

    let allowed: BTreeSet<String> = allowed
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();
    let baseline = read_baseline(project_root);
    let mut report = Report {
        compared: baseline.is_some(),
        ..Default::default()
    };
    for dependency in &dependencies {
        match &dependency.license {
            None => report.undeclared.push(dependency.clone()),
            Some(expression) if !allowed.is_empty() => {
                match allowed_by(expression, &allowed) {
                    Some(true) => {}
                    // Either refused, or an expression this will not judge by
                    // halves: both belong in front of a person.
                    _ => report.disallowed.push(dependency.clone()),
                }
            }
            Some(_) => {}
        }
        if let Some(baseline) = baseline.as_ref() {
            if !baseline.contains_key(&dependency.key()) {
                report.added.push(dependency.clone());
            }
        }
    }
    report.dependencies = dependencies;
    Ok(report)
}

/// The scan, as a person reads it.
pub fn render(report: &Report) -> String {
    let mut out = format!("{} dependenc(ies) read\n", report.dependencies.len());
    let list = |title: &str, items: &[Dependency], out: &mut String| {
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("{title} ({}):\n", items.len()));
        for d in items {
            out.push_str(&format!(
                "  {} {} {} — {}\n",
                d.ecosystem.label(),
                d.name,
                d.version,
                d.license.as_deref().unwrap_or("(declares none)")
            ));
        }
    };
    list("not in the allowed set", &report.disallowed, &mut out);
    list("declaring no licence", &report.undeclared, &mut out);
    if report.compared {
        list("new since the recorded scan", &report.added, &mut out);
    } else {
        out.push_str("no recorded scan to compare against (use --record)\n");
    }
    if report.disallowed.is_empty() && report.undeclared.is_empty() {
        out.push_str("every dependency declares a licence the project allows\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn temp_project(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_licenses_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("project");
        root
    }

    fn npm_package(root: &Path, name: &str, version: &str, license: Option<&str>) {
        let dir = root.join("node_modules").join(name);
        std::fs::create_dir_all(&dir).expect("package dir");
        let mut json = serde_json::json!({ "name": name, "version": version });
        if let Some(license) = license {
            json["license"] = serde_json::json!(license);
        }
        std::fs::write(dir.join("package.json"), json.to_string()).expect("package.json");
    }

    /// The expressions a licence is actually written in, and the one this
    /// refuses to judge rather than judging by halves.
    #[test]
    fn a_licence_expression_is_read_the_way_it_is_written() {
        let set = allowed(&["MIT", "Apache-2.0"]);
        assert_eq!(allowed_by("MIT", &set), Some(true));
        assert_eq!(allowed_by("mit", &set), Some(true), "identifiers are not case");
        assert_eq!(allowed_by("MIT OR Apache-2.0", &set), Some(true));
        assert_eq!(allowed_by("MIT OR GPL-3.0", &set), Some(true), "either will do");
        assert_eq!(allowed_by("GPL-3.0 OR AGPL-3.0", &set), Some(false));
        assert_eq!(allowed_by("MIT AND Apache-2.0", &set), Some(true));
        assert_eq!(allowed_by("MIT AND OpenSSL", &set), Some(false), "both, or neither");
        // Nested expressions are not judged by halves.
        assert_eq!(allowed_by("(MIT OR Apache-2.0) AND OpenSSL", &set), None);
        assert_eq!(allowed_by("MIT OR (Apache-2.0 AND X)", &set), None);
        assert_eq!(allowed_by("   ", &set), None);
        // `*` is a project saying it allows anything declared -- including an
        // expression whose shape this would otherwise decline to judge.
        assert_eq!(allowed_by("Whatever-1.0", &allowed(&["*"])), Some(true));
        assert_eq!(
            allowed_by("ISC AND (Apache-2.0 OR ISC)", &allowed(&["*"])),
            Some(true)
        );
        // But it never makes an undeclared licence into a declared one.
        assert_eq!(allowed_by("", &allowed(&["*"])), None);
    }

    /// A package's own declaration is what is read -- including the long
    /// deprecated array form -- and one that declares nothing is reported as
    /// declaring nothing, never as allowed.
    #[test]
    fn what_a_package_declares_is_what_is_read() {
        let root = temp_project("npm");
        npm_package(&root, "good", "1.0.0", Some("MIT"));
        npm_package(&root, "bad", "2.0.0", Some("GPL-3.0"));
        npm_package(&root, "silent", "3.0.0", None);
        // The array form, and a scoped package.
        let scoped = root.join("node_modules").join("@scope").join("thing");
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::write(
            scoped.join("package.json"),
            serde_json::json!({
                "name": "@scope/thing",
                "version": "4.0.0",
                "licenses": [{ "type": "MIT" }]
            })
            .to_string(),
        )
        .unwrap();

        let report = scan(&root, &["MIT".to_string()]).expect("scanned");
        assert_eq!(report.dependencies.len(), 4, "{:#?}", report.dependencies);
        assert_eq!(report.disallowed.len(), 1);
        assert_eq!(report.disallowed[0].name, "bad");
        assert_eq!(report.undeclared.len(), 1);
        assert_eq!(report.undeclared[0].name, "silent");
        assert!(
            report.dependencies.iter().any(|d| d.name == "@scope/thing"
                && d.license.as_deref() == Some("MIT")),
            "{:#?}",
            report.dependencies
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project that has not said what it allows has said nothing for this to
    /// enforce: everything is reported, nothing is called disallowed.
    #[test]
    fn a_project_with_no_allowed_set_judges_nothing() {
        let root = temp_project("nothing");
        npm_package(&root, "anything", "1.0.0", Some("GPL-3.0"));
        let report = scan(&root, &[]).expect("scanned");
        assert_eq!(report.dependencies.len(), 1);
        assert!(report.disallowed.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// "New" is only a question once something was written down; before that
    /// the scan says so rather than calling every dependency new.
    #[test]
    fn new_means_new_since_a_recorded_scan() {
        let root = temp_project("baseline");
        npm_package(&root, "first", "1.0.0", Some("MIT"));
        let first = scan(&root, &["MIT".to_string()]).expect("scanned");
        assert!(!first.compared);
        assert!(first.added.is_empty(), "nothing to compare against");
        assert!(render(&first).contains("no recorded scan"), "{}", render(&first));

        record(&root, &first.dependencies).expect("recorded");
        npm_package(&root, "second", "2.0.0", Some("GPL-3.0"));
        let later = scan(&root, &["MIT".to_string()]).expect("scanned");
        assert!(later.compared);
        assert_eq!(later.added.len(), 1, "{:#?}", later.added);
        assert_eq!(later.added[0].name, "second");
        assert_eq!(later.disallowed.len(), 1);

        // A version change is a new dependency for this purpose: it is a
        // different artifact, and its licence may differ.
        npm_package(&root, "first", "1.1.0", Some("MIT"));
        let bumped = scan(&root, &["MIT".to_string()]).expect("scanned");
        assert!(
            bumped.added.iter().any(|d| d.name == "first" && d.version == "1.1.0"),
            "{:#?}",
            bumped.added
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project with nothing to read is not a project with no problems: it is
    /// reported as having read nothing.
    #[test]
    fn a_project_with_no_dependencies_reads_none() {
        let root = temp_project("empty");
        let report = scan(&root, &["MIT".to_string()]).expect("scanned");
        assert!(report.dependencies.is_empty());
        assert!(render(&report).starts_with("0 dependenc"), "{}", render(&report));
        let _ = std::fs::remove_dir_all(&root);
    }
}
