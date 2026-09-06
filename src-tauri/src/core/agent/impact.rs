//! Which tests a change touches (`AH-066`, `AH-067`).
//!
//! After editing a file the useful question is "what should I run now", and the
//! agent had no way to answer it but guessing or running everything. Running
//! everything is slow enough that it does not happen; guessing produces a green
//! run that proved nothing.
//!
//! This maps source files to test files **by naming convention** -- and that
//! caveat is the most important thing in this module. It does not know which
//! tests exercise which code. It knows that `foo.ts` is conventionally tested
//! by `foo.test.ts`, and it checks that the file exists. Two consequences are
//! stated everywhere this is surfaced:
//!
//! - A file with no conventionally-named test is reported as **unmapped**, not
//!   omitted. Silence would read as "covered", which is the opposite of true.
//! - Passing the mapped tests does not mean a change is safe. A test elsewhere
//!   may cover the code and will not be found here.
//!
//! Real coverage-based selection needs instrumentation the harness does not
//! have. Convention-based selection is the honest 80%, provided it says which
//! 80% it is.

use std::path::Path;

use crate::core::agent::project_kind::ProjectKind;

/// What a set of changed files implies.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Impact {
    /// Test files that conventionally cover the changed files, deduplicated.
    pub tests: Vec<String>,
    /// Changed files with no conventionally-named test.
    pub unmapped: Vec<String>,
}

/// Whether a path is itself a test, by the same conventions.
fn is_test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.ends_with("_test.go")
        || name.ends_with("_test.py")
        || name.starts_with("test_")
        || name.contains(".test.")
        || name.contains(".spec.")
        || path.contains("/__tests__/")
        || path.starts_with("tests/")
        || path.contains("/tests/")
}

/// Candidate test paths for a source file, whether or not they exist.
fn candidates(source: &str) -> Vec<String> {
    let (dir, name) = match source.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (String::new(), source.to_string()),
    };
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return Vec::new();
    };
    let at = |dir: &str, file: String| {
        if dir.is_empty() {
            file
        } else {
            format!("{dir}/{file}")
        }
    };

    match extension {
        // Rust tests usually live in the file they test, behind `#[cfg(test)]`;
        // that case is handled by the caller, which can read the file.
        "rs" => vec![at("tests", format!("{stem}.rs"))],
        "ts" | "tsx" | "js" | "jsx" | "mjs" => {
            let nested = if dir.is_empty() {
                "__tests__".to_string()
            } else {
                format!("{dir}/__tests__")
            };
            vec![
                at(&dir, format!("{stem}.test.{extension}")),
                at(&dir, format!("{stem}.spec.{extension}")),
                at(&nested, format!("{stem}.test.{extension}")),
            ]
        }
        "py" => vec![
            at(&dir, format!("test_{stem}.py")),
            at(&dir, format!("{stem}_test.py")),
            at("tests", format!("test_{stem}.py")),
        ],
        "go" => vec![at(&dir, format!("{stem}_test.go"))],
        _ => Vec::new(),
    }
}

/// Maps changed files onto the tests that conventionally cover them.
pub(crate) fn analyse(root: &Path, changed: &[String]) -> Impact {
    let mut impact = Impact::default();
    for path in changed {
        // A changed test is its own target: it is the thing to run.
        if is_test_path(path) {
            push_unique(&mut impact.tests, path.clone());
            continue;
        }

        let mut found = false;
        // A Rust file carrying `#[cfg(test)]` tests itself.
        if path.ends_with(".rs")
            && std::fs::read_to_string(root.join(path))
                .is_ok_and(|text| text.contains("#[cfg(test)]"))
        {
            push_unique(&mut impact.tests, path.clone());
            found = true;
        }
        for candidate in candidates(path) {
            if root.join(&candidate).is_file() {
                push_unique(&mut impact.tests, candidate);
                found = true;
            }
        }
        if !found {
            push_unique(&mut impact.unmapped, path.clone());
        }
    }
    impact.tests.sort();
    impact.unmapped.sort();
    impact
}

fn push_unique(into: &mut Vec<String>, value: String) {
    if !into.contains(&value) {
        into.push(value);
    }
}

/// Renders the impact for the model, including how to run the tests.
pub(crate) fn render(impact: &Impact, changed: &[String], kind: &ProjectKind) -> String {
    if changed.is_empty() {
        return "No changed files, so nothing to run.".to_string();
    }

    let mut lines = vec![format!("{} changed file(s).", changed.len())];

    if impact.tests.is_empty() {
        lines.push("No conventionally-named test file covers them.".to_string());
    } else {
        lines.push(format!("Tests that conventionally cover them ({}):", impact.tests.len()));
        lines.extend(impact.tests.iter().map(|t| format!("  {t}")));
    }

    // Reported, never omitted: silence here would read as "covered".
    if !impact.unmapped.is_empty() {
        lines.push(format!(
            "No test file found for ({}):",
            impact.unmapped.len()
        ));
        lines.extend(impact.unmapped.iter().map(|p| format!("  {p}")));
    }

    if !kind.test.is_empty() {
        let commands: Vec<String> = kind.test.iter().map(|f| format!("`{}`", f.what)).collect();
        lines.push(format!("Test command for this project: {}", commands.join(", ")));
    }

    lines.push(
        "Mapping is by filename convention, not coverage: it does not know which tests exercise \
         which code. Passing these does not prove the change is safe, and a test elsewhere may \
         cover it."
            .to_string(),
    );
    lines.join("\n")
}

/// The `impact` tool, as the model sees it.
pub(crate) fn impact_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "impact",
            "description":
                "Given changed files, list the test files that conventionally cover them, plus \
                 this project's test command. Defaults to the files currently changed in git. \
                 Use it after editing to decide what to run instead of running everything or \
                 guessing. Mapping is by filename convention (foo.ts -> foo.test.ts, foo.go -> \
                 foo_test.go, a Rust file with #[cfg(test)] tests itself), NOT by coverage: it \
                 does not know which tests exercise which code, it reports files it could not \
                 map, and passing the tests it lists does not prove a change is safe.",
            "parameters": {
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description":
                            "Repository-relative paths. Omit to use the files changed in git."
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::fixtures::TempDir;

    fn repo(files: &[&str]) -> TempDir {
        let dir = TempDir::new("impact");
        for name in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "// file\n").unwrap();
        }
        dir
    }

    #[test]
    fn a_typescript_file_maps_to_its_sibling_test() {
        let dir = repo(&["src/foo.ts", "src/foo.test.ts"]);
        let impact = analyse(dir.path(), &["src/foo.ts".to_string()]);
        assert_eq!(impact.tests, vec!["src/foo.test.ts"]);
        assert!(impact.unmapped.is_empty());
    }

    #[test]
    fn a_spec_file_counts_as_the_test() {
        let dir = repo(&["a/b.ts", "a/b.spec.ts"]);
        let impact = analyse(dir.path(), &["a/b.ts".to_string()]);
        assert_eq!(impact.tests, vec!["a/b.spec.ts"]);
    }

    #[test]
    fn a_tests_subdirectory_is_searched_too() {
        let dir = repo(&["c/d.ts", "c/__tests__/d.test.ts"]);
        let impact = analyse(dir.path(), &["c/d.ts".to_string()]);
        assert_eq!(impact.tests, vec!["c/__tests__/d.test.ts"]);
        assert!(impact.unmapped.is_empty());
    }

    #[test]
    fn a_go_file_maps_to_its_test_file() {
        let dir = repo(&["pkg/server.go", "pkg/server_test.go"]);
        let impact = analyse(dir.path(), &["pkg/server.go".to_string()]);
        assert_eq!(impact.tests, vec!["pkg/server_test.go"]);
    }

    #[test]
    fn a_python_file_maps_to_either_convention() {
        let dir = repo(&["app/mod.py", "app/test_mod.py", "b/other.py", "b/other_test.py"]);
        let impact = analyse(
            dir.path(),
            &["app/mod.py".to_string(), "b/other.py".to_string()],
        );
        assert_eq!(impact.tests, vec!["app/test_mod.py", "b/other_test.py"]);
    }

    /// Rust usually tests in-file, so the changed file is its own target.
    #[test]
    fn a_rust_file_with_an_inline_test_module_tests_itself() {
        let dir = TempDir::new("impact-rust");
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/lib.rs"),
            "pub fn x() {}\n#[cfg(test)]\nmod tests {}\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("src/plain.rs"), "pub fn y() {}\n").unwrap();

        let impact = analyse(
            dir.path(),
            &["src/lib.rs".to_string(), "src/plain.rs".to_string()],
        );
        assert_eq!(impact.tests, vec!["src/lib.rs"]);
        assert_eq!(impact.unmapped, vec!["src/plain.rs"]);
    }

    #[test]
    fn a_changed_test_file_is_its_own_target() {
        let dir = repo(&["src/foo.test.ts"]);
        let impact = analyse(dir.path(), &["src/foo.test.ts".to_string()]);
        assert_eq!(impact.tests, vec!["src/foo.test.ts"]);
        assert!(impact.unmapped.is_empty());
    }

    /// Silence would read as "covered", which is the opposite of true.
    #[test]
    fn a_file_with_no_test_is_reported_not_omitted() {
        let dir = repo(&["src/untested.ts"]);
        let impact = analyse(dir.path(), &["src/untested.ts".to_string()]);
        assert!(impact.tests.is_empty());
        assert_eq!(impact.unmapped, vec!["src/untested.ts"]);

        let rendered = render(&impact, &["src/untested.ts".to_string()], &ProjectKind::default());
        assert!(rendered.contains("No test file found"), "{rendered}");
        assert!(rendered.contains("src/untested.ts"), "{rendered}");
    }

    #[test]
    fn a_candidate_that_does_not_exist_is_never_offered() {
        let dir = repo(&["src/foo.ts"]);
        let impact = analyse(dir.path(), &["src/foo.ts".to_string()]);
        assert!(impact.tests.is_empty(), "{:?}", impact.tests);
    }

    #[test]
    fn the_same_test_is_listed_once_for_two_changed_files() {
        let dir = repo(&["a.go", "a_test.go", "b.go", "b_test.go"]);
        let mut impact = analyse(dir.path(), &["a.go".to_string(), "a.go".to_string()]);
        impact.tests.dedup();
        assert_eq!(impact.tests, vec!["a_test.go"]);
    }

    /// The caveat has to travel with the answer, every time.
    #[test]
    fn the_rendered_report_always_states_that_this_is_not_coverage() {
        let dir = repo(&["a.go", "a_test.go"]);
        let impact = analyse(dir.path(), &["a.go".to_string()]);
        let rendered = render(&impact, &["a.go".to_string()], &ProjectKind::default());
        assert!(rendered.contains("not coverage"), "{rendered}");
        assert!(rendered.contains("does not prove the change is safe"), "{rendered}");
    }

    #[test]
    fn the_report_carries_the_projects_test_command_when_one_is_known() {
        let dir = repo(&["a.go", "a_test.go"]);
        let mut kind = ProjectKind::default();
        kind.test.push(crate::core::agent::project_kind::Finding {
            what: "go test ./...".to_string(),
            source: "go.mod".to_string(),
        });
        let impact = analyse(dir.path(), &["a.go".to_string()]);
        let rendered = render(&impact, &["a.go".to_string()], &kind);
        assert!(rendered.contains("`go test ./...`"), "{rendered}");
    }

    #[test]
    fn no_changes_reports_nothing_to_run() {
        let dir = repo(&[]);
        let impact = analyse(dir.path(), &[]);
        assert_eq!(render(&impact, &[], &ProjectKind::default()), "No changed files, so nothing to run.");
    }

    #[test]
    fn the_tool_description_states_that_it_is_not_coverage() {
        let schema = impact_tool_schema();
        let description = schema["function"]["description"].as_str().unwrap();
        assert!(description.contains("NOT by coverage"));
        assert!(description.contains("does not prove a change is safe"));
    }
}
