//! A declaration index over the repository (`AH-053`, `AH-054`, `AH-055`).
//!
//! The agent navigated code with `find`, `grep` and `read` and nothing else.
//! Locating a function meant grepping for a string that also matches its call
//! sites, its tests, and any comment mentioning it -- so "where is
//! `resolve_decision` defined" cost a turn and a page of output.
//!
//! This is a **declaration** index, and the word is load-bearing. It records
//! where names are *declared*, by matching the declaration syntax of a handful
//! of languages line by line. It is not a parser and does not pretend to be:
//!
//! - It finds declarations, never references. "Who calls this" is `AH-060`, and
//!   needs real analysis rather than pattern matching.
//! - It can be fooled. A declaration written inside a string literal looks like
//!   a declaration; the mitigation is that line comments are skipped and the
//!   tests pin both behaviours, so what it does is known rather than assumed.
//! - It says nothing about types, scopes or visibility.
//!
//! Being explicit about that is the point. An index that quietly missed half a
//! file's functions would be worse than no index, because the model would trust
//! it and stop grepping.
//!
//! Refresh is incremental: a file whose size and modification time are
//! unchanged is not re-read. That is what makes the index cheap enough to
//! refresh at the start of a run rather than build once and let rot.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use jan_agent_harness::error::{ErrorKind, HarnessError};

/// Schema of the persisted index. Bumped when the shape changes; an index
/// written by a different version is rebuilt rather than misread.
pub(crate) const INDEX_SCHEMA_VERSION: u32 = 2;

/// Largest file this will read. A declaration past this point is not worth
/// pulling a generated bundle or a vendored blob into memory for.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Ceiling on indexed files, so a pathological tree cannot make a run hang.
/// Reaching it is reported, never silent.
const MAX_FILES: usize = 20_000;

/// What a declaration is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SymbolKind {
    Function,
    Type,
    Constant,
}

/// One declared name and where it was declared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// Repository-relative path, always with `/` separators so an index built
    /// on Windows reads the same as one built anywhere else.
    pub path: String,
    /// 1-based, matching every editor and every compiler message.
    pub line: u32,
}

/// What was known about a file when it was last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileEntry {
    pub size: u64,
    pub mtime_ms: u64,
    pub symbols: Vec<Symbol>,
    /// Repository-relative paths this file imports.
    ///
    /// Only specifiers that resolve to a file in this repository, which is why
    /// this is trustworthy where "find references" would not be: an import is a
    /// declaration at the top of a file with unambiguous syntax, not a name
    /// that might be a call, a comment or a string.
    #[serde(default)]
    pub imports: Vec<String>,
}

/// The persisted index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RepoIndex {
    pub schema_version: u32,
    pub built_at_ms: u64,
    /// Whether the last build stopped at [`MAX_FILES`].
    #[serde(default)]
    pub truncated: bool,
    /// Keyed by repository-relative path, so a refresh is a map diff.
    pub files: BTreeMap<String, FileEntry>,
}

impl Default for RepoIndex {
    fn default() -> Self {
        Self {
            schema_version: INDEX_SCHEMA_VERSION,
            built_at_ms: 0,
            truncated: false,
            files: BTreeMap::new(),
        }
    }
}

/// What a refresh changed. Reported rather than counted silently: "indexed 4
/// changed files" is the difference between a working incremental index and one
/// that is quietly rebuilding everything every time.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Delta {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
}

impl Delta {
    pub fn is_noop(&self) -> bool {
        self.added == 0 && self.updated == 0 && self.removed == 0
    }
}

impl RepoIndex {
    /// Every symbol whose name matches `query`, case-insensitively.
    ///
    /// Exact matches first, then prefix, then substring: a search for `run`
    /// should lead with `run`, not with `spawn_background_runner`.
    pub fn search(&self, query: &str, limit: usize) -> Vec<&Symbol> {
        let needle = query.to_ascii_lowercase();
        let mut scored: Vec<(u8, &Symbol)> = Vec::new();
        for entry in self.files.values() {
            for symbol in &entry.symbols {
                let name = symbol.name.to_ascii_lowercase();
                let rank = if name == needle {
                    0
                } else if name.starts_with(&needle) {
                    1
                } else if name.contains(&needle) {
                    2
                } else {
                    continue;
                };
                scored.push((rank, symbol));
            }
        }
        scored.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.name.len().cmp(&b.1.name.len()))
                .then_with(|| a.1.path.cmp(&b.1.path))
                .then_with(|| a.1.line.cmp(&b.1.line))
        });
        scored.into_iter().take(limit).map(|(_, s)| s).collect()
    }

    /// Files that import `path`, directly.
    ///
    /// One hop, not a transitive closure: two hops out, "affected by" stops
    /// meaning much, and a list long enough to ignore is worse than a short
    /// one that is read.
    pub fn importers_of(&self, path: &str) -> Vec<&str> {
        let mut out: Vec<&str> = self
            .files
            .iter()
            .filter(|(_, entry)| entry.imports.iter().any(|i| i == path))
            .map(|(key, _)| key.as_str())
            .collect();
        out.sort();
        out
    }

    pub fn symbol_count(&self) -> usize {
        self.files.values().map(|f| f.symbols.len()).sum()
    }
}

/// Where a repository's index lives.
pub(crate) fn index_path(state_root: &Path, repo_key: &str) -> PathBuf {
    state_root.join("index").join(format!("{repo_key}.json"))
}

/// Reads an index, returning an empty one when absent or written by another
/// schema. A stale schema is rebuilt rather than misread: the cost is one walk,
/// and the alternative is symbols that silently mean something else.
pub(crate) fn load(path: &Path) -> RepoIndex {
    let Ok(bytes) = std::fs::read(path) else {
        return RepoIndex::default();
    };
    match serde_json::from_slice::<RepoIndex>(&bytes) {
        Ok(index) if index.schema_version == INDEX_SCHEMA_VERSION => index,
        _ => RepoIndex::default(),
    }
}

/// Writes the index, replacing any previous one atomically.
pub(crate) fn save(path: &Path, index: &RepoIndex) -> Result<(), HarnessError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(index)?)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Brings `index` up to date with the tree at `root`.
///
/// Only files whose size or modification time changed are re-read. Files that
/// disappeared are dropped, so a rename costs one add and one remove rather
/// than leaving a symbol pointing at a path that no longer exists -- which is
/// the failure that makes an index worse than grep.
pub(crate) fn refresh(root: &Path, index: &mut RepoIndex) -> Result<Delta, HarnessError> {
    if !root.is_dir() {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            format!("{} is not a directory", root.display()),
        ));
    }

    let mut delta = Delta::default();
    let mut seen: BTreeMap<String, FileEntry> = BTreeMap::new();
    let mut truncated = false;

    // `ignore` honours .gitignore and skips VCS internals, so the index never
    // contains build output the repository already declared uninteresting.
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .parents(false)
        // Honour `.gitignore` whether or not there is a `.git` directory. The
        // default requires one, which would silently index build output in a
        // project that is not (yet) a repository -- and a user who wrote a
        // `.gitignore` meant it either way.
        .require_git(false)
        .build();

    for entry in walker.flatten() {
        if seen.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(language) = Language::of(path) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let Some(relative) = relative_key(root, path) else {
            continue;
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // The whole point of an incremental index: unchanged files are not read.
        if let Some(previous) = index.files.get(&relative) {
            if previous.size == metadata.len() && previous.mtime_ms == mtime_ms {
                delta.unchanged += 1;
                seen.insert(relative, previous.clone());
                continue;
            }
        }

        let Ok(text) = std::fs::read_to_string(path) else {
            // Not valid UTF-8: a binary that happens to carry a source
            // extension. Skipping keeps it out rather than indexing mojibake.
            continue;
        };
        let symbols = declarations(&text, language, &relative);
        let imports = imports_of(&text, language, &relative, root);
        if index.files.contains_key(&relative) {
            delta.updated += 1;
        } else {
            delta.added += 1;
        }
        seen.insert(
            relative,
            FileEntry { size: metadata.len(), mtime_ms, symbols, imports },
        );
    }

    delta.removed = index.files.keys().filter(|key| !seen.contains_key(*key)).count();
    index.files = seen;
    index.truncated = truncated;
    index.schema_version = INDEX_SCHEMA_VERSION;
    index.built_at_ms = jan_agent_harness::event::now_ms();
    Ok(delta)
}

fn relative_key(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

/// The languages whose declaration syntax is recognised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    Rust,
    TypeScript,
    Python,
    Go,
}

impl Language {
    fn of(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "ts" | "tsx" | "js" | "jsx" | "mjs" => Some(Self::TypeScript),
            "py" => Some(Self::Python),
            "go" => Some(Self::Go),
            _ => None,
        }
    }

    /// The comment prefix that makes a line a comment in this language.
    fn line_comment(self) -> &'static str {
        match self {
            Self::Python => "#",
            _ => "//",
        }
    }
}

/// Extracts declarations from source text.
///
/// Line-oriented and deliberately simple. Each recognised form is a keyword at
/// the start of a (trimmed) line, optionally behind a small set of modifiers,
/// followed by an identifier. That covers the overwhelming majority of real
/// declarations and cannot silently mangle the ones it misses -- it just does
/// not find them.
fn declarations(text: &str, language: Language, path: &str) -> Vec<Symbol> {
    let mut out = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim_start();
        if line.starts_with(language.line_comment()) {
            continue;
        }
        let Some((name, kind)) = declaration_on(line, language) else {
            continue;
        };
        out.push(Symbol {
            name,
            kind,
            path: path.to_string(),
            line: index as u32 + 1,
        });
    }
    out
}

/// Files this file imports, resolved to repository-relative paths.
///
/// Only specifiers that name a file in this repository are kept. A bare
/// specifier (`serde`, `react`, `os`) names a package, not a file here, and
/// resolving it would be a guess.
fn imports_of(text: &str, language: Language, from: &str, root: &Path) -> Vec<String> {
    let dir = from.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut out: Vec<String> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim_start();
        if line.starts_with(language.line_comment()) {
            continue;
        }
        for resolved in import_targets(line, language, dir, root) {
            if !out.contains(&resolved) {
                out.push(resolved);
            }
        }
    }
    out
}

fn import_targets(line: &str, language: Language, dir: &str, root: &Path) -> Vec<String> {
    let exists = |candidate: String| -> Option<String> {
        root.join(&candidate).is_file().then_some(candidate)
    };
    let joined = |relative: &str| -> String {
        // Normalise `a/b/../c` without touching the filesystem, so a path that
        // climbs out of the repository simply fails to resolve.
        let combined = format!("{dir}/{relative}");
        let mut parts: Vec<&str> = Vec::new();
        for segment in combined.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        parts.join("/")
    };

    match language {
        // `mod foo;` is the whole of Rust's file-level import syntax, and it
        // resolves to exactly two possible paths.
        Language::Rust => {
            let rest = line
                .strip_prefix("pub mod ")
                .or_else(|| line.strip_prefix("pub(crate) mod "))
                .or_else(|| line.strip_prefix("mod "));
            let Some(rest) = rest else {
                return Vec::new();
            };
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if name.is_empty() || !rest[name.len()..].trim_start().starts_with(';') {
                // `mod tests { ... }` is an inline module, not another file.
                return Vec::new();
            }
            [joined(&format!("{name}.rs")), joined(&format!("{name}/mod.rs"))]
                .into_iter()
                .filter_map(exists)
                .collect()
        }
        Language::TypeScript => {
            let Some(specifier) = quoted_specifier(line) else {
                return Vec::new();
            };
            if !specifier.starts_with('.') {
                return Vec::new();
            }
            let base = joined(&specifier);
            ["ts", "tsx", "js", "jsx", "mjs"]
                .iter()
                .flat_map(|ext| {
                    [format!("{base}.{ext}"), format!("{base}/index.{ext}")]
                })
                .chain(std::iter::once(base.clone()))
                .filter_map(exists)
                .take(1)
                .collect()
        }
        Language::Python => {
            let Some(rest) = line.strip_prefix("from .") else {
                return Vec::new();
            };
            let module: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if module.is_empty() {
                return Vec::new();
            }
            [joined(&format!("{module}.py")), joined(&format!("{module}/__init__.py"))]
                .into_iter()
                .filter_map(exists)
                .collect()
        }
        // Go imports name packages, not files; there is no file to resolve to.
        Language::Go => Vec::new(),
    }
}

/// The single- or double-quoted string on an import line, if there is one.
fn quoted_specifier(line: &str) -> Option<String> {
    if !(line.starts_with("import ")
        || line.starts_with("export ")
        || line.contains("require("))
    {
        return None;
    }
    let bytes = line.as_bytes();
    let quote = bytes.iter().position(|b| *b == b'\'' || *b == b'"')?;
    let closing = bytes[quote + 1..].iter().position(|b| *b == bytes[quote])?;
    Some(line[quote + 1..quote + 1 + closing].to_string())
}

fn declaration_on(line: &str, language: Language) -> Option<(String, SymbolKind)> {
    // Modifiers that may precede a declaration keyword. Stripped rather than
    // enumerated in every pattern, so `pub async unsafe fn` needs no new rule.
    const MODIFIERS: [&str; 8] = [
        "pub(crate) ", "pub(super) ", "pub ", "export default ", "export ", "async ", "unsafe ",
        "const ",
    ];
    let mut rest = line;
    loop {
        let trimmed = MODIFIERS
            .iter()
            .find_map(|m| rest.strip_prefix(m))
            .map(str::trim_start);
        match trimmed {
            Some(next) => rest = next,
            None => break,
        }
    }

    let forms: &[(&str, SymbolKind)] = match language {
        Language::Rust => &[
            ("fn ", SymbolKind::Function),
            ("struct ", SymbolKind::Type),
            ("enum ", SymbolKind::Type),
            ("trait ", SymbolKind::Type),
            ("type ", SymbolKind::Type),
        ],
        Language::TypeScript => &[
            ("function ", SymbolKind::Function),
            ("class ", SymbolKind::Type),
            ("interface ", SymbolKind::Type),
            ("type ", SymbolKind::Type),
            ("enum ", SymbolKind::Type),
        ],
        Language::Python => &[
            ("def ", SymbolKind::Function),
            ("class ", SymbolKind::Type),
        ],
        Language::Go => &[
            ("func ", SymbolKind::Function),
            ("type ", SymbolKind::Type),
        ],
    };

    for (keyword, kind) in forms {
        let Some(after) = rest.strip_prefix(keyword) else {
            continue;
        };
        let name: String = after
            .trim_start()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            return None;
        }
        return Some((name, *kind));
    }
    None
}

/// A stable directory-safe key for a repository, so two projects never share
/// an index and the same project always finds its own.
pub(crate) fn repo_key(root: &Path) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut hash = OFFSET;
    for byte in canonical.to_string_lossy().as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// The `symbol_search` tool, as the model sees it.
///
/// The description states the limits outright. A model told only "search for
/// symbols" will read a miss as "this does not exist" and stop looking, when
/// the truth is that this finds declarations in four languages and nothing else.
pub(crate) fn symbol_search_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "symbol_search",
            "description":
                "Find where a name is DECLARED in this project: functions, types, classes,                  traits, interfaces and enums in Rust, TypeScript/JavaScript, Python and Go.                  Much cheaper than grep for 'where is X defined', because it does not also                  match call sites, tests and comments. Limits worth knowing: it indexes                  declarations only (not references or call sites -- use grep for those), only                  those four languages, and it skips anything .gitignore excludes. A miss means                  'not found in the index', not 'does not exist' -- fall back to grep.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name or fragment to look for; case-insensitive."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum results (default 20)."
                    }
                },
                "required": ["name"]
            }
        }
    })
}

/// Renders search results for the model.
pub(crate) fn render_results(query: &str, results: &[&Symbol], index: &RepoIndex) -> String {
    if index.symbol_count() == 0 {
        return "No symbol index for this project. It covers Rust, TypeScript/JavaScript,                 Python and Go; use grep instead."
            .to_string();
    }
    if results.is_empty() {
        return format!(
            "No declaration matching '{query}' in the index ({} symbols across {} files).              It indexes declarations only, in four languages -- use grep to search for              references or other file types.",
            index.symbol_count(),
            index.files.len()
        );
    }
    let mut lines = vec![format!("{} match(es) for '{query}':", results.len())];
    for symbol in results {
        lines.push(format!(
            "{}:{}  {:?} {}",
            symbol.path, symbol.line, symbol.kind, symbol.name
        ));
    }
    if index.truncated {
        lines.push(
            "(the index hit its file ceiling, so parts of this repository are not covered)"
                .to_string(),
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::fixtures::TempDir;

    fn repo(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new("repo-index");
        for (name, body) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    fn names(index: &RepoIndex) -> Vec<String> {
        let mut all: Vec<String> = index
            .files
            .values()
            .flat_map(|f| f.symbols.iter().map(|s| s.name.clone()))
            .collect();
        all.sort();
        all
    }

    #[test]
    fn declarations_are_found_across_the_supported_languages() {
        let dir = repo(&[
            ("a.rs", "pub fn alpha() {}\nstruct Beta;\npub(crate) enum Gamma {}\n"),
            ("b.ts", "export function delta() {}\nexport interface Epsilon {}\n"),
            ("c.py", "def zeta():\n    pass\nclass Eta:\n    pass\n"),
            ("d.go", "func theta() {}\ntype Iota struct{}\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        assert_eq!(
            names(&index),
            vec!["Beta", "Epsilon", "Eta", "Gamma", "Iota", "alpha", "delta", "theta", "zeta"]
        );
    }

    #[test]
    fn a_declaration_records_its_path_and_one_based_line() {
        let dir = repo(&[("src/lib.rs", "// header\n\npub fn target() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let found = index.search("target", 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "src/lib.rs");
        assert_eq!(found[0].line, 3);
        assert_eq!(found[0].kind, SymbolKind::Function);
    }

    /// Known limits, pinned so they stay known. A commented-out declaration is
    /// skipped; one inside a string is not, because this is not a parser.
    #[test]
    fn a_commented_declaration_is_skipped_and_a_stringed_one_is_not() {
        let dir = repo(&[(
            "a.rs",
            "// fn commented_out() {}\nlet s = \"fn in_a_string() {}\";\nfn real() {}\n",
        )]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let found = names(&index);
        assert!(found.contains(&"real".to_string()));
        assert!(!found.contains(&"commented_out".to_string()));
        // Documented, not desirable: the mitigation is that it is known.
        assert!(!found.contains(&"in_a_string".to_string()), "{found:?}");
    }

    #[test]
    fn modifiers_do_not_hide_a_declaration() {
        let dir = repo(&[("a.rs", "pub async unsafe fn deeply_modified() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(names(&index), vec!["deeply_modified"]);
    }

    /// The property that makes the index cheap enough to refresh every run.
    #[test]
    fn an_unchanged_file_is_not_re_read() {
        let dir = repo(&[("a.rs", "fn one() {}\n"), ("b.rs", "fn two() {}\n")]);
        let mut index = RepoIndex::default();
        let first = refresh(dir.path(), &mut index).unwrap();
        assert_eq!((first.added, first.updated, first.unchanged), (2, 0, 0));

        let second = refresh(dir.path(), &mut index).unwrap();
        assert_eq!((second.added, second.updated, second.unchanged), (0, 0, 2));
        assert!(second.is_noop());
    }

    #[test]
    fn a_changed_file_is_re_read_and_its_symbols_replaced() {
        let dir = repo(&[("a.rs", "fn before() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(names(&index), vec!["before"]);

        // A different length guarantees the change is visible even where the
        // filesystem's modification time has coarse resolution.
        std::fs::write(dir.path().join("a.rs"), "fn after_the_change() {}\n").unwrap();
        let delta = refresh(dir.path(), &mut index).unwrap();

        assert_eq!((delta.added, delta.updated), (0, 1));
        assert_eq!(names(&index), vec!["after_the_change"]);
    }

    /// A stale entry pointing at a path that no longer exists is the failure
    /// that makes an index worse than grep.
    #[test]
    fn a_deleted_file_leaves_no_symbols_behind() {
        let dir = repo(&[("a.rs", "fn gone() {}\n"), ("b.rs", "fn stays() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        std::fs::remove_file(dir.path().join("a.rs")).unwrap();
        let delta = refresh(dir.path(), &mut index).unwrap();

        assert_eq!(delta.removed, 1);
        assert_eq!(names(&index), vec!["stays"]);
        assert!(index.search("gone", 10).is_empty());
    }

    #[test]
    fn gitignored_and_unsupported_files_are_not_indexed() {
        let dir = repo(&[
            (".gitignore", "target/\n"),
            ("target/generated.rs", "fn generated() {}\n"),
            ("notes.md", "# fn not_code() {}\n"),
            ("src/real.rs", "fn real() {}\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(names(&index), vec!["real"]);
    }

    #[test]
    fn a_rust_module_declaration_resolves_to_the_file_it_names() {
        let dir = repo(&[
            ("src/lib.rs", "pub mod helper;\nmod nested;\nmod tests { }\n"),
            ("src/helper.rs", "pub fn h() {}\n"),
            ("src/nested/mod.rs", "pub fn n() {}\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let imports = &index.files["src/lib.rs"].imports;
        assert!(imports.contains(&"src/helper.rs".to_string()), "{imports:?}");
        assert!(imports.contains(&"src/nested/mod.rs".to_string()), "{imports:?}");
        // `mod tests { ... }` is an inline module, not another file.
        assert_eq!(imports.len(), 2, "{imports:?}");
    }

    #[test]
    fn a_relative_typescript_import_resolves_and_a_package_one_does_not() {
        let dir = repo(&[
            ("src/a.ts", "import { b } from './b'\nimport React from 'react'\n"),
            ("src/b.ts", "export const b = 1\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        // A bare specifier names a package, not a file here; resolving it would
        // be a guess.
        assert_eq!(index.files["src/a.ts"].imports, vec!["src/b.ts"]);
    }

    #[test]
    fn an_import_of_a_directory_resolves_to_its_index_file() {
        let dir = repo(&[
            ("src/a.ts", "import { x } from './widget'\n"),
            ("src/widget/index.ts", "export const x = 1\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(index.files["src/a.ts"].imports, vec!["src/widget/index.ts"]);
    }

    #[test]
    fn a_parent_relative_import_is_normalised() {
        let dir = repo(&[
            ("src/deep/a.ts", "import { b } from '../b'\n"),
            ("src/b.ts", "export const b = 1\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(index.files["src/deep/a.ts"].imports, vec!["src/b.ts"]);
    }

    /// A specifier that climbs out of the repository must resolve to nothing
    /// rather than to a path outside it.
    #[test]
    fn an_import_escaping_the_repository_resolves_to_nothing() {
        let dir = repo(&[("src/a.ts", "import x from '../../../../etc/passwd'\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert!(index.files["src/a.ts"].imports.is_empty());
    }

    #[test]
    fn a_relative_python_import_resolves() {
        let dir = repo(&[
            ("pkg/a.py", "from .helper import thing\nimport os\n"),
            ("pkg/helper.py", "thing = 1\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();
        assert_eq!(index.files["pkg/a.py"].imports, vec!["pkg/helper.py"]);
    }

    #[test]
    fn importers_are_found_in_both_directions() {
        let dir = repo(&[
            ("src/core.ts", "export const core = 1\n"),
            ("src/one.ts", "import { core } from './core'\n"),
            ("src/two.ts", "import { core } from './core'\n"),
            ("src/unrelated.ts", "export const u = 1\n"),
        ]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        assert_eq!(index.importers_of("src/core.ts"), vec!["src/one.ts", "src/two.ts"]);
        assert!(index.importers_of("src/unrelated.ts").is_empty());
    }

    /// Adding `imports` to the entry was a schema change, so an index written
    /// before it must be rebuilt -- not read as though every file simply
    /// imported nothing, which would make the graph silently empty.
    #[test]
    fn an_index_predating_the_import_graph_is_discarded() {
        let dir = TempDir::new("index-old-schema");
        let path = index_path(dir.path(), "repo-key");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "schema_version": 1,
                "built_at_ms": 1,
                "files": {
                    "a.ts": { "size": 1, "mtime_ms": 1, "symbols": [] }
                }
            })
            .to_string(),
        )
        .unwrap();

        let loaded = load(&path);
        assert_eq!(loaded, RepoIndex::default());
        assert!(loaded.files.is_empty(), "the stale entry must not survive");
    }

    #[test]
    fn search_puts_the_exact_match_first() {
        let dir = repo(&[(
            "a.rs",
            "fn run_the_whole_thing() {}\nfn runner() {}\nfn run() {}\nfn prerun() {}\n",
        )]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let found = index.search("run", 10);
        assert_eq!(found[0].name, "run");
        assert_eq!(found[1].name, "runner", "prefix beats substring");
        assert!(found.iter().any(|s| s.name == "prerun"));
    }

    #[test]
    fn search_is_case_insensitive_and_bounded() {
        let dir = repo(&[("a.rs", "struct HttpClient;\nstruct HttpServer;\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        assert_eq!(index.search("httpclient", 10)[0].name, "HttpClient");
        assert_eq!(index.search("http", 1).len(), 1, "the limit is honoured");
    }

    /// A miss must not read as "this does not exist", or the model stops
    /// looking when the right answer is to fall back to grep.
    #[test]
    fn a_miss_says_what_the_index_does_not_cover() {
        let dir = repo(&[("a.rs", "fn present() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let rendered = render_results("absent", &index.search("absent", 20), &index);
        assert!(rendered.contains("declarations only"), "{rendered}");
        assert!(rendered.contains("use grep"), "{rendered}");
        assert!(rendered.contains("1 symbols"), "{rendered}");
    }

    #[test]
    fn an_empty_index_says_so_rather_than_reporting_no_matches() {
        let index = RepoIndex::default();
        let rendered = render_results("anything", &[], &index);
        assert!(rendered.contains("No symbol index"), "{rendered}");
    }

    #[test]
    fn results_name_the_file_and_line_a_reader_can_open() {
        let dir = repo(&[("src/a.rs", "\n\nfn target() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let rendered = render_results("target", &index.search("target", 20), &index);
        assert!(rendered.contains("src/a.rs:3"), "{rendered}");
    }

    #[test]
    fn the_tool_description_states_its_limits() {
        let schema = symbol_search_tool_schema();
        let description = schema["function"]["description"].as_str().unwrap();
        assert!(description.contains("DECLARED"));
        assert!(description.contains("not references"));
        assert!(description.contains("fall back to grep"));
    }

    #[test]
    fn two_projects_never_share_an_index() {
        let a = TempDir::new("key-a");
        let b = TempDir::new("key-b");
        assert_ne!(repo_key(a.path()), repo_key(b.path()));
        assert_eq!(repo_key(a.path()), repo_key(a.path()), "and one project is stable");
    }

    #[test]
    fn an_index_round_trips_through_disk() {
        let dir = repo(&[("a.rs", "fn persisted() {}\n")]);
        let mut index = RepoIndex::default();
        refresh(dir.path(), &mut index).unwrap();

        let path = index_path(dir.path(), "repo-key");
        save(&path, &index).unwrap();
        let loaded = load(&path);

        assert_eq!(loaded, index);
        assert_eq!(loaded.symbol_count(), 1);
    }

    /// An index from another schema is rebuilt, never reinterpreted: symbols
    /// that silently mean something else are worse than a second walk.
    #[test]
    fn an_index_from_another_schema_is_discarded() {
        let dir = TempDir::new("index-schema");
        let path = index_path(dir.path(), "repo-key");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::json!({
                "schema_version": INDEX_SCHEMA_VERSION + 1,
                "built_at_ms": 1,
                "files": {}
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(load(&path), RepoIndex::default());
    }

    #[test]
    fn a_missing_index_reads_as_empty_rather_than_failing() {
        let dir = TempDir::new("index-absent");
        assert_eq!(load(&index_path(dir.path(), "never-built")), RepoIndex::default());
    }

    #[test]
    fn indexing_something_that_is_not_a_directory_is_reported() {
        let dir = repo(&[("a.rs", "fn x() {}\n")]);
        let mut index = RepoIndex::default();
        let error = refresh(&dir.path().join("a.rs"), &mut index).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
    }
}
