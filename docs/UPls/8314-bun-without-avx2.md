# janhq/jan#8314 — built-in MCP servers crash with "Illegal instruction" on Windows

- Upstream: https://github.com/janhq/jan/issues/8314
- Kind: issue, open upstream
- Priority: P1 (every npx-based MCP server fails on affected machines; Windows)
- Status in this fork: **fixed**; hardware verification pending

## Root cause, confirmed in this fork

Jan starts `npx`-based MCP servers through the `bun` it bundles when
`jan_utils::can_override_npx` allows it. `scripts/download-bin.mjs` fetches the
regular `bun-windows-x64` / `bun-linux-x64` build, which requires AVX2. The
reporter's log shows exactly that failure:

```
Bun v1.3.14 (0d9b296a) Windows x64
Features: no_avx2
panic: Illegal instruction
```

`can_override_npx` did check AVX2 — but only under
`#[cfg(all(target_os = "macos", any(target_arch = "x86", target_arch = "x86_64")))]`.
Windows and Linux x86 machines without AVX2 were handed a bun that cannot run.

## Fix

`src-tauri/utils/src/system.rs`:

- `bun_runs_on_cpu(is_x86, has_avx2)` is the pure rule: non-x86 always runs,
  x86 only with AVX2.
- `can_override_npx` applies it on **every** x86 target via
  `is_x86_feature_detected!("avx2")`, falling back to the system `npx` otherwise,
  as it already did on Intel macOS.

## Verification

```
cargo test --manifest-path src-tauri/utils/Cargo.toml bun_   3 passed
```

This machine has AVX2, so the fallback path itself has not been exercised end
to end; that needs a CPU without AVX2.
