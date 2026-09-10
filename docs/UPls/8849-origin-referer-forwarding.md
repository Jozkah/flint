# janhq/jan#8849 (fixes #8792) — Origin header breaks CORS-strict backends

- Upstream PR: https://github.com/janhq/jan/pull/8849 (open, by gokay-ai)
- Upstream issue: https://github.com/janhq/jan/issues/8792
- Priority: P1 (provider requests refused with 403 by Ollama behind nginx or
  with `OLLAMA_ORIGINS`)
- Status in this fork: **adapted** (reimplemented; the PR does not fit this fork)

## The PR's two halves

1. **Webview requests.** Upstream sends provider requests from the webview
   through Tauri's HTTP plugin, which injects `Origin: http://tauri.localhost`.
   The PR adds an `omitTauriWebviewOrigin` wrapper and strips it there.
   **Not applicable here:** this fork sends every provider request through its
   own Rust transport (`web-app/src/lib/providerFetch.ts` →
   `provider_http_stream`), and `src-tauri/src/core/net/transport.rs` never sets
   `Origin`. There is no webview Origin to strip.
2. **The local API proxy.** Jan's OpenAI-compatible server copied every inbound
   header onto the upstream request except `Host`, `Authorization`,
   `Content-Length` and `Transfer-Encoding`. A browser client calling Jan's API
   therefore had its own `Origin` and `Referer` forwarded to the backend.
   **Applicable, and present verbatim** in `src-tauri/src/core/server/proxy.rs`.

## Fix

The filter is now a named predicate, `forwards_to_upstream`, that also drops
`Origin` and `Referer`: they describe the page that called Jan, not Jan. Jan's
own CORS handling of inbound requests is unchanged.

## Verification

```
cargo test --lib (test-tauri) forwarded_upstream   1 passed
```

Mutation: re-allowing `Origin` fails
`the_caller_origin_and_referer_are_not_forwarded_upstream`.

The PR's 300-line webview wrapper and its tests were not taken; nothing in this
fork would call them.
