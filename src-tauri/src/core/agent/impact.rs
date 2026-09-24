//! What a change can affect, and which tests cover it. AH-065, AH-066,
//! AH-067, AH-151.
//!
//! The question a run keeps asking is "what should I run after this edit?".
//! Without an answer, a model either runs the whole suite (slow enough that it
//! stops running it) or guesses a test name from the file name (wrong as soon
//! as the coverage is indirect). This module answers it from the repository
//! itself:
//!
//! * [`graph`] reads import edges out of the source files -- Rust `mod`/`use`,
//!   JS/TS `import`/`require`, Python `import`/`from` -- and resolves them to
//!   files in the same repository. Anything that does not resolve to a file in
//!   the project is dropped rather than guessed at: an unresolved edge is a
//!   package, and a package is not a file this change can have broken.
//! * [`tests_for`] walks those edges backwards from a source file and keeps
//!   the test files it reaches, so the answer includes a test that covers the
//!   file through three layers of re-export.
//! * [`impact`] does the same for a set of changed files at once, and says
//!   what it could not resolve rather than quietly returning less.
//! * [`selection`] turns that into the command a project's own detected test
//!   runner would use -- never an invented one.
//!
//! Three things it deliberately does not do. It does not parse: the edges come
//! from line-shaped matching, which is wrong for code inside a string literal
//! and right often enough to be useful, and every answer says how confident it
//! is. It does not follow edges out of the project, which is what keeps a
//! traversal bounded. And it never runs anything: selection produces a command
//! for someone else to decide about.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::Serialize;

/// The most files read while building a graph.
pub const MAX_FILES: usize = 20_000;
/// The most bytes read from any one file. A generated bundle is not a source
/// file, and reading it whole would cost more than the edges are worth.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// How deep the directory walk goes.
pub const MAX_DEPTH: usize = 24;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ImpactErrorKind {
    /// The path given is not a directory that can be read.
    NoProject,
    /// A changed path is outside the project it was asked about.
    Escapes,
    /// The project could not be read.
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImpactError {
    pub kind: ImpactErrorKind,
    pub message: String,
}

impl ImpactError {
    fn new(kind: ImpactErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&ImpactError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &ImpactError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            ImpactErrorKind::NoProject => ErrorKind::NotFound,
            // A path out of the project is the sandbox's answer, not a
            // missing file: saying "not found" would invite a retry with a
            // different spelling.
            ImpactErrorKind::Escapes => ErrorKind::SandboxDenied,
            ImpactErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

/// The language a file's edges were read as.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Language {
    Rust,
    TypeScript,
    Python,
}

impl Language {
    fn of(path: &Path) -> Option<Language> {
        match path.extension().and_then(|e| e.to_str())? {
            "rs" => Some(Language::Rust),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(Language::TypeScript),
            "py" => Some(Language::Python),
            _ => None,
        }
    }
}

/// A repository's files and the edges between them.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    /// Every source file read, relative to the project root, `/`-separated.
    pub files: Vec<String>,
    /// `from -> to`: the file on the left imports the file on the right.
    pub edges: BTreeMap<String, BTreeSet<String>>,
    /// Files that look like tests.
    pub tests: BTreeSet<String>,
    /// Imports that named something outside the project: a package, a
    /// standard-library module. These do not make an answer incomplete -- a
    /// package cannot be a file in this repository that imports the changed
    /// one -- but they are counted, because "no edges" and "all edges went
    /// outside" are different shapes of repository.
    pub external: usize,
    /// Imports that looked like they named a file *here* -- relative, or
    /// through one of the project's own aliases, or a Rust `crate::` path --
    /// and did not resolve to one. Each of these is an edge that should exist
    /// and does not, so any answer drawn from this graph may be missing a
    /// test.
    pub missed: usize,
    /// Set when a bound stopped the walk: what is here is incomplete.
    pub truncated: bool,
}

impl Graph {
    /// Everything that imports `file`, directly.
    fn importers(&self) -> BTreeMap<&str, Vec<&str>> {
        let mut back: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (from, tos) in &self.edges {
            for to in tos {
                back.entry(to.as_str()).or_default().push(from.as_str());
            }
        }
        back
    }
}

/// Whether a path looks like a test file, by the conventions of the three
/// languages this reads.
///
/// Convention, not configuration: `tests/`, `__tests__/`, `*_test.py`,
/// `test_*.py`, `*.test.ts`, `*.spec.ts`, and Rust's `tests/` directory. A
/// file that is a test by some other convention is simply not called one --
/// the answer is then smaller than the truth, which is the safe direction for
/// "here is what covers this".
pub fn looks_like_test(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if lower.split('/').any(|seg| seg == "tests" || seg == "__tests__" || seg == "test") {
        return true;
    }
    name.starts_with("test_")
        || name.ends_with("_test.py")
        || name.ends_with("_test.rs")
        || name.contains(".test.")
        || name.contains(".spec.")
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | "venv"
            | ".venv"
            | "__pycache__"
            | ".mypy_cache"
            | ".pytest_cache"
            | "vendor"
            | "coverage"
    )
}

/// Read a project's import edges.
pub fn graph(project_root: &Path) -> Result<Graph, ImpactError> {
    if !project_root.is_dir() {
        return Err(ImpactError::new(
            ImpactErrorKind::NoProject,
            "there is no project directory to read here",
        ));
    }
    let mut graph = Graph::default();
    let mut sources: Vec<(String, Language, String)> = Vec::new();
    let mut queue = VecDeque::from([(project_root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > MAX_DEPTH {
            graph.truncated = true;
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // A directory that cannot be read is skipped, not fatal: one
            // unreadable folder must not cost the whole answer.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name != ".jan" || ignored(&name) {
                continue;
            }
            if path.is_dir() {
                queue.push_back((path, depth + 1));
                continue;
            }
            let Some(language) = Language::of(&path) else { continue };
            if sources.len() >= MAX_FILES {
                graph.truncated = true;
                continue;
            }
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
                graph.truncated = true;
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Some(relative) = relative(project_root, &path) else { continue };
            sources.push((relative, language, text));
        }
    }

    let known: BTreeSet<String> = sources.iter().map(|(rel, _, _)| rel.clone()).collect();
    // A TypeScript project that declares `paths` means them: `@/lib/x` is a
    // file in this repository, not a package. Reading them is the difference
    // between an answer and an empty one -- found by running this against a
    // real app, where every import is written through the alias and the first
    // answer had no edges at all.
    let aliases = ts_aliases(project_root);
    for (relative, language, text) in &sources {
        if looks_like_test(relative) {
            graph.tests.insert(relative.clone());
        }
        let mut targets = BTreeSet::new();
        for raw in imports(*language, text) {
            match resolve(*language, relative, &raw, &known, &aliases) {
                Some(target) if &target != relative => {
                    targets.insert(target);
                }
                Some(_) => {}
                None if names_this_project(*language, &raw, &aliases)
                    && !names_a_non_source_file(project_root, relative, &raw, &aliases) =>
                {
                    graph.missed += 1
                }
                None => graph.external += 1,
            }
        }
        if !targets.is_empty() {
            graph.edges.insert(relative.clone(), targets);
        }
    }
    graph.files = known.into_iter().collect();
    Ok(graph)
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

/// The import specifiers one file names, by language.
///
/// Line-shaped, not parsed: a specifier inside a comment or a string is read
/// as an import. The cost of that is an edge that should not be there, which
/// makes an answer larger; the cost of parsing three languages properly is a
/// dependency on three parsers.
fn imports(language: Language, text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in text.lines().take(20_000) {
        let line = line.trim();
        match language {
            Language::Rust => {
                if let Some(rest) = line.strip_prefix("mod ").or_else(|| line.strip_prefix("pub mod ")) {
                    let name = rest.trim_end_matches(';').trim_end_matches('{').trim();
                    if !name.is_empty() && !name.contains(' ') {
                        found.push(format!("mod:{name}"));
                    }
                } else if let Some(rest) = line.strip_prefix("use ").or_else(|| line.strip_prefix("pub use ")) {
                    let path = rest.trim_end_matches(';').trim();
                    if let Some(stripped) = path.strip_prefix("crate::").or_else(|| path.strip_prefix("self::")) {
                        found.push(format!("use:{stripped}"));
                    }
                }
            }
            Language::TypeScript => {
                if let Some(spec) = quoted_after(line, "from ") {
                    found.push(spec);
                } else if let Some(spec) = quoted_after(line, "require(") {
                    found.push(spec);
                } else if line.starts_with("import ") {
                    if let Some(spec) = quoted(line) {
                        found.push(spec);
                    }
                }
            }
            Language::Python => {
                if let Some(rest) = line.strip_prefix("from ") {
                    if let Some(module) = rest.split_whitespace().next() {
                        found.push(module.to_string());
                    }
                } else if let Some(rest) = line.strip_prefix("import ") {
                    for module in rest.split(',') {
                        if let Some(name) = module.split_whitespace().next() {
                            found.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    found
}

fn quoted_after(line: &str, marker: &str) -> Option<String> {
    let at = line.find(marker)? + marker.len();
    quoted(&line[at..])
}

fn quoted(text: &str) -> Option<String> {
    let open = text.find(['"', '\''])?;
    let quote = text.as_bytes()[open] as char;
    let rest = &text[open + 1..];
    let close = rest.find(quote)?;
    Some(rest[..close].to_string())
}

/// Resolve one import specifier to a file in this project, or to nothing.
fn resolve(
    language: Language,
    from: &str,
    raw: &str,
    known: &BTreeSet<String>,
    aliases: &[(String, Vec<String>)],
) -> Option<String> {
    let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let try_paths = |candidates: Vec<String>| -> Option<String> {
        candidates.into_iter().find(|c| known.contains(c))
    };
    match language {
        Language::Rust => {
            let (kind, rest) = raw.split_once(':')?;
            // Every module segment of the path, `r#` raw identifiers unwrapped;
            // a `{...}` group or glob ends the module part.
            let segments: Vec<&str> = rest
                .split("::")
                .map(|s| s.trim().trim_start_matches("r#"))
                .take_while(|s| !s.is_empty() && !s.starts_with('{') && *s != "*")
                .collect();
            if segments.is_empty() {
                return None;
            }
            let base = if kind == "mod" { dir.to_string() } else { crate_root(from) };
            let prefix = if base.is_empty() { String::new() } else { format!("{base}/") };
            // The deepest module that is a file here wins (Jozkah/jan#265):
            // `crate::core::agent::r#loop::ModelInvoker` is `core/agent/loop.rs`,
            // not `core.rs`. The trailing item names are simply not files.
            let candidates = (1..=segments.len())
                .rev()
                .flat_map(|n| {
                    let module = segments[..n].join("/");
                    [format!("{prefix}{module}.rs"), format!("{prefix}{module}/mod.rs")]
                })
                .collect();
            try_paths(candidates)
        }
        Language::TypeScript => {
            let bases: Vec<String> = if raw.starts_with('.') {
                vec![join(dir, raw)]
            } else {
                // Not relative: an alias the project declared, or a package.
                let expanded = expand_alias(raw, aliases);
                if expanded.is_empty() {
                    return None;
                }
                expanded
            };
            let mut candidates = Vec::new();
            for base in bases {
                candidates.push(base.clone());
                for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
                    candidates.push(format!("{base}.{ext}"));
                    candidates.push(format!("{base}/index.{ext}"));
                }
            }
            try_paths(candidates)
        }
        Language::Python => {
            let (leading, rest) = {
                let dots = raw.chars().take_while(|c| *c == '.').count();
                (dots, raw.trim_start_matches('.'))
            };
            let base = if leading == 0 {
                String::new()
            } else {
                let mut here = dir.to_string();
                for _ in 1..leading {
                    here = here.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
                }
                here
            };
            let path = rest.replace('.', "/");
            let prefix = if base.is_empty() { String::new() } else { format!("{base}/") };
            try_paths(vec![
                format!("{prefix}{path}.py"),
                format!("{prefix}{path}/__init__.py"),
            ])
        }
    }
}

/// Whether a specifier names something that is on disk here but is not a file
/// this reads -- a stylesheet, an image, a JSON fixture.
///
/// These are the bulk of what looks like a missed edge in a real application,
/// and none of them can import anything, so none of them can be the path from
/// a change to a test. Treating them as incompleteness would make every answer
/// in a real repository partial, which is the same as having no answer.
fn names_a_non_source_file(
    project_root: &Path,
    from: &str,
    raw: &str,
    aliases: &[(String, Vec<String>)],
) -> bool {
    let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let bases: Vec<String> = if raw.starts_with('.') {
        vec![join(dir, raw)]
    } else {
        expand_alias(raw, aliases)
    };
    bases.iter().any(|base| {
        let direct = project_root.join(base);
        direct.is_file()
            || ["css", "scss", "sass", "less", "json", "svg", "png", "jpg", "webp", "md", "wasm"]
                .iter()
                .any(|ext| project_root.join(format!("{base}.{ext}")).is_file())
    })
}

/// Whether an unresolved specifier was *meant* to be a file in this project.
///
/// The distinction decides whether an answer is complete. `import React from
/// "react"` naming nothing here is the normal case and hides no edge; `import
/// { x } from "./helper"` naming nothing here means an edge was missed, and
/// every answer drawn from the graph has to say so.
fn names_this_project(
    language: Language,
    raw: &str,
    aliases: &[(String, Vec<String>)],
) -> bool {
    match language {
        // Only `crate::`, `self::` and `mod` are collected at all; each of
        // them names something inside this tree by construction.
        Language::Rust => true,
        Language::TypeScript => {
            raw.starts_with('.') || aliases.iter().any(|(prefix, _)| raw.starts_with(prefix.as_str()))
        }
        // A leading dot is an explicit relative import; a bare name is a
        // module that may equally be a package.
        Language::Python => raw.starts_with('.'),
    }
}

/// The `compilerOptions.paths` a TypeScript project declares, as
/// `(prefix, targets)` with the trailing `*` removed from both sides.
///
/// Read from `tsconfig.json` at the project root only, and only the shape
/// `"@/*": ["./src/*"]`: a `paths` entry that is not a simple prefix mapping
/// is left alone rather than approximated, and its imports stay unresolved --
/// which makes the answer partial, which is the honest outcome.
fn ts_aliases(project_root: &Path) -> Vec<(String, Vec<String>)> {
    let Ok(raw) = std::fs::read_to_string(project_root.join("tsconfig.json")) else {
        return Vec::new();
    };
    // tsconfig.json permits comments and trailing commas, which serde_json
    // does not. Strip line comments; anything still unreadable yields no
    // aliases rather than a guess.
    let stripped: String = raw
        .lines()
        .map(|line| match line.find("//") {
            Some(at) if !line[..at].contains('"') => &line[..at],
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&stripped) else {
        return Vec::new();
    };
    let base = doc
        .pointer("/compilerOptions/baseUrl")
        .and_then(|v| v.as_str())
        .map(|b| normalise_prefix(b))
        .unwrap_or_default();
    let Some(paths) = doc.pointer("/compilerOptions/paths").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut aliases = Vec::new();
    for (key, value) in paths {
        let Some(prefix) = key.strip_suffix('*') else { continue };
        let targets: Vec<String> = value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|t| t.as_str())
                    .filter_map(|t| t.strip_suffix('*'))
                    .map(|t| {
                        let t = normalise_prefix(t);
                        if base.is_empty() || t.starts_with(&base) {
                            t
                        } else {
                            format!("{base}/{t}")
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !targets.is_empty() {
            aliases.push((prefix.to_string(), targets));
        }
    }
    aliases
}

fn normalise_prefix(raw: &str) -> String {
    let cleaned = raw.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches("./").trim_matches('/');
    // `"baseUrl": "."` means the project root, which is the empty prefix
    // here -- not a directory called `.`.
    if cleaned == "." {
        String::new()
    } else {
        cleaned.to_string()
    }
}

/// The paths an aliased specifier could mean.
fn expand_alias(raw: &str, aliases: &[(String, Vec<String>)]) -> Vec<String> {
    let mut out = Vec::new();
    for (prefix, targets) in aliases {
        let Some(rest) = raw.strip_prefix(prefix.as_str()) else { continue };
        for target in targets {
            let joined = if target.is_empty() {
                rest.to_string()
            } else {
                format!("{}/{}", target.trim_end_matches('/'), rest)
            };
            out.push(joined.trim_matches('/').to_string());
        }
    }
    out
}

/// Where a Rust crate's `crate::` paths start from, for a file inside it.
fn crate_root(from: &str) -> String {
    let mut here = from.to_string();
    while let Some((dir, _)) = here.rsplit_once('/') {
        if dir.ends_with("/src") || dir == "src" {
            return dir.to_string();
        }
        here = dir.to_string();
    }
    String::new()
}

fn join(dir: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for segment in relative.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// How sure an answer is.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    /// Every import in the files involved resolved inside the project.
    Whole,
    /// Something was not resolved or not read: the answer may be missing
    /// tests, and the caller should be told so rather than shown a number.
    Partial,
}

/// What a change can affect.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    /// The files given, as the project spells them.
    pub changed: Vec<String>,
    /// Everything reachable backwards from them: the files that import them,
    /// what imports those, and so on.
    pub affected: Vec<String>,
    /// The subset of `affected` (plus any changed file that is itself a test)
    /// that looks like a test.
    pub tests: Vec<String>,
    /// Changed paths that are not source files this reads, or are not in the
    /// project at all -- said rather than dropped.
    pub unknown: Vec<String>,
    /// Imports that named a file here and did not find one: the count of
    /// edges this answer is missing.
    pub missed: usize,
    /// Whether a bound stopped the walk that produced this answer.
    pub truncated: bool,
    pub confidence: Confidence,
}

/// The tests that cover one source file.
pub fn tests_for(graph: &Graph, file: &str) -> Vec<String> {
    impact_of(graph, std::slice::from_ref(&file.to_string())).tests
}

/// What a set of changed files can affect.
///
/// The paths are the project's own spelling, `/`-separated and relative. A
/// path that is not in the graph is reported in `unknown` rather than ignored:
/// "no tests cover this" and "I have never seen this file" are different
/// answers, and only one of them means it is safe to skip the suite.
pub fn impact(project_root: &Path, changed: &[String]) -> Result<Impact, ImpactError> {
    for path in changed {
        if path.contains("..") || Path::new(path).is_absolute() {
            return Err(ImpactError::new(
                ImpactErrorKind::Escapes,
                format!("{path:?} is not a path inside this project"),
            ));
        }
    }
    let graph = graph(project_root)?;
    Ok(impact_of(&graph, changed))
}

fn impact_of(graph: &Graph, changed: &[String]) -> Impact {
    let importers = graph.importers();
    let known: BTreeSet<&str> = graph.files.iter().map(String::as_str).collect();
    let mut unknown = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    for path in changed {
        let normalised = path.replace('\\', "/");
        if known.contains(normalised.as_str()) {
            queue.push_back(normalised);
        } else {
            unknown.push(normalised);
        }
    }
    while let Some(file) = queue.pop_front() {
        if !seen.insert(file.clone()) {
            continue;
        }
        for importer in importers.get(file.as_str()).into_iter().flatten() {
            if !seen.contains(*importer) {
                queue.push_back((*importer).to_string());
            }
        }
    }
    let tests: Vec<String> = seen.iter().filter(|f| graph.tests.contains(*f)).cloned().collect();
    // Partial when something that should have been seen was not: a walk that
    // hit a bound, an import that named a file here and did not find it, or a
    // changed path that is not in the graph at all. Any of those can hide a
    // test. Imports that named packages do not count -- in a real repository
    // almost every file has one, and treating that as incompleteness would
    // make every answer partial and the feature useless.
    let confidence = if graph.truncated || graph.missed > 0 || !unknown.is_empty() {
        Confidence::Partial
    } else {
        Confidence::Whole
    };
    Impact {
        changed: changed.iter().map(|c| c.replace('\\', "/")).collect(),
        affected: seen.into_iter().collect(),
        tests,
        unknown,
        missed: graph.missed,
        truncated: graph.truncated,
        confidence,
    }
}

/// What to run after a change, and why.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub impact: Impact,
    /// The command to run, from the project's own detected test runner. `None`
    /// when the project does not say how its tests are run -- a command is
    /// never invented.
    pub command: Option<String>,
    /// Why this is what it is, in one line, for a person reading the run.
    pub reason: String,
}

/// Choose the tests to run for a change.
///
/// Two refusals worth naming. When the impact is `Partial`, the whole suite is
/// proposed rather than a subset: an incomplete graph can hide the one test
/// that would have failed, and a green subset would then be a false negative
/// dressed as a pass. When the project does not say how to run its tests,
/// there is no command at all -- guessing `npm test` at a project that has no
/// such script wastes a turn and teaches the model a command that does not
/// work.
pub fn selection(
    project_root: &Path,
    changed: &[String],
    runner_command: Option<&str>,
) -> Result<Selection, ImpactError> {
    let impact = impact(project_root, changed)?;
    let command = runner_command.map(str::to_string);
    let reason = match (&command, impact.confidence, impact.tests.len()) {
        (None, _, _) => {
            "this project does not say how its tests are run, so nothing is proposed".to_string()
        }
        (Some(_), Confidence::Partial, _) => format!(
            "the whole suite: the import graph is incomplete here ({} import(s) named a file that was not found, {} changed path(s) not seen{}), so a smaller selection could miss the test that matters",
            impact.missed,
            impact.unknown.len(),
            if impact.truncated { ", and the walk hit a bound" } else { "" }
        ),
        (Some(_), Confidence::Whole, 0) => {
            "the whole suite: nothing in this project's tests reaches the changed files"
                .to_string()
        }
        (Some(_), Confidence::Whole, n) => {
            format!("{n} test file(s) reach the changed files through the import graph")
        }
    };
    Ok(Selection { impact, command, reason })
}

/// The command this project's own detected test runner uses, if it says.
///
/// Read from the same detection the prompt and the readiness card use
/// (AH-070), so the run, the panel and this all name one command. A project
/// whose manifest does not say how its tests are run yields `None` -- there is
/// no fallback guess here, because a guessed command is a turn spent learning
/// that it does not work.
pub fn detected_runner(project_root: &Path) -> Option<String> {
    use crate::core::agent::tooling::{self, FactKind, TestKind};
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let tooling = tooling::detect(project_root, &cancel).ok()?;
    let runners: Vec<_> = tooling
        .facts
        .iter()
        .filter(|f| f.kind == FactKind::TestRunner && f.command.is_some())
        .collect();
    // A unit-test command first: it is the one a change-scoped selection is
    // for. An end-to-end suite is a decision, not a default.
    runners
        .iter()
        .find(|f| f.test_kind == Some(TestKind::Unit))
        .or_else(|| runners.first())
        .and_then(|f| f.command.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan-impact-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        for (path, body) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        root
    }

    #[test]
    fn a_nested_rust_use_resolves_to_the_deepest_module_file() {
        let root = project(
            "nested",
            &[
                ("src/main.rs", "mod core;\nuse crate::core::agent::r#loop::ModelInvoker;\nuse crate::core::agent::{a, b};\n"),
                ("src/core/mod.rs", "pub mod agent;\n"),
                ("src/core/agent/mod.rs", "pub mod r#loop;\n"),
                ("src/core/agent/loop.rs", "pub struct ModelInvoker;\n"),
            ],
        );
        let g = graph(&root).unwrap();
        let edges = &g.edges["src/main.rs"];
        assert!(edges.contains("src/core/agent/loop.rs"), "{edges:?}");
        assert!(edges.contains("src/core/agent/mod.rs"), "{edges:?}");
        assert_eq!(g.missed, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_import_that_names_a_file_here_is_an_edge_and_one_that_names_a_package_is_not() {
        let root = project(
            "edges",
            &[
                ("src/main.rs", "mod store;\nuse crate::store::Thing;\nuse serde::Serialize;\n"),
                ("src/store.rs", "pub struct Thing;\n"),
                ("web/app.ts", "import { thing } from './store'\nimport React from 'react'\n"),
                ("web/store.ts", "export const thing = 1\n"),
                ("py/app.py", "from .store import thing\nimport os\n"),
                ("py/store.py", "thing = 1\n"),
            ],
        );
        let g = graph(&root).unwrap();
        assert_eq!(g.edges["src/main.rs"], BTreeSet::from(["src/store.rs".to_string()]));
        assert_eq!(g.edges["web/app.ts"], BTreeSet::from(["web/store.ts".to_string()]));
        assert_eq!(g.edges["py/app.py"], BTreeSet::from(["py/store.py".to_string()]));
        // `react` and `os` name packages: they resolve to nothing and are
        // counted, never invented as files. `use serde::Serialize` is not even
        // a candidate -- a Rust `use` that does not start at `crate::` or
        // `self::` names something outside this file tree by construction.
        assert_eq!(g.external, 2, "a package must not become an edge");
        assert_eq!(g.missed, 0, "nothing that named a file here went unresolved");
        let targets: Vec<&String> = g.edges.values().flatten().collect();
        assert!(
            targets.iter().all(|t| !t.contains("serde") && !t.contains("react") && *t != "os"),
            "a package was resolved to a file: {targets:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_test_is_found_through_the_files_between_it_and_the_change() {
        let root = project(
            "indirect",
            &[
                ("src/store.ts", "export const load = () => 1\n"),
                ("src/service.ts", "import { load } from './store'\nexport const use = load\n"),
                ("src/api.ts", "import { use } from './service'\nexport const api = use\n"),
                ("src/__tests__/api.test.ts", "import { api } from '../api'\nit('works', () => api())\n"),
                ("src/unrelated.ts", "export const x = 1\n"),
                ("src/__tests__/unrelated.test.ts", "import { x } from '../unrelated'\n"),
            ],
        );
        let g = graph(&root).unwrap();
        let covering = tests_for(&g, "src/store.ts");
        assert_eq!(
            covering,
            ["src/__tests__/api.test.ts"],
            "a test three edges away still covers the change"
        );
        // And the test that cannot reach it is not claimed.
        assert!(!covering.iter().any(|t| t.contains("unrelated")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_change_resolves_to_what_it_can_reach_and_says_what_it_could_not_place() {
        let root = project(
            "impact",
            &[
                ("src/store.py", "VALUE = 1\n"),
                ("src/service.py", "from .store import VALUE\n"),
                ("tests/test_service.py", "from src.service import VALUE\n"),
            ],
        );
        let found = impact(&root, &["src/store.py".to_string(), "README.md".to_string()]).unwrap();
        assert!(found.affected.contains(&"src/service.py".to_string()));
        assert_eq!(found.tests, ["tests/test_service.py"]);
        // A path this does not know is said, not silently dropped: "nothing
        // covers it" and "I have not seen it" are different answers.
        assert_eq!(found.unknown, ["README.md"]);
        assert_eq!(found.confidence, Confidence::Partial);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_that_leaves_the_project_is_refused_rather_than_read() {
        let root = project("escape", &[("src/a.py", "X = 1\n")]);
        for hostile in ["../secrets.py", "src/../../elsewhere.py"] {
            let err = impact(&root, &[hostile.to_string()]).unwrap_err();
            assert_eq!(err.kind, ImpactErrorKind::Escapes, "{hostile}");
            let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&err).into();
            assert_eq!(
                harness.kind(),
                tauri_plugin_agent_tools::harness_error::ErrorKind::SandboxDenied
            );
        }
        let missing = impact(Path::new("no-such-project-here"), &[]).unwrap_err();
        assert_eq!(missing.kind, ImpactErrorKind::NoProject);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The selection rules, which are mostly about when *not* to narrow.
    #[test]
    fn a_selection_narrows_only_when_it_can_see_the_whole_graph() {
        let root = project(
            "select",
            &[
                ("src/store.ts", "export const load = () => 1\n"),
                ("src/store.test.ts", "import { load } from './store'\n"),
            ],
        );
        let whole = selection(&root, &["src/store.ts".to_string()], Some("yarn test")).unwrap();
        assert_eq!(whole.impact.confidence, Confidence::Whole);
        assert_eq!(whole.impact.tests, ["src/store.test.ts"]);
        assert_eq!(whole.command.as_deref(), Some("yarn test"));
        assert!(whole.reason.contains("1 test file"), "{}", whole.reason);

        // A change this cannot place makes the answer partial, and a partial
        // answer proposes the suite rather than a subset that might be green
        // for the wrong reason.
        let partial =
            selection(&root, &["src/unseen.ts".to_string()], Some("yarn test")).unwrap();
        assert_eq!(partial.impact.confidence, Confidence::Partial);
        assert!(partial.reason.starts_with("the whole suite"), "{}", partial.reason);

        // And with no detected runner there is no command at all.
        let no_runner = selection(&root, &["src/store.ts".to_string()], None).unwrap();
        assert_eq!(no_runner.command, None);
        assert!(no_runner.reason.contains("does not say how"), "{}", no_runner.reason);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The distinction that decides whether an answer is usable at all: a
    /// package import is not a missing edge, and a relative import that names
    /// nothing here is.
    #[test]
    fn a_package_import_is_not_incompleteness_but_a_broken_relative_one_is() {
        let ordinary = project(
            "external",
            &[
                ("src/a.ts", "import React from 'react'
export const a = 1
"),
                ("src/a.test.ts", "import { a } from './a'
"),
            ],
        );
        let g = graph(&ordinary).unwrap();
        assert!(g.external > 0 && g.missed == 0);
        let found = impact(&ordinary, &["src/a.ts".to_string()]).unwrap();
        assert_eq!(
            found.confidence,
            Confidence::Whole,
            "every real file imports a package; that cannot be what makes an answer partial"
        );
        assert_eq!(found.tests, ["src/a.test.ts"]);

        // An import that meant a file here and found none is a missing edge.
        let broken = project(
            "missed",
            &[("src/a.ts", "import { gone } from './not-here'
export const a = 1
")],
        );
        let g = graph(&broken).unwrap();
        assert_eq!(g.missed, 1, "a relative import that resolves to nothing is a missed edge");
        assert_eq!(
            impact(&broken, &["src/a.ts".to_string()]).unwrap().confidence,
            Confidence::Partial
        );
        let _ = std::fs::remove_dir_all(&ordinary);
        let _ = std::fs::remove_dir_all(&broken);
    }

    #[test]
    fn a_walk_that_hit_a_bound_says_the_answer_is_partial() {
        let root = project("bounded", &[("src/a.ts", "export const a = 1\n")]);
        // A file too big to read is not read, and that is said.
        std::fs::write(root.join("src/huge.ts"), "x".repeat((MAX_FILE_BYTES + 1) as usize))
            .unwrap();
        let g = graph(&root).unwrap();
        assert!(g.truncated, "a file that was skipped must make the graph partial");
        assert!(!g.files.contains(&"src/huge.ts".to_string()));
        let found = impact(&root, &["src/a.ts".to_string()]).unwrap();
        assert_eq!(found.confidence, Confidence::Partial);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The command comes from the project's own manifest, and there is none
    /// when the manifest does not say.
    #[test]
    fn the_runner_command_is_the_projects_own_or_there_is_none() {
        let root = project(
            "runner",
            &[
                (
                    "package.json",
                    r#"{"name":"p","scripts":{"test":"vitest --run"},"devDependencies":{"vitest":"1.0.0"}}"#,
                ),
                // Which package manager runs it is part of what the project
                // says: without a lockfile there is no command, by design --
                // `npm test` at a yarn project is a guess.
                ("yarn.lock", "# yarn lockfile v1
"),
                ("src/a.ts", "export const a = 1
"),
            ],
        );
        let found = detected_runner(&root);
        assert!(
            found.as_deref().is_some_and(|c| c.contains("test")),
            "the project's own test script should be found: {found:?}"
        );
        let bare = project("runner-none", &[("src/a.ts", "export const a = 1
")]);
        assert_eq!(detected_runner(&bare), None, "nothing is invented");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// The case a real app is written in: every import goes through the
    /// project's own alias, so without reading `paths` the answer is empty.
    #[test]
    fn an_import_through_the_projects_own_alias_is_still_an_edge() {
        let root = project(
            "alias",
            &[
                (
                    "tsconfig.json",
                    r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }"#,
                ),
                ("src/lib/timeline.ts", "export const build = () => 1\n"),
                (
                    "src/lib/__tests__/timeline.test.ts",
                    "import { build } from '@/lib/timeline'\nimport { it } from 'vitest'\n",
                ),
            ],
        );
        let g = graph(&root).unwrap();
        assert_eq!(
            tests_for(&g, "src/lib/timeline.ts"),
            ["src/lib/__tests__/timeline.test.ts"],
            "an aliased import must resolve to the file it names: {:?}",
            g.edges
        );
        // `vitest` is still a package, alias or no alias.
        let targets: Vec<&String> = g.edges.values().flatten().collect();
        assert!(targets.iter().all(|t| !t.contains("vitest")), "{targets:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn what_counts_as_a_test_is_a_convention_not_a_guess() {
        for yes in [
            "tests/test_thing.py",
            "src/__tests__/a.test.ts",
            "src/a.spec.ts",
            "src/thing_test.rs",
            "test/helper.js",
        ] {
            assert!(looks_like_test(yes), "{yes}");
        }
        for no in ["src/latest.ts", "src/contest.py", "src/attestation.rs", "src/main.rs"] {
            assert!(!looks_like_test(no), "{no}");
        }
    }

    /// Generated and vendored trees are not read: they are large, they are not
    /// where a change is made, and reading them would swamp the answer.
    #[test]
    fn the_places_a_change_is_never_made_are_not_read() {
        let root = project(
            "ignored",
            &[
                ("src/a.ts", "export const a = 1\n"),
                ("node_modules/pkg/index.ts", "export const p = 1\n"),
                ("target/debug/build.rs", "fn main() {}\n"),
                ("dist/bundle.js", "var x = 1\n"),
            ],
        );
        let g = graph(&root).unwrap();
        assert_eq!(g.files, ["src/a.ts"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
