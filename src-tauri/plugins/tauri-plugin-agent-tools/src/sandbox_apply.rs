//! Copy one file a Review only session wrote into its sandbox into the
//! attached project folder.
//!
//! A Review only run never touches the project: its writes land in the
//! session sandbox. This is the explicit, per-file step the user takes to
//! bring one of those files across. Both ends are checked on disk, after
//! links are resolved, so neither a `..` in the path nor a link planted in the
//! sandbox or the project can carry the copy outside the two folders.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// What happened to the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxApplyOutcome {
    /// Written to a path that did not exist before.
    Created,
    /// An existing file was replaced (only when overwriting was asked for).
    Replaced,
    /// A file is already there and overwriting was not asked for. Nothing
    /// was written; the caller asks the user and calls again.
    Exists,
}

/// The relative path, refused unless every part of it is a plain name.
fn plain_relative(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.trim().is_empty() {
        return Err("the file path is empty".into());
    }
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            _ => return Err(format!("{relative} is not a path inside the sandbox")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("the file path is empty".into());
    }
    Ok(out)
}

/// The deepest existing ancestor of `path`, canonicalised.
fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return std::fs::canonicalize(&current).map_err(|e| e.to_string());
        }
        if !current.pop() {
            return Err(format!("{} has no existing parent", path.display()));
        }
    }
}

/// Copy `relative` from `sandbox` to the same relative path under `project`.
pub fn apply_sandbox_file(
    sandbox: &Path,
    project: &Path,
    relative: &str,
    overwrite: bool,
) -> Result<SandboxApplyOutcome, String> {
    let relative = plain_relative(relative)?;
    let sandbox_root = std::fs::canonicalize(sandbox)
        .map_err(|e| format!("the session sandbox is not readable: {e}"))?;
    let project_root = std::fs::canonicalize(project)
        .map_err(|e| format!("the attached folder is not readable: {e}"))?;
    if !project_root.is_dir() {
        return Err("the attached folder is not a folder".into());
    }

    let source = std::fs::canonicalize(sandbox_root.join(&relative))
        .map_err(|e| format!("the sandbox file is gone: {e}"))?;
    if !source.starts_with(&sandbox_root) {
        return Err("the sandbox file points outside the sandbox".into());
    }
    if !source.is_file() {
        return Err("only files can be applied".into());
    }

    let destination = project_root.join(&relative);
    // Whatever part of the destination already exists must resolve inside
    // the project, so a link in the project cannot redirect the write.
    if !canonical_existing_ancestor(&destination)?.starts_with(&project_root) {
        return Err("the destination points outside the attached folder".into());
    }
    let existed = match std::fs::symlink_metadata(&destination) {
        Ok(meta) if meta.is_dir() => {
            return Err("a folder with that name is already in the attached folder".into())
        }
        Ok(_) => true,
        Err(_) => false,
    };
    if existed && !overwrite {
        return Ok(SandboxApplyOutcome::Exists);
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
    Ok(if existed {
        SandboxApplyOutcome::Replaced
    } else {
        SandboxApplyOutcome::Created
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dirs() -> (TempDir, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "sandbox-apply-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let sandbox = root.join("sandbox");
        let project = root.join("project");
        std::fs::create_dir_all(sandbox.join("docs")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(sandbox.join("docs/notes.md"), "from the run").unwrap();
        (TempDir(root), sandbox, project)
    }

    #[test]
    fn copies_a_new_file_and_its_folders() {
        let (_root, sandbox, project) = dirs();
        let out = apply_sandbox_file(&sandbox, &project, "docs/notes.md", false).unwrap();
        assert_eq!(out, SandboxApplyOutcome::Created);
        assert_eq!(
            std::fs::read_to_string(project.join("docs/notes.md")).unwrap(),
            "from the run"
        );
    }

    #[test]
    fn leaves_an_existing_file_alone_unless_asked() {
        let (_root, sandbox, project) = dirs();
        std::fs::create_dir_all(project.join("docs")).unwrap();
        std::fs::write(project.join("docs/notes.md"), "mine").unwrap();
        let out = apply_sandbox_file(&sandbox, &project, "docs/notes.md", false).unwrap();
        assert_eq!(out, SandboxApplyOutcome::Exists);
        assert_eq!(
            std::fs::read_to_string(project.join("docs/notes.md")).unwrap(),
            "mine"
        );
        let out = apply_sandbox_file(&sandbox, &project, "docs/notes.md", true).unwrap();
        assert_eq!(out, SandboxApplyOutcome::Replaced);
        assert_eq!(
            std::fs::read_to_string(project.join("docs/notes.md")).unwrap(),
            "from the run"
        );
    }

    #[test]
    fn refuses_paths_that_climb_out() {
        let (_root, sandbox, project) = dirs();
        for bad in ["../project/x", "docs/../../x", "", "/etc/passwd"] {
            assert!(
                apply_sandbox_file(&sandbox, &project, bad, true).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn refuses_a_missing_source_or_a_folder() {
        let (_root, sandbox, project) = dirs();
        assert!(apply_sandbox_file(&sandbox, &project, "nope.txt", false).is_err());
        assert!(apply_sandbox_file(&sandbox, &project, "docs", false).is_err());
    }
}
