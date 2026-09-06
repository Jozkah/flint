//! A one-shot diagnostic over the repository and the agent's index of it.
//!
//! Every other repository tool answers a question by trusting the index. This
//! one asks whether the index deserves that trust, and reports each way it
//! might not: built from a tree that has since moved on, written by an older
//! schema, carrying edges to files that were deleted, or carrying build output
//! `.gitignore` should have kept out.
//!
//! It runs no compiler, no type checker, no linter and no test. So it cannot
//! say a repository is healthy -- only that a fixed list of checks found
//! nothing, which is a different and much smaller claim. The report says which
//! checks ran and which were skipped and why, because a check that silently
//! did not run reads exactly like a check that passed.
//!
//! Findings are advisory. Several -- duplicate names, unsupported languages,
//! build-configuration gates -- are usually deliberate, and are reported as
//! notes so that a report full of correct-but-uninteresting errors does not
//! teach the reader to skip the report.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::impact::{candidates, is_test_path};
use super::index::{RepoIndex, SymbolKind, INDEX_SCHEMA_VERSION};
use super::project_kind;

/// The most paths named in any one finding's evidence. The rest are counted.
pub(crate) const MAX_SAMPLE: usize = 8;

/// The most files the tree walk will look at, matching the index's own cap.
const MAX_WALK: usize = 20_000;

/// The most files opened to probe for an in-file test module.
const MAX_TEST_PROBES: usize = 4_000;

/// The most bytes read from the feature registry.
const MAX_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;

/// The index's own per-file ceiling, mirrored so the walk excludes exactly what
/// the index excludes. Without this, every file above the ceiling reads as
/// permanently "added since the index was built", which is a stale-index
/// warning that no rebuild can ever clear.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Directory names that mean build output, matched as whole path segments.
///
/// `vendor` is deliberately absent. It reads as vendored dependencies, but it
/// is also an ordinary word: this repository has a hand-written
/// `tauri-plugin-hardware/src/vendor/` holding GPU vendor code, and flagging it
/// would tell the reader not to edit real source. A check that is wrong in that
/// direction is worse than one that misses a case.
const GENERATED_DIRS: &[&str] = &["node_modules", "dist", "build", "out", "__pycache__"];

/// Filename endings that mean generated output.
const GENERATED_SUFFIXES: &[&str] = &[".min.js", ".generated.ts", ".generated.js", "_pb2.py", ".pb.go"];

/// Path prefixes that mean build output.
const GENERATED_PREFIXES: &[&str] = &["target/debug/", "target/release/"];

/// How much a finding matters. Deliberately three levels: anything finer
/// invites arguing about the boundary instead of reading the finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Severity {
    /// The index or the project metadata is wrong, and other tools will lie.
    Error,
    /// Something is inconsistent and worth looking at before trusting a result.
    Warning,
    /// True, possibly deliberate, and stated so it is not mistaken for absent.
    Note,
}

impl Severity {
    fn label(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Note => "note",
        }
    }
}

/// One thing the scan found, and how it knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Finding {
    /// Stable identifier for the check, so a report can be diffed run to run.
    pub check: &'static str,
    pub severity: Severity,
    /// What is wrong, in one line.
    pub what: String,
    /// The paths, counts or values the finding rests on.
    pub evidence: String,
}

/// A check that did not run, and why. Never silently omitted: a check that
/// could not run is not a check that passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Skipped {
    pub check: &'static str,
    pub why: String,
}

/// The outcome of one scan.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Report {
    pub findings: Vec<Finding>,
    /// Checks that executed, whether or not they found anything.
    pub ran: Vec<&'static str>,
    pub skipped: Vec<Skipped>,
}

impl Report {
    fn ran(&mut self, check: &'static str) {
        if !self.ran.contains(&check) {
            self.ran.push(check);
        }
    }

    fn skip(&mut self, check: &'static str, why: impl Into<String>) {
        self.ran.retain(|c| *c != check);
        if !self.skipped.iter().any(|s| s.check == check) {
            self.skipped.push(Skipped { check, why: why.into() });
        }
    }

    fn push(&mut self, check: &'static str, severity: Severity, what: impl Into<String>, evidence: impl Into<String>) {
        self.findings.push(Finding {
            check,
            severity,
            what: what.into(),
            evidence: evidence.into(),
        });
    }
}

/// Renders up to `MAX_SAMPLE` names, then says how many were left out. A
/// truncated list that does not admit it is a lie about the size of a problem.
fn sample(items: &[String]) -> String {
    if items.len() <= MAX_SAMPLE {
        return items.join(", ");
    }
    let shown = items[..MAX_SAMPLE].join(", ");
    format!("{shown}, and {} more", items.len() - MAX_SAMPLE)
}

/// What the tree looks like right now, independent of the index.
struct Tree {
    /// Indexable files -> (size, mtime_ms).
    indexable: BTreeMap<String, (u64, u64)>,
    /// Extensions the indexer does not read -> how many files carry them.
    unsupported: BTreeMap<String, usize>,
    /// Files in an indexable language that exceed the index's size ceiling.
    oversized: Vec<String>,
    /// True if the walk hit its cap, so every count below is a lower bound.
    truncated: bool,
}

fn relative_key(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

/// Walks the repository under the same rules the index uses -- `.gitignore`
/// honoured, hidden files skipped -- so a difference between this and the index
/// is a real difference and not a difference of method.
fn walk(root: &Path) -> Tree {
    let mut tree = Tree {
        indexable: BTreeMap::new(),
        unsupported: BTreeMap::new(),
        oversized: Vec::new(),
        truncated: false,
    };

    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .parents(false)
        .require_git(false)
        .build();

    let mut seen = 0usize;
    for entry in walker.flatten() {
        if seen >= MAX_WALK {
            tree.truncated = true;
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(relative) = relative_key(root, path) else {
            continue;
        };
        seen += 1;
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(extension, "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "py" | "go") {
            if !extension.is_empty() {
                *tree.unsupported.entry(extension.to_string()).or_default() += 1;
            }
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            // Recorded as absent from the tree; the index comparison then
            // reports it as unreadable rather than quietly matching.
            continue;
        };
        if metadata.len() > MAX_FILE_BYTES {
            tree.oversized.push(relative);
            continue;
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        tree.indexable.insert(relative, (metadata.len(), mtime_ms));
    }
    tree
}

/// Runs every check that its inputs allow, and records the rest as skipped.
pub(crate) fn scan(root: &Path, index: Option<&RepoIndex>) -> Report {
    let mut report = Report::default();

    if !root.is_dir() {
        report.ran("root-unreadable");
        report.push(
            "root-unreadable",
            Severity::Error,
            "the scan root is not a readable directory, so nothing was checked",
            root.display().to_string(),
        );
        for check in ALL_CHECKS {
            if *check != "root-unreadable" {
                report.skip(check, "the scan root is not a readable directory");
            }
        }
        return report;
    }
    report.ran("root-unreadable");

    let tree = walk(root);
    check_project_metadata(root, &mut report);
    check_registry(root, &mut report);

    let Some(index) = index else {
        report.ran("index-missing");
        report.push(
            "index-missing",
            Severity::Error,
            "no index has been built for this repository, so every index-backed answer is unavailable rather than empty",
            format!("{} indexable files found on disk", tree.indexable.len()),
        );
        for check in INDEX_CHECKS {
            report.skip(check, "there is no index to check");
        }
        check_languages(&tree, &mut report);
        check_oversized(&tree, &mut report);
        return report;
    };
    report.ran("index-missing");

    check_schema(index, &mut report);
    check_staleness(&tree, index, &mut report);
    check_unreadable(root, &tree, index, &mut report);
    check_imports(root, &tree, index, &mut report);
    check_duplicates(index, &mut report);
    check_languages(&tree, &mut report);
    check_oversized(&tree, &mut report);
    check_generated(index, &mut report);
    check_untested(root, index, &mut report);
    check_config_drift(root, index, &mut report);
    report
}

/// Every check this module can run, in report order.
const ALL_CHECKS: &[&str] = &[
    "root-unreadable",
    "index-missing",
    "index-schema",
    "index-stale",
    "file-unreadable",
    "import-broken",
    "project-metadata",
    "symbol-duplicate",
    "language-unsupported",
    "file-oversized",
    "index-generated",
    "capability-untested",
    "registry-drift",
    "config-drift",
];

/// The checks that cannot run without an index.
const INDEX_CHECKS: &[&str] = &[
    "index-schema",
    "index-stale",
    "file-unreadable",
    "import-broken",
    "symbol-duplicate",
    "index-generated",
    "capability-untested",
    "config-drift",
];

fn check_schema(index: &RepoIndex, report: &mut Report) {
    report.ran("index-schema");
    if index.schema_version != INDEX_SCHEMA_VERSION {
        report.push(
            "index-schema",
            Severity::Error,
            "the index was written by a different schema version and will be discarded and rebuilt",
            format!(
                "index carries schema {}, this build expects {INDEX_SCHEMA_VERSION}",
                index.schema_version
            ),
        );
    }
}

fn check_staleness(tree: &Tree, index: &RepoIndex, report: &mut Report) {
    report.ran("index-stale");
    let mut added: Vec<String> = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    for (path, (size, mtime)) in &tree.indexable {
        match index.files.get(path) {
            None => added.push(path.clone()),
            Some(entry) if entry.size != *size || entry.mtime_ms != *mtime => {
                changed.push(path.clone())
            }
            Some(_) => {}
        }
    }
    for path in index.files.keys() {
        if !tree.indexable.contains_key(path) {
            removed.push(path.clone());
        }
    }

    if added.is_empty() && changed.is_empty() && removed.is_empty() {
        return;
    }
    let mut parts: Vec<String> = Vec::new();
    if !added.is_empty() {
        parts.push(format!("{} added ({})", added.len(), sample(&added)));
    }
    if !changed.is_empty() {
        parts.push(format!("{} changed ({})", changed.len(), sample(&changed)));
    }
    if !removed.is_empty() {
        parts.push(format!("{} removed ({})", removed.len(), sample(&removed)));
    }
    report.push(
        "index-stale",
        Severity::Warning,
        "the tree has moved on since the index was built, so index-backed answers may name lines that no longer exist",
        parts.join("; "),
    );
}

fn check_unreadable(root: &Path, tree: &Tree, index: &RepoIndex, report: &mut Report) {
    report.ran("file-unreadable");
    let mut gone: Vec<String> = Vec::new();
    for path in index.files.keys() {
        if tree.indexable.contains_key(path) {
            continue;
        }
        // Absent from the walk: either deleted, or present but unreadable.
        // Both mean a stored line number cannot be checked; the distinction
        // is worth drawing because only one of them is a permissions problem.
        let full = root.join(path);
        let note = if full.exists() { "unreadable" } else { "absent" };
        gone.push(format!("{path} ({note})"));
    }
    if gone.is_empty() {
        return;
    }
    report.push(
        "file-unreadable",
        Severity::Warning,
        "files in the index could not be read back from disk",
        sample(&gone),
    );
}

fn check_imports(root: &Path, tree: &Tree, index: &RepoIndex, report: &mut Report) {
    report.ran("import-broken");
    let mut broken: Vec<String> = Vec::new();
    for (path, entry) in &index.files {
        for target in &entry.imports {
            // An import is only recorded once its target has been seen on
            // disk, so a target missing now was deleted or renamed after the
            // index was built. The test is against the tree, never against the
            // index: the index still holding an entry for a deleted file is
            // exactly the state this check exists to find.
            if tree.indexable.contains_key(target) {
                continue;
            }
            // Absent from the walk but present on disk means it became hidden
            // or ignored rather than deleted. That is not a broken edge.
            if root.join(target).is_file() {
                continue;
            }
            broken.push(format!("{path} -> {target}"));
        }
    }
    if broken.is_empty() {
        return;
    }
    report.push(
        "import-broken",
        Severity::Warning,
        "the index records imports whose target no longer exists, so dependent lookups are incomplete",
        sample(&broken),
    );
}

fn check_project_metadata(root: &Path, report: &mut Report) {
    report.ran("project-metadata");
    let kind = project_kind::detect(root);
    if kind.is_empty() {
        report.push(
            "project-metadata",
            Severity::Error,
            "no recognised manifest at the repository root, so the agent has no build or test command and will guess",
            "looked for the manifests of the ecosystems this build recognises; found none",
        );
        return;
    }
    let mut missing: Vec<&str> = Vec::new();
    if kind.build.is_empty() {
        missing.push("build");
    }
    if kind.test.is_empty() {
        missing.push("test");
    }
    if missing.is_empty() {
        return;
    }
    let found: Vec<String> = kind.ecosystems.iter().map(|f| f.what.clone()).collect();
    report.push(
        "project-metadata",
        Severity::Warning,
        format!("no {} command could be established from the manifests", missing.join(" or ")),
        format!("ecosystems detected: {}", if found.is_empty() { "none".to_string() } else { found.join(", ") }),
    );
}

fn check_duplicates(index: &RepoIndex, report: &mut Report) {
    report.ran("symbol-duplicate");
    let mut homes: BTreeMap<(&str, SymbolKind), BTreeSet<&str>> = BTreeMap::new();
    for (path, entry) in &index.files {
        for symbol in &entry.symbols {
            homes
                .entry((symbol.name.as_str(), symbol.kind))
                .or_default()
                .insert(path.as_str());
        }
    }
    let mut ambiguous: Vec<(usize, String)> = homes
        .iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|((name, kind), paths)| (paths.len(), format!("{name} ({kind:?}) in {} files", paths.len())))
        .collect();
    if ambiguous.is_empty() {
        return;
    }
    // Worst first, then alphabetically, so the same index always renders the
    // same list.
    ambiguous.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = ambiguous.len();
    let lines: Vec<String> = ambiguous.into_iter().map(|(_, line)| line).collect();
    report.push(
        "symbol-duplicate",
        Severity::Note,
        format!("{total} names are declared in more than one file, and no search here can tell you which one a caller meant"),
        sample(&lines),
    );
}

fn check_languages(tree: &Tree, report: &mut Report) {
    report.ran("language-unsupported");
    if tree.unsupported.is_empty() {
        return;
    }
    let mut counted: Vec<(usize, String)> = tree
        .unsupported
        .iter()
        .map(|(extension, count)| (*count, format!(".{extension} x{count}")))
        .collect();
    counted.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let lines: Vec<String> = counted.into_iter().map(|(_, line)| line).collect();
    report.push(
        "language-unsupported",
        Severity::Note,
        "files in languages this index does not parse are invisible to symbol search, code search and impact",
        sample(&lines),
    );
}

fn check_oversized(tree: &Tree, report: &mut Report) {
    report.ran("file-oversized");
    if tree.oversized.is_empty() {
        return;
    }
    let mut files = tree.oversized.clone();
    files.sort();
    report.push(
        "file-oversized",
        Severity::Note,
        format!(
            "{} file(s) are in an indexable language but exceed the index's {MAX_FILE_BYTES}-byte ceiling, so their declarations are absent from every search",
            files.len()
        ),
        sample(&files),
    );
}

/// Whether a path looks like build output.
///
/// Directory names are matched as whole segments, never as substrings: `build`
/// as a substring also matches `rebuild.rs` and `src/buildings/`, and a false
/// positive here points the reader away from source they are meant to edit.
fn is_generated(path: &str) -> bool {
    if GENERATED_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
        || GENERATED_SUFFIXES.iter().any(|suffix| path.ends_with(suffix))
    {
        return true;
    }
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    segments.iter().any(|segment| GENERATED_DIRS.contains(segment))
}

fn check_generated(index: &RepoIndex, report: &mut Report) {
    report.ran("index-generated");
    let mut suspects: Vec<String> = index
        .files
        .keys()
        .filter(|path| is_generated(path))
        .cloned()
        .collect();
    if suspects.is_empty() {
        return;
    }
    suspects.sort();
    report.push(
        "index-generated",
        Severity::Warning,
        "build output or vendored code reached the index, which dilutes every search and points edits at files that are regenerated",
        sample(&suspects),
    );
}

fn check_untested(root: &Path, index: &RepoIndex, report: &mut Report) {
    report.ran("capability-untested");
    let mut untested: Vec<String> = Vec::new();
    let mut probes = 0usize;
    let mut probe_capped = false;

    for (path, entry) in &index.files {
        // A `.d.ts` declares types for code that lives elsewhere. There is
        // nothing in it to test, so listing it as untested is noise that makes
        // the real entries harder to see.
        if entry.symbols.is_empty() || is_test_path(path) || path.ends_with(".d.ts") {
            continue;
        }
        if candidates(path).iter().any(|c| index.files.contains_key(c) || root.join(c).is_file()) {
            continue;
        }
        // A Rust file carrying `#[cfg(test)]` tests itself, and the index does
        // not record that, so it has to be read. Bounded, and the bound is
        // reported: an unprobed file is not a file without tests.
        if path.ends_with(".rs") {
            if probes >= MAX_TEST_PROBES {
                probe_capped = true;
                continue;
            }
            probes += 1;
            if std::fs::read_to_string(root.join(path))
                .is_ok_and(|text| text.contains("#[cfg(test)]"))
            {
                continue;
            }
        }
        untested.push(path.clone());
    }

    if untested.is_empty() {
        return;
    }
    let capped = if probe_capped {
        format!(" (stopped probing Rust files after {MAX_TEST_PROBES}, so this is a lower bound)")
    } else {
        String::new()
    };
    report.push(
        "capability-untested",
        Severity::Note,
        format!(
            "{} indexed files declare symbols and have no conventionally-named test; this is a naming convention, not coverage, so a file listed here may well be tested elsewhere",
            untested.len()
        ),
        format!("{}{capped}", sample(&untested)),
    );
}

/// Checks the harness feature registry's own claims against the tree, when one
/// is present. A registry that says `implemented` while naming a file that is
/// not there is worse than no registry: it is read as evidence.
fn check_registry(root: &Path, report: &mut Report) {
    const REGISTRY: &str = "docs/agent-harness-features.json";
    let path = root.join(REGISTRY);
    let Ok(metadata) = std::fs::metadata(&path) else {
        report.skip("registry-drift", format!("no {REGISTRY} in this repository"));
        return;
    };
    if metadata.len() > MAX_REGISTRY_BYTES {
        report.skip("registry-drift", format!("{REGISTRY} is larger than {MAX_REGISTRY_BYTES} bytes"));
        return;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        report.skip("registry-drift", format!("{REGISTRY} could not be read"));
        return;
    };
    report.ran("registry-drift");

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            report.push(
                "registry-drift",
                Severity::Error,
                format!("{REGISTRY} does not parse, so none of its claims could be checked"),
                error.to_string(),
            );
            return;
        }
    };
    let features = parsed
        .get("features")
        .and_then(|f| f.as_array())
        .or_else(|| parsed.as_array());
    let Some(features) = features else {
        report.push(
            "registry-drift",
            Severity::Error,
            format!("{REGISTRY} does not parse into a list of features, so none of its claims could be checked"),
            "expected a top-level array, or an object with a `features` array",
        );
        return;
    };

    let mut drift: Vec<String> = Vec::new();
    for feature in features {
        let id = feature.get("id").and_then(|v| v.as_str()).unwrap_or("<no id>");
        let status = feature.get("status").and_then(|v| v.as_str()).unwrap_or("");
        // Only claims of work done are checkable. `missing` and `planned` name
        // no files by design, and reporting them would bury the real drift.
        if !matches!(status, "implemented" | "verified" | "in-progress") {
            continue;
        }
        let strings = |key: &str| -> Vec<String> {
            feature
                .get(key)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        for file in strings("files") {
            if !root.join(&file).exists() {
                drift.push(format!("{id} ({status}) names {file}, which does not exist"));
            }
        }
        for test in strings("tests") {
            // `path::module::name` -- the file, then the test's own name.
            let Some((file, rest)) = test.split_once("::") else {
                continue;
            };
            let name = rest.rsplit("::").next().unwrap_or(rest);
            match std::fs::read_to_string(root.join(file)) {
                Ok(text) if text.contains(name) => {}
                Ok(_) => drift.push(format!("{id} ({status}) claims test {name}, which is not in {file}")),
                Err(_) => drift.push(format!("{id} ({status}) claims test {name} in {file}, which could not be read")),
            }
        }
    }

    if drift.is_empty() {
        return;
    }
    drift.sort();
    report.push(
        "registry-drift",
        Severity::Error,
        format!("{} registry claims are not backed by the tree", drift.len()),
        sample(&drift),
    );
}

/// Reports modules that exist in only one build configuration.
///
/// Two configurations that differ are not a defect -- this repository gates
/// modules on `cli` deliberately -- but they are the reason a green test run in
/// one configuration proves nothing about the other, and that is worth saying
/// out loud to anyone about to trust a single run.
fn check_config_drift(root: &Path, index: &RepoIndex, report: &mut Report) {
    report.ran("config-drift");
    let mut gated: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for path in index.files.keys() {
        if !path.ends_with(".rs") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.join(path)) else {
            continue;
        };
        if !text.contains("cfg(feature") {
            continue;
        }
        let mut pending: Option<String> = None;
        for raw in text.lines() {
            let line = raw.trim();
            if let Some(feature) = gate_feature(line) {
                pending = Some(feature);
                continue;
            }
            let Some(feature) = pending.take() else {
                continue;
            };
            if let Some(module) = module_name(line) {
                gated.entry(feature).or_default().push(format!("{path}: {module}"));
            }
        }
    }

    if gated.is_empty() {
        return;
    }
    let lines: Vec<String> = gated
        .into_iter()
        .map(|(feature, mut modules)| {
            modules.sort();
            format!("{feature}: {}", sample(&modules))
        })
        .collect();
    report.push(
        "config-drift",
        Severity::Note,
        "some modules exist in only one build configuration, so a test run in one configuration does not prove the other compiles",
        lines.join("; "),
    );
}

/// The feature named by a `#[cfg(feature = "x")]` or its `not(...)` form.
fn gate_feature(line: &str) -> Option<String> {
    if !line.starts_with("#[cfg(") || !line.contains("feature") {
        return None;
    }
    let (_, rest) = line.split_once("feature")?;
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let (name, _) = rest.split_once('"')?;
    let negated = line.contains("not(");
    Some(if negated { format!("not {name}") } else { name.to_string() })
}

/// The module named by a `mod x;` declaration, at any visibility.
fn module_name(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("pub mod ")
        .or_else(|| line.strip_prefix("pub(crate) mod "))
        .or_else(|| line.strip_prefix("mod "))?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() || !rest[name.len()..].trim_start().starts_with(';') {
        return None;
    }
    Some(name)
}

/// Renders the report for the model.
pub(crate) fn render(report: &Report) -> String {
    let mut out = String::new();
    let errors = report.findings.iter().filter(|f| f.severity == Severity::Error).count();
    let warnings = report.findings.iter().filter(|f| f.severity == Severity::Warning).count();
    let notes = report.findings.len() - errors - warnings;

    out.push_str(&format!(
        "Repository scan: {} check(s) run, {errors} error(s), {warnings} warning(s), {notes} note(s).\n",
        report.ran.len()
    ));

    if report.findings.is_empty() {
        out.push_str("\nNothing found by the checks that ran. That is not the same as a working repository -- see the limits below.\n");
    } else {
        for finding in &report.findings {
            out.push_str(&format!(
                "\n[{}] {}: {}\n  evidence: {}\n",
                finding.severity.label(),
                finding.check,
                finding.what,
                finding.evidence
            ));
        }
    }

    if !report.skipped.is_empty() {
        out.push_str("\nNot checked (a skipped check is not a passed one):\n");
        for skipped in &report.skipped {
            out.push_str(&format!("  {}: {}\n", skipped.check, skipped.why));
        }
    }

    out.push_str(
        "\nLimits: this scan reads files and compares them with the index. It runs no compiler, \
         type checker, linter or test, so it cannot tell you whether the code builds, passes or \
         is correct. Test mapping is by filename convention, not coverage. Duplicate names, \
         unsupported languages and build-configuration gates are usually deliberate and are \
         reported as notes, not defects.\n",
    );
    out
}

/// The tool description the model sees.
pub(crate) fn health_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "repo_health",
            "description":
                "Diagnose the repository index and project metadata: stale or missing index, \
                 schema mismatch, files that changed or cannot be read, imports whose target is \
                 gone, missing build/test commands, ambiguous symbol names, unindexed languages, \
                 build output that reached the index, files with no conventionally-named test, \
                 feature-registry claims not backed by the tree, and modules that exist in only \
                 one build configuration. It DOES NOT build, type check, lint or run tests, so it \
                 cannot report whether the code compiles or passes, and finding nothing does not \
                 mean the repository is healthy. Takes no arguments.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::index::{refresh, RepoIndex};
    use jan_agent_harness::fixtures::TempDir;

    fn repo(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new("health");
        for (name, body) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    fn indexed(files: &[(&str, &str)]) -> (TempDir, RepoIndex) {
        let dir = repo(files);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        (dir, index)
    }

    fn finding<'a>(report: &'a Report, check: &str) -> &'a Finding {
        report
            .findings
            .iter()
            .find(|f| f.check == check)
            .unwrap_or_else(|| panic!("no {check} finding in {:?}", report.findings))
    }

    fn has(report: &Report, check: &str) -> bool {
        report.findings.iter().any(|f| f.check == check)
    }

    fn skip_reason<'a>(report: &'a Report, check: &str) -> &'a str {
        report
            .skipped
            .iter()
            .find(|s| s.check == check)
            .map(|s| s.why.as_str())
            .unwrap_or_else(|| panic!("{check} was not skipped: {:?}", report.skipped))
    }

    // ---- missing and stale indexes --------------------------------------

    #[test]
    fn a_missing_index_is_an_error_not_a_clean_bill_of_health() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), None);
        let found = finding(&report, "index-missing");
        assert_eq!(found.severity, Severity::Error);
    }

    #[test]
    fn without_an_index_the_checks_that_need_one_are_skipped_with_a_reason() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), None);
        for check in ["index-stale", "import-broken", "symbol-duplicate"] {
            assert!(
                skip_reason(&report, check).contains("index"),
                "{check} should say it needs an index"
            );
        }
    }

    #[test]
    fn a_file_added_since_the_index_was_built_is_reported_as_stale() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        std::fs::write(dir.path().join("b.rs"), "pub fn b() {}\n").unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "index-stale");
        assert!(found.evidence.contains("b.rs"), "{}", found.evidence);
    }

    #[test]
    fn a_file_deleted_since_the_index_was_built_is_reported_as_stale() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n"), ("b.rs", "pub fn b() {}\n")]);
        std::fs::remove_file(dir.path().join("b.rs")).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "index-stale");
        assert!(found.evidence.contains("b.rs"), "{}", found.evidence);
    }

    #[test]
    fn an_index_matching_the_tree_reports_no_staleness() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "index-stale"));
    }

    // ---- schema ---------------------------------------------------------

    #[test]
    fn an_index_from_an_older_schema_is_reported_as_a_mismatch() {
        let (dir, mut index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        index.schema_version = 1;
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "index-schema");
        assert_eq!(found.severity, Severity::Error);
        assert!(found.evidence.contains('1'), "{}", found.evidence);
    }

    #[test]
    fn a_current_schema_is_not_reported() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "index-schema"));
    }

    // ---- unreadable files -----------------------------------------------

    #[test]
    fn an_indexed_file_that_can_no_longer_be_read_is_reported() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n"), ("b.rs", "pub fn b() {}\n")]);
        std::fs::remove_file(dir.path().join("b.rs")).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "file-unreadable");
        assert!(found.evidence.contains("b.rs"), "{}", found.evidence);
    }

    // ---- import edges ---------------------------------------------------

    #[test]
    fn an_import_whose_target_was_deleted_is_a_broken_edge() {
        let (dir, index) = indexed(&[
            ("mod.rs", "pub mod leaf;\n"),
            ("leaf.rs", "pub fn leaf() {}\n"),
        ]);
        std::fs::remove_file(dir.path().join("leaf.rs")).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "import-broken");
        assert!(found.evidence.contains("leaf.rs"), "{}", found.evidence);
    }

    #[test]
    fn intact_imports_produce_no_broken_edge_finding() {
        let (dir, index) = indexed(&[
            ("mod.rs", "pub mod leaf;\n"),
            ("leaf.rs", "pub fn leaf() {}\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "import-broken"));
    }

    // ---- project metadata -----------------------------------------------

    #[test]
    fn a_project_with_no_recognised_manifest_is_reported() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "project-metadata");
        assert_eq!(found.severity, Severity::Error);
    }

    #[test]
    fn a_project_with_a_manifest_but_no_test_command_says_which_part_is_missing() {
        let (dir, index) = indexed(&[("a.py", "def a():\n    pass\n")]);
        std::fs::write(dir.path().join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "project-metadata");
        assert!(found.what.contains("test"), "{}", found.what);
    }

    // ---- duplicate symbols ----------------------------------------------

    #[test]
    fn a_name_declared_in_two_files_is_reported_as_ambiguous() {
        let (dir, index) = indexed(&[
            ("a.rs", "pub fn handle() {}\n"),
            ("b.rs", "pub fn handle() {}\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "symbol-duplicate");
        assert!(found.evidence.contains("handle"), "{}", found.evidence);
    }

    #[test]
    fn a_duplicate_is_a_note_not_an_error_because_it_is_usually_legitimate() {
        let (dir, index) = indexed(&[
            ("a.rs", "pub fn handle() {}\n"),
            ("b.rs", "pub fn handle() {}\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        assert_eq!(finding(&report, "symbol-duplicate").severity, Severity::Note);
    }

    #[test]
    fn a_name_declared_once_is_not_reported_as_duplicate() {
        let (dir, index) = indexed(&[("a.rs", "pub fn handle() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "symbol-duplicate"));
    }

    // ---- unsupported languages ------------------------------------------

    #[test]
    fn files_in_a_language_the_indexer_cannot_read_are_named_with_their_count() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        std::fs::write(dir.path().join("x.rb"), "def x; end\n").unwrap();
        std::fs::write(dir.path().join("y.rb"), "def y; end\n").unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "language-unsupported");
        assert!(found.evidence.contains("rb"), "{}", found.evidence);
        assert!(found.evidence.contains('2'), "{}", found.evidence);
    }

    // ---- generated and ignored files ------------------------------------

    #[test]
    fn a_generated_file_that_reached_the_index_is_reported() {
        let (dir, index) = indexed(&[
            ("a.rs", "pub fn a() {}\n"),
            ("dist/bundle.js", "export function b() {}\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "index-generated");
        assert!(found.evidence.contains("dist/bundle.js"), "{}", found.evidence);
    }

    #[test]
    fn a_repository_without_generated_output_reports_none() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "index-generated"));
    }

    // ---- test coverage of indexed files ----------------------------------

    #[test]
    fn an_indexed_file_with_no_conventional_test_is_reported() {
        let (dir, index) = indexed(&[("src/a.ts", "export function a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "capability-untested");
        assert!(found.evidence.contains("src/a.ts"), "{}", found.evidence);
    }

    #[test]
    fn the_untested_finding_says_it_is_convention_not_coverage() {
        let (dir, index) = indexed(&[("src/a.ts", "export function a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "capability-untested");
        let text = format!("{} {}", found.what, found.evidence).to_lowercase();
        assert!(text.contains("convention"), "{text}");
        assert!(text.contains("coverage"), "{text}");
    }

    #[test]
    fn a_file_with_a_sibling_test_is_not_reported_as_untested() {
        let (dir, index) = indexed(&[
            ("src/a.ts", "export function a() {}\n"),
            ("src/a.test.ts", "test('a', () => {});\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        if has(&report, "capability-untested") {
            let found = finding(&report, "capability-untested");
            assert!(!found.evidence.contains("src/a.ts"), "{}", found.evidence);
        }
    }

    // ---- registry drift --------------------------------------------------

    #[test]
    fn a_registry_claiming_a_file_that_does_not_exist_is_an_error() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(
            dir.path().join("docs/agent-harness-features.json"),
            r#"{"features":[{"id":"X-1","status":"implemented","files":["src/gone.rs"],"tests":[]}]}"#,
        )
        .unwrap();
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "registry-drift");
        assert_eq!(found.severity, Severity::Error);
        assert!(found.evidence.contains("X-1"), "{}", found.evidence);
    }

    #[test]
    fn a_registry_claiming_a_test_that_is_not_in_the_file_is_an_error() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(
            dir.path().join("docs/agent-harness-features.json"),
            r#"{"features":[{"id":"X-2","status":"implemented","files":["a.rs"],
                "tests":["a.rs::tests::not_written_yet"]}]}"#,
        )
        .unwrap();
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "registry-drift");
        assert!(found.evidence.contains("not_written_yet"), "{}", found.evidence);
    }

    #[test]
    fn a_registry_whose_claims_hold_is_not_reported() {
        let dir = repo(&[("a.rs", "pub fn a() {}\nfn really_written() {}\n")]);
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(
            dir.path().join("docs/agent-harness-features.json"),
            r#"{"features":[{"id":"X-3","status":"implemented","files":["a.rs"],
                "tests":["a.rs::tests::really_written"]}]}"#,
        )
        .unwrap();
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "registry-drift"));
    }

    #[test]
    fn a_missing_registry_is_skipped_not_reported_as_a_defect() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "registry-drift"));
        assert!(skip_reason(&report, "registry-drift").contains("agent-harness-features.json"));
    }

    #[test]
    fn a_malformed_registry_is_reported_rather_than_silently_passing() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/agent-harness-features.json"), "{ not json").unwrap();
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "registry-drift");
        assert!(found.what.to_lowercase().contains("parse"), "{}", found.what);
    }

    // ---- configuration drift ---------------------------------------------

    #[test]
    fn a_module_gated_to_one_build_configuration_is_reported_as_drift() {
        let (dir, index) = indexed(&[(
            "mod.rs",
            "#[cfg(feature = \"cli\")]\npub mod only_cli;\npub mod shared;\n",
        ), ("only_cli.rs", "pub fn c() {}\n"), ("shared.rs", "pub fn s() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "config-drift");
        assert!(found.evidence.contains("cli"), "{}", found.evidence);
        assert!(found.evidence.contains("only_cli"), "{}", found.evidence);
    }

    #[test]
    fn an_ungated_module_tree_reports_no_drift() {
        let (dir, index) = indexed(&[
            ("mod.rs", "pub mod shared;\n"),
            ("shared.rs", "pub fn s() {}\n"),
        ]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "config-drift"));
    }

    // ---- bounds and honesty ----------------------------------------------

    #[test]
    fn a_root_that_is_not_a_directory_is_refused_with_a_reason() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(&dir.path().join("a.rs"), None);
        let found = finding(&report, "root-unreadable");
        assert_eq!(found.severity, Severity::Error);
    }

    #[test]
    fn the_report_lists_every_check_it_ran_so_silence_is_not_read_as_clean() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(report.ran.contains(&"index-stale"));
        assert!(report.ran.contains(&"import-broken"));
        assert!(!report.ran.is_empty());
    }

    #[test]
    fn a_skipped_check_is_never_also_listed_as_run() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), None);
        for skipped in &report.skipped {
            assert!(
                !report.ran.contains(&skipped.check),
                "{} is both run and skipped",
                skipped.check
            );
        }
    }

    #[test]
    fn a_sample_is_bounded_and_says_how_many_it_left_out() {
        let files: Vec<(String, String)> = (0..(MAX_SAMPLE + 5))
            .map(|n| (format!("src/f{n}.ts"), "export function f() {}\n".to_string()))
            .collect();
        let borrowed: Vec<(&str, &str)> =
            files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (dir, index) = indexed(&borrowed);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "capability-untested");
        assert!(found.evidence.contains("more"), "{}", found.evidence);
    }

    // ---- false positives found by reading real output --------------------

    #[test]
    fn a_file_above_the_index_ceiling_is_not_reported_as_stale() {
        let big = format!("pub fn a() {{}}\n{}", "// pad\n".repeat(200_000));
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n"), ("big.rs", big.as_str())]);
        let report = scan(dir.path(), Some(&index));
        if has(&report, "index-stale") {
            let found = finding(&report, "index-stale");
            assert!(!found.evidence.contains("big.rs"), "{}", found.evidence);
        }
    }

    #[test]
    fn a_file_above_the_index_ceiling_is_reported_as_invisible_to_search() {
        let big = format!("pub fn a() {{}}\n{}", "// pad\n".repeat(200_000));
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n"), ("big.rs", big.as_str())]);
        let report = scan(dir.path(), Some(&index));
        let found = finding(&report, "file-oversized");
        assert!(found.evidence.contains("big.rs"), "{}", found.evidence);
    }

    #[test]
    fn a_source_directory_named_vendor_is_not_mistaken_for_vendored_code() {
        let (dir, index) = indexed(&[("src/vendor/amd.rs", "pub fn amd() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "index-generated"), "{:?}", report.findings);
    }

    #[test]
    fn a_generated_directory_is_matched_as_a_segment_not_a_substring() {
        let (dir, index) = indexed(&[("src/buildings/a.rs", "pub fn a() {}\n")]);
        let report = scan(dir.path(), Some(&index));
        assert!(!has(&report, "index-generated"), "{:?}", report.findings);
    }

    #[test]
    fn a_type_declaration_file_is_not_reported_as_untested() {
        let (dir, index) = indexed(&[("src/types.d.ts", "export declare function a(): void;\n")]);
        let report = scan(dir.path(), Some(&index));
        if has(&report, "capability-untested") {
            let found = finding(&report, "capability-untested");
            assert!(!found.evidence.contains("types.d.ts"), "{}", found.evidence);
        }
    }

    // ---- rendering --------------------------------------------------------

    #[test]
    fn the_rendered_report_names_the_checks_that_were_skipped() {
        let dir = repo(&[("a.rs", "pub fn a() {}\n")]);
        let text = render(&scan(dir.path(), None));
        assert!(text.to_lowercase().contains("not checked"), "{text}");
        assert!(text.contains("index-stale"), "{text}");
    }

    #[test]
    fn a_clean_report_does_not_claim_the_repository_is_healthy() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let text = render(&scan(dir.path(), Some(&index))).to_lowercase();
        assert!(!text.contains("healthy"), "{text}");
    }

    #[test]
    fn the_report_says_what_the_scan_cannot_see() {
        let (dir, index) = indexed(&[("a.rs", "pub fn a() {}\n")]);
        let text = render(&scan(dir.path(), Some(&index))).to_lowercase();
        assert!(text.contains("compiler") || text.contains("does not build"), "{text}");
    }

    #[test]
    fn the_tool_description_does_not_promise_build_or_lint_results() {
        let schema = health_tool_schema();
        let description = schema["function"]["description"].as_str().unwrap().to_lowercase();
        assert!(description.contains("does not"), "{description}");
    }
}
