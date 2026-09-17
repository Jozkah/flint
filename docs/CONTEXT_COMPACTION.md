# Context compaction

Jan has two complementary layers, kept in separate modules:

- **Reactive** (`src-tauri/src/core/agent/compaction.rs`): triggered by an
  upstream context-overflow error. Summarizes the dropped middle and retries.
  Unchanged.
- **Proactive policy** (`src-tauri/src/core/agent/compaction_policy.rs`): the
  four mechanisms below, each a pure function or small state machine so it is
  testable without a model or a live run.

## 1. Token-threshold calculation — `thresholds()`

```
effective_window = context_window - reserved_output_tokens
compact_at       = effective_window - 13000   (DEFAULT_HEADROOM_TOKENS)
```

`context_window` and `reserved_output_tokens` come from the project `[agent]`
config (`context_window`, `compaction_reserve_tokens`) — the single source of
model limits; this module adds no second one. Overrides: an absolute
`Window(n)` (clamped down to the effective window; `0` rejected) or a
`Percentage(p)` in `(0.0, 1.0]`. A window swallowed by the output reserve, or an
out-of-range percentage, is a configuration **error**, not a silent compact-at-0.
`disabled` turns the layer off (`Ok(None)`). Token counts use the module's one
estimator, `estimate_tokens` (chars/4).

## 2. Gap-based microcompaction — `microcompact()`

Runs before deciding on a full compaction. Condenses **stale, bulky tool
results** in place, keeping tool identity (`tool_call_id`), a head of the output,
and every salient line (errors, file paths, shell commands, exit markers). It
**never** touches user or assistant messages (including tool-call requests and
approval prompts) or the most recent `protect_recent_results` results, and it
never removes a message — only shrinks an old result's body. Returns
`MicrocompactStats { condensed, tokens_removed }`.

## 3. Full-compaction contract — `parse_structured_summary()` / `reject_tool_calls()`

`FULL_COMPACTION_SYSTEM_PROMPT` asks for exactly `<analysis>…</analysis>` then
`<summary>…</summary>`, tools disabled, and a summary preserving the nine facets a
continuation needs. `parse_structured_summary` validates the contract (both
blocks present, correct order, non-empty summary) and errors on anything
malformed so the caller falls back safely. `reject_tool_calls` fails the response
if the model tried to call a tool. The validated summary is reinserted as a typed
conversation event (the reactive path already publishes `MessagesUpdated`).

## 4. Rapid-refill circuit breaker — `RefillGuard`

Tracks consecutive failures, consecutive rapid refills after success, whether a
compaction already ran in this chain, and turns since the last one. Opens (and
stays open for the run) after `max_consecutive_failures` failures or
`max_rapid_refills` rapid/ineffective compactions, so the loop never compacts
repeatedly without freeing at least `min_tokens_freed`. `decide()` returns
`Proceed` or `Blocked(reason)` with a structured, log-safe reason. No conversation
content or secrets are logged — only counts and state.

## Integration points (loop)

The loop consults `thresholds()` + `should_compact()` at end of turn; if over,
runs `microcompact()` first, then a full compaction gated by `RefillGuard::decide`,
recording the outcome with `record_success`/`record_failure`. Observability
fields to emit: current tokens, `compact_at`, `effective_window`, tokens removed,
compaction kind, failure/refill counts, breaker state.
