# janhq/jan#8358 — local API server drops the connection on certain Cyrillic prompts

- Upstream: https://github.com/janhq/jan/issues/8358
- Kind: issue, open upstream
- Priority: P1 (chat request fails with no response)
- Status in this fork: **fixed**

## Root cause, confirmed in this fork

`strip_anthropic_billing_header` in `src-tauri/src/core/server/proxy.rs` checks
whether a system prompt starts with Claude Code's
`x-anthropic-billing-header:` prefix:

```rust
if text.len() < KEY.len() || !text[..KEY.len()].eq_ignore_ascii_case(KEY) {
```

`KEY.len()` is 27 bytes. For the reported prompt, byte 27 falls inside a
Cyrillic character:

```
"Ты извлекаешь финансовую" — 46 bytes; byte 27 is a char boundary: false
" Ты извлекаешь финансовую" — byte 27 is a char boundary: true
```

Indexing a `str` off a char boundary panics, which killed the request handler
and closed the connection without a response. That is exactly the "one extra
ASCII byte flips it" behaviour the reporter measured.

## Fix

`text.get(..KEY.len())` — `None` off a boundary, so a misaligned prompt is
simply "not the header". A repository-wide search for other byte-index slices
of request text found none that can land off a boundary (the remaining ones
slice at positions returned by `find` of ASCII characters, which are always
boundaries).

## Verification

```
cargo test --lib (test-tauri) strip_billing_header   6 passed
```

Mutation: restoring the `[..KEY.len()]` indexing makes
`strip_billing_header_survives_multibyte_text_at_the_key_length` panic at
`proxy.rs:153`.
