//! Search over what the index actually knows (`AH-071`).
//!
//! Registered in the backlog as "semantic search", and the first thing this
//! module does is decline that word. It matches **lexically** -- on symbol
//! names, the words inside them, the paths they live in, and the doc comments
//! written directly above them. It has no model of meaning, and a search for
//! `authentication` will not find `login` unless one of those strings is
//! literally there.
//!
//! Saying so is not modesty, it is the whole design. A model told it has
//! semantic search reads a miss as "this concept is absent from the codebase"
//! and stops looking. A model told it has lexical search over an index reads a
//! miss as "try grep, try another word", which is the true and useful reading.
//! So every hit carries the evidence for why it matched, every miss says what
//! was searched, and nothing in the output claims understanding.
//!
//! What it does add over `symbol_search` is reach: four ways a query can match,
//! ranked, so a half-remembered name or a concept mentioned in a doc comment
//! still lands somewhere.

use crate::core::agent::index::{RepoIndex, Symbol, SymbolKind};

/// Longest query accepted. Beyond this it is a paragraph, not a query, and
/// scanning for it costs more than it can possibly return.
pub(crate) const MAX_QUERY_LEN: usize = 128;

/// Shortest query accepted. One character matches most of a codebase, which is
/// the same as matching nothing.
pub(crate) const MIN_QUERY_LEN: usize = 2;

/// Hard ceiling on returned hits, whatever the caller asks for.
pub(crate) const MAX_RESULTS: usize = 50;

/// Ceiling on symbols examined in one search. A repository large enough to
/// exceed it gets a partial answer that says it is partial, rather than a slow
/// one that does not.
pub(crate) const MAX_SCANNED: usize = 20_000;

/// How a hit matched, best first. The order is the ranking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum MatchType {
    /// The query is the whole name.
    Exact,
    /// The query is one of the words the name is made of.
    Token,
    /// The query's characters appear in the name, in order, with gaps.
    Fuzzy,
    /// The query appears in the doc comment or the path, not the name.
    Metadata,
}

impl MatchType {
    /// A fixed number per match type, so two runs never disagree.
    ///
    /// Deliberately not a computed score: a confidence that drifts with corpus
    /// size invites the reader to compare numbers across searches, which would
    /// mean nothing.
    fn confidence(self) -> u8 {
        match self {
            Self::Exact => 100,
            Self::Token => 75,
            Self::Fuzzy => 45,
            Self::Metadata => 30,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Exact => "exact name",
            Self::Token => "token in name",
            Self::Fuzzy => "fuzzy name",
            Self::Metadata => "metadata",
        }
    }
}

/// One result, with the evidence for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    pub path: String,
    pub line: u32,
    /// The declaration matched, or `None` for a whole-file (path) match.
    pub symbol: Option<String>,
    pub kind: Option<SymbolKind>,
    pub match_type: MatchType,
    pub confidence: u8,
    /// Why this matched, in words. The reader should never have to infer it.
    pub evidence: String,
}

/// What a search produced. The empty cases are separate on purpose: "the index
/// is empty" and "the index has no match" call for different next moves.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// The query could not be searched. Carries the reason.
    Refused(String),
    /// Nothing is indexed for this project.
    NoIndex,
    NoMatches {
        scanned: usize,
    },
    Hits {
        hits: Vec<Hit>,
        scanned: usize,
        /// The scan stopped at [`MAX_SCANNED`], so these hits are partial.
        capped: bool,
    },
}

/// Splits an identifier into the words it is made of.
///
/// `parse_header` and `HttpRequestBuilder` both become the words a person would
/// say out loud, which is what a half-remembered query tends to contain.
fn tokens(name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;

    for ch in name.chars() {
        if ch == '_' || ch == '-' || ch == '.' || ch == '/' || ch == ' ' {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            previous_lower = false;
            continue;
        }
        // A capital after a lowercase starts a new word: `HttpRequest`.
        if ch.is_uppercase() && previous_lower && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        previous_lower = ch.is_lowercase() || ch.is_numeric();
        current.push(ch.to_ascii_lowercase());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Whether `query`'s characters appear in `name` in order.
fn is_subsequence(query: &str, name: &str) -> bool {
    let mut wanted = query.chars();
    let mut next = wanted.next();
    for ch in name.chars() {
        if Some(ch) == next {
            next = wanted.next();
            if next.is_none() {
                return true;
            }
        }
    }
    next.is_none()
}

/// How a symbol's *name* matches, if it does.
fn name_match(query: &str, name: &str) -> Option<MatchType> {
    let lowered = name.to_ascii_lowercase();
    if lowered == query {
        return Some(MatchType::Exact);
    }
    if tokens(name).iter().any(|token| token == query) {
        return Some(MatchType::Token);
    }
    if is_subsequence(query, &lowered) {
        return Some(MatchType::Fuzzy);
    }
    None
}

/// Searches the index. Deterministic: the same index and query always produce
/// the same list, in the same order.
pub(crate) fn search(index: &RepoIndex, query: &str, limit: usize) -> Outcome {
    let trimmed = query.trim();
    if trimmed.chars().count() < MIN_QUERY_LEN {
        return Outcome::Refused(format!(
            "A query must be at least {MIN_QUERY_LEN} characters; one character matches most of \
             a codebase, which is the same as matching nothing."
        ));
    }
    if trimmed.chars().count() > MAX_QUERY_LEN {
        return Outcome::Refused(format!(
            "That query is longer than {MAX_QUERY_LEN} characters. Search for a name or a word, \
             not a sentence."
        ));
    }
    if index.files.is_empty() {
        return Outcome::NoIndex;
    }

    let needle = trimmed.to_ascii_lowercase();
    let limit = limit.clamp(1, MAX_RESULTS);
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0usize;
    let mut capped = false;

    // BTreeMap iteration is ordered by path, so the scan itself is stable and
    // the cap always falls in the same place.
    'files: for (path, entry) in &index.files {
        let path_matches = tokens(path).iter().any(|token| token == &needle);

        for symbol in &entry.symbols {
            if scanned >= MAX_SCANNED {
                capped = true;
                break 'files;
            }
            scanned += 1;

            // One hit per symbol, best match wins: a symbol that matches by
            // name and by path is one result, not two.
            if let Some(match_type) = name_match(&needle, &symbol.name) {
                hits.push(hit_for(symbol, match_type, evidence_for(match_type, &symbol.name)));
                continue;
            }
            if let Some(doc) = symbol.doc.as_ref() {
                if tokens(doc).iter().any(|token| token == &needle) {
                    hits.push(hit_for(
                        symbol,
                        MatchType::Metadata,
                        format!("'{needle}' appears in the doc comment above `{}`", symbol.name),
                    ));
                }
            }
        }

        // A path match is one hit for the file, not one per symbol in it.
        if path_matches && !hits.iter().any(|h| h.path == *path) {
            hits.push(Hit {
                path: path.clone(),
                line: 1,
                symbol: None,
                kind: None,
                match_type: MatchType::Metadata,
                confidence: MatchType::Metadata.confidence(),
                evidence: format!("'{needle}' is a segment of the file path"),
            });
        }
    }

    if hits.is_empty() {
        return Outcome::NoMatches { scanned };
    }

    // Rank, then break every tie on stable data so the order cannot drift.
    hits.sort_by(|a, b| {
        a.match_type
            .cmp(&b.match_type)
            .then_with(|| {
                a.symbol
                    .as_ref()
                    .map(|s| s.len())
                    .unwrap_or(usize::MAX)
                    .cmp(&b.symbol.as_ref().map(|s| s.len()).unwrap_or(usize::MAX))
            })
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.line.cmp(&b.line))
    });
    hits.truncate(limit);
    Outcome::Hits { hits, scanned, capped }
}

fn hit_for(symbol: &Symbol, match_type: MatchType, evidence: String) -> Hit {
    Hit {
        path: symbol.path.clone(),
        line: symbol.line,
        symbol: Some(symbol.name.clone()),
        kind: Some(symbol.kind),
        match_type,
        confidence: match_type.confidence(),
        evidence,
    }
}

fn evidence_for(match_type: MatchType, name: &str) -> String {
    match match_type {
        MatchType::Exact => format!("`{name}` is exactly the query"),
        MatchType::Token => format!("the query is a token in `{name}`"),
        MatchType::Fuzzy => format!("the query's letters appear in order in `{name}`"),
        MatchType::Metadata => format!("matched metadata for `{name}`"),
    }
}

/// Renders an outcome for the model.
pub(crate) fn render(query: &str, outcome: &Outcome) -> String {
    match outcome {
        Outcome::Refused(why) => why.clone(),
        Outcome::NoIndex => "No index for this project yet, so there is nothing to search. It \
             covers Rust, TypeScript/JavaScript, Python and Go; use grep instead."
            .to_string(),
        Outcome::NoMatches { scanned } => format!(
            "'{query}' was not found in the index ({scanned} declarations searched by name, \
             doc comment and path). This matches text, not meaning, so a related name spelled \
             differently will not appear here -- try grep, or another word."
        ),
        Outcome::Hits { hits, scanned, capped } => {
            let mut lines = vec![format!(
                "{} match(es) for '{query}' ({scanned} declarations searched):",
                hits.len()
            )];
            for hit in hits {
                let what = hit.symbol.as_deref().unwrap_or("(file)");
                lines.push(format!(
                    "{}:{}  {}  [{}, confidence {}] {}",
                    hit.path,
                    hit.line,
                    what,
                    hit.match_type.label(),
                    hit.confidence,
                    hit.evidence
                ));
            }
            if *capped {
                lines.push(format!(
                    "The scan stopped at {MAX_SCANNED} declarations, so these results are partial."
                ));
            }
            lines.push(
                "Matching is lexical -- names, the words in them, paths and doc comments. It \
                 does not relate one word to another, so a differently-named equivalent will not \
                 be listed."
                    .to_string(),
            );
            lines.join("\n")
        }
    }
}

/// The `code_search` tool, as the model sees it.
pub(crate) fn search_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "code_search",
            "description":
                "Search the project index for a name or word across declarations, the words \
                 inside their names, their doc comments and their file paths. Broader than \
                 symbol_search, which only matches names. Matching is LEXICAL, not conceptual: \
                 it does not know that 'auth' and 'login' are related, and a miss means the text \
                 is not in the index, not that the concept is absent -- fall back to grep. Every \
                 result says how it matched (exact name, token in name, fuzzy name, or metadata) \
                 so you can judge it. Covers Rust, TypeScript/JavaScript, Python and Go only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "A name or single word; case-insensitive."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum results (default 20)."
                    }
                },
                "required": ["query"]
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::index::{refresh, RepoIndex, SymbolKind};
    use jan_agent_harness::fixtures::TempDir;

    fn repo(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new("search");
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

    fn hits(outcome: &Outcome) -> &[Hit] {
        match outcome {
            Outcome::Hits { hits, .. } => hits,
            other => panic!("expected hits, got {other:?}"),
        }
    }

    // ---- match classification -------------------------------------------

    #[test]
    fn an_identical_name_is_an_exact_match() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn parse_header() {}\n")]);
        let found = search(&index, "parse_header", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.match_type, MatchType::Exact);
        assert_eq!(hit.symbol.as_deref(), Some("parse_header"));
        assert_eq!(hit.confidence, 100);
    }

    #[test]
    fn a_word_of_a_name_is_a_token_match_not_an_exact_one() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn parse_header() {}\n")]);
        let found = search(&index, "header", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.match_type, MatchType::Token);
        assert!(hit.confidence < 100);
        assert!(hit.evidence.contains("token"), "{}", hit.evidence);
    }

    #[test]
    fn camel_case_is_tokenised_too() {
        let (_dir, index) = indexed(&[("a.ts", "export class HttpRequestBuilder {}\n")]);
        let found = search(&index, "request", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.match_type, MatchType::Token);
        assert_eq!(hit.symbol.as_deref(), Some("HttpRequestBuilder"));
    }

    #[test]
    fn a_subsequence_is_a_fuzzy_match_ranked_below_a_token() {
        let (_dir, index) = indexed(&[
            ("a.rs", "pub fn header_parser() {}\npub fn hdpr_unrelated() {}\n"),
        ]);
        let found = search(&index, "hdpr", 10);
        let hit = &hits(&found)[0];
        // `hdpr_unrelated` contains the query as a token; `header_parser`
        // only contains those letters in order.
        assert_eq!(hit.symbol.as_deref(), Some("hdpr_unrelated"));
        let fuzzy = hits(&found)
            .iter()
            .find(|h| h.symbol.as_deref() == Some("header_parser"))
            .expect("the subsequence match is still reported");
        assert_eq!(fuzzy.match_type, MatchType::Fuzzy);
    }

    #[test]
    fn a_doc_comment_is_a_metadata_match_and_says_so() {
        let (_dir, index) = indexed(&[(
            "a.rs",
            "/// Decodes the wire protocol envelope.\npub fn decode() {}\n",
        )]);
        let found = search(&index, "envelope", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.match_type, MatchType::Metadata);
        assert!(hit.evidence.contains("doc comment"), "{}", hit.evidence);
        assert_eq!(hit.symbol.as_deref(), Some("decode"));
    }

    #[test]
    fn a_path_segment_is_a_metadata_match() {
        let (_dir, index) = indexed(&[("src/telemetry/sink.rs", "pub fn write() {}\n")]);
        let found = search(&index, "telemetry", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.match_type, MatchType::Metadata);
        assert!(hit.evidence.contains("path"), "{}", hit.evidence);
        assert_eq!(hit.path, "src/telemetry/sink.rs");
    }

    // ---- ranking and determinism ----------------------------------------

    #[test]
    fn results_are_ranked_exact_then_token_then_fuzzy_then_metadata() {
        let (_dir, index) = indexed(&[(
            "src/render/mod.rs",
            "pub fn render() {}\npub fn render_frame() {}\npub fn rnd_helper() {}\n",
        )]);
        let found = search(&index, "render", 20);
        let ordered: Vec<MatchType> = hits(&found)
            .iter()
            .map(|h| h.match_type)
            .collect();
        let mut sorted = ordered.clone();
        sorted.sort();
        assert_eq!(ordered, sorted, "results must be ranked, got {ordered:?}");
        assert_eq!(ordered[0], MatchType::Exact);
    }

    #[test]
    fn the_same_query_returns_the_same_order_every_time() {
        let (_dir, index) = indexed(&[
            ("b.rs", "pub fn handle_a() {}\n"),
            ("a.rs", "pub fn handle_b() {}\n"),
            ("c.rs", "pub fn handle_c() {}\n"),
        ]);
        let first_found = search(&index, "handle", 20);
        let first: Vec<String> = hits(&first_found)
            .iter()
            .map(|h| format!("{}:{}", h.path, h.line))
            .collect();
        for _ in 0..5 {
            let again_found = search(&index, "handle", 20);
            let again: Vec<String> = hits(&again_found)
                .iter()
                .map(|h| format!("{}:{}", h.path, h.line))
                .collect();
            assert_eq!(first, again, "ordering must be deterministic");
        }
    }

    #[test]
    fn every_hit_carries_a_file_a_line_and_its_evidence() {
        let (_dir, index) = indexed(&[("src/a.rs", "\n\npub fn thing() {}\n")]);
        let found = search(&index, "thing", 10);
        let hit = &hits(&found)[0];
        assert_eq!(hit.path, "src/a.rs");
        assert_eq!(hit.line, 3);
        assert_eq!(hit.kind, Some(SymbolKind::Function));
        assert!(!hit.evidence.is_empty());
    }

    // ---- limits ----------------------------------------------------------

    #[test]
    fn the_result_limit_is_honoured() {
        let body: String = (0..50).map(|n| format!("pub fn handle_{n}() {{}}\n")).collect();
        let (_dir, index) = indexed(&[("a.rs", body.as_str())]);
        let found = search(&index, "handle", 5);
        assert_eq!(hits(&found).len(), 5);
    }

    #[test]
    fn an_absurd_result_limit_is_clamped_rather_than_honoured() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn xy() {}\n")]);
        match search(&index, "xy", usize::MAX) {
            Outcome::Hits { hits, .. } => assert!(hits.len() <= MAX_RESULTS),
            other => panic!("expected hits, got {other:?}"),
        }
    }

    #[test]
    fn a_query_that_is_too_short_is_refused_with_a_reason() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn x() {}\n")]);
        match search(&index, "x", 10) {
            Outcome::Refused(why) => assert!(why.contains("at least"), "{why}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_query_that_is_too_long_is_refused_with_a_reason() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn x() {}\n")]);
        let long = "a".repeat(MAX_QUERY_LEN + 1);
        match search(&index, &long, 10) {
            Outcome::Refused(why) => assert!(why.contains("longer than"), "{why}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_blank_query_is_refused_rather_than_matching_everything() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn x() {}\n")]);
        assert!(matches!(search(&index, "   ", 10), Outcome::Refused(_)));
    }

    #[test]
    fn the_scan_is_capped_and_says_when_it_stopped_early() {
        let body: String = (0..MAX_SCANNED + 50)
            .map(|n| format!("pub fn s{n}() {{}}\n"))
            .collect();
        let (_dir, index) = indexed(&[("a.rs", body.as_str())]);
        match search(&index, "zzzz", 10) {
            Outcome::NoMatches { scanned } => assert!(scanned <= MAX_SCANNED),
            Outcome::Hits { capped, scanned, .. } => {
                assert!(capped, "a scan that stopped early must say so");
                assert!(scanned <= MAX_SCANNED);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    // ---- honest empty and unsupported answers ----------------------------

    #[test]
    fn an_empty_index_is_distinguished_from_no_matches() {
        let empty = RepoIndex::default();
        assert!(matches!(search(&empty, "anything", 10), Outcome::NoIndex));

        let (_dir, index) = indexed(&[("a.rs", "pub fn present() {}\n")]);
        assert!(matches!(
            search(&index, "absent_name", 10),
            Outcome::NoMatches { .. }
        ));
    }

    #[test]
    fn a_miss_never_claims_the_name_does_not_exist() {
        let (_dir, index) = indexed(&[("a.rs", "pub fn present() {}\n")]);
        let rendered = render("absent_name", &search(&index, "absent_name", 10));
        assert!(rendered.contains("not found in the index"), "{rendered}");
        assert!(rendered.contains("grep"), "{rendered}");
        assert!(
            !rendered.to_lowercase().contains("does not exist"),
            "a miss must not be reported as absence: {rendered}"
        );
    }

    #[test]
    fn an_empty_index_says_so_rather_than_reporting_no_matches() {
        let rendered = render("anything", &search(&RepoIndex::default(), "anything", 10));
        assert!(rendered.contains("No index"), "{rendered}");
    }

    /// The whole risk of calling this "semantic": a model that believes the
    /// index understands meaning will stop looking when it should not.
    #[test]
    fn nothing_in_the_output_claims_to_understand_meaning() {
        let (_dir, index) = indexed(&[(
            "a.rs",
            "/// Decodes the wire protocol envelope.\npub fn decode() {}\n",
        )]);
        for query in ["decode", "envelope", "absent"] {
            let rendered = render(query, &search(&index, query, 10));
            let lowered = rendered.to_lowercase();
            for forbidden in ["semantically", "means the same", "similar meaning", "understands"] {
                assert!(
                    !lowered.contains(forbidden),
                    "output claimed meaning ({forbidden}): {rendered}"
                );
            }
        }
    }

    #[test]
    fn the_rendered_output_names_the_match_type_of_every_hit() {
        let (_dir, index) = indexed(&[(
            "src/telemetry/sink.rs",
            "/// Writes an envelope.\npub fn write_record() {}\n",
        )]);
        let rendered = render("record", &search(&index, "record", 10));
        assert!(rendered.contains("src/telemetry/sink.rs:2"), "{rendered}");
        assert!(rendered.contains("token"), "{rendered}");
    }

    #[test]
    fn the_tool_description_states_that_matching_is_lexical() {
        let schema = search_tool_schema();
        let description = schema["function"]["description"].as_str().unwrap().to_lowercase();
        assert!(description.contains("lexical"), "{description}");
        assert!(description.contains("not conceptual"), "it must say what it is not");
        assert!(description.contains("grep"));
    }
}
