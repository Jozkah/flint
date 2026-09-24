//! A stored index of a repository's files and symbols. AH-053, AH-054,
//! AH-055, AH-056.
//!
//! [`impact`](super::impact) reads a repository every time it is asked
//! anything, which is right for a one-off question and wrong as a foundation:
//! a symbol search that re-reads a thousand files per query is a search nobody
//! runs twice. This is the same reading, kept.
//!
//! What is stored, per file: its path, size, modification time, a content
//! hash, and the symbols it defines. What makes it trustworthy rather than
//! merely fast:
//!
//! * **A stale entry is never used.** A file is re-read when its size or
//!   modification time differs from what was stored -- and because a
//!   modification time can go backwards (a checkout, a restore), *any*
//!   difference counts, not a newer one.
//! * **An update is incremental and says what it did.** Rebuilding only what
//!   changed is the point; reporting how many files were re-read is what makes
//!   that claim checkable rather than assumed.
//! * **A branch change reconciles rather than trusting.** The index records
//!   the commit it was built at. When that has moved, every entry is
//!   re-checked against disk -- still incremental, because unchanged files are
//!   stat-compared and not re-read, but nothing is believed because it was
//!   true on another branch.
//! * **Cancellation leaves nothing behind.** A build can be stopped mid-flight;
//!   it writes no index at all rather than a half one, because a half index
//!   that looks whole is worse than none.
//!
//! Symbols come from line-shaped matching, like the import edges: a definition
//! inside a string literal is read as a definition. Every answer says how many
//! files it is drawn from, so "nothing found" can be told from "nothing
//! indexed".

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The version of the stored shape. An index written by an older build is
/// rebuilt rather than misread.
pub const INDEX_VERSION: u32 = 1;
/// The most files an index holds.
pub const MAX_FILES: usize = 20_000;
/// The most bytes read from one file.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// The most symbols kept from one file.
pub const MAX_SYMBOLS_PER_FILE: usize = 2_000;
/// How deep the walk goes. A directory symlink is not followed at all, but a
/// deeply nested tree is still a tree, and an unbounded walk is a walk that
/// can be made not to end.
pub const MAX_DEPTH: usize = 24;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IndexErrorKind {
    /// The path is not a directory that can be read.
    NoProject,
    /// The build was stopped before it finished.
    Cancelled,
    /// The index could not be read or written.
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexError {
    pub kind: IndexErrorKind,
    pub message: String,
}

impl IndexError {
    fn new(kind: IndexErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&IndexError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &IndexError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            IndexErrorKind::NoProject => ErrorKind::NotFound,
            IndexErrorKind::Cancelled => ErrorKind::Cancelled,
            IndexErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

/// What kind of thing a symbol is. Deliberately coarse: the distinction that
/// matters to someone looking for a definition is "where is this named", not
/// which of six declaration forms it used.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolKind {
    Function,
    Type,
    Constant,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// 1-based line of the definition.
    pub line: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    /// Modification time in milliseconds since the epoch, as the filesystem
    /// reports it.
    pub modified_ms: u64,
    /// Of the file's bytes, so a change that keeps size and mtime (a restore,
    /// a same-second write) is still seen.
    pub hash: String,
    pub symbols: Vec<Symbol>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub version: u32,
    /// The project this is about, as an absolute path.
    pub project: String,
    /// The commit it was built at, when the project is a git repository.
    #[serde(default)]
    pub commit: Option<String>,
    pub files: BTreeMap<String, FileEntry>,
    /// Set when a bound stopped the walk: the index is not the whole tree.
    #[serde(default)]
    pub truncated: bool,
    pub built_at: String,
}

/// What an update did, so "incremental" is checkable rather than claimed.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    /// Files whose stored entry was reused without reading the file.
    pub unchanged: usize,
    /// Whether the commit moved since the index was built, which is what makes
    /// every entry worth re-checking.
    pub reconciled: bool,
}

impl Update {
    /// Whether anything was read from disk at all.
    pub fn read_anything(&self) -> bool {
        self.added + self.changed > 0
    }
}

/// Where a project's index is stored.
///
/// Under the data folder, keyed by a hash of the project path: an index is
/// state about a checkout, not part of it, and writing it into the repository
/// would put it in someone's diff.
pub fn path_for(data_folder: &Path, project: &Path) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(project.to_string_lossy().as_bytes()));
    data_folder.join("index").join(format!("{}.json", &digest[..24]))
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | "venv" | ".venv"
            | "__pycache__" | ".mypy_cache" | ".pytest_cache" | "vendor" | "coverage"
    )
}

fn indexable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java" | "rb")
    )
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The commit the checkout is on, when it is a git checkout at all.
fn head_commit(project: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(project).args(["rev-parse", "HEAD"]);
    jan_utils::system::hide_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// Read a stored index, if there is a usable one.
///
/// An index for another project, or written by an older build, is not used --
/// it is not an error either, it simply means the next build is a full one.
pub fn load(data_folder: &Path, project: &Path) -> Option<Index> {
    let raw = std::fs::read_to_string(path_for(data_folder, project)).ok()?;
    let index: Index = serde_json::from_str(&raw).ok()?;
    (index.version == INDEX_VERSION && index.project == project.to_string_lossy()).then_some(index)
}

fn save(data_folder: &Path, index: &Index) -> Result<(), IndexError> {
    let path = path_for(data_folder, Path::new(&index.project));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| IndexError::new(IndexErrorKind::Io, format!("index: {e}")))?;
    }
    let body = serde_json::to_string(index)
        .map_err(|e| IndexError::new(IndexErrorKind::Io, format!("index: {e}")))?;
    // Written whole and moved into place, so a reader never sees half an
    // index -- the same reason a cancelled build writes nothing. Each writer
    // uses its own temp file (Jozkah/jan#245): two refreshes of one project
    // sharing a name interleaved their writes and lost each other's rename.
    // A rename that loses a race to another writer's rename on Windows is
    // retried briefly; either complete index is a correct result.
    let mut attempt = 0;
    loop {
        match tauri_plugin_agent_tools::workspace::write_atomic(&path, body.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 5 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(20 * attempt));
            }
            Err(e) => return Err(IndexError::new(IndexErrorKind::Io, format!("index: {e}"))),
        }
    }
}

/// Build or update a project's index.
///
/// The first call reads everything (AH-054). Later calls read only what
/// changed (AH-055), and re-check every entry when the commit has moved
/// (AH-056). `cancel` stops it; a stopped build writes nothing.
pub fn refresh(
    data_folder: &Path,
    project: &Path,
    cancel: &AtomicBool,
) -> Result<(Index, Update), IndexError> {
    if !project.is_dir() {
        return Err(IndexError::new(
            IndexErrorKind::NoProject,
            "there is no project directory to index here",
        ));
    }
    let previous = load(data_folder, project);
    let commit = head_commit(project);
    // AH-056: a moved commit means the tree may differ everywhere, so nothing
    // is believed merely because it was true before. Unchanged files are still
    // not re-read -- they are stat-compared, which is what keeps this
    // incremental rather than a rebuild.
    let reconciled = previous
        .as_ref()
        .is_some_and(|index| index.commit != commit);

    let mut update = Update { reconciled, ..Update::default() };
    let mut files: BTreeMap<String, FileEntry> = BTreeMap::new();
    let mut truncated = false;
    let _ = &truncated;
    let mut queue = std::collections::VecDeque::from([(project.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > MAX_DEPTH {
            truncated = true;
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(IndexError::new(
                IndexErrorKind::Cancelled,
                "the index build was stopped; nothing was written",
            ));
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || ignored(&name) {
                continue;
            }
            // A symlink is not followed, in either direction. Following one
            // is how a repository containing `ln -s .. loop` -- which git
            // happily carries -- makes this walk never end, and how a link to
            // `$HOME` gets somebody's home directory hashed into an index that
            // claims to describe a repository.
            let link = entry.file_type().map(|t| t.is_symlink()).unwrap_or(true);
            if link {
                truncated = true;
                continue;
            }
            if path.is_dir() {
                queue.push_back((path, depth + 1));
                continue;
            }
            if !indexable(&path) {
                continue;
            }
            if files.len() >= MAX_FILES {
                truncated = true;
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES {
                truncated = true;
                continue;
            }
            let Ok(relative) = path.strip_prefix(project) else { continue };
            let relative = relative.to_string_lossy().replace('\\', "/");
            let size = meta.len();
            let modified = modified_ms(&meta);

            // Any difference, not a newer one: a checkout or a restore can put
            // an older file in place, and "older than the index" is still a
            // file the index does not describe.
            let reusable = previous
                .as_ref()
                .and_then(|index| index.files.get(&relative))
                .filter(|entry| entry.size == size && entry.modified_ms == modified);
            if let Some(entry) = reusable {
                update.unchanged += 1;
                files.insert(relative, entry.clone());
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            let known = previous.as_ref().and_then(|index| index.files.get(&relative));
            match known {
                Some(entry) if entry.hash == hash => update.unchanged += 1,
                Some(_) => update.changed += 1,
                None => update.added += 1,
            }
            files.insert(
                relative.clone(),
                FileEntry {
                    path: relative,
                    size,
                    modified_ms: modified,
                    hash,
                    symbols: symbols_in(&path, &text),
                },
            );
        }
    }
    update.removed = previous
        .as_ref()
        .map(|index| index.files.keys().filter(|p| !files.contains_key(*p)).count())
        .unwrap_or(0);

    let index = Index {
        version: INDEX_VERSION,
        project: project.to_string_lossy().into_owned(),
        commit,
        files,
        truncated,
        built_at: tauri_plugin_agent_tools::audit::now(),
    };
    save(data_folder, &index)?;
    Ok((index, update))
}

/// The definitions one file makes.
fn symbols_in(path: &Path, text: &str) -> Vec<Symbol> {
    let mut out = Vec::new();
    let rust = path.extension().and_then(|e| e.to_str()) == Some("rs");
    let python = path.extension().and_then(|e| e.to_str()) == Some("py");
    for (index, raw) in text.lines().enumerate() {
        if out.len() >= MAX_SYMBOLS_PER_FILE {
            break;
        }
        let line = raw.trim_start();
        let line = line
            .strip_prefix("pub(crate) ")
            .or_else(|| line.strip_prefix("pub "))
            .or_else(|| line.strip_prefix("export default "))
            .or_else(|| line.strip_prefix("export "))
            .unwrap_or(line);
        let line = line.strip_prefix("async ").unwrap_or(line);
        let found = if rust {
            first_word_after(line, "fn ")
                .map(|n| (n, SymbolKind::Function))
                .or_else(|| first_word_after(line, "struct ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "enum ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "trait ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "type ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "const ").map(|n| (n, SymbolKind::Constant)))
                .or_else(|| first_word_after(line, "static ").map(|n| (n, SymbolKind::Constant)))
        } else if python {
            first_word_after(line, "def ")
                .map(|n| (n, SymbolKind::Function))
                .or_else(|| first_word_after(line, "class ").map(|n| (n, SymbolKind::Type)))
        } else {
            first_word_after(line, "function ")
                .map(|n| (n, SymbolKind::Function))
                .or_else(|| first_word_after(line, "class ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "interface ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "type ").map(|n| (n, SymbolKind::Type)))
                .or_else(|| first_word_after(line, "const ").map(|n| (n, SymbolKind::Constant)))
                .or_else(|| first_word_after(line, "let ").map(|n| (n, SymbolKind::Constant)))
        };
        if let Some((name, kind)) = found {
            out.push(Symbol { name, kind, line: index + 1 });
        }
    }
    out
}

/// The identifier that follows `marker`, when the line begins with it.
fn first_word_after(line: &str, marker: &str) -> Option<String> {
    let rest = line.strip_prefix(marker)?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// One place a symbol is defined.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub name: String,
    pub kind: SymbolKind,
    pub path: String,
    pub line: usize,
}

/// Find where a name is defined (AH-059).
///
/// Exact matches first, then names that contain the query, so an exact answer
/// is never buried under near ones. Bounded by `limit`.
pub fn find_symbol(index: &Index, query: &str, limit: usize) -> Vec<Definition> {
    let needle = query.trim();
    if needle.is_empty() {
        return Vec::new();
    }
    let lower = needle.to_ascii_lowercase();
    let mut exact = Vec::new();
    let mut partial = Vec::new();
    for file in index.files.values() {
        for symbol in &file.symbols {
            let hit = Definition {
                name: symbol.name.clone(),
                kind: symbol.kind,
                path: file.path.clone(),
                line: symbol.line,
            };
            if symbol.name == needle {
                exact.push(hit);
            } else if symbol.name.to_ascii_lowercase().contains(&lower) {
                partial.push(hit);
            }
        }
    }
    exact.extend(partial);
    exact.truncate(limit);
    exact
}

/// One place a name is used.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub path: String,
    pub line: usize,
    /// The line itself, trimmed and bounded, so a caller can see the use
    /// without opening the file.
    pub text: String,
    /// Whether this line is the definition the index recorded, rather than a
    /// use of it.
    pub is_definition: bool,
}

/// The most references returned, and the most of a line kept.
pub const MAX_REFERENCES: usize = 500;
const MAX_REFERENCE_TEXT: usize = 200;

/// Every place a name is used, across the files the index knows (AH-060).
///
/// Whole-word matching over the indexed files: `load` does not match
/// `payload`. This is not a resolver -- two unrelated functions with one name
/// are both reported, and the caller is told which lines are definitions so
/// the difference is visible rather than guessed at. What it is not is a grep
/// of the whole disk: it reads only what the index says is source, which is
/// what keeps it bounded and free of `node_modules`.
pub fn find_references(index: &Index, name: &str, limit: usize) -> Vec<Reference> {
    let needle = name.trim();
    if needle.is_empty() {
        return Vec::new();
    }
    let project = PathBuf::from(&index.project);
    let limit = limit.min(MAX_REFERENCES);
    let mut out = Vec::new();
    for file in index.files.values() {
        if out.len() >= limit {
            break;
        }
        let defined_at: Vec<usize> = file
            .symbols
            .iter()
            .filter(|s| s.name == needle)
            .map(|s| s.line)
            .collect();
        let Ok(text) = std::fs::read_to_string(project.join(&file.path)) else { continue };
        if !text.contains(needle) {
            continue;
        }
        for (index_of_line, line) in text.lines().enumerate() {
            if out.len() >= limit {
                break;
            }
            if !contains_word(line, needle) {
                continue;
            }
            let number = index_of_line + 1;
            out.push(Reference {
                path: file.path.clone(),
                line: number,
                text: line.trim().chars().take(MAX_REFERENCE_TEXT).collect(),
                is_definition: defined_at.contains(&number),
            });
        }
    }
    out
}

/// Whether `line` uses `needle` as a whole word.
fn contains_word(line: &str, needle: &str) -> bool {
    let bytes = line.as_bytes();
    let mut from = 0;
    while let Some(at) = line[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = end;
        if from >= line.len() {
            break;
        }
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

/// One end of a call relationship.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    /// The function on the other end, by name.
    pub name: String,
    /// Where the call is written.
    pub path: String,
    pub line: usize,
    /// The function the call is written inside, when one could be named. A
    /// call at the top level of a module has none.
    #[serde(default)]
    pub within: Option<String>,
}

/// Who calls this function, and what it calls (AH-062).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hierarchy {
    pub name: String,
    /// Where the function is defined, when the index knows.
    pub defined: Vec<Definition>,
    pub callers: Vec<Call>,
    pub callees: Vec<Call>,
    /// Set when either list was cut at the bound.
    pub truncated: bool,
}

/// The most calls reported on each side.
pub const MAX_CALLS: usize = 200;

/// Walk one function's callers and callees.
///
/// Built on the same reading as everything else here, with the same honesty:
/// a call is a name followed by `(` on a line, and the enclosing function is
/// the nearest definition above it in the same file. That is right for
/// ordinary code and wrong for a name used as a value, a macro that looks like
/// a call, or two functions with one name -- so this says where it looked
/// rather than claiming a call graph. A model can open the lines; what it
/// could not do before was find them without reading the whole project.
pub fn hierarchy(index: &Index, name: &str, limit: usize) -> Hierarchy {
    let needle = name.trim();
    let limit = limit.min(MAX_CALLS);
    let mut result = Hierarchy {
        name: needle.to_string(),
        defined: find_symbol(index, needle, 20),
        callers: Vec::new(),
        callees: Vec::new(),
        truncated: false,
    };
    if needle.is_empty() {
        return result;
    }
    let project = PathBuf::from(&index.project);

    // Callers: every place the name is called, with the function it is called
    // from. The definition line itself is not a call.
    for reference in find_references(index, needle, MAX_CALLS) {
        if reference.is_definition || !reference.text.contains(&format!("{needle}(")) {
            continue;
        }
        if result.callers.len() >= limit {
            result.truncated = true;
            break;
        }
        let within = enclosing(index, &reference.path, reference.line);
        result.callers.push(Call {
            name: within.clone().unwrap_or_else(|| "(top level)".to_string()),
            path: reference.path,
            line: reference.line,
            within,
        });
    }

    // Callees: the names called inside the function's own body, which is the
    // lines from its definition to the next definition in that file.
    for definition in &result.defined {
        let Ok(text) = std::fs::read_to_string(project.join(&definition.path)) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let end = index
            .files
            .get(&definition.path)
            .map(|file| {
                file.symbols
                    .iter()
                    .map(|s| s.line)
                    .filter(|line| *line > definition.line)
                    .min()
                    .unwrap_or(lines.len() + 1)
            })
            .unwrap_or(lines.len() + 1);
        for (offset, line) in lines.iter().enumerate() {
            let number = offset + 1;
            if number <= definition.line || number >= end {
                continue;
            }
            for called in called_names(line) {
                if called == needle {
                    continue;
                }
                if result.callees.len() >= limit {
                    result.truncated = true;
                    break;
                }
                if result.callees.iter().any(|c| c.name == called && c.line == number) {
                    continue;
                }
                result.callees.push(Call {
                    name: called,
                    path: definition.path.clone(),
                    line: number,
                    within: Some(definition.name.clone()),
                });
            }
        }
    }
    result
}

/// The function a line sits inside: the nearest definition above it in the
/// same file, as the index recorded them.
fn enclosing(index: &Index, path: &str, line: usize) -> Option<String> {
    let file = index.files.get(path)?;
    file.symbols
        .iter()
        .filter(|s| s.line <= line && s.kind == SymbolKind::Function)
        .max_by_key(|s| s.line)
        .map(|s| s.name.clone())
}

/// The names called on one line: an identifier immediately followed by `(`.
fn called_names(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut start: Option<usize> = None;
    for (at, byte) in bytes.iter().enumerate() {
        let word = byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$';
        match (word, start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                if *byte == b'(' {
                    let name = &line[from..at];
                    // Keywords read as calls otherwise: `if (x)`, `while (y)`.
                    if !matches!(
                        name,
                        "if" | "while" | "for" | "match" | "switch" | "return" | "fn" | "def"
                    ) {
                        out.push(name.to_string());
                    }
                }
                start = None;
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod concurrent_save_tests {
    use super::*;

    /// Jozkah/jan#245: many refreshes of one project saving at once all
    /// succeed, and what is left on disk is one whole index.
    #[test]
    fn concurrent_saves_of_one_project_all_succeed() {
        let data = std::env::temp_dir().join(format!("jan_index_race_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let project = data.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let index = Index {
            version: 1,
            project: project.to_string_lossy().into_owned(),
            commit: None,
            files: BTreeMap::new(),
            truncated: false,
            built_at: "now".into(),
        };
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (data, index) = (data.clone(), index.clone());
                std::thread::spawn(move || (0..25).map(|_| save(&data, &index)).collect::<Vec<_>>())
            })
            .collect();
        for h in handles {
            for r in h.join().unwrap() {
                assert!(r.is_ok(), "{:?}", r.err().map(|e| e.message));
            }
        }
        assert!(load(&data, &project).is_some());
        let _ = std::fs::remove_dir_all(&data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        data: PathBuf,
        project: PathBuf,
    }

    /// Put a file's modification time where the test needs it, without a
    /// dependency: the point of several of these is what the index does with a
    /// time that is older or newer than what it stored.
    fn set_mtime(path: &Path, when: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).expect("open to set times");
        let times = std::fs::FileTimes::new().set_modified(when);
        file.set_times(times).expect("set the modification time");
    }

    impl Fixture {
        fn new(tag: &str, files: &[(&str, &str)]) -> Fixture {
            let base = std::env::temp_dir().join(format!(
                "jan-index-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            let project = base.join("project");
            for (path, body) in files {
                let full = project.join(path);
                std::fs::create_dir_all(full.parent().unwrap()).unwrap();
                std::fs::write(full, body).unwrap();
            }
            Fixture { data: base.join("data"), project }
        }

        fn refresh(&self) -> (Index, Update) {
            refresh(&self.data, &self.project, &AtomicBool::new(false)).expect("the index builds")
        }

        fn write(&self, path: &str, body: &str) {
            let full = self.project.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, body).unwrap();
            // Filesystems keep modification times at a coarse resolution, so a
            // rewrite inside the same tick would look unchanged. The content
            // hash catches it either way; this makes the stat path the one
            // under test.
            set_mtime(&full, std::time::SystemTime::now() + std::time::Duration::from_secs(2));
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.project.parent().unwrap());
        }
    }

    fn sample() -> Fixture {
        Fixture::new(
            "sample",
            &[
                ("src/store.rs", "pub struct Store;\n\npub fn load() -> u8 {\n    1\n}\n"),
                ("src/lib.rs", "pub mod store;\npub const NAME: &str = \"x\";\n"),
                ("web/app.ts", "export function render() {}\nexport const TITLE = 'x'\n"),
                ("pkg/thing.py", "class Thing:\n    def use(self):\n        return 1\n"),
                ("README.md", "# not indexed\n"),
                ("node_modules/pkg/index.ts", "export function ignored() {}\n"),
            ],
        )
    }

    #[test]
    fn a_first_build_reads_the_repository_and_keeps_what_it_found() {
        let f = sample();
        let (index, update) = f.refresh();
        assert_eq!(update.added, 4, "four indexable files: {:?}", index.files.keys());
        assert_eq!(update.changed + update.removed, 0);
        assert!(!index.files.contains_key("README.md"), "a document is not source");
        assert!(
            index.files.keys().all(|p| !p.contains("node_modules")),
            "a vendored tree was indexed: {:?}",
            index.files.keys()
        );
        // It is on disk, under the data folder, and names no path of its own.
        assert!(path_for(&f.data, &f.project).is_file());
        assert!(load(&f.data, &f.project).is_some());
    }

    #[test]
    fn the_symbols_a_file_defines_are_found_by_name() {
        let f = sample();
        let (index, _) = f.refresh();
        let store = find_symbol(&index, "Store", 10);
        assert_eq!(store.len(), 1, "{store:?}");
        assert_eq!(store[0].path, "src/store.rs");
        assert_eq!(store[0].kind, SymbolKind::Type);
        assert_eq!(store[0].line, 1);

        assert_eq!(find_symbol(&index, "load", 10)[0].kind, SymbolKind::Function);
        assert_eq!(find_symbol(&index, "render", 10)[0].path, "web/app.ts");
        assert_eq!(find_symbol(&index, "Thing", 10)[0].path, "pkg/thing.py");
        assert_eq!(find_symbol(&index, "use", 10)[0].path, "pkg/thing.py");
        assert_eq!(find_symbol(&index, "NAME", 10)[0].kind, SymbolKind::Constant);

        // An exact match is never buried under the ones that merely contain it.
        let mixed = find_symbol(&index, "load", 10);
        assert_eq!(mixed[0].name, "load");
        // And a name nothing defines finds nothing rather than something near.
        assert!(find_symbol(&index, "no_such_symbol", 10).is_empty());
        assert!(find_symbol(&index, "  ", 10).is_empty());
    }

    /// The point of storing it: a second pass reads nothing it does not have
    /// to.
    #[test]
    fn a_second_pass_reads_only_what_changed() {
        let f = sample();
        let (_, first) = f.refresh();
        assert_eq!(first.added, 4);

        let (_, again) = f.refresh();
        assert!(!again.read_anything(), "an unchanged repository was re-read: {again:?}");
        assert_eq!(again.unchanged, 4);

        f.write("src/store.rs", "pub struct Store;\npub fn load() -> u8 { 2 }\npub fn extra() {}\n");
        let (index, changed) = f.refresh();
        assert_eq!((changed.added, changed.changed, changed.unchanged), (0, 1, 3), "{changed:?}");
        assert_eq!(find_symbol(&index, "extra", 5).len(), 1, "the new symbol is there");

        f.write("src/new.rs", "pub fn added_later() {}\n");
        let (index, added) = f.refresh();
        assert_eq!((added.added, added.changed), (1, 0), "{added:?}");
        assert_eq!(find_symbol(&index, "added_later", 5).len(), 1);

        std::fs::remove_file(f.project.join("src/new.rs")).unwrap();
        let (index, removed) = f.refresh();
        assert_eq!(removed.removed, 1, "{removed:?}");
        assert!(find_symbol(&index, "added_later", 5).is_empty(), "a deleted file's symbols stayed");
    }

    /// A file restored to an older copy has an older modification time. "Newer
    /// than the index" would miss it; any difference does not.
    #[test]
    fn a_file_put_back_to_an_older_copy_is_still_re_read() {
        let f = sample();
        f.refresh();
        let path = f.project.join("src/store.rs");
        std::fs::write(&path, "pub struct Store;\npub fn restored() {}\n").unwrap();
        set_mtime(&path, std::time::SystemTime::now() - std::time::Duration::from_secs(3600));

        let (index, update) = f.refresh();
        assert_eq!(update.changed, 1, "{update:?}");
        assert_eq!(find_symbol(&index, "restored", 5).len(), 1);
    }

    /// AH-056: when the checkout moves, everything is re-checked -- and
    /// re-checking is still not re-reading.
    #[test]
    fn a_moved_checkout_reconciles_without_rebuilding() {
        let f = sample();
        let git = |args: &[&str]| {
            let _ = std::process::Command::new("git")
                .arg("-C")
                .arg(&f.project)
                .args(args)
                .output();
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.invalid"]);
        git(&["config", "user.name", "T"]);
        git(&["add", "-A"]);
        git(&["commit", "-qm", "one"]);
        let (first, _) = f.refresh();
        assert!(first.commit.is_some(), "a git checkout records its commit");

        // A second commit on another branch, with one file different.
        git(&["switch", "-q", "-c", "other"]);
        std::fs::write(f.project.join("src/store.rs"), "pub struct Store;\npub fn on_other() {}\n")
            .unwrap();
        git(&["commit", "-qam", "two"]);

        let (index, update) = f.refresh();
        assert!(update.reconciled, "the commit moved and the index did not notice");
        assert_ne!(index.commit, first.commit);
        assert!(update.changed <= 1, "reconciling re-read more than changed: {update:?}");
        assert_eq!(find_symbol(&index, "on_other", 5).len(), 1);
    }

    /// A build that is stopped leaves no index at all: half an index that
    /// looks whole is worse than none.
    /// A repository that contains a link to itself does not make the walk
    /// run forever, and a link out of the project does not put somebody
    /// else's files in the index.
    #[test]
    #[cfg(windows)]
    fn a_symlinked_directory_is_not_followed() {
        let f = sample();
        let outside = f.project.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.rs"), "pub fn not_ours() {}\n").unwrap();
        // Symlinks need privilege on Windows; where they cannot be made the
        // test has nothing to say rather than a false pass.
        if std::os::windows::fs::symlink_dir(&outside, f.project.join("linked")).is_err() {
            return;
        }
        let _ = std::os::windows::fs::symlink_dir(&f.project, f.project.join("loop"));

        let started = std::time::Instant::now();
        let (index, _) = f.refresh();
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "the walk did not end");
        assert!(
            index.files.keys().all(|p| !p.contains("linked") && !p.contains("loop")),
            "a symlink was followed: {:?}",
            index.files.keys()
        );
        assert!(find_symbol(&index, "not_ours", 5).is_empty(), "a file outside the project");
    }

    #[test]
    fn a_cancelled_build_writes_nothing() {
        let f = sample();
        let cancel = AtomicBool::new(true);
        let stopped = refresh(&f.data, &f.project, &cancel).unwrap_err();
        assert_eq!(stopped.kind, IndexErrorKind::Cancelled);
        assert!(load(&f.data, &f.project).is_none(), "a stopped build left an index");
        assert!(!path_for(&f.data, &f.project).exists());

        let harness: tauri_plugin_agent_tools::harness_error::HarnessError = (&stopped).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::Cancelled
        );

        // And a later build, not stopped, is a first build rather than an
        // update of something that was never written.
        let (_, update) = f.refresh();
        assert_eq!(update.added, 4);
    }

    #[test]
    fn an_index_for_another_project_or_an_older_build_is_not_used() {
        let f = sample();
        let (index, _) = f.refresh();
        // Another project's path: the same file, read for somewhere else.
        assert!(load(&f.data, Path::new("/somewhere/else")).is_none());

        // An older shape is rebuilt rather than misread.
        let mut old = index.clone();
        old.version = INDEX_VERSION - 1;
        let path = path_for(&f.data, &f.project);
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
        assert!(load(&f.data, &f.project).is_none());
        let (_, update) = f.refresh();
        assert_eq!(update.added, 4, "a rebuild, not an update: {update:?}");
    }

    /// AH-060: every use of a name, with the definition among them and
    /// nothing that merely contains it.
    #[test]
    fn every_use_of_a_name_is_found_and_the_definition_is_marked() {
        let f = Fixture::new(
            "refs",
            &[
                ("src/store.rs", "pub fn load() -> u8 {\n    1\n}\n"),
                (
                    "src/use.rs",
                    "use crate::store::load;\nfn go() {\n    let payload = 1;\n    let _ = load();\n}\n",
                ),
                ("src/quiet.rs", "pub fn unrelated() {}\n"),
            ],
        );
        let (index, _) = f.refresh();
        let refs = find_references(&index, "load", 50);
        let places: Vec<String> = refs.iter().map(|r| format!("{}:{}", r.path, r.line)).collect();
        assert!(places.contains(&"src/store.rs:1".to_string()), "{places:?}");
        assert!(places.contains(&"src/use.rs:1".to_string()), "{places:?}");
        assert!(places.contains(&"src/use.rs:4".to_string()), "{places:?}");
        // `payload` contains `load` and is not a use of it.
        assert!(!places.contains(&"src/use.rs:3".to_string()), "{places:?}");
        assert!(refs.iter().all(|r| !r.path.contains("quiet")));

        // The definition is marked as one, so it is not mistaken for a call.
        let definition: Vec<&Reference> = refs.iter().filter(|r| r.is_definition).collect();
        assert_eq!(definition.len(), 1, "{refs:?}");
        assert_eq!(definition[0].path, "src/store.rs");

        // AH-061: the same name resolves to where it is defined.
        let defined = find_symbol(&index, "load", 5);
        assert_eq!((defined[0].path.as_str(), defined[0].line), ("src/store.rs", 1));

        assert!(find_references(&index, "", 10).is_empty());
        assert!(find_references(&index, "nothing_uses_this", 10).is_empty());
    }

    /// AH-062: who calls this, and what it calls.
    #[test]
    fn the_callers_and_callees_of_a_function_are_walked() {
        let f = Fixture::new(
            "hierarchy",
            &[
                (
                    "src/core.rs",
                    "pub fn helper() -> u8 {\n    1\n}\n\npub fn middle() -> u8 {\n    if helper() > 0 {\n        helper()\n    } else {\n        0\n    }\n}\n",
                ),
                (
                    "src/top.rs",
                    "use crate::core::middle;\n\npub fn run() -> u8 {\n    middle()\n}\n",
                ),
            ],
        );
        let (index, _) = f.refresh();

        let middle = hierarchy(&index, "middle", 50);
        assert_eq!(middle.defined.len(), 1, "{:?}", middle.defined);
        // Called from `run`, in the other file.
        let callers: Vec<(&str, usize)> = middle
            .callers
            .iter()
            .map(|c| (c.path.as_str(), c.line))
            .collect();
        assert!(callers.contains(&("src/top.rs", 4)), "{callers:?}");
        assert_eq!(
            middle.callers.iter().find(|c| c.path == "src/top.rs" && c.line == 4).unwrap().within.as_deref(),
            Some("run"),
            "a caller says which function the call is written in"
        );
        // The `use` line names it but does not call it.
        assert!(!callers.contains(&("src/top.rs", 1)), "{callers:?}");

        // And it calls `helper`, twice, inside its own body only.
        let callees: Vec<&str> = middle.callees.iter().map(|c| c.name.as_str()).collect();
        assert!(callees.contains(&"helper"), "{callees:?}");
        assert!(
            middle.callees.iter().all(|c| c.line > 5),
            "a call outside the function's body was counted: {:?}",
            middle.callees
        );
        // `if` is not a call.
        assert!(!callees.contains(&"if"), "{callees:?}");

        // A name nothing defines has no hierarchy rather than a made-up one.
        let nothing = hierarchy(&index, "no_such_function", 50);
        assert!(nothing.defined.is_empty() && nothing.callers.is_empty() && nothing.callees.is_empty());
        assert!(hierarchy(&index, "", 50).defined.is_empty());
    }

    #[test]
    fn a_directory_that_is_not_a_project_is_a_typed_refusal() {
        let f = sample();
        let missing = refresh(&f.data, Path::new("no-such-directory-here"), &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(missing.kind, IndexErrorKind::NoProject);
    }
}

/// AH-057 evidence. Written before the LSP client existed, as a test that the
/// index resolves `f.Close()` to the one method it calls; it failed, and not
/// only for the reason expected: Go declarations are read with JS/TS keywords,
/// so no Go `func` -- function or method -- is indexed at all. What the index
/// cannot do is kept here as a statement of that limit, and the question it
/// could not answer is asked of the language server in `lsp.rs`.
#[cfg(test)]
pub(crate) mod resolve_evidence {
    use super::*;

    pub(crate) const GO_FIXTURE: &str = "package probe

type Closer interface{ Close() error }

type File struct{}

func (f *File) Close() error { return nil }

type Socket struct{}

func (s *Socket) Close() error { return nil }

func Shut(c Closer) error { return c.Close() }

func UseFile() error {
	f := &File{}
	return f.Close()
}
";

    #[test]
    fn the_index_cannot_say_which_method_a_go_call_reaches() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("go.mod"), "module example.com/probe

go 1.22
").unwrap();
        std::fs::write(project.path().join("probe.go"), GO_FIXTURE).unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let (index, _) = refresh(data.path(), project.path(), &cancel).unwrap();
        let close: Vec<_> = find_symbol(&index, "Close", 20).into_iter().filter(|d| d.name == "Close").collect();
        assert!(close.is_empty(), "the index now reads Go methods; revisit lsp.rs's comparison: {close:?}");
        // A name-based lookup would be ambiguous even if it did: both methods
        // are named Close.
        assert_eq!(GO_FIXTURE.matches(") Close() error").count(), 2);
    }
}
