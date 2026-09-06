//! What kind of project this is, and how it builds and tests
//! (`AH-068`, `AH-069`, `AH-070`).
//!
//! The runtime block told the model the working directory, the OS, the date,
//! the shell and the git branch -- and nothing about the project itself. So a
//! model's first move in an unfamiliar repository was to guess a test command,
//! or to spend turns running `ls` and `cat package.json` to work out what every
//! contributor already knows.
//!
//! Detection here is deliberately narrow and evidence-led:
//!
//! - It reads a fixed set of manifests at the project root. It never walks the
//!   tree: a repository-wide scan is the index's job (`AH-053`), and doing it
//!   on every run to answer "is this a Rust project" would be absurd.
//! - It reports the file each conclusion came from. A model told
//!   "test: `cargo test`" with no provenance cannot tell a detected command
//!   from an invented one, and neither can the person reading the transcript.
//! - It never guesses a command it has no evidence for. An unrecognised project
//!   produces nothing rather than a plausible-looking default, because a
//!   confidently wrong test command is worse than no test command: the model
//!   runs it, it fails, and the failure looks like the code's.

use std::path::Path;

/// Longest manifest this will read. `package.json` in a large monorepo can be
/// substantial, and none of what is needed lives past the first few KiB of a
/// sane one.
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;

/// One detected fact and the file it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Finding {
    pub what: String,
    pub source: String,
}

impl Finding {
    fn new(what: impl Into<String>, source: &str) -> Self {
        Self { what: what.into(), source: source.to_string() }
    }
}

/// What could be established about a project from its manifests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ProjectKind {
    /// Languages or ecosystems, in the order their manifests were found.
    pub ecosystems: Vec<Finding>,
    /// How the project builds.
    pub build: Vec<Finding>,
    /// How the project runs its tests.
    pub test: Vec<Finding>,
    /// Frameworks worth knowing about before touching the code.
    pub frameworks: Vec<Finding>,
}

impl ProjectKind {
    pub fn is_empty(&self) -> bool {
        self.ecosystems.is_empty()
            && self.build.is_empty()
            && self.test.is_empty()
            && self.frameworks.is_empty()
    }
}

/// Reads a manifest, refusing anything absent or implausibly large.
fn read_manifest(root: &Path, name: &str) -> Option<String> {
    let path = root.join(name);
    let size = std::fs::metadata(&path).ok()?.len();
    if size > MAX_MANIFEST_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn exists(root: &Path, name: &str) -> bool {
    root.join(name).exists()
}

/// Detects the project's ecosystem, build and test commands.
pub(crate) fn detect(root: &Path) -> ProjectKind {
    let mut kind = ProjectKind::default();
    detect_rust(root, &mut kind);
    detect_node(root, &mut kind);
    detect_python(root, &mut kind);
    detect_go(root, &mut kind);
    detect_make(root, &mut kind);
    kind
}

fn detect_rust(root: &Path, kind: &mut ProjectKind) {
    let Some(manifest) = read_manifest(root, "Cargo.toml") else {
        return;
    };
    kind.ecosystems.push(Finding::new("Rust", "Cargo.toml"));
    kind.build.push(Finding::new("cargo build", "Cargo.toml"));
    kind.test.push(Finding::new("cargo test", "Cargo.toml"));
    // A workspace root is worth naming: `cargo test` there means every member,
    // which is a different (and much slower) thing than testing one crate.
    if manifest.contains("[workspace]") {
        kind.frameworks
            .push(Finding::new("Cargo workspace", "Cargo.toml"));
    }
    if exists(root, "src-tauri") || manifest.contains("tauri") {
        kind.frameworks.push(Finding::new("Tauri", "Cargo.toml"));
    }
}

fn detect_node(root: &Path, kind: &mut ProjectKind) {
    let Some(manifest) = read_manifest(root, "package.json") else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&manifest) else {
        // A malformed manifest is reported as an ecosystem and nothing more:
        // its scripts cannot be trusted, and guessing them is the failure this
        // module exists to avoid.
        kind.ecosystems
            .push(Finding::new("JavaScript/TypeScript", "package.json"));
        return;
    };

    // The lockfile, not the manifest, says which package manager is really in
    // use -- and running the wrong one rewrites the other's lockfile.
    let runner = if exists(root, "yarn.lock") {
        Some(("yarn", "yarn.lock"))
    } else if exists(root, "pnpm-lock.yaml") {
        Some(("pnpm", "pnpm-lock.yaml"))
    } else if exists(root, "bun.lockb") || exists(root, "bun.lock") {
        Some(("bun", "bun.lock"))
    } else if exists(root, "package-lock.json") {
        Some(("npm", "package-lock.json"))
    } else {
        None
    };
    let (command, lock_source) = match runner {
        Some((name, source)) => (name, source),
        None => ("npm", "package.json"),
    };
    kind.ecosystems
        .push(Finding::new("JavaScript/TypeScript", "package.json"));
    kind.build
        .push(Finding::new(format!("{command} install"), lock_source));

    // Only scripts that actually exist. A `test` script is the project's own
    // answer; inventing `npm test` when none is defined produces a run that
    // fails for a reason unrelated to the code.
    let scripts = parsed.get("scripts").and_then(|v| v.as_object());
    for (script, bucket) in [("build", &mut kind.build), ("test", &mut kind.test)] {
        if scripts.is_some_and(|s| s.contains_key(script)) {
            bucket.push(Finding::new(format!("{command} {script}"), "package.json"));
        }
    }

    let deps = ["dependencies", "devDependencies"].iter().filter_map(|key| {
        parsed.get(*key).and_then(|v| v.as_object())
    });
    let mut named: Vec<&str> = Vec::new();
    for table in deps {
        for (framework, label) in [
            ("next", "Next.js"),
            ("react", "React"),
            ("vue", "Vue"),
            ("svelte", "Svelte"),
            ("vitest", "Vitest"),
            ("jest", "Jest"),
            ("@playwright/test", "Playwright"),
        ] {
            if table.contains_key(framework) && !named.contains(&label) {
                named.push(label);
            }
        }
    }
    for label in named {
        kind.frameworks.push(Finding::new(label, "package.json"));
    }
}

fn detect_python(root: &Path, kind: &mut ProjectKind) {
    let manifest = ["pyproject.toml", "setup.py", "requirements.txt"]
        .into_iter()
        .find(|name| exists(root, name));
    let Some(source) = manifest else {
        return;
    };
    kind.ecosystems.push(Finding::new("Python", source));

    let text = read_manifest(root, source).unwrap_or_default();
    if text.contains("pytest") {
        kind.test.push(Finding::new("pytest", source));
    }
    for (needle, label) in [("django", "Django"), ("flask", "Flask"), ("fastapi", "FastAPI")] {
        if text.to_ascii_lowercase().contains(needle) {
            kind.frameworks.push(Finding::new(label, source));
        }
    }
}

fn detect_go(root: &Path, kind: &mut ProjectKind) {
    if !exists(root, "go.mod") {
        return;
    }
    kind.ecosystems.push(Finding::new("Go", "go.mod"));
    kind.build.push(Finding::new("go build ./...", "go.mod"));
    kind.test.push(Finding::new("go test ./...", "go.mod"));
}

fn detect_make(root: &Path, kind: &mut ProjectKind) {
    let Some(makefile) = read_manifest(root, "Makefile") else {
        return;
    };
    // Only targets that are actually declared. `make test` on a Makefile
    // without that target fails in a way that reads like a broken project.
    for target in ["build", "test"] {
        let declared = makefile
            .lines()
            .any(|line| line.starts_with(&format!("{target}:")));
        if !declared {
            continue;
        }
        let bucket = if target == "build" { &mut kind.build } else { &mut kind.test };
        bucket.push(Finding::new(format!("make {target}"), "Makefile"));
    }
}

/// Renders the detected facts for the system prompt, or nothing when there is
/// nothing to say.
pub(crate) fn project_block(kind: &ProjectKind) -> Option<String> {
    if kind.is_empty() {
        return None;
    }
    let render = |label: &str, findings: &[Finding]| -> Option<String> {
        if findings.is_empty() {
            return None;
        }
        let items: Vec<String> = findings
            .iter()
            .map(|f| format!("`{}` (from {})", f.what, f.source))
            .collect();
        Some(format!("{label}: {}", items.join(", ")))
    };

    let mut lines = vec![
        "Project (detected from the manifests at the project root; nothing here was inferred \
         beyond the file named):"
            .to_string(),
    ];
    lines.extend(render("Ecosystem", &kind.ecosystems));
    lines.extend(render("Build", &kind.build));
    lines.extend(render("Test", &kind.test));
    lines.extend(render("Frameworks", &kind.frameworks));
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::fixtures::TempDir;

    fn project(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new("project-kind");
        for (name, body) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    fn whats(findings: &[Finding]) -> Vec<&str> {
        findings.iter().map(|f| f.what.as_str()).collect()
    }

    #[test]
    fn an_unrecognised_project_produces_nothing_rather_than_a_guess() {
        let dir = project(&[("README.md", "# hello")]);
        let kind = detect(dir.path());
        assert!(kind.is_empty());
        assert!(project_block(&kind).is_none());
    }

    #[test]
    fn a_rust_project_reports_its_build_and_test_commands() {
        let dir = project(&[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.ecosystems), vec!["Rust"]);
        assert_eq!(whats(&kind.build), vec!["cargo build"]);
        assert_eq!(whats(&kind.test), vec!["cargo test"]);
    }

    /// `cargo test` at a workspace root means every member, which is a very
    /// different thing from testing one crate.
    #[test]
    fn a_cargo_workspace_is_named_as_one() {
        let dir = project(&[("Cargo.toml", "[workspace]\nmembers = [\"a\"]\n")]);
        assert!(whats(&detect(dir.path()).frameworks).contains(&"Cargo workspace"));
    }

    /// The lockfile decides the package manager. Running the wrong one rewrites
    /// the other's lockfile, which is a real and annoying way to dirty a tree.
    #[test]
    fn the_lockfile_decides_the_package_manager() {
        for (lock, expected) in [
            ("yarn.lock", "yarn"),
            ("pnpm-lock.yaml", "pnpm"),
            ("package-lock.json", "npm"),
        ] {
            let dir = project(&[
                ("package.json", r#"{"scripts":{"test":"vitest"}}"#),
                (lock, ""),
            ]);
            let kind = detect(dir.path());
            let wanted = format!("{expected} test");
            assert!(
                whats(&kind.test).contains(&wanted.as_str()),
                "{lock} should imply {expected}: {:?}",
                whats(&kind.test)
            );
        }
    }

    /// Inventing `npm test` where no script is defined produces a run that
    /// fails for a reason that has nothing to do with the code.
    #[test]
    fn a_script_that_does_not_exist_is_never_offered() {
        let dir = project(&[("package.json", r#"{"scripts":{"build":"tsc"}}"#)]);
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.build), vec!["npm install", "npm build"]);
        assert!(kind.test.is_empty(), "{:?}", whats(&kind.test));
    }

    #[test]
    fn a_malformed_manifest_reports_the_ecosystem_and_no_commands() {
        let dir = project(&[("package.json", "{ not json")]);
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.ecosystems), vec!["JavaScript/TypeScript"]);
        assert!(kind.build.is_empty());
        assert!(kind.test.is_empty());
    }

    #[test]
    fn node_frameworks_are_named_once_each() {
        let dir = project(&[(
            "package.json",
            r#"{"dependencies":{"react":"18"},"devDependencies":{"react":"18","vitest":"2"}}"#,
        )]);
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.frameworks), vec!["React", "Vitest"]);
    }

    #[test]
    fn a_makefile_target_is_only_offered_when_it_is_declared() {
        let dir = project(&[("Makefile", "build:\n\tcc main.c\n\nlint:\n\techo\n")]);
        let kind = detect(dir.path());
        assert!(whats(&kind.build).contains(&"make build"));
        assert!(kind.test.is_empty(), "no test target is declared");
    }

    #[test]
    fn a_polyglot_repository_reports_every_ecosystem_it_finds() {
        let dir = project(&[
            ("Cargo.toml", "[package]\nname=\"x\"\n"),
            ("package.json", r#"{"scripts":{"test":"vitest"}}"#),
            ("go.mod", "module x\n"),
        ]);
        let kind = detect(dir.path());
        assert_eq!(
            whats(&kind.ecosystems),
            vec!["Rust", "JavaScript/TypeScript", "Go"]
        );
        assert!(whats(&kind.test).contains(&"cargo test"));
        assert!(whats(&kind.test).contains(&"go test ./..."));
    }

    #[test]
    fn python_test_and_framework_come_from_the_manifest_that_named_them() {
        let dir = project(&[(
            "pyproject.toml",
            "[project]\ndependencies = [\"fastapi\"]\n[tool.pytest.ini_options]\n",
        )]);
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.test), vec!["pytest"]);
        assert_eq!(whats(&kind.frameworks), vec!["FastAPI"]);
        assert_eq!(kind.ecosystems[0].source, "pyproject.toml");
    }

    /// Every claim has to name the file it came from, or a reader cannot tell a
    /// detected command from an invented one.
    #[test]
    fn every_finding_carries_its_source_into_the_rendered_block() {
        let dir = project(&[
            ("Cargo.toml", "[package]\nname=\"x\"\n"),
            ("package.json", r#"{"scripts":{"test":"vitest"}}"#),
            ("yarn.lock", ""),
        ]);
        let kind = detect(dir.path());
        for findings in [&kind.ecosystems, &kind.build, &kind.test, &kind.frameworks] {
            for finding in findings {
                assert!(!finding.source.is_empty(), "{finding:?}");
            }
        }
        let block = project_block(&kind).expect("a block");
        assert!(block.contains("(from Cargo.toml)"), "{block}");
        assert!(block.contains("(from yarn.lock)"), "{block}");
        assert!(block.contains("nothing here was inferred"), "{block}");
    }

    #[test]
    fn an_implausibly_large_manifest_is_not_read() {
        let dir = project(&[("Cargo.toml", "[package]\nname=\"x\"\n")]);
        std::fs::write(
            dir.path().join("package.json"),
            "x".repeat(MAX_MANIFEST_BYTES as usize + 1),
        )
        .unwrap();
        let kind = detect(dir.path());
        assert_eq!(whats(&kind.ecosystems), vec!["Rust"], "the oversized manifest is skipped");
    }
}
