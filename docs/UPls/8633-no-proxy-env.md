# janhq/jan#8633 (fixes #8565) — honour `NO_PROXY` / `no_proxy`

- Upstream PR: https://github.com/janhq/jan/pull/8633 (open, by SnowingFox)
- Upstream issue: https://github.com/janhq/jan/issues/8565
- Priority: P2 (corporate-proxy users; inner-network and localhost endpoints)
- Status in this fork: **adapted**

## Review

The diff was inspected in full before applying: it reads one environment
variable, merges it into the existing bypass list, and adds four integration
tests. No dependency, build-script, network or permission changes. It applied
cleanly to `src-tauri/utils/src/network.rs`, which is identical to upstream's
base here.

## Why the PR alone was not enough in this fork

This fork has **two** copies of `should_bypass_proxy`: the one in `jan_utils`
the PR changes, and a duplicate in `src-tauri/src/core/downloads/helpers.rs`.
The only production caller — the download client — uses the duplicate. Applying
the PR as-is would have changed a function nothing calls.

So the downloads copy now delegates to `jan_utils::network::should_bypass_proxy`,
and a fork test (`download_proxy_bypass_honours_the_no_proxy_environment`)
pins that the environment reaches the real caller.

## Verification

```
cargo test --manifest-path src-tauri/utils/Cargo.toml     40 unit + 4 no_proxy_env passed
cargo test --lib (test-tauri) bypass                       7 passed
```

## Out of scope, as upstream also notes

The local API proxy (`src-tauri/src/core/server/proxy.rs`) builds its client
without the app's proxy settings and relies on reqwest's own environment
handling, so it is unaffected by this change.
