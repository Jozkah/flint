//! A fixed set of repositories the harness is run over on every change.
//! AH-197.
//!
//! Unit tests answer "does this function do what it says". What they cannot
//! answer is "does the harness still say something sensible about a real
//! repository" -- the question that changes when a resolver is tightened, a
//! detector learns a new framework, or a bound moves. Each of those changes is
//! locally correct and can still make the harness wrong about an actual
//! project.
//!
//! So: a handful of small repositories, built here rather than checked in (a
//! fixture that is a real `git init` cannot drift from what git actually
//! does), and the harness's own readers run over each one with the answer
//! asserted. They are deliberately boring repositories -- a TypeScript app
//! with path aliases, a Python package, a Rust crate, a repository in the
//! middle of a failed merge -- because the point is coverage of the *shapes*
//! the harness meets, not of anything clever.
//!
//! Every assertion here is a property, never a golden string: "the test that
//! imports the changed file is found" rather than "the answer is these 43
//! paths". A golden string would fail on every unrelated improvement and be
//! updated without being read, which is worse than no test.

use std::process::Command;

use app_lib::core::agent::fixtures::Workspace;
use app_lib::core::agent::{impact, vcs};

/// One repository, built from nothing each run.
///
/// The builder is the harness's own (AH-011), so these repositories are made
/// the same way every other test makes one -- and a real `git init`, so what
/// the readers see is what git produces.
type Golden = Workspace;

fn typescript_app() -> Golden {
    Workspace::new("golden-ts").files(
        &[
            (
                "package.json",
                r#"{"name":"app","scripts":{"test":"vitest --run"},"devDependencies":{"vitest":"1.0.0"}}"#,
            ),
            ("yarn.lock", "# yarn lockfile v1\n"),
            (
                "tsconfig.json",
                r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }"#,
            ),
            ("src/lib/store.ts", "export const load = () => 1\n"),
            (
                "src/lib/service.ts",
                "import { load } from '@/lib/store'\nexport const use = () => load()\n",
            ),
            (
                "src/ui/panel.tsx",
                "import { use } from '@/lib/service'\nimport './panel.css'\nexport const Panel = () => use()\n",
            ),
            ("src/ui/panel.css", ".panel { color: red }\n"),
            (
                "src/ui/__tests__/panel.test.tsx",
                "import { Panel } from '@/ui/panel'\nimport { it } from 'vitest'\nit('renders', () => Panel())\n",
            ),
            (
                "src/lib/__tests__/unrelated.test.ts",
                "import { it } from 'vitest'\nit('is unrelated', () => 1)\n",
            ),
        ],
    )
}

fn python_package() -> Golden {
    Workspace::new("golden-py").files(
        &[
            ("pyproject.toml", "[project]\nname = \"pkg\"\nversion = \"0.1.0\"\n"),
            ("pkg/__init__.py", ""),
            ("pkg/store.py", "VALUE = 1\n"),
            ("pkg/service.py", "from .store import VALUE\n\n\ndef use():\n    return VALUE\n"),
            ("tests/test_service.py", "from pkg.service import use\n\n\ndef test_use():\n    assert use() == 1\n"),
        ],
    )
}

/// A change in a real application resolves to the test that covers it, through
/// the project's own alias, and not to the test that does not.
#[test]
fn a_typescript_app_says_which_test_covers_a_change() {
    let repo = typescript_app();
    let found = impact::impact(repo.path(), &["src/lib/store.ts".to_string()]).unwrap();

    assert!(
        found.tests.iter().any(|t| t.ends_with("panel.test.tsx")),
        "the test that reaches the change through two aliased imports: {:?}",
        found.tests
    );
    assert!(
        !found.tests.iter().any(|t| t.contains("unrelated")),
        "a test that cannot reach it was claimed: {:?}",
        found.tests
    );
    // A stylesheet is on disk and imports nothing, so it is not a missing edge.
    assert_eq!(found.missed, 0, "an import was not resolved that should have been");
    assert_eq!(found.confidence, impact::Confidence::Whole);

    // And the command is the project's own, never invented.
    let selection =
        impact::selection(repo.path(), &["src/lib/store.ts".to_string()], impact::detected_runner(repo.path()).as_deref())
            .unwrap();
    let command = selection.command.expect("the manifest says how tests are run");
    assert!(command.contains("test"), "{command}");
}

#[test]
fn a_python_package_resolves_its_own_imports() {
    let repo = python_package();
    let found = impact::impact(repo.path(), &["pkg/store.py".to_string()]).unwrap();
    assert!(found.affected.contains(&"pkg/service.py".to_string()), "{:?}", found.affected);
    assert!(
        found.tests.iter().any(|t| t.ends_with("test_service.py")),
        "{:?}",
        found.tests
    );
    assert_eq!(found.missed, 0);
}

/// A path that leaves the repository is refused in every golden repository,
/// not just in the unit test that first checked it.
#[test]
fn no_golden_repository_can_be_asked_about_a_path_outside_it() {
    for repo in [typescript_app(), python_package()] {
        for hostile in ["../secrets", "src/../../elsewhere.ts"] {
            let refused = impact::impact(repo.path(), &[hostile.to_string()]);
            assert!(refused.is_err(), "{hostile} was read in {:?}", repo.path());
        }
    }
}

/// A repository in the middle of a failed merge is read as one, and reading it
/// resolves nothing.
#[test]
fn a_repository_with_a_stopped_merge_is_reported_and_left_alone() {
    let repo = Workspace::new("golden-merge")
        .files(&[("file.txt", "one\n"), ("README.md", "# golden\n")])
        .git();
    repo.git_run(&["switch", "-q", "-c", "theirs"]);
    std::fs::write(repo.path().join("file.txt"), "one\ntheirs\n").unwrap();
    repo.git_run(&["commit", "-qam", "theirs"]);
    repo.git_run(&["switch", "-q", "main"]);
    std::fs::write(repo.path().join("file.txt"), "one\nours\n").unwrap();
    repo.git_run(&["commit", "-qam", "ours"]);
    // Expected to fail: this is the conflict.
    let _ = Command::new("git")
        .arg("-C")
        .arg(repo.path())
        .args(["merge", "theirs"])
        .output()
        .unwrap();

    let state = vcs::conflicts(repo.path()).unwrap();
    assert!(state.in_progress);
    assert_eq!(state.files.len(), 1, "{:?}", state.files);
    assert_eq!(state.files[0].kind, vcs::ConflictKind::BothChanged);
    assert_eq!(state.files[0].hunks.len(), 1);

    // Reading it changed nothing on disk.
    let on_disk = std::fs::read_to_string(repo.path().join("file.txt")).unwrap();
    assert!(on_disk.contains("<<<<<<<"), "the merge was resolved by reading it");

    // A repository with no remote is not mistaken for one that is in sync.
    let standing = vcs::divergence(repo.path()).unwrap();
    assert_eq!(standing.standing, vcs::Standing::NoUpstream);
    repo.git_run(&["merge", "--abort"]);
}

/// Nothing the harness reads about a repository leaks a credential that is
/// sitting in it. A real repository has secrets in it more often than anyone
/// would like -- a `.env` someone forgot -- and the answers this harness
/// produces are pasted into transcripts and exports.
#[test]
fn nothing_read_from_a_repository_carries_a_credential_out_of_it() {
    let repo = Workspace::new("golden-secrets").files(
        &[
            (".env", "OPENAI_API_KEY=sk-not-a-real-key-1234567890\n"),
            ("src/a.ts", "export const a = 1\n"),
            ("src/a.test.ts", "import { a } from './a'\n"),
        ],
    );
    let found = impact::impact(repo.path(), &["src/a.ts".to_string()]).unwrap();
    let rendered = serde_json::to_string(&found).unwrap();
    assert!(
        !rendered.contains("sk-not-a-real-key-1234567890"),
        "a credential in the repository reached the answer: {rendered}"
    );
    // And the `.env` is not read as source at all.
    assert!(!rendered.contains(".env"), "{rendered}");
}

/// The bounds hold on a repository big enough to hit them, and say so rather
/// than quietly answering about a subset.
#[test]
fn a_repository_larger_than_the_bounds_says_the_answer_is_partial() {
    let repo = Workspace::new("golden-big").file("src/a.ts", "export const a = 1\n");
    std::fs::write(
        repo.path().join("src/huge.ts"),
        "x".repeat((impact::MAX_FILE_BYTES + 1) as usize),
    )
    .unwrap();
    let graph = impact::graph(repo.path()).unwrap();
    assert!(graph.truncated, "a file too big to read must make the graph partial");
    let found = impact::impact(repo.path(), &["src/a.ts".to_string()]).unwrap();
    assert_eq!(found.confidence, impact::Confidence::Partial);
    assert!(found.truncated);
}
