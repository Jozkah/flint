//! A ranked repository map for the system prompt (opt-in: `[prompt] repo_map`).
//!
//! The symbol index already knows every file and its top-level definitions.
//! This turns it into a short orientation block -- the project's most relevant
//! files with their main symbols -- sized to the context window, so a run starts
//! knowing where things are instead of spending its first turns on `ls`.
//!
//! Everything here is local and deterministic. The ranking reads only the index,
//! the git working-tree status and the task text; the same inputs give the same
//! bytes, so a prompt cache is not churned by the map itself. Anything missing
//! (no index, not a git repository, a budget too small to say anything useful)
//! yields no block rather than a worse one.

use std::collections::BTreeSet;
use std::path::Path;

use crate::core::agent::index::{FileEntry, Index, Symbol, SymbolKind};

/// Characters per token, the same rule of thumb the rest of the prompt budgets
/// use: this crate has no tokeniser.
const CHARS_PER_TOKEN: usize = 4;
/// Share of the context window the map may take, in percent, and its bounds.
const WINDOW_PERCENT: u64 = 2;
const MIN_BUDGET_TOKENS: u64 = 300;
const MAX_BUDGET_TOKENS: u64 = 2000;
/// The window assumed when none is known (the documented default).
pub(crate) const DEFAULT_WINDOW_TOKENS: u64 = 128_000;
/// Symbols listed per file.
const MAX_SYMBOLS_PER_FILE: usize = 8;
/// Task words considered, and the most the task can add to one file's score.
const MAX_TASK_WORDS: usize = 32;
const MAX_TASK_BONUS: u32 = 60;

const HEADER: &str = "# Repository map\n\nThe project's most relevant files and their top-level symbols, \
ranked for this task. Orientation only: read a file before relying on it.\n\n";

/// Directory names whose contents are vendored, built or generated.
const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    "vendor",
    ".next",
    "out",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
];

/// Lockfiles and the like: large, symbol-free and never what a task is about.
const EXCLUDED_FILES: &[&str] = &[
    "cargo.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "poetry.lock",
    "composer.lock",
    "gemfile.lock",
    "go.sum",
];

/// Words too common in a task to say which file it is about.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "that", "this", "with", "from", "into", "have", "has", "not", "are", "was",
    "you", "your", "can", "all", "any", "add", "fix", "make", "use", "new", "get", "set", "how",
    "why", "what", "when", "should", "would", "could", "please", "need", "want", "update", "change",
];

/// The token budget for a context window: 2% of it, within 300..=2000.
pub(crate) fn budget_tokens(window_tokens: u64) -> usize {
    (window_tokens.saturating_mul(WINDOW_PERCENT) / 100).clamp(MIN_BUDGET_TOKENS, MAX_BUDGET_TOKENS)
        as usize
}

/// What a map is built from besides the index.
pub(crate) struct Input<'a> {
    /// The user's task text, for the name-match boost. May be empty.
    pub task: &'a str,
    /// Paths (relative to the project, `/`-separated) git reports as changed.
    /// `None` when the project is not a git repository, which yields no map.
    pub changed: Option<&'a BTreeSet<String>>,
    /// The most tokens the whole block may take.
    pub budget_tokens: usize,
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

/// Whether a path is vendored, built or generated output rather than source.
fn excluded(path: &str) -> bool {
    let path = normalized(path).to_ascii_lowercase();
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_some() {
            if EXCLUDED_DIRS.contains(&part) {
                return true;
            }
        } else if EXCLUDED_FILES.contains(&part)
            || part.ends_with(".lock")
            || part.contains(".min.")
            || part.ends_with(".map")
        {
            return true;
        }
    }
    false
}

/// Distinct lowercase words of the task worth matching against names.
fn task_words(task: &str) -> Vec<String> {
    let words: BTreeSet<String> = task
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(&w.as_str()))
        .collect();
    words.into_iter().take(MAX_TASK_WORDS).collect()
}

fn symbol_matches(symbol: &Symbol, words: &[String]) -> bool {
    let name = symbol.name.to_lowercase();
    words.iter().any(|w| name.contains(w.as_str()))
}

/// One file's score. Integer arithmetic only, so there is nothing to round
/// differently between runs.
fn score(
    path: &str,
    entry: &FileEntry,
    newest_ms: u64,
    changed: &BTreeSet<String>,
    words: &[String],
) -> u32 {
    let mut score = 0u32;
    if changed.contains(path) {
        score += 50;
    }
    // Recency is relative to the newest file in the index, not to the clock:
    // the ranking must not drift just because time passed between two runs.
    let age = newest_ms.saturating_sub(entry.modified_ms);
    score += match age {
        a if a <= 86_400_000 => 25,
        a if a <= 7 * 86_400_000 => 15,
        _ => 0,
    };
    score += entry.symbols.len().min(20) as u32;
    // Shallower paths are usually the entry points and the core.
    let depth = path.matches('/').count() as u32;
    score += 10u32.saturating_sub(depth * 2);
    if !words.is_empty() {
        let lower = path.to_lowercase();
        let mut bonus = 0u32;
        for word in words {
            if lower.contains(word.as_str()) {
                bonus += 15;
            }
            if entry.symbols.iter().any(|s| s.name.to_lowercase().contains(word.as_str())) {
                bonus += 8;
            }
        }
        score += bonus.min(MAX_TASK_BONUS);
    }
    score
}

/// The symbols to list for a file: those the task names first, then types,
/// functions and constants, each in line order, each name once.
fn pick_symbols(entry: &FileEntry, words: &[String]) -> Vec<String> {
    let mut symbols: Vec<&Symbol> = entry.symbols.iter().collect();
    symbols.sort_by_key(|s| {
        let kind = match s.kind {
            SymbolKind::Type => 0,
            SymbolKind::Function => 1,
            SymbolKind::Constant => 2,
        };
        (!symbol_matches(s, words), kind, s.line, s.name.clone())
    });
    let mut seen = BTreeSet::new();
    symbols
        .into_iter()
        .filter(|s| seen.insert(s.name.as_str()))
        .take(MAX_SYMBOLS_PER_FILE)
        .map(|s| s.name.clone())
        .collect()
}

/// The `Repository map` block, or `None` when there is nothing worth saying or
/// no room to say it.
pub(crate) fn render(index: &Index, input: &Input<'_>) -> Option<String> {
    let changed = input.changed?;
    let max_chars = input.budget_tokens.saturating_mul(CHARS_PER_TOKEN);
    if max_chars <= HEADER.len() {
        return None;
    }
    let words = task_words(input.task);
    let candidates: Vec<(&String, &FileEntry)> = index
        .files
        .iter()
        .filter(|(path, _)| !excluded(path))
        // A file with no symbols says nothing a directory listing would not,
        // unless it is the thing being worked on.
        .filter(|(path, entry)| !entry.symbols.is_empty() || changed.contains(path.as_str()))
        .collect();
    let newest_ms = candidates.iter().map(|(_, e)| e.modified_ms).max().unwrap_or(0);
    let mut ranked: Vec<(u32, &String, &FileEntry)> = candidates
        .into_iter()
        .map(|(path, entry)| (score(path, entry, newest_ms, changed, &words), path, entry))
        .collect();
    // Highest score first; the path breaks ties, so the order is total.
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));

    let mut out = String::from(HEADER);
    let mut listed = 0usize;
    for (_, path, entry) in ranked {
        let mut names = pick_symbols(entry, &words);
        let line = loop {
            let line = if names.is_empty() {
                format!("{}\n", normalized(path))
            } else {
                format!("{}: {}\n", normalized(path), names.join(", "))
            };
            if out.len() + line.len() <= max_chars {
                break Some(line);
            }
            // Say less about this file before giving up on it.
            if names.pop().is_none() {
                break None;
            }
        };
        match line {
            Some(line) => {
                out.push_str(&line);
                listed += 1;
            }
            // Not even the bare path fits: nothing after it will either.
            None => break,
        }
    }
    (listed > 0).then(|| out.trim_end().to_string())
}

/// `git status` paths made relative to `project`, `/`-separated. Paths outside
/// the project are dropped. `repo_root` and `project` may differ in separators
/// and in a verbatim `\\?\` prefix.
fn relative_changes(repo_root: &str, project: &Path, paths: &[String]) -> BTreeSet<String> {
    let clean = |s: &str| {
        let s = s.replace('\\', "/");
        s.strip_prefix("//?/").unwrap_or(&s).trim_end_matches('/').to_string()
    };
    let root = clean(repo_root);
    let project = clean(&project.to_string_lossy());
    let prefix = project
        .strip_prefix(root.as_str())
        .map(|rest| rest.trim_matches('/').to_string())
        .unwrap_or_default();
    paths
        .iter()
        .map(|p| clean(p))
        .filter_map(|p| {
            if prefix.is_empty() {
                Some(p)
            } else {
                p.strip_prefix(&format!("{prefix}/")).map(str::to_string)
            }
        })
        .collect()
}

/// The files git reports changed in `project`, or `None` when it is not a git
/// repository (or git cannot answer).
fn git_changed(project: &Path) -> Option<BTreeSet<String>> {
    let status = crate::core::agent::git::status(project, crate::core::agent::git::DiffScope::All).ok()?;
    let paths: Vec<String> = status.files.into_iter().map(|f| f.path).collect();
    Some(relative_changes(&status.repo_root, project, &paths))
}

/// The map for a run: brings the stored index up to date (stat-compared, so
/// cheap after the first build), reads git's view of what changed, and renders.
/// Blocking: call it off the async runtime.
pub(crate) fn for_run(
    data_folder: &Path,
    project: &Path,
    task: &str,
    window_tokens: u64,
) -> Option<String> {
    let changed = git_changed(project)?;
    let never = std::sync::atomic::AtomicBool::new(false);
    let index = match crate::core::agent::index::refresh(data_folder, project, &never) {
        Ok((index, _)) => index,
        Err(e) => {
            log::warn!("repo map: {}", e.message);
            crate::core::agent::index::load(data_folder, project)?
        }
    };
    render(
        &index,
        &Input {
            task,
            changed: Some(&changed),
            budget_tokens: budget_tokens(window_tokens),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn sym(name: &str, kind: SymbolKind, line: usize) -> Symbol {
        Symbol { name: name.to_string(), kind, line }
    }

    fn entry(modified_ms: u64, symbols: Vec<Symbol>) -> FileEntry {
        FileEntry {
            path: String::new(),
            size: 10,
            modified_ms,
            hash: String::new(),
            symbols,
        }
    }

    fn index_of(files: Vec<(&str, FileEntry)>) -> Index {
        Index {
            version: 1,
            project: "/p".to_string(),
            commit: None,
            files: files
                .into_iter()
                .map(|(p, mut e)| {
                    e.path = p.to_string();
                    (p.to_string(), e)
                })
                .collect::<BTreeMap<_, _>>(),
            truncated: false,
            built_at: String::new(),
        }
    }

    const OLD: u64 = 1_000_000;
    const NEW: u64 = OLD + 100 * 86_400_000;

    fn changed(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    fn lines(map: &str) -> Vec<&str> {
        map.lines().skip(4).collect()
    }

    fn input<'a>(task: &'a str, changed: &'a BTreeSet<String>, budget: usize) -> Input<'a> {
        Input { task, changed: Some(changed), budget_tokens: budget }
    }

    #[test]
    fn budget_is_two_percent_of_the_window_within_bounds() {
        assert_eq!(budget_tokens(8_000), 300, "floor");
        assert_eq!(budget_tokens(32_000), 640);
        assert_eq!(budget_tokens(128_000), 2000, "ceiling");
        assert_eq!(budget_tokens(2_000_000), 2000);
        assert_eq!(budget_tokens(0), 300);
    }

    #[test]
    fn changed_recent_and_shallow_files_rank_first() {
        let one = |n: &str| vec![sym(n, SymbolKind::Function, 1)];
        let index = index_of(vec![
            ("deep/a/b/c/old.rs", entry(OLD, one("old"))),
            ("src/touched.rs", entry(OLD, one("touched"))),
            ("src/fresh.rs", entry(NEW, one("fresh"))),
            ("main.rs", entry(OLD, one("main"))),
        ]);
        let changed = changed(&["src/touched.rs"]);
        let map = render(&index, &input("", &changed, 500)).unwrap();
        let order: Vec<&str> = lines(&map).iter().map(|l| l.split(':').next().unwrap()).collect();
        // changed (+50) beats recent (+25) beats shallow; the deep old file is last.
        assert_eq!(order, ["src/touched.rs", "src/fresh.rs", "main.rs", "deep/a/b/c/old.rs"]);
    }

    #[test]
    fn more_symbols_rank_higher_when_all_else_is_equal() {
        let index = index_of(vec![
            ("src/a.rs", entry(OLD, vec![sym("one", SymbolKind::Function, 1)])),
            (
                "src/b.rs",
                entry(
                    OLD,
                    vec![
                        sym("two", SymbolKind::Function, 1),
                        sym("three", SymbolKind::Function, 2),
                        sym("four", SymbolKind::Function, 3),
                    ],
                ),
            ),
        ]);
        let changed = changed(&[]);
        let map = render(&index, &input("", &changed, 500)).unwrap();
        assert!(lines(&map)[0].starts_with("src/b.rs"), "{map}");
    }

    #[test]
    fn task_words_boost_matching_paths_and_symbols() {
        let index = index_of(vec![
            ("src/alpha.rs", entry(OLD, vec![sym("run", SymbolKind::Function, 1)])),
            ("src/beta.rs", entry(OLD, vec![sym("run", SymbolKind::Function, 1)])),
            ("src/gamma.rs", entry(OLD, vec![sym("billing_total", SymbolKind::Function, 1)])),
        ]);
        let changed = changed(&[]);
        let plain = render(&index, &input("", &changed, 500)).unwrap();
        assert!(lines(&plain)[0].starts_with("src/alpha.rs"), "ties go by path: {plain}");

        let by_path = render(&index, &input("fix the beta module", &changed, 500)).unwrap();
        assert!(lines(&by_path)[0].starts_with("src/beta.rs"), "{by_path}");

        let by_symbol = render(&index, &input("billing is wrong", &changed, 500)).unwrap();
        assert!(lines(&by_symbol)[0].starts_with("src/gamma.rs"), "{by_symbol}");
    }

    #[test]
    fn stopwords_and_short_words_do_not_boost() {
        assert!(task_words("fix the and to do it").is_empty());
        assert_eq!(task_words("Billing, billing! BILLING_total"), ["billing", "total"]);
    }

    #[test]
    fn vendored_generated_and_lock_files_are_left_out() {
        let f = |n: &str| vec![sym(n, SymbolKind::Function, 1)];
        let index = index_of(vec![
            ("node_modules/pkg/index.js", entry(NEW, f("a"))),
            ("target/debug/x.rs", entry(NEW, f("b"))),
            ("dist/app.js", entry(NEW, f("c"))),
            ("web/build/out.js", entry(NEW, f("d"))),
            (".git/hooks/h.js", entry(NEW, f("e"))),
            ("vendor/lib.go", entry(NEW, f("f"))),
            ("Cargo.lock", entry(NEW, f("g"))),
            ("web/yarn.lock", entry(NEW, f("h"))),
            ("web/app.min.js", entry(NEW, f("i"))),
            ("src/real.rs", entry(OLD, f("real"))),
        ]);
        let changed = changed(&[]);
        let map = render(&index, &input("", &changed, 500)).unwrap();
        assert_eq!(lines(&map), ["src/real.rs: real"]);
    }

    #[test]
    fn a_symbol_free_file_is_listed_only_when_changed() {
        let index = index_of(vec![
            ("src/empty.rs", entry(OLD, vec![])),
            ("src/edited.rs", entry(OLD, vec![])),
            ("src/real.rs", entry(OLD, vec![sym("real", SymbolKind::Function, 1)])),
        ]);
        let changed = changed(&["src/edited.rs"]);
        let map = render(&index, &input("", &changed, 500)).unwrap();
        let listed = lines(&map);
        assert!(listed.contains(&"src/edited.rs"));
        assert!(!listed.iter().any(|l| l.starts_with("src/empty.rs")));
    }

    #[test]
    fn symbols_are_capped_ordered_and_deduplicated() {
        let mut symbols = vec![
            sym("zeta", SymbolKind::Function, 1),
            sym("Widget", SymbolKind::Type, 50),
            sym("LIMIT", SymbolKind::Constant, 2),
            sym("zeta", SymbolKind::Function, 9),
        ];
        for i in 0..20 {
            symbols.push(sym(&format!("f{i:02}"), SymbolKind::Function, 100 + i));
        }
        let index = index_of(vec![("src/big.rs", entry(OLD, symbols))]);
        let changed = changed(&[]);
        let map = render(&index, &input("", &changed, 500)).unwrap();
        let line = lines(&map)[0].to_string();
        let names: Vec<&str> = line.strip_prefix("src/big.rs: ").unwrap().split(", ").collect();
        assert_eq!(names.len(), MAX_SYMBOLS_PER_FILE);
        // Types first, then functions by line (one `zeta`), constants after.
        assert_eq!(&names[..3], ["Widget", "zeta", "f00"]);
        assert_eq!(names.iter().filter(|n| **n == "zeta").count(), 1);
    }

    #[test]
    fn the_task_chooses_which_symbols_are_listed() {
        let mut symbols: Vec<Symbol> = (0..12)
            .map(|i| sym(&format!("helper{i:02}"), SymbolKind::Function, 1 + i))
            .collect();
        symbols.push(sym("checkout_flow", SymbolKind::Function, 500));
        let index = index_of(vec![("src/shop.rs", entry(OLD, symbols))]);
        let changed = changed(&[]);
        let map = render(&index, &input("the checkout is slow", &changed, 500)).unwrap();
        assert!(lines(&map)[0].starts_with("src/shop.rs: checkout_flow, "), "{map}");
    }

    #[test]
    fn the_budget_is_respected_and_the_best_files_survive() {
        let files: Vec<(String, FileEntry)> = (0..200)
            .map(|i| {
                (
                    format!("src/module_{i:03}.rs"),
                    entry(OLD, vec![sym(&format!("function_number_{i:03}"), SymbolKind::Function, 1)]),
                )
            })
            .collect();
        let index = index_of(files.iter().map(|(p, e)| (p.as_str(), e.clone())).collect());
        let changed = changed(&["src/module_150.rs"]);
        for budget in [60, 120, 300, 2000] {
            let map = render(&index, &input("", &changed, budget)).unwrap();
            assert!(
                map.len() <= budget * CHARS_PER_TOKEN,
                "budget {budget}: {} chars",
                map.len()
            );
            assert!(lines(&map)[0].starts_with("src/module_150.rs"), "the changed file leads");
        }
        let small = render(&index, &input("", &changed, 60)).unwrap();
        let large = render(&index, &input("", &changed, 2000)).unwrap();
        assert!(lines(&small).len() < lines(&large).len());
    }

    #[test]
    fn a_line_that_does_not_fit_loses_symbols_before_it_loses_its_place() {
        let symbols: Vec<Symbol> = (0..8)
            .map(|i| sym(&format!("a_rather_long_symbol_name_{i}"), SymbolKind::Function, 1 + i))
            .collect();
        let index = index_of(vec![("src/wide.rs", entry(OLD, symbols))]);
        let changed = changed(&[]);
        // Header plus a short line only.
        let budget = (HEADER.len() + 70) / CHARS_PER_TOKEN + 1;
        let map = render(&index, &input("", &changed, budget)).unwrap();
        assert!(map.len() <= budget * CHARS_PER_TOKEN);
        assert!(lines(&map)[0].starts_with("src/wide.rs: a_rather_long_symbol_name_0"), "{map}");
    }

    #[test]
    fn a_tiny_budget_or_nothing_to_list_gives_no_block() {
        let index = index_of(vec![("src/a.rs", entry(OLD, vec![sym("a", SymbolKind::Function, 1)]))]);
        let changed = changed(&[]);
        assert_eq!(render(&index, &input("", &changed, 0)), None);
        assert_eq!(render(&index, &input("", &changed, 10)), None, "header alone does not fit");
        // Header fits, but not even one path after it.
        let barely = HEADER.len() / CHARS_PER_TOKEN + 1;
        assert_eq!(render(&index, &input("", &changed, barely)), None);
        assert_eq!(render(&index_of(vec![]), &input("", &changed, 500)), None, "empty index");
        let only_excluded = index_of(vec![(
            "node_modules/x.js",
            entry(OLD, vec![sym("x", SymbolKind::Function, 1)]),
        )]);
        assert_eq!(render(&only_excluded, &input("", &changed, 500)), None);
    }

    #[test]
    fn not_a_git_repository_gives_no_block() {
        let index = index_of(vec![("src/a.rs", entry(OLD, vec![sym("a", SymbolKind::Function, 1)]))]);
        let no_git = Input { task: "", changed: None, budget_tokens: 500 };
        assert_eq!(render(&index, &no_git), None);
    }

    #[test]
    fn the_same_inputs_give_the_same_bytes_whatever_the_insertion_order() {
        let build = |reverse: bool| {
            let mut files: Vec<(&str, FileEntry)> = (0..30)
                .map(|i| {
                    // Many exact ties, so only the tie-break decides.
                    (
                        Box::leak(format!("src/f{i:02}.rs").into_boxed_str()) as &str,
                        entry(OLD, vec![sym(&format!("s{i}"), SymbolKind::Function, 1)]),
                    )
                })
                .collect();
            if reverse {
                files.reverse();
            }
            index_of(files)
        };
        let changed = changed(&["src/f07.rs"]);
        let a = render(&build(false), &input("the f12 module", &changed, 400)).unwrap();
        let b = render(&build(true), &input("the f12 module", &changed, 400)).unwrap();
        let c = render(&build(false), &input("the f12 module", &changed, 400)).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn git_paths_are_made_relative_to_the_project() {
        let paths = vec!["app/src/a.rs".to_string(), "other/b.rs".to_string()];
        let rel = relative_changes("C:/repo", Path::new("C:\\repo\\app"), &paths);
        assert_eq!(rel, changed(&["src/a.rs"]), "outside the project is dropped");
        let same = relative_changes("C:/repo", Path::new("C:/repo"), &paths);
        assert_eq!(same.len(), 2);
        let verbatim = relative_changes("//?/C:/repo", Path::new("C:/repo/app"), &paths);
        assert_eq!(verbatim, changed(&["src/a.rs"]));
    }

    #[test]
    fn a_project_outside_git_gets_no_map_from_for_run() {
        let dir = std::env::temp_dir().join(format!("repo_map_nogit_{}", std::process::id()));
        let data = dir.join("data");
        let project = dir.join("p");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(project.join("src/a.rs"), "pub fn a() {}\n").unwrap();
        // Only meaningful when the temp dir is not inside some repository.
        if crate::core::agent::git::repo_root(&project).is_none() {
            assert_eq!(for_run(&data, &project, "", DEFAULT_WINDOW_TOKENS), None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_git_project_gets_a_map_from_for_run() {
        let dir = std::env::temp_dir().join(format!("repo_map_git_{}", std::process::id()));
        let data = dir.join("data");
        let project = dir.join("p");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(project.join("src/store.rs"), "pub struct Store;\npub fn load() {}\n").unwrap();
        let initialised = std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&project)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        // No git on this box: nothing to prove here, and not a failure.
        if initialised {
            let map = for_run(&data, &project, "store", DEFAULT_WINDOW_TOKENS).expect("a map");
            assert!(map.starts_with("# Repository map"), "{map}");
            assert!(map.contains("src/store.rs: Store, load"), "{map}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
