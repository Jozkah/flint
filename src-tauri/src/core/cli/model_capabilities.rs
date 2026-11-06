//! Pure per-model context-window resolution for the CLI.
//!
//! The effective context window comes from the selected model unless the
//! project explicitly configures one. This module resolves that without any
//! provider metadata request: a small fixed catalog of known model families
//! covers the models Flint ships, and everything else falls back to a
//! conservative default. The resolved value drives the header gauge and
//! proactive compaction, and is deliberately never sent up as a generation
//! parameter.

pub(crate) const FALLBACK_CONTEXT_WINDOW: u64 = 128_000;

/// Where a resolved context window came from. `Configured` is authoritative:
/// `[agent].context_window` wins outright. `Catalog` is the built-in model
/// family table. `Fallback` is the conservative default for an unknown model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContextWindowSource {
    Configured,
    Catalog,
    Fallback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedContextWindow {
    pub(crate) tokens: u64,
    pub(crate) source: ContextWindowSource,
}

impl ContextWindowSource {
    /// Short label shown in the header: `ctx N/K <configured|catalog|fallback>`.
    pub(crate) fn label(self) -> &'static str {
        match self {
            ContextWindowSource::Configured => "configured",
            ContextWindowSource::Catalog => "catalog",
            ContextWindowSource::Fallback => "fallback",
        }
    }
}

/// Strip exactly one configured provider qualifier (`anthropic/...`) when the
/// first segment is one of Flint's catalog providers. A user-provided model id is
/// normally the bare id, but `--model anthropic/claude-sonnet-4-6` and the
/// desktop selection can carry the provider prefix; both must resolve alike.
fn strip_provider_qualifier(model_id: &str) -> &str {
    let mut id = model_id;
    // Repeat so nested qualifiers (`jan/anthropic/...`) reduce to the bare id.
    loop {
        let mut parts = id.splitn(2, '/');
        let first = parts.next().unwrap_or("");
        match (first, parts.next()) {
            ("anthropic" | "openai" | "google" | "tokamak" | "jan", Some(rest)) => id = rest,
            _ => return id,
        }
    }
}

/// `id` is `base` itself or `base` followed by a `-` suffix (a date, `-mini`,
/// `-pro`). Plain `starts_with` would also match `gpt-5.10` for `gpt-5.1`.
fn is_version(id: &str, base: &str) -> bool {
    id.strip_prefix(base)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

/// Look up the catalog window for a bare model id (provider qualifier already
/// stripped). `None` means the id matches no known family -> fallback.
fn catalog_window(model_id: &str) -> Option<u64> {
    // Claude family: the two newest releases get 1M, everything else claude 200K.
    if model_id.starts_with("claude-") {
        // Dotted ids (`claude-sonnet-4.6`) name the same models as `4-6`.
        let model_id = model_id.replace('.', "-");
        let is_new = ["haiku", "sonnet", "opus"].iter().any(|family| {
            is_version(&model_id, &format!("claude-{family}-4-6"))
                || is_version(&model_id, &format!("claude-{family}-4-7"))
        });
        return Some(if is_new { 1_000_000 } else { 200_000 });
    }

    // Codex variants are matched before the base gpt-5.x rows they contain.
    if ["gpt-5.1-codex", "gpt-5.2-codex", "gpt-5.3-codex"]
        .iter()
        .any(|b| is_version(model_id, b))
    {
        return Some(272_000);
    }
    if ["gpt-5.1", "gpt-5.2", "gpt-5.3"].iter().any(|b| is_version(model_id, b)) {
        return Some(400_000);
    }
    if ["gpt-5.4", "gpt-5.5"].iter().any(|b| is_version(model_id, b)) {
        return Some(1_050_000);
    }
    // gpt-5 and its mini/nano variants, and the o-series reasoning models,
    // would otherwise fall to the 128K default (F2b-007).
    if ["gpt-5", "gpt-5-mini", "gpt-5-nano"].iter().any(|b| is_version(model_id, b)) {
        return Some(400_000);
    }
    if ["o1", "o3", "o4-mini"].iter().any(|b| is_version(model_id, b)) {
        return Some(200_000);
    }
    if is_version(model_id, "gpt-4.1") {
        return Some(1_047_576);
    }
    // Bare `gpt-4` stays exact: dated gpt-4 snapshots have a much smaller window.
    if model_id == "gpt-4" || is_version(model_id, "gpt-4o") {
        return Some(128_000);
    }

    if model_id.starts_with("gemini-2.5-") || model_id.starts_with("gemini-3-") {
        return Some(1_000_000);
    }
    if model_id.starts_with("tokamak-") {
        return Some(200_000);
    }

    None
}

/// Smallest window treated as real (matches the desktop's `plausibleWindow`).
const MIN_PLAUSIBLE_CONTEXT_WINDOW: u64 = 128;

/// Resolve the effective context window for `model_id`. `configured` (from
/// `[agent].context_window`) is authoritative when set; otherwise the built-in
/// catalog is consulted; an unknown model gets the conservative fallback.
pub(crate) fn resolve_context_window(
    model_id: &str,
    configured: Option<u64>,
) -> ResolvedContextWindow {
    // A window under 128 tokens is a config slip or a bad server report, not a
    // real limit: the desktop treats it as unknown, so does the CLI.
    if let Some(tokens) = configured.filter(|t| *t >= MIN_PLAUSIBLE_CONTEXT_WINDOW) {
        return ResolvedContextWindow {
            tokens,
            source: ContextWindowSource::Configured,
        };
    }
    let bare = strip_provider_qualifier(model_id);
    match catalog_window(bare) {
        Some(tokens) => ResolvedContextWindow {
            tokens,
            source: ContextWindowSource::Catalog,
        },
        None => ResolvedContextWindow {
            tokens: FALLBACK_CONTEXT_WINDOW,
            source: ContextWindowSource::Fallback,
        },
    }
}

/// True when `model_id` is a known family that accepts image input. Unknown
/// models answer false: an image they cannot read is worse than a text note.
pub(crate) fn accepts_images(model_id: &str) -> bool {
    let id = strip_provider_qualifier(model_id);
    id.starts_with("claude-")
        || id.starts_with("gemini-")
        || ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5", "o3", "o4-mini"]
            .iter()
            .any(|b| is_version(id, b))
}

#[cfg(test)]
mod tests {
    #[test]
    fn accepts_images_is_conservative() {
        assert!(super::accepts_images("anthropic/claude-sonnet-4-6"));
        assert!(super::accepts_images("gpt-4o-mini"));
        assert!(!super::accepts_images("qwen3-4b"));
    }

    use super::*;

    #[test]
    fn implausibly_small_configured_window_is_ignored() {
        let r = resolve_context_window("gpt-4o", Some(7));
        assert_ne!(r.tokens, 7);
        assert!(!matches!(r.source, ContextWindowSource::Configured));
        assert_eq!(resolve_context_window("gpt-4o", Some(128)).tokens, 128);
    }

    #[test]
    fn configured_window_overrides_every_catalog_entry() {
        let resolved = resolve_context_window("claude-sonnet-4-6", Some(333_000));
        assert_eq!(resolved.tokens, 333_000);
        assert_eq!(resolved.source, ContextWindowSource::Configured);
    }

    #[test]
    fn catalog_resolves_supported_model_families() {
        assert_eq!(
            resolve_context_window("claude-sonnet-4-5", None).tokens,
            200_000
        );
        assert_eq!(
            resolve_context_window("claude-sonnet-4-6", None).tokens,
            1_000_000
        );
        assert_eq!(resolve_context_window("gpt-5", None).tokens, 400_000);
        assert_eq!(resolve_context_window("gpt-5-mini", None).tokens, 400_000);
        assert_eq!(resolve_context_window("o3", None).tokens, 200_000);
        assert_eq!(resolve_context_window("o4-mini-2025-04-16", None).tokens, 200_000);
        assert_eq!(resolve_context_window("o3x", None).source, ContextWindowSource::Fallback);
        assert_eq!(resolve_context_window("gpt-5.2", None).tokens, 400_000);
        assert_eq!(resolve_context_window("gpt-5.3", None).tokens, 400_000);
        assert_eq!(resolve_context_window("gpt-5.3-2026-02-01", None).tokens, 400_000);
        assert_eq!(
            resolve_context_window("gpt-5.2-codex", None).tokens,
            272_000
        );
        assert_eq!(
            resolve_context_window("gemini-3-pro", None).tokens,
            1_000_000
        );
    }

    #[test]
    fn dated_suffixed_dotted_and_nested_ids_resolve() {
        assert_eq!(resolve_context_window("gpt-4o-2024-08-06", None).tokens, 128_000);
        assert_eq!(resolve_context_window("gpt-5.2-pro", None).tokens, 400_000);
        assert_eq!(resolve_context_window("gpt-5.1-codex-max", None).tokens, 272_000);
        assert_eq!(resolve_context_window("gpt-4.1-mini", None).tokens, 1_047_576);
        assert_eq!(resolve_context_window("gpt-4.1-2025-04-14", None).tokens, 1_047_576);
        assert_eq!(
            resolve_context_window("claude-sonnet-4.6", None).tokens,
            1_000_000
        );
        assert_eq!(
            resolve_context_window("jan/anthropic/claude-opus-4-7-20260101", None).tokens,
            1_000_000
        );
    }

    #[test]
    fn version_boundary_prevents_false_prefix_matches() {
        assert_eq!(resolve_context_window("gpt-5.10", None).source, ContextWindowSource::Fallback);
        assert_eq!(resolve_context_window("gpt-4-0613", None).source, ContextWindowSource::Fallback);
        assert_eq!(
            resolve_context_window("claude-sonnet-4-60", None).tokens,
            200_000
        );
    }

    #[test]
    fn provider_qualifier_does_not_change_resolution() {
        assert_eq!(
            resolve_context_window("anthropic/claude-sonnet-4-6", None),
            resolve_context_window("claude-sonnet-4-6", None),
        );
    }

    #[test]
    fn unknown_model_uses_conservative_fallback() {
        assert_eq!(
            resolve_context_window("private-gateway-model", None),
            ResolvedContextWindow {
                tokens: 128_000,
                source: ContextWindowSource::Fallback,
            },
        );
    }

    #[test]
    fn non_catalog_provider_qualifier_is_not_stripped() {
        // A provider Flint doesn't ship keeps its qualifier: the id must still
        // fall through to the conservative default rather than mis-matching.
        assert_eq!(
            resolve_context_window("azure/claude-sonnet-4-6", None).source,
            ContextWindowSource::Fallback,
        );
    }
}
