//! Proactive compaction policy: the four mechanisms that decide *whether* and
//! *how much* to compact, kept separate from the reactive overflow path in
//! [`super::compaction`]. Each mechanism is a pure function or a small state
//! machine so it is testable without a model or a live conversation:
//!
//! 1. [`thresholds`] — token-threshold calculation from the model window and the
//!    reserved output budget, with a validated override and a disable switch.
//! 2. [`microcompact`] — gap-based removal of stale, bulky tool results that
//!    keeps their load-bearing content and never touches protected messages.
//! 3. [`parse_structured_summary`] / [`FULL_COMPACTION_SYSTEM_PROMPT`] — the
//!    `<analysis>`/`<summary>` response contract for a full compaction.
//! 4. [`RefillGuard`] — a circuit breaker that stops the loop compacting over and
//!    over without freeing meaningful context.
//!
//! Model limits come from the project's `[agent]` config (`context_window`,
//! `compaction_reserve_tokens`) — this module introduces no second source of
//! them. Token counts use [`estimate_tokens`], the one estimator here.

use serde_json::Value;

/// The single token estimator. A coarse chars/4 heuristic — deliberately not a
/// model tokenizer, because the decision it feeds (compact soon vs. later) does
/// not need per-token precision and a real tokenizer is neither available for
/// every remote model nor worth its cost on every turn. Whitespace-only content
/// still counts as at least one token so an empty message is never free.
pub fn estimate_tokens_str(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    chars.div_ceil(4)
}

/// Estimate the tokens a wire message will cost, counting text content, tool-call
/// names and arguments, and tool results. Non-text parts (images) are counted at
/// a flat, deliberately conservative cost rather than zero.
pub fn estimate_message_tokens(msg: &Value) -> u64 {
    let mut total: u64 = 4; // per-message role/framing overhead.
    match msg.get("content") {
        Some(Value::String(text)) => total += estimate_tokens_str(text),
        Some(Value::Array(parts)) => {
            for part in parts {
                match part.get("text").and_then(|t| t.as_str()) {
                    Some(text) => total += estimate_tokens_str(text),
                    None => total += 256, // an image or other non-text part.
                }
            }
        }
        _ => {}
    }
    for call in msg
        .get("tool_calls")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(f) = call.get("function") {
            if let Some(n) = f.get("name").and_then(|n| n.as_str()) {
                total += estimate_tokens_str(n);
            }
            if let Some(a) = f.get("arguments").and_then(|a| a.as_str()) {
                total += estimate_tokens_str(a);
            }
        }
    }
    total
}

/// Estimate the tokens a whole conversation will cost.
pub fn estimate_tokens(messages: &[Value]) -> u64 {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Headroom held below the effective window when no override is set, matching
/// the reference's `effectiveWindow - 13000`. It is the room a single further
/// turn (its request growth plus a normal response) needs so the very turn that
/// crosses the threshold does not itself overflow.
pub const DEFAULT_HEADROOM_TOKENS: u64 = 13_000;

/// An explicit override for where compaction triggers, from configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompactionOverride {
    /// Compact when usage reaches this absolute token count.
    Window(u64),
    /// Compact when usage reaches this fraction (0.0, 1.0] of the effective
    /// window — the "auto-compact percentage" form.
    Percentage(f64),
}

/// Inputs to [`thresholds`], assembled from the model window and config.
#[derive(Clone, Copy, Debug)]
pub struct WindowConfig {
    /// The model's full context window in tokens.
    pub context_window: u64,
    /// Tokens reserved for the model's output (the response budget). Subtracted
    /// from the window to get the input budget compaction measures against.
    pub reserved_output_tokens: u64,
    /// Headroom below the effective window; defaults to [`DEFAULT_HEADROOM_TOKENS`].
    pub headroom: u64,
    /// A configured override for the trigger point, if any.
    pub override_trigger: Option<CompactionOverride>,
    /// When true, compaction is turned off entirely: [`thresholds`] returns
    /// `Ok(None)` and nothing else here should run.
    pub disabled: bool,
}

impl WindowConfig {
    /// Build from the project config values, applying the same defaults the
    /// config documents (128K window, 16K reserve) when a value is absent.
    pub fn from_config(context_window: Option<u64>, reserved_output: Option<u64>) -> Self {
        Self {
            context_window: context_window.unwrap_or(128_000),
            reserved_output_tokens: reserved_output.unwrap_or(16_384),
            headroom: DEFAULT_HEADROOM_TOKENS,
            override_trigger: None,
            disabled: false,
        }
    }

    pub fn with_override(mut self, override_trigger: Option<CompactionOverride>) -> Self {
        self.override_trigger = override_trigger;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// The computed trigger points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Thresholds {
    /// `context_window - reserved_output_tokens`: the input budget.
    pub effective_window: u64,
    /// Compact once estimated usage reaches this.
    pub compact_at: u64,
}

/// Compute the compaction thresholds, or `Ok(None)` when compaction is disabled.
///
/// Returns `Err` for a configuration that cannot produce a safe threshold — a
/// zero (or output-swallowed) window, or an out-of-range percentage — so the
/// caller reports the misconfiguration instead of silently compacting at 0 (which
/// would compact every turn) or never. A `Window` override that lands above the
/// effective window is clamped down to it rather than rejected: asking to compact
/// "late" is safe, asking to compact past the point the request fits is not.
pub fn thresholds(cfg: &WindowConfig) -> Result<Option<Thresholds>, String> {
    if cfg.disabled {
        return Ok(None);
    }
    let effective = cfg
        .context_window
        .checked_sub(cfg.reserved_output_tokens)
        .filter(|&e| e > 0)
        .ok_or_else(|| {
            format!(
                "reserved_output_tokens ({}) leaves no room in the {}-token context window",
                cfg.reserved_output_tokens, cfg.context_window
            )
        })?;

    let compact_at = match cfg.override_trigger {
        None => effective.saturating_sub(cfg.headroom).max(1),
        Some(CompactionOverride::Window(w)) => {
            if w == 0 {
                return Err("compaction window override must be greater than 0".to_string());
            }
            w.min(effective)
        }
        Some(CompactionOverride::Percentage(p)) => {
            if !(p.is_finite() && p > 0.0 && p <= 1.0) {
                return Err(format!(
                    "compaction percentage override must be in (0.0, 1.0], got {p}"
                ));
            }
            (((effective as f64) * p).floor() as u64).clamp(1, effective)
        }
    };

    Ok(Some(Thresholds {
        effective_window: effective,
        compact_at,
    }))
}

/// Whether estimated usage has reached the compaction trigger.
pub fn should_compact(messages: &[Value], t: &Thresholds) -> bool {
    estimate_tokens(messages) >= t.compact_at
}

// ---------------------------------------------------------------------------
// Microcompaction: prune stale, bulky tool results in place.
// ---------------------------------------------------------------------------

/// Tuning for [`microcompact`].
#[derive(Clone, Copy, Debug)]
pub struct MicrocompactConfig {
    /// Tool results this size (in estimated tokens) or larger are candidates.
    /// Smaller results are cheap enough to leave whole.
    pub bulky_result_tokens: u64,
    /// The most recent tool results are never pruned — they are the state the
    /// run is actively using. This many, counted from the end, are protected.
    pub protect_recent_results: usize,
    /// How much of a pruned result's head to keep verbatim (chars), before the
    /// retained salient lines. Bounds the condensed size.
    pub keep_head_chars: usize,
}

impl Default for MicrocompactConfig {
    fn default() -> Self {
        Self {
            bulky_result_tokens: 512,
            protect_recent_results: 4,
            keep_head_chars: 400,
        }
    }
}

/// What a microcompaction pass did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MicrocompactStats {
    /// Number of tool results condensed.
    pub condensed: usize,
    /// Estimated tokens removed (before minus after).
    pub tokens_removed: u64,
}

/// Condense stale, bulky tool results in place, returning the rewritten
/// conversation and what changed.
///
/// Only `tool` messages are ever touched. A condensed result keeps its identity
/// (`tool_call_id`), a head of its output, and every salient line — errors, file
/// paths, shell commands, and explicit result/exit markers — so a later message
/// that refers back to "the error" or "that path" still finds it. User messages,
/// assistant messages (including their tool-call requests and any unresolved
/// approval prompts), and the most recent results are left exactly as they were:
/// this never removes a message, only shrinks the body of an old bulky result.
pub fn microcompact(messages: &[Value], cfg: &MicrocompactConfig) -> (Vec<Value>, MicrocompactStats) {
    // Index of the tool results protected as "recent", counted from the end.
    let mut result_positions: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| role(m) == "tool")
        .map(|(i, _)| i)
        .collect();
    let protected_from = result_positions
        .len()
        .saturating_sub(cfg.protect_recent_results);
    let protected: std::collections::HashSet<usize> =
        result_positions.split_off(protected_from).into_iter().collect();

    let before = estimate_tokens(messages);
    let mut out = Vec::with_capacity(messages.len());
    let mut condensed = 0usize;
    for (i, msg) in messages.iter().enumerate() {
        if role(msg) == "tool"
            && !protected.contains(&i)
            && estimate_message_tokens(msg) >= cfg.bulky_result_tokens
        {
            if let Some(new_msg) = condense_tool_result(msg, cfg.keep_head_chars) {
                out.push(new_msg);
                condensed += 1;
                continue;
            }
        }
        out.push(msg.clone());
    }
    let after = estimate_tokens(&out);
    (
        out,
        MicrocompactStats {
            condensed,
            tokens_removed: before.saturating_sub(after),
        },
    )
}

/// Build a condensed copy of one tool-result message, or `None` when its content
/// is not a plain string this can safely shrink.
fn condense_tool_result(msg: &Value, keep_head_chars: usize) -> Option<Value> {
    let content = msg.get("content")?.as_str()?;
    let salient = salient_lines(content);
    let head: String = content.chars().take(keep_head_chars).collect();
    let mut condensed = head;
    if content.chars().count() > keep_head_chars {
        condensed.push_str("\n[... tool output condensed to save context ...]");
    }
    if !salient.is_empty() {
        condensed.push_str("\n[kept lines]\n");
        condensed.push_str(&salient.join("\n"));
    }
    // Preserve everything else about the message (role, tool_call_id, name).
    let mut new_msg = msg.clone();
    new_msg["content"] = Value::String(condensed);
    Some(new_msg)
}

/// Lines worth keeping from a bulky tool result: errors, file paths, shell
/// commands, and explicit exit/result markers. Deduplicated, capped so a
/// pathological result cannot re-inflate the message it was meant to shrink.
fn salient_lines(content: &str) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let lower = l.to_ascii_lowercase();
        let is_error = lower.contains("error")
            || lower.contains("failed")
            || lower.contains("panic")
            || lower.contains("exception")
            || l.starts_with("[exit ")
            || lower.contains("traceback");
        let looks_like_path = l.contains('/') || l.contains('\\');
        let looks_like_command = l.starts_with('$') || l.starts_with("> ");
        if (is_error || looks_like_path || looks_like_command) && !kept.contains(&l.to_string()) {
            kept.push(l.to_string());
        }
        if kept.len() >= 40 {
            break;
        }
    }
    kept
}

// ---------------------------------------------------------------------------
// Full-compaction response contract: <analysis> then <summary>.
// ---------------------------------------------------------------------------

/// System prompt for a full compaction. Tools MUST be disabled on this request
/// (see [`reject_tool_calls`]); the model is asked for text only, structured as
/// an `<analysis>` block followed by a `<summary>` block whose summary preserves
/// the nine facets a continuation needs.
pub const FULL_COMPACTION_SYSTEM_PROMPT: &str = "\
You are compacting an AI agent conversation so work can continue in a fresh context. \
Do not call any tools. Respond with exactly two blocks and nothing else:\n\
<analysis>your reasoning about what matters in this conversation</analysis>\n\
<summary>the durable brief</summary>\n\
The <summary> MUST preserve, in this order: 1) the primary request and intent; \
2) key technical concepts; 3) files and code sections, with important signatures or \
snippets; 4) errors encountered and how they were fixed; 5) the problem-solving history; \
6) every user message that was not a tool result, verbatim or closely paraphrased; \
7) pending tasks; 8) work completed or in progress; 9) the continuation context or a \
tightly scoped next step. Omit pleasantries and redundant tool output.";

/// A validated full-compaction response.
#[derive(Clone, Debug, PartialEq)]
pub struct StructuredSummary {
    pub analysis: String,
    pub summary: String,
}

/// Parse and validate the `<analysis>`/`<summary>` contract. The analysis must
/// precede the summary, both must be present, and the summary must be non-empty.
/// A malformed response is an `Err` the caller falls back from safely rather than
/// splicing a broken summary into the conversation.
pub fn parse_structured_summary(text: &str) -> Result<StructuredSummary, String> {
    let analysis = extract_block(text, "analysis")
        .ok_or_else(|| "compaction response missing <analysis> block".to_string())?;
    let summary = extract_block(text, "summary")
        .ok_or_else(|| "compaction response missing <summary> block".to_string())?;
    let a_start = text.find("<analysis>").unwrap();
    let s_start = text.find("<summary>").unwrap();
    if a_start > s_start {
        return Err("<analysis> must precede <summary>".to_string());
    }
    if summary.trim().is_empty() {
        return Err("compaction <summary> is empty".to_string());
    }
    Ok(StructuredSummary {
        analysis: analysis.trim().to_string(),
        summary: summary.trim().to_string(),
    })
}

fn extract_block(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].to_string())
}

/// Whether a compaction completion improperly tried to call a tool. Full
/// compaction runs with tools disabled, so any tool call in the response is a
/// contract violation the caller must reject (and fall back).
pub fn reject_tool_calls(completion_message: &Value) -> Result<(), String> {
    let has_calls = completion_message
        .get("tool_calls")
        .and_then(|c| c.as_array())
        .is_some_and(|c| !c.is_empty());
    if has_calls {
        Err("compaction response attempted a tool call; tools are disabled here".to_string())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Rapid-refill circuit breaker.
// ---------------------------------------------------------------------------

/// Limits governing [`RefillGuard`].
#[derive(Clone, Copy, Debug)]
pub struct RefillLimits {
    /// Open the breaker after this many consecutive failed compactions.
    pub max_consecutive_failures: u32,
    /// Open the breaker after this many consecutive "rapid refills" — a
    /// successful compaction followed almost immediately by crossing the
    /// threshold again.
    pub max_rapid_refills: u32,
    /// A compaction must free at least this many tokens to count as meaningful;
    /// below it, the pass is treated as not worth repeating.
    pub min_tokens_freed: u64,
    /// Crossing the threshold again within this many turns of a successful
    /// compaction counts as a rapid refill.
    pub rapid_refill_within_turns: u32,
}

impl Default for RefillLimits {
    fn default() -> Self {
        Self {
            max_consecutive_failures: 3,
            max_rapid_refills: 3,
            min_tokens_freed: 1_000,
            rapid_refill_within_turns: 1,
        }
    }
}

/// The breaker's decision for one compaction opportunity.
#[derive(Clone, Debug, PartialEq)]
pub enum CompactionDecision {
    /// Compaction may proceed.
    Proceed,
    /// Compaction is blocked; the string is a structured, log-safe reason.
    Blocked(String),
}

/// Tracks compaction history within a run to stop a loop that compacts, refills
/// immediately, and compacts again without ever freeing meaningful context.
#[derive(Clone, Debug)]
pub struct RefillGuard {
    limits: RefillLimits,
    consecutive_failures: u32,
    consecutive_rapid_refills: u32,
    compacted_this_chain: bool,
    turns_since_last_compaction: u32,
    open: bool,
}

impl RefillGuard {
    pub fn new(limits: RefillLimits) -> Self {
        Self {
            limits,
            consecutive_failures: 0,
            consecutive_rapid_refills: 0,
            compacted_this_chain: false,
            turns_since_last_compaction: u32::MAX,
            open: false,
        }
    }

    /// Whether the breaker has opened.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Decide whether a compaction may run now. Once the breaker is open it stays
    /// open for the rest of the run: repeatedly compacting a conversation that
    /// refills instantly makes no progress and burns tokens.
    pub fn decide(&self) -> CompactionDecision {
        if self.open {
            return CompactionDecision::Blocked(format!(
                "compaction circuit breaker open (failures={}, rapid_refills={})",
                self.consecutive_failures, self.consecutive_rapid_refills
            ));
        }
        CompactionDecision::Proceed
    }

    /// Record that a turn advanced without compaction (used to measure refills).
    pub fn on_turn(&mut self) {
        self.turns_since_last_compaction = self.turns_since_last_compaction.saturating_add(1);
    }

    /// Record a compaction that failed (error or produced no smaller result).
    pub fn record_failure(&mut self) {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= self.limits.max_consecutive_failures {
            self.open = true;
        }
    }

    /// Record a compaction that succeeded, freeing `tokens_freed`. A success that
    /// freed less than the minimum, or that is immediately followed by another
    /// threshold crossing (a rapid refill), advances the refill counter; a
    /// genuinely effective compaction resets the counters.
    pub fn record_success(&mut self, tokens_freed: u64) {
        self.consecutive_failures = 0;
        let rapid = self.compacted_this_chain
            && self.turns_since_last_compaction <= self.limits.rapid_refill_within_turns;
        let ineffective = tokens_freed < self.limits.min_tokens_freed;
        if rapid || ineffective {
            self.consecutive_rapid_refills += 1;
            if self.consecutive_rapid_refills >= self.limits.max_rapid_refills {
                self.open = true;
            }
        } else {
            self.consecutive_rapid_refills = 0;
        }
        self.compacted_this_chain = true;
        self.turns_since_last_compaction = 0;
    }
}

fn role(msg: &Value) -> &str {
    msg.get("role").and_then(|r| r.as_str()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- thresholds ---

    #[test]
    fn threshold_is_effective_window_minus_headroom() {
        let cfg = WindowConfig::from_config(Some(128_000), Some(16_000));
        let t = thresholds(&cfg).unwrap().unwrap();
        assert_eq!(t.effective_window, 112_000);
        assert_eq!(t.compact_at, 112_000 - DEFAULT_HEADROOM_TOKENS);
    }

    #[test]
    fn threshold_disabled_returns_none() {
        let cfg = WindowConfig::from_config(Some(8_000), Some(1_000)).disabled(true);
        assert_eq!(thresholds(&cfg).unwrap(), None);
    }

    #[test]
    fn threshold_rejects_a_window_swallowed_by_output_reserve() {
        let cfg = WindowConfig::from_config(Some(4_000), Some(4_000));
        assert!(thresholds(&cfg).is_err());
        let cfg = WindowConfig::from_config(Some(1_000), Some(4_000));
        assert!(thresholds(&cfg).is_err());
    }

    #[test]
    fn threshold_window_override_is_clamped_not_rejected_when_high() {
        let cfg = WindowConfig::from_config(Some(20_000), Some(4_000))
            .with_override(Some(CompactionOverride::Window(999_999)));
        let t = thresholds(&cfg).unwrap().unwrap();
        assert_eq!(t.compact_at, t.effective_window, "clamped to effective window");

        let cfg = cfg.with_override(Some(CompactionOverride::Window(0)));
        assert!(thresholds(&cfg).is_err(), "a zero window override is rejected");
    }

    #[test]
    fn threshold_percentage_override_and_bounds() {
        let cfg = WindowConfig::from_config(Some(20_000), Some(4_000))
            .with_override(Some(CompactionOverride::Percentage(0.5)));
        let t = thresholds(&cfg).unwrap().unwrap();
        assert_eq!(t.effective_window, 16_000);
        assert_eq!(t.compact_at, 8_000);

        for bad in [0.0, -0.1, 1.5, f64::NAN] {
            let cfg = WindowConfig::from_config(Some(20_000), Some(4_000))
                .with_override(Some(CompactionOverride::Percentage(bad)));
            assert!(thresholds(&cfg).is_err(), "percentage {bad} must be rejected");
        }
    }

    #[test]
    fn should_compact_reflects_estimated_usage() {
        let t = Thresholds {
            effective_window: 1_000,
            compact_at: 100,
        };
        let small = vec![json!({ "role": "user", "content": "hi" })];
        assert!(!should_compact(&small, &t));
        let big = vec![json!({ "role": "user", "content": "x".repeat(1_000) })];
        assert!(should_compact(&big, &t));
    }

    // --- microcompaction ---

    fn bulky(id: &str, body: &str) -> Value {
        json!({ "role": "tool", "tool_call_id": id, "content": body })
    }

    #[test]
    fn microcompact_condenses_old_bulky_results_and_keeps_errors_and_paths() {
        let big = format!(
            "{}\nError: build failed\nsrc/main.rs\n[exit 1]",
            "noise line\n".repeat(600)
        );
        let mut msgs = vec![
            json!({ "role": "user", "content": "go" }),
            bulky("t0", &big),
        ];
        // Pad with recent protected results so t0 is not in the recent window.
        for i in 0..5 {
            msgs.push(bulky(&format!("r{i}"), "small recent result"));
        }
        let (out, stats) = microcompact(&msgs, &MicrocompactConfig::default());
        assert_eq!(stats.condensed, 1);
        assert!(stats.tokens_removed > 0);
        let condensed = out[1]["content"].as_str().unwrap();
        assert!(condensed.contains("condensed"), "marker present");
        assert!(condensed.contains("Error: build failed"), "error kept");
        assert!(condensed.contains("src/main.rs"), "path kept");
        assert!(condensed.contains("[exit 1]"), "exit marker kept");
        assert!(condensed.len() < big.len(), "result shrank");
        // Identity is preserved.
        assert_eq!(out[1]["tool_call_id"], "t0");
    }

    #[test]
    fn microcompact_never_touches_user_or_assistant_or_recent_results() {
        let big = "x".repeat(8_000);
        let msgs = vec![
            json!({ "role": "user", "content": big.clone() }),
            json!({ "role": "assistant", "content": big.clone() }),
            bulky("recent", &big),
        ];
        // Only one tool result and it is within the protected recent window.
        let (out, stats) = microcompact(&msgs, &MicrocompactConfig::default());
        assert_eq!(stats.condensed, 0, "recent result protected");
        assert_eq!(out, msgs, "nothing changed");
    }

    #[test]
    fn microcompact_leaves_small_results_alone() {
        let mut msgs = vec![json!({ "role": "user", "content": "go" })];
        for i in 0..10 {
            msgs.push(bulky(&format!("t{i}"), "tiny"));
        }
        let (_out, stats) = microcompact(&msgs, &MicrocompactConfig::default());
        assert_eq!(stats.condensed, 0);
    }

    // --- structured summary contract ---

    #[test]
    fn parses_valid_analysis_then_summary() {
        let text = "<analysis>thought about it</analysis>\n<summary>the brief</summary>";
        let s = parse_structured_summary(text).unwrap();
        assert_eq!(s.analysis, "thought about it");
        assert_eq!(s.summary, "the brief");
    }

    #[test]
    fn rejects_malformed_summaries() {
        // Missing summary.
        assert!(parse_structured_summary("<analysis>a</analysis>").is_err());
        // Missing analysis.
        assert!(parse_structured_summary("<summary>s</summary>").is_err());
        // Wrong order.
        assert!(
            parse_structured_summary("<summary>s</summary><analysis>a</analysis>").is_err()
        );
        // Empty summary.
        assert!(parse_structured_summary("<analysis>a</analysis><summary>  </summary>").is_err());
        // No blocks at all.
        assert!(parse_structured_summary("just prose").is_err());
    }

    #[test]
    fn rejects_a_tool_call_in_the_compaction_response() {
        let with_call = json!({
            "role": "assistant",
            "tool_calls": [{ "id": "x", "function": { "name": "bash" } }]
        });
        assert!(reject_tool_calls(&with_call).is_err());
        let text_only = json!({ "role": "assistant", "content": "<summary>ok</summary>" });
        assert!(reject_tool_calls(&text_only).is_ok());
    }

    // --- refill guard ---

    #[test]
    fn breaker_opens_after_repeated_failures() {
        let mut g = RefillGuard::new(RefillLimits::default());
        assert_eq!(g.decide(), CompactionDecision::Proceed);
        g.record_failure();
        g.record_failure();
        assert!(!g.is_open());
        g.record_failure(); // third — default max.
        assert!(g.is_open());
        assert!(matches!(g.decide(), CompactionDecision::Blocked(_)));
    }

    #[test]
    fn breaker_opens_on_repeated_rapid_refills() {
        let mut g = RefillGuard::new(RefillLimits::default());
        // First compaction frees plenty — establishes the chain.
        g.record_success(50_000);
        // Now three rapid refills (immediate re-cross, no turns between).
        for _ in 0..3 {
            g.record_success(50_000); // rapid because turns_since_last == 0.
        }
        assert!(g.is_open(), "rapid refills must open the breaker");
    }

    #[test]
    fn an_ineffective_compaction_counts_as_a_refill() {
        let mut g = RefillGuard::new(RefillLimits::default());
        g.record_success(50_000); // effective, resets.
        g.on_turn();
        g.on_turn();
        g.record_success(10); // freed < min_tokens_freed -> ineffective.
        assert_eq!(g.consecutive_rapid_refills_for_test(), 1);
    }

    #[test]
    fn effective_spaced_out_compactions_do_not_open_the_breaker() {
        let mut g = RefillGuard::new(RefillLimits::default());
        for _ in 0..10 {
            g.record_success(50_000);
            g.on_turn();
            g.on_turn();
            g.on_turn();
        }
        assert!(!g.is_open(), "healthy compactions never trip the breaker");
    }

    impl RefillGuard {
        fn consecutive_rapid_refills_for_test(&self) -> u32 {
            self.consecutive_rapid_refills
        }
    }
}
