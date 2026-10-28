use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn dir(label: &str) -> PathBuf {
    let n = N.fetch_add(1, Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("flint_hint_{label}_{}_{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// `<project>/pokemon-card-app/lib/db.ts`, the shape in the failing run.
fn project() -> PathBuf {
    let p = dir("project");
    std::fs::create_dir_all(p.join("pokemon-card-app").join("lib")).unwrap();
    std::fs::write(p.join("pokemon-card-app").join("lib").join("db.ts"), "x").unwrap();
    p
}

#[tokio::test]
async fn a_relative_read_names_the_project_file_it_missed() {
    let workspace = dir("ws");
    let project = project();
    let store = dir("store");
    let reads = [project.clone()];
    let ctx = ToolContext::new(&workspace, &store, &[]).with_read_roots(&reads);
    let (out, _) = read_or_list(&json!({"path": "lib/db.ts"}), &ctx).await;
    assert!(out.starts_with("ERROR: File not found: lib/db.ts"), "{out}");
    assert!(out.contains("exists at"), "{out}");
    assert!(out.contains("pokemon-card-app"), "{out}");
    assert!(out.contains(&project.display().to_string()), "{out}");
}

#[tokio::test]
async fn a_miss_with_no_match_names_the_attached_folder() {
    let workspace = dir("ws");
    let project = project();
    let store = dir("store");
    let reads = [project.clone()];
    let ctx = ToolContext::new(&workspace, &store, &[]).with_read_roots(&reads);
    let (out, _) = read_or_list(&json!({"path": "nothing/here.ts"}), &ctx).await;
    assert!(out.contains("scratch space, not the project"), "{out}");
    assert!(out.contains(&project.display().to_string()), "{out}");
}

#[tokio::test]
async fn a_worktree_root_above_the_app_gets_the_nested_path() {
    // The session worktree is the project root; the app is one level down.
    let worktree = project();
    let store = dir("store");
    let ctx = ToolContext::new(&worktree, &store, &[]);
    let (out, _) = read_or_list(&json!({"path": "lib/db.ts"}), &ctx).await;
    assert!(out.contains("exists at"), "{out}");
    assert!(out.contains("pokemon-card-app"), "{out}");
}

#[tokio::test]
async fn a_path_rebased_onto_the_worktree_still_finds_the_nested_file() {
    // A worktree session rewrites `lib/db.ts` to `<worktree>/lib/db.ts`
    // before the tool runs, so the path is absolute by the time it misses.
    let worktree = project();
    let store = dir("store");
    let reads = [worktree.clone()];
    let ctx = ToolContext::new(&worktree, &store, &[]).with_read_roots(&reads);
    let rebased = worktree.join("lib").join("db.ts").display().to_string();
    let (out, _) = read_or_list(&json!({"path": rebased}), &ctx).await;
    assert!(out.starts_with("ERROR: File not found"), "{out}");
    assert!(out.contains("exists at"), "{out}");
    assert!(out.contains("pokemon-card-app"), "{out}");
    // A path that really is somewhere else gets no invented match.
    let elsewhere = dir("elsewhere")
        .join("lib")
        .join("db.ts")
        .display()
        .to_string();
    let (out, _) = read_or_list(&json!({"path": elsewhere}), &ctx).await;
    assert!(!out.contains("exists at"), "{out}");
}

#[test]
fn the_verbatim_prefix_is_dropped_from_shown_paths() {
    use crate::tools::sandbox::plain_display;
    assert_eq!(plain_display(Path::new(r"\\?\C:\tmp\a")), r"C:\tmp\a");
    assert_eq!(plain_display(Path::new(r"C:\tmp\a")), r"C:\tmp\a");
    // A UNC path keeps its prefix: stripping it would name another place.
    assert_eq!(
        plain_display(Path::new(r"\\?\UNC\srv\share")),
        r"\\?\UNC\srv\share"
    );
}

#[tokio::test]
async fn ls_gets_the_same_hint() {
    let workspace = dir("ws");
    let project = project();
    let store = dir("store");
    let reads = [project.clone()];
    let ctx = ToolContext::new(&workspace, &store, &[]).with_read_roots(&reads);
    let out = with_project_hint(
        ls(
            &json!({"path": "lib"}),
            &workspace,
            None,
            false,
            &reads,
            &[],
        )
        .await,
        &ctx,
        &json!({"path": "lib"}),
    );
    assert!(out.starts_with("ERROR"), "{out}");
    assert!(out.contains("exists at"), "{out}");
}

#[tokio::test]
async fn an_absolute_path_or_a_plain_workspace_gets_no_hint() {
    let workspace = dir("ws");
    let store = dir("store");
    let ctx = ToolContext::new(&workspace, &store, &[]);
    let (plain, _) = read_or_list(&json!({"path": "nope.md"}), &ctx).await;
    assert!(
        plain.starts_with("ERROR: File not found: nope.md."),
        "{plain}"
    );
    assert!(!plain.contains("scratch space, not the project"), "{plain}");
    let abs = workspace.join("missing.md").display().to_string();
    let (out, _) = read_or_list(&json!({"path": abs}), &ctx).await;
    assert!(!out.contains("exists at"), "{out}");
}

#[test]
fn only_missing_path_errors_are_recognised() {
    assert!(is_missing_path_error(
        "ERROR: File not found: a. Relative paths"
    ));
    assert!(is_missing_path_error(
        "ERROR: The system cannot find the path specified. (os error 3)"
    ));
    assert!(!is_missing_path_error("ERROR: a is a directory; use ls."));
    assert!(!is_missing_path_error("fine, file not found in the text"));
}
