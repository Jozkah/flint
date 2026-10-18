# Flint patch to genai 0.7.0-beta.19

This directory is `genai` 0.7.0-beta.19 (https://github.com/jeremychone/rust-genai),
dual-licensed MIT / Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE` kept unchanged).
Examples, tests, docs and dev folders were dropped and their `[[example]]` /
`[[test]]` sections removed from `Cargo.toml`; nothing else in the manifest
changed. It replaces the crates.io copy through `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## What is patched

Only `src/adapter/adapters/openai/streamer.rs` (search for `FLINT PATCH`).

1. Several tool calls in one SSE chunk. Upstream took `delta.tool_calls.first()`
   on a non-final chunk, so a provider that batches
   `tool_calls: [{index:0,...},{index:1,...}]` into one chunk lost every call but
   the first, both from the stream events and from the captured end-of-stream
   calls the agent loop executes. The patch captures every entry (indexes
   preserved, partial arguments appended per index) and queues the extra
   `ToolCallChunk` events in a `pending` deque drained at the top of `poll_next`.
   The finish-reason chunk path now announces every call too, not only the first.
2. `function.arguments` sent as a JSON object (or other non-string) was read as
   `String` and became empty; it is now serialised to a string.
3. A tool call without `index` falls back to its array position instead of being
   skipped.

Regression tests live in `src/core/agent/genai_bridge.rs`
(`two_tool_calls_in_one_chunk_are_both_delivered`,
`two_tool_calls_alongside_the_finish_reason_are_both_delivered`) and the
table-driven provider quirk suite in `src/core/agent/provider_quirks.rs`
(batched calls, object arguments, missing index, over a real socket).

## Upstream issue text (to file against jeremychone/rust-genai)

> OpenAI streamer drops all but the first tool call of a chunk
>
> `OpenAIStreamer::poll_next` handles `delta.tool_calls` with
> `delta_tool_calls.first()`. OpenAI itself streams one entry per chunk, but
> several OpenAI-compatible servers (llama.cpp, vLLM, some proxies) put every
> parallel tool call into a single chunk. All entries after the first are
> discarded, so `StreamEnd.captured_tool_calls` is missing calls and the model
> appears to ignore parallel tool use. The finish-reason branch has the same
> shape (it only emits the first captured call as an event). Expected: every
> entry is captured by `index` and surfaced as a `ToolCallChunk`.

## Dropping the patch

Remove `[patch.crates-io]` from `src-tauri/Cargo.toml`, delete this directory,
and re-run the regression tests above against the new release.
