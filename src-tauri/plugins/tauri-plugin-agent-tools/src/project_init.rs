//! A first description of an attached project, proposed for the user to edit
//! and accept as its `JAN.md`. AH-209.
//!
//! The survey reads, and only reads: it walks the folder through
//! [`project_browse`], so it sees exactly what the Code panel sees -- inside
//! the folder, `.gitignore` honoured, dependency and build output skipped,
//! symlinks out of the folder dropped, credential-shaped files refused. It
//! never runs anything the project contains: a build is described from its
//! manifest, not by invoking it. It is bounded, and it says what the bounds
//! left unread.
//!
//! Nothing is written by surveying. [`accept`] writes one file, `JAN.md` at the
//! folder root, and only with the text the user accepted.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::project_browse;

/// Folders listed before the walk stops.
pub const MAX_DIRS: usize = 200;
/// Entries looked at before the walk stops.
pub const MAX_ENTRIES: usize = 4000;
/// Folder depth below the root that is listed.
pub const MAX_DEPTH: usize = 4;
/// The largest `JAN.md` that can be accepted.
pub const MAX_JAN_MD_BYTES: usize = 64 * 1024;
/// Jan's own instructions file.
pub const JAN_MD: &str = "JAN.md";

/// What a survey found, and what it did not read.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Survey {
    /// A starting `JAN.md`, for the user to edit.
    pub draft: String,
    /// Files whose content the survey read, relative to the folder.
    pub read: Vec<String>,
    /// What the bounds or refusals left unread, in words.
    pub not_read: Vec<String>,
    /// How many files were seen in the listing.
    pub files_seen: usize,
    /// Whether the folder already has a `JAN.md`.
    pub has_instructions: bool,
}

fn language_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "rs" => "Rust",
        "py" => "Python",
        "go" => "Go",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "cs" => "C#",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "C++",
        "c" | "h" => "C",
        "rb" => "Ruby",
        "php" => "PHP",
        "swift" => "Swift",
        "dart" => "Dart",
        "scala" => "Scala",
        "lua" => "Lua",
        "sh" | "bash" => "Shell",
        "ps1" => "PowerShell",
        "vue" => "Vue",
        "svelte" => "Svelte",
        _ => return None,
    })
}

/// The file's text, or why it was not read -- noted in `not_read`.
fn read_text(root: &str, rel: &str, read: &mut Vec<String>, not_read: &mut Vec<String>) -> Option<String> {
    match project_browse::read_file(root, rel, false) {
        Ok(file) if file.oversized => {
            not_read.push(format!("{rel}: larger than {} bytes", project_browse::MAX_READ_BYTES));
            None
        }
        Ok(file) if file.binary => None,
        Ok(file) => {
            read.push(rel.to_string());
            Some(file.content)
        }
        Err(e) if e.starts_with("SENSITIVE") => {
            not_read.push(format!("{rel}: looks like credentials, so it was not opened"));
            None
        }
        Err(e) => {
            not_read.push(format!("{rel}: {e}"));
            None
        }
    }
}

/// The README's title and first paragraph.
fn readme_summary(text: &str) -> (Option<String>, Option<String>) {
    let mut title = None;
    let mut paragraph = String::new();
    for line in text.lines() {
        let t = line.trim();
        if title.is_none() && t.starts_with('#') {
            title = Some(t.trim_start_matches('#').trim().to_string());
            continue;
        }
        if t.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        // Badges, images and HTML are not a description.
        if t.starts_with('!') || t.starts_with('<') || t.starts_with("[!") || t.starts_with('#') {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(t);
        if paragraph.len() > 600 {
            break;
        }
    }
    let paragraph = paragraph.chars().take(600).collect::<String>();
    (title.filter(|t| !t.is_empty()), (!paragraph.is_empty()).then_some(paragraph))
}

/// Survey the folder at `root` (already validated by the caller).
pub fn survey(root: &str) -> Result<Survey, String> {
    let mut read = Vec::new();
    let mut not_read = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut top_level: Vec<(String, bool)> = Vec::new();

    // Breadth first, so a bound cuts off depth rather than a whole subtree.
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(String::new(), 0)]);
    let mut listed = 0usize;
    let mut seen = 0usize;
    let mut deeper = 0usize;
    let mut stopped = false;
    while let Some((rel, depth)) = queue.pop_front() {
        if listed >= MAX_DIRS || seen >= MAX_ENTRIES {
            not_read.push(format!(
                "{} folder(s) were not listed: the survey stops after {MAX_DIRS} folders or {MAX_ENTRIES} entries",
                queue.len() + 1
            ));
            stopped = true;
            break;
        }
        let listing = match project_browse::list_dir(root, &rel) {
            Ok(listing) => listing,
            Err(e) if rel.is_empty() => return Err(e),
            Err(e) => {
                not_read.push(format!("{rel}/: {e}"));
                continue;
            }
        };
        listed += 1;
        if listing.truncated {
            not_read.push(format!(
                "{}: more than {} entries; the rest were not listed",
                if rel.is_empty() { "the folder root" } else { &rel },
                project_browse::MAX_LIST_ENTRIES
            ));
        }
        for entry in listing.entries {
            seen += 1;
            if depth == 0 {
                top_level.push((entry.rel_path.clone(), entry.is_dir));
            }
            if entry.is_dir {
                if depth + 1 < MAX_DEPTH {
                    queue.push_back((entry.rel_path, depth + 1));
                } else {
                    deeper += 1;
                }
            } else {
                files.push(entry.rel_path);
            }
        }
    }
    if deeper > 0 && !stopped {
        not_read.push(format!(
            "{deeper} folder(s) deeper than {MAX_DEPTH} levels were not listed"
        ));
    }
    not_read.push(
        "ignored by .gitignore, or dependency and build output (node_modules, target, dist, ...): skipped by design"
            .to_string(),
    );

    let has = |name: &str| files.iter().any(|f| f.eq_ignore_ascii_case(name));
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut build: Vec<String> = Vec::new();

    if has("package.json") {
        if let Some(text) = read_text(root, "package.json", &mut read, &mut not_read) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                name = name.or(json["name"].as_str().map(str::to_string));
                description = description.or(json["description"].as_str().map(str::to_string));
                let runner = if has("yarn.lock") {
                    "yarn"
                } else if has("pnpm-lock.yaml") {
                    "pnpm"
                } else {
                    "npm run"
                };
                if let Some(scripts) = json["scripts"].as_object() {
                    let names: Vec<String> = scripts.keys().take(12).map(|k| format!("`{runner} {k}`")).collect();
                    if !names.is_empty() {
                        build.push(format!("Node scripts (package.json): {}", names.join(", ")));
                    }
                } else {
                    build.push("Node package (package.json), no scripts declared".to_string());
                }
                if json.get("workspaces").is_some() {
                    build.push("A Node workspace: package.json declares `workspaces`".to_string());
                }
            }
        }
    }
    if has("Cargo.toml") {
        if let Some(text) = read_text(root, "Cargo.toml", &mut read, &mut not_read) {
            if let Ok(value) = toml::from_str::<toml::Value>(&text) {
                name = name.or(value
                    .get("package")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string));
                description = description.or(value
                    .get("package")
                    .and_then(|p| p.get("description"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string));
                let members = value
                    .get("workspace")
                    .and_then(|w| w.get("members"))
                    .and_then(|m| m.as_array())
                    .map(|m| m.len())
                    .unwrap_or(0);
                build.push(if members > 0 {
                    format!("Rust workspace of {members} member(s) (Cargo.toml): `cargo build`, `cargo test`")
                } else {
                    "Rust crate (Cargo.toml): `cargo build`, `cargo test`".to_string()
                });
            }
        }
    }
    if has("pyproject.toml") {
        if let Some(text) = read_text(root, "pyproject.toml", &mut read, &mut not_read) {
            if let Ok(value) = toml::from_str::<toml::Value>(&text) {
                let project = value.get("project").or_else(|| {
                    value.get("tool").and_then(|t| t.get("poetry"))
                });
                name = name.or(project
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string));
                description = description.or(project
                    .and_then(|p| p.get("description"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string));
            }
            build.push("Python project (pyproject.toml)".to_string());
        }
    } else if has("requirements.txt") {
        build.push("Python dependencies in requirements.txt".to_string());
    }
    if has("go.mod") {
        if let Some(text) = read_text(root, "go.mod", &mut read, &mut not_read) {
            if let Some(module) = text.lines().find_map(|l| l.trim().strip_prefix("module ")) {
                name = name.or(Some(module.trim().to_string()));
            }
            build.push("Go module (go.mod): `go build ./...`, `go test ./...`".to_string());
        }
    }
    if has("Makefile") {
        if let Some(text) = read_text(root, "Makefile", &mut read, &mut not_read) {
            let targets: Vec<String> = text
                .lines()
                .filter_map(|l| {
                    let (head, _) = l.split_once(':')?;
                    let head = head.trim();
                    (!l.starts_with('\t')
                        && !head.is_empty()
                        && !head.starts_with('.')
                        && !head.contains('=')
                        && head.chars().all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c)))
                    .then(|| format!("`make {head}`"))
                })
                .take(10)
                .collect();
            if !targets.is_empty() {
                build.push(format!("make targets: {}", targets.join(", ")));
            }
        }
    }
    for (file, what) in [
        ("CMakeLists.txt", "CMake project (CMakeLists.txt)"),
        ("Dockerfile", "A Dockerfile at the root"),
        ("build.gradle", "Gradle build (build.gradle)"),
        ("build.gradle.kts", "Gradle build (build.gradle.kts)"),
        ("pom.xml", "Maven build (pom.xml)"),
    ] {
        if has(file) {
            build.push(what.to_string());
        }
    }
    if files.iter().any(|f| !f.contains('/') && f.to_lowercase().ends_with(".sln")) {
        build.push(".NET solution (.sln) at the root".to_string());
    }

    let readme = ["README.md", "README", "readme.md", "Readme.md", "README.txt"]
        .into_iter()
        .find(|f| files.iter().any(|g| g == f));
    let mut readme_title = None;
    if let Some(file) = readme {
        if let Some(text) = read_text(root, file, &mut read, &mut not_read) {
            let (title, paragraph) = readme_summary(&text);
            readme_title = title;
            description = description.or(paragraph);
        }
    }

    let mut languages: BTreeMap<&'static str, usize> = BTreeMap::new();
    for file in &files {
        if let Some(lang) = Path::new(file)
            .extension()
            .and_then(|e| e.to_str())
            .and_then(|e| language_of(&e.to_lowercase()))
        {
            *languages.entry(lang).or_default() += 1;
        }
    }
    let mut languages: Vec<(&str, usize)> = languages.into_iter().collect();
    languages.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));

    let folder_name = Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "This project".to_string());
    let title = name.or(readme_title).unwrap_or(folder_name);

    let mut draft = format!("# {title}\n\n");
    draft.push_str(
        description
            .as_deref()
            .unwrap_or("Describe what this project is for, in a sentence or two."),
    );
    draft.push_str("\n\n## What is here\n\n");
    if !languages.is_empty() {
        let langs: Vec<String> = languages
            .iter()
            .take(5)
            .map(|(lang, n)| format!("{lang} ({n} file{})", if *n == 1 { "" } else { "s" }))
            .collect();
        draft.push_str(&format!("- Languages: {}\n", langs.join(", ")));
    }
    let mut layout: Vec<String> = top_level
        .iter()
        .map(|(p, is_dir)| if *is_dir { format!("`{p}/`") } else { format!("`{p}`") })
        .collect();
    let more = layout.len().saturating_sub(15);
    layout.truncate(15);
    if !layout.is_empty() {
        draft.push_str(&format!(
            "- Top level: {}{}\n",
            layout.join(", "),
            if more > 0 { format!(", and {more} more") } else { String::new() }
        ));
    }
    draft.push_str("\n## How it is built and tested\n\n");
    if build.is_empty() {
        draft.push_str("- No build manifest was found. Say how to build and test it.\n");
    } else {
        for line in &build {
            draft.push_str(&format!("- {line}\n"));
        }
    }
    draft.push_str(
        "\n## Notes for Jan\n\n- Conventions to follow, files not to touch, how to check a change.\n",
    );

    Ok(Survey {
        draft,
        read,
        not_read,
        files_seen: files.len(),
        has_instructions: has(JAN_MD),
    })
}

/// Write the accepted text as `<root>/JAN.md`. `root` is canonical.
///
/// Refuses, writing nothing: empty or oversized text; an existing `JAN.md`
/// unless `overwrite` was asked for; a `JAN.md` that is a link or a folder,
/// since writing through a link could land anywhere. The write goes to a
/// temporary file in the same folder first and is then renamed into place, so
/// an interrupted write never leaves a half-written `JAN.md`.
pub fn accept(root: &Path, content: &str, overwrite: bool) -> Result<PathBuf, String> {
    if content.trim().is_empty() {
        return Err("the description is empty, so nothing was written".to_string());
    }
    if content.len() > MAX_JAN_MD_BYTES {
        return Err(format!(
            "the description is larger than {MAX_JAN_MD_BYTES} bytes, so nothing was written"
        ));
    }
    let target = root.join(JAN_MD);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("JAN.md is a link, and Jan will not write through it; nothing was written".to_string())
        }
        Ok(meta) if meta.is_dir() => {
            return Err("JAN.md is a folder, so nothing was written".to_string())
        }
        Ok(_) if !overwrite => {
            return Err("this folder already has a JAN.md, so nothing was written".to_string())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("JAN.md could not be checked: {e}")),
    }
    let temp = root.join(format!(".JAN.md.jan-{}.tmp", std::process::id()));
    std::fs::write(&temp, content).map_err(|e| format!("JAN.md could not be written: {e}"))?;
    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("JAN.md could not be written: {e}"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn dir(name: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "jan-init-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn put(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn s(root: &Path) -> String {
        root.to_string_lossy().to_string()
    }

    #[test]
    fn a_node_project_is_described_from_its_manifest_and_readme() {
        let root = dir("node");
        put(&root, "package.json", r#"{"name":"widget","scripts":{"build":"vite build","test":"vitest"}}"#);
        put(&root, "README.md", "# Widget\n\n![badge](x)\nA small widget library.\n\nMore.\n");
        put(&root, "src/index.ts", "export {}\n");
        put(&root, "src/util.ts", "export {}\n");
        let out = survey(&s(&root)).unwrap();
        assert!(out.draft.starts_with("# widget\n"), "{}", out.draft);
        assert!(out.draft.contains("A small widget library."), "{}", out.draft);
        assert!(out.draft.contains("`npm run build`"), "{}", out.draft);
        assert!(out.draft.contains("TypeScript (2 files)"), "{}", out.draft);
        assert!(out.read.contains(&"package.json".to_string()));
        assert!(!out.has_instructions);
    }

    #[test]
    fn a_rust_workspace_is_described_without_running_anything() {
        let root = dir("rust");
        put(&root, "Cargo.toml", "[workspace]\nmembers = [\"a\", \"b\"]\n");
        // A build script that would leave a mark if anything executed it.
        put(&root, "build.rs", "fn main() { std::fs::write(\"RAN\", \"\").unwrap(); }\n");
        let out = survey(&s(&root)).unwrap();
        assert!(out.draft.contains("Rust workspace of 2 member(s)"), "{}", out.draft);
        assert!(!root.join("RAN").exists());
    }

    /// Ignored and credential-shaped files are neither listed nor read.
    #[test]
    fn it_reads_only_what_the_code_panel_would_show() {
        let root = dir("ignore");
        put(&root, ".gitignore", "private/\n");
        put(&root, "private/notes.md", "SECRET-PLAN\n");
        put(&root, ".env", "TOKEN=abc\n");
        put(&root, "README.md", "# R\n\nText.\n");
        let out = survey(&s(&root)).unwrap();
        assert!(!out.draft.contains("SECRET-PLAN"));
        assert!(!out.read.iter().any(|r| r.contains("private") || r == ".env"));
        assert!(!out.draft.contains("private/"), "{}", out.draft);
    }

    #[test]
    fn a_link_out_of_the_folder_is_not_followed() {
        let root = dir("link");
        let outside = dir("link-outside");
        put(&outside, "package.json", r#"{"name":"not-this-one"}"#);
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("package.json"), root.join("package.json")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(outside.join("package.json"), root.join("package.json")).is_err() {
            return; // Creating links needs a privilege this host may not grant.
        }
        let out = survey(&s(&root)).unwrap();
        assert!(!out.draft.contains("not-this-one"), "{}", out.draft);
    }

    /// A tree past the bounds is surveyed partly, and says so.
    #[test]
    fn a_large_tree_is_bounded_and_says_what_it_did_not_read() {
        let root = dir("deep");
        put(&root, "a/b/c/d/e/f.ts", "x\n");
        for i in 0..(MAX_DIRS + 5) {
            std::fs::create_dir_all(root.join(format!("wide/d{i}"))).unwrap();
        }
        let out = survey(&s(&root)).unwrap();
        assert!(
            out.not_read.iter().any(|n| n.contains("were not listed")),
            "{:?}",
            out.not_read
        );
    }

    #[test]
    fn accepting_writes_exactly_the_text_and_refuses_to_overwrite() {
        let root = dir("accept");
        let path = accept(&root, "# Mine\n", false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Mine\n");
        let err = accept(&root, "# Other\n", false).unwrap_err();
        assert!(err.contains("already has a JAN.md"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Mine\n");
        accept(&root, "# Replaced\n", true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Replaced\n");
        // No temporary file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn empty_or_oversized_text_writes_nothing() {
        let root = dir("empty");
        assert!(accept(&root, "  \n", false).is_err());
        assert!(accept(&root, &"x".repeat(MAX_JAN_MD_BYTES + 1), false).is_err());
        assert!(!root.join(JAN_MD).exists());
    }

    #[test]
    fn a_jan_md_that_is_a_link_is_never_written_through() {
        let root = dir("jan-link");
        let outside = dir("jan-link-outside");
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, "original").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, root.join(JAN_MD)).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&victim, root.join(JAN_MD)).is_err() {
            return;
        }
        let err = accept(&root, "# Hijack\n", true).unwrap_err();
        assert!(err.contains("link"), "{err}");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "original");
    }
}
