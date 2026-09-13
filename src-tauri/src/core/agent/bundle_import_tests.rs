//! Tests for `bundle_import`: an exported bundle applied to a fresh clone, and
//! every way a hostile bundle or a changed destination is refused.

use super::*;
use crate::core::agent::worktree_export;
use serde_json::json;
use tauri_plugin_agent_tools::proposal::{FileSelection, HunkChoice};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Git reads a `\\?\` path as a host name.
fn plain(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

const TARGET: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";

struct Fx {
    root: PathBuf,
    data: PathBuf,
    bundle: PathBuf,
    dest: PathBuf,
    worktree: PathBuf,
}

/// A source repository, a worktree with every kind of change, its exported
/// bundle, and a fresh clone at the base holding an unrelated dirty file.
fn fixture(tag: &str) -> Fx {
    let root = std::env::temp_dir().join(format!(
        "jan-import-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let src = root.join("src");
    std::fs::create_dir_all(src.join("db/migrations")).unwrap();
    git(&src, &["init", "-q", "-b", "main"]);
    git(&src, &["config", "core.autocrlf", "false"]);
    std::fs::write(src.join("target.txt"), TARGET).unwrap();
    std::fs::write(src.join("drop.txt"), "bye\n").unwrap();
    std::fs::write(src.join("package.json"), "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\"\n  }\n}\n").unwrap();
    std::fs::write(src.join("db/migrations/0001.sql"), "CREATE TABLE a(x int);\n").unwrap();
    git(&src, &["add", "."]);
    git(&src, &["commit", "-q", "-m", "base"]);
    let src = src.canonicalize().unwrap();
    let data = root.join("data");
    let roots = root.join("worktrees");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&roots).unwrap();
    let record = worktree::ensure(&src, &roots, "import-session").unwrap();
    let wt = PathBuf::from(&record.path);
    std::fs::write(wt.join("target.txt"), TARGET.replace("1\n2\n", "ONE\n2\n").replace("11\n", "ELEVEN\n")).unwrap();
    std::fs::remove_file(wt.join("drop.txt")).unwrap();
    std::fs::write(wt.join("new.txt"), "fresh\n").unwrap();
    std::fs::write(wt.join("logo.bin"), [0u8, 1, 2, 255]).unwrap();
    std::fs::write(
        wt.join("package.json"),
        "{\n  \"dependencies\": {\n    \"react\": \"^18.0.0\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n",
    )
    .unwrap();
    std::fs::write(wt.join("yarn.lock"), "left-pad@1.3.0\n").unwrap();
    std::fs::write(wt.join("db/migrations/0002.sql"), "DROP TABLE a;\n").unwrap();
    let report = worktree_export::export(&data, &roots, &record, &mut |_| Ok(())).unwrap();
    let dest = root.join("dest");
    git(&root, &["clone", "-q", &plain(&src), "dest"]);
    git(&dest, &["config", "core.autocrlf", "false"]);
    std::fs::write(dest.join("unrelated.txt"), "my own work\n").unwrap();
    Fx { root, data, bundle: PathBuf::from(report.path), dest, worktree: wt }
}

fn run(fx: &Fx, bundle: &Path) -> Result<ImportView, ImportError> {
    import(&fx.data, bundle, &fx.dest, &AtomicBool::new(false), LIMITS, &mut |_| Ok(()))
}

fn flagged(view: &ImportView) -> Vec<String> {
    view.proposal.as_ref().unwrap().files.iter().filter(|f| !f.flags.is_empty()).map(|f| f.path.clone()).collect()
}

fn approval(fx: &Fx, view: &ImportView, files: Vec<FileSelection>, acknowledged: Vec<String>) -> BundleApproval {
    let p = view.proposal.as_ref().unwrap();
    BundleApproval {
        import_id: view.record.id.clone(),
        bundle_sha256: view.record.bundle_sha256.clone(),
        manifest_sha256: view.record.manifest_sha256.clone(),
        destination: fx.dest.to_string_lossy().to_string(),
        approval: Approval {
            proposal_id: p.id.clone(),
            patch_hash: p.patch_hash.clone(),
            base_state_hash: p.base_state_hash.clone(),
            scope: p.scope.clone(),
            files,
            acknowledged,
        },
    }
}

fn everything(view: &ImportView) -> Vec<FileSelection> {
    view.proposal
        .as_ref()
        .unwrap()
        .files
        .iter()
        .map(|f| FileSelection { path: f.path.clone(), hunks: HunkChoice::All })
        .collect()
}

fn leftovers(fx: &Fx) -> Vec<String> {
    std::fs::read_dir(imports_dir(&fx.data))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".partial"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_imported_bundle_applies_to_a_fresh_clone_and_only_there() {
    let fx = fixture("roundtrip");
    let view = run(&fx, &fx.bundle).unwrap();
    assert_eq!(view.record.state, ImportState::Pending);
    let mut flags = flagged(&view);
    flags.sort();
    assert_eq!(flags, ["db/migrations/0002.sql", "drop.txt", "logo.bin", "package.json", "yarn.lock"]);
    assert!(leftovers(&fx).is_empty(), "the private copy was left behind");

    // Refused without the acknowledgements, nothing written.
    let err = apply(&fx.data, &approval(&fx, &view, everything(&view), vec![])).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::Refused);
    assert_eq!(err.unacknowledged.len(), 5);
    assert!(!fx.dest.join("new.txt").exists());

    let report = apply(&fx.data, &approval(&fx, &view, everything(&view), flagged(&view))).unwrap();
    assert_eq!(report.state, ProposalState::Applied);
    for p in ["target.txt", "new.txt", "logo.bin", "package.json", "yarn.lock", "db/migrations/0002.sql"] {
        assert_eq!(std::fs::read(fx.dest.join(p)).unwrap(), std::fs::read(fx.worktree.join(p)).unwrap(), "{p}");
    }
    assert!(!fx.dest.join("drop.txt").exists());
    assert_eq!(std::fs::read_to_string(fx.dest.join("unrelated.txt")).unwrap(), "my own work\n");
    // No Git state was touched: still on main, nothing staged.
    assert_eq!(git(&fx.dest, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(git(&fx.dest, &["diff", "--cached", "--name-only"]), "");

    // Twice is a typed answer, never a second write.
    let again = approval(&fx, &view, everything(&view), flagged(&view));
    assert_eq!(apply(&fx.data, &again).unwrap_err().kind, ImportErrorKind::AlreadyApplied);
    assert_eq!(run(&fx, &fx.bundle).unwrap_err().kind, ImportErrorKind::AlreadyApplied);
    assert_eq!(load(&fx.data, &view.record.id).unwrap().state, ImportState::Applied);
}

#[test]
fn one_hunk_of_two_lands_and_the_other_stays_out() {
    let fx = fixture("one-hunk");
    let view = run(&fx, &fx.bundle).unwrap();
    let target = view.proposal.as_ref().unwrap().files.iter().find(|f| f.path == "target.txt").unwrap();
    assert_eq!(target.hunks.len(), 2);
    let only = vec![FileSelection {
        path: "target.txt".into(),
        hunks: HunkChoice::Only(vec![target.hunks[0].id.clone()]),
    }];
    let report = apply(&fx.data, &approval(&fx, &view, only, vec![])).unwrap();
    assert_eq!(report.state, ProposalState::PartiallyApplied);
    assert_eq!(std::fs::read_to_string(fx.dest.join("target.txt")).unwrap(), TARGET.replace("1\n2\n", "ONE\n2\n"));
    assert!(!fx.dest.join("new.txt").exists());
}

#[test]
fn a_destination_changed_after_review_is_refused_whole() {
    let fx = fixture("stale");
    let view = run(&fx, &fx.bundle).unwrap();
    // The person edits the first hunk's lines after reviewing.
    std::fs::write(fx.dest.join("target.txt"), TARGET.replace("1\n", "mine\n")).unwrap();
    let err = apply(&fx.data, &approval(&fx, &view, everything(&view), flagged(&view))).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::Refused);
    let conflicts = err.conflicts.unwrap();
    assert_eq!(conflicts[0].path, "target.txt");
    assert!(!conflicts[0].hunk.is_empty());
    // Atomic: no other selected file landed.
    assert!(!fx.dest.join("new.txt").exists());
    assert!(fx.dest.join("drop.txt").exists());
    assert!(!fx.dest.join("logo.bin").exists());
    assert_eq!(load(&fx.data, &view.record.id).unwrap().state, ImportState::Pending);
}

#[test]
fn an_approval_for_another_bundle_or_destination_is_refused() {
    let fx = fixture("binding");
    let view = run(&fx, &fx.bundle).unwrap();
    let base = || approval(&fx, &view, everything(&view), flagged(&view));
    let mut a = base();
    a.bundle_sha256 = "0".repeat(64);
    assert_eq!(apply(&fx.data, &a).unwrap_err().kind, ImportErrorKind::ApprovalMismatch);
    let mut a = base();
    a.manifest_sha256 = "0".repeat(64);
    assert_eq!(apply(&fx.data, &a).unwrap_err().kind, ImportErrorKind::ApprovalMismatch);
    let mut a = base();
    a.destination = fx.root.join("src").to_string_lossy().to_string();
    assert_eq!(apply(&fx.data, &a).unwrap_err().kind, ImportErrorKind::DestinationChanged);
    let mut a = base();
    a.import_id = "imp-nope".into();
    assert_eq!(apply(&fx.data, &a).unwrap_err().kind, ImportErrorKind::NotFound);
    assert!(!fx.dest.join("new.txt").exists());
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), &target).unwrap();
        }
    }
}

/// Copy the exported bundle and change it.
fn tampered(fx: &Fx, tag: &str, change: impl FnOnce(&Path)) -> PathBuf {
    let copy = fx.root.join(format!("bundle-{tag}"));
    copy_dir(&fx.bundle, &copy);
    change(&copy);
    copy
}

fn edit_manifest(dir: &Path, f: impl FnOnce(&mut serde_json::Value)) {
    let p = dir.join("manifest.json");
    let mut m: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    f(&mut m);
    std::fs::write(&p, serde_json::to_vec_pretty(&m).unwrap()).unwrap();
}

#[test]
fn a_tampered_bundle_is_refused_and_leaves_nothing() {
    let fx = fixture("tampered");
    type Change = Box<dyn FnOnce(&Path)>;
    let cases: Vec<(&str, ImportErrorKind, Change)> = vec![
        ("patch", ImportErrorKind::HashMismatch, Box::new(|d: &Path| {
            let p = d.join("changes.patch");
            let t = std::fs::read_to_string(&p).unwrap().replace("+ONE", "+EVIL");
            std::fs::write(p, t).unwrap();
        })),
        ("binary", ImportErrorKind::HashMismatch, Box::new(|d: &Path| {
            std::fs::write(d.join("files").join("logo.bin"), [9u8, 9]).unwrap()
        })),
        ("manifest-hash", ImportErrorKind::HashMismatch, Box::new(|d: &Path| {
            edit_manifest(d, |m| m["patchSha256"] = json!("a".repeat(64)))
        })),
        ("unknown-field", ImportErrorKind::ManifestInvalid, Box::new(|d: &Path| {
            edit_manifest(d, |m| m["hooks"] = json!("run me"))
        })),
        ("version", ImportErrorKind::UnsupportedVersion, Box::new(|d: &Path| {
            edit_manifest(d, |m| m["schemaVersion"] = json!(2))
        })),
        ("base", ImportErrorKind::ManifestInvalid, Box::new(|d: &Path| {
            edit_manifest(d, |m| m["baseSha"] = json!("main"))
        })),
        ("extra", ImportErrorKind::EntryExtra, Box::new(|d: &Path| {
            std::fs::write(d.join("post-apply.sh"), "rm -rf /").unwrap()
        })),
        ("missing", ImportErrorKind::EntryMissing, Box::new(|d: &Path| {
            std::fs::remove_file(d.join("files").join("logo.bin")).unwrap()
        })),
        ("truncated", ImportErrorKind::ManifestInvalid, Box::new(|d: &Path| {
            let p = d.join("manifest.json");
            let t = std::fs::read(&p).unwrap();
            std::fs::write(p, &t[..t.len() / 2]).unwrap();
        })),
    ];
    for (tag, kind, change) in cases {
        let bundle = tampered(&fx, tag, change);
        let err = run(&fx, &bundle).unwrap_err();
        assert_eq!(err.kind, kind, "{tag}: {}", err.message);
        assert!(leftovers(&fx).is_empty(), "{tag} left a private copy");
    }
    assert!(list(&fx.data, &fx.dest.to_string_lossy()).is_empty(), "a refused import left a record");
    assert!(!fx.dest.join("new.txt").exists());
}

/// A bundle whose manifest names paths it should never be able to.
fn hostile(fx: &Fx, tag: &str, paths: &[&str]) -> PathBuf {
    let dir = fx.root.join(format!("hostile-{tag}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("changes.patch"), "").unwrap();
    let base = git(&fx.dest, &["rev-parse", "HEAD"]);
    let files: Vec<serde_json::Value> = paths
        .iter()
        .map(|p| json!({ "path": p, "change": "added", "additions": 1, "deletions": 0, "whole": true, "sha256": "b".repeat(64) }))
        .collect();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1, "createdAt": "t", "repository": "r", "branch": "b",
            "baseSha": base, "headSha": "", "patchSha256": sha256_hex(b""),
            "files": files, "applyWith": ""
        }))
        .unwrap(),
    )
    .unwrap();
    dir
}

#[test]
fn paths_that_could_leave_the_project_or_collide_are_refused() {
    let fx = fixture("hostile");
    let cases: Vec<(&str, Vec<&str>, ImportErrorKind)> = vec![
        ("dotdot", vec!["../outside.txt"], ImportErrorKind::PathRefused),
        ("inner-dotdot", vec!["a/../../x.txt"], ImportErrorKind::PathRefused),
        ("absolute", vec!["/etc/passwd"], ImportErrorKind::PathRefused),
        ("drive", vec!["C:/Windows/x.txt"], ImportErrorKind::PathRefused),
        ("unc", vec!["\\\\server\\share\\x.txt"], ImportErrorKind::PathRefused),
        ("backslash", vec!["a\\..\\x.txt"], ImportErrorKind::PathRefused),
        ("stream", vec!["notes.txt:hidden"], ImportErrorKind::PathRefused),
        ("device", vec!["NUL"], ImportErrorKind::PathRefused),
        ("git", vec![".git/hooks/pre-commit"], ImportErrorKind::PathRefused),
        ("nested-git", vec!["vendor/.git/config"], ImportErrorKind::PathRefused),
        ("short-name", vec!["GIT~1/hooks/pre-commit"], ImportErrorKind::PathRefused),
        ("jan", vec![".jan/state"], ImportErrorKind::PathRefused),
        ("trailing-dot", vec![".git./config"], ImportErrorKind::PathRefused),
        ("decomposed", vec!["cafe\u{301}.txt"], ImportErrorKind::PathRefused),
        ("case", vec!["Readme.txt", "README.txt"], ImportErrorKind::PathCollision),
        ("unicode", vec!["\u{e9}t\u{e9}.txt", "\u{c9}T\u{c9}.txt"], ImportErrorKind::PathCollision),
    ];
    for (tag, paths, kind) in cases {
        let bundle = hostile(&fx, tag, &paths);
        let err = run(&fx, &bundle).unwrap_err();
        assert_eq!(err.kind, kind, "{tag}: {}", err.message);
    }
    assert!(leftovers(&fx).is_empty());
}

#[test]
fn a_container_that_is_not_a_bundle_folder_is_refused() {
    let fx = fixture("container");
    let zip = fx.root.join("bundle.zip");
    std::fs::write(&zip, b"PK\x03\x04").unwrap();
    assert_eq!(run(&fx, &zip).unwrap_err().kind, ImportErrorKind::UnsupportedContainer);
    assert_eq!(run(&fx, &fx.root.join("nope")).unwrap_err().kind, ImportErrorKind::UnsupportedContainer);
    let tight = Limits { max_total_bytes: 64, ..LIMITS };
    let err = import(&fx.data, &fx.bundle, &fx.dest, &AtomicBool::new(false), tight, &mut |_| Ok(())).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::TooLarge);
    let few = Limits { max_entries: 2, ..LIMITS };
    let err = import(&fx.data, &fx.bundle, &fx.dest, &AtomicBool::new(false), few, &mut |_| Ok(())).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::TooLarge);
    assert!(leftovers(&fx).is_empty());
}

#[cfg(windows)]
#[test]
fn a_junction_inside_a_bundle_is_refused() {
    let fx = fixture("junction");
    let outside = fx.root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let bundle = tampered(&fx, "junction", |d| {
        let ok = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(d.join("files").join("escape"))
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok);
    });
    assert_eq!(run(&fx, &bundle).unwrap_err().kind, ImportErrorKind::EntryLink);
}

#[test]
fn a_repository_without_the_base_is_refused() {
    let fx = fixture("no-base");
    let other = fx.root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    git(&other, &["init", "-q", "-b", "main"]);
    std::fs::write(other.join("x.txt"), "x\n").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "unrelated"]);
    let err = import(&fx.data, &fx.bundle, &other, &AtomicBool::new(false), LIMITS, &mut |_| Ok(())).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::BaseMissing);
    let err = import(&fx.data, &fx.bundle, &fx.dest.join("db"), &AtomicBool::new(false), LIMITS, &mut |_| Ok(()))
        .unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::DestinationInvalid, "{err:?}");
}

#[test]
fn an_import_stopped_part_way_leaves_nothing() {
    let fx = fixture("cancel");
    let err = import(&fx.data, &fx.bundle, &fx.dest, &AtomicBool::new(false), LIMITS, &mut |piece| {
        if piece == "changes.patch" {
            Err("stopped".into())
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::Cancelled);
    let flag = AtomicBool::new(true);
    let err = import(&fx.data, &fx.bundle, &fx.dest, &flag, LIMITS, &mut |_| Ok(())).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::Cancelled);
    assert!(leftovers(&fx).is_empty());
    assert!(list(&fx.data, &fx.dest.to_string_lossy()).is_empty());
    // A copy left by a process that died is swept by the next import.
    std::fs::create_dir_all(imports_dir(&fx.data).join("imp-dead.partial")).unwrap();
    run(&fx, &fx.bundle).unwrap();
    assert!(leftovers(&fx).is_empty());
}

#[test]
fn an_abandoned_import_cannot_be_applied_and_survives_a_reload() {
    let fx = fixture("abandon");
    let view = run(&fx, &fx.bundle).unwrap();
    // Read back from disk, as after a restart.
    let listed = list(&fx.data, &fx.dest.to_string_lossy());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].record.state, ImportState::Pending);
    assert!(listed[0].proposal.is_some());
    abandon(&fx.data, &view.record.id).unwrap();
    let err = apply(&fx.data, &approval(&fx, &view, everything(&view), flagged(&view))).unwrap_err();
    assert_eq!(err.kind, ImportErrorKind::NotFound);
    assert!(!fx.dest.join("new.txt").exists());
}
