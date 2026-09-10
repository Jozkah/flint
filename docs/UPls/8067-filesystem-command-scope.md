# janhq/jan#8067 — path traversal in `mv`, `mkdir` and `write_file_sync`

- Upstream: https://github.com/janhq/jan/issues/8067
- Kind: issue, open upstream
- Priority: P0 (sandbox escape / arbitrary write)
- Status in this fork: **fixed**

## Applies to us

Yes, verbatim. `src-tauri/src/core/filesystem/commands.rs` resolved `mkdir`,
`mv` and `write_file_sync` arguments through `resolve_path`, which canonicalizes
but never checks the result against the Jan data folder. The sibling commands
(`rm`, `write_yaml`, `read_yaml`, `decompress`) already used
`resolve_app_path_within_jan_data_folder`, so the guard existed — those three
commands simply did not call it.

Anything that reaches the IPC surface — a compromised renderer, an extension, a
crafted payload — could therefore create directories, move files and overwrite
files anywhere the Jan process can write, including shell rc files and autostart
directories.

## Reproduction

`src-tauri/src/core/filesystem/scope_tests.rs`. Against the unfixed tree:

```
test result: FAILED. 2 passed; 5 failed
  mkdir_refuses_absolute_path_outside_data_folder
  mkdir_refuses_parent_traversal_out_of_data_folder
  mv_refuses_destination_outside_data_folder
  mv_refuses_source_outside_data_folder
  write_file_sync_refuses_absolute_path_outside_data_folder
```

The two that passed are the in-scope positive cases, which pins that the fix
does not simply refuse everything.

## Fix

All three commands now resolve through
`resolve_app_path_within_jan_data_folder`. For `mv` both the source and the
destination are checked: an unscoped source makes `mv` an exfiltration
primitive, an unscoped destination an arbitrary-write one.

The read-side commands (`read_file_sync`, `readdir_sync`, `file_stat`,
`exists_sync`, `join_path`) were deliberately left unscoped. Imported GGUF
models legitimately live at absolute paths outside the data folder — see
`extensions/llamacpp-extension/src/index.ts`, where `imported` is derived from
`model_path` being absolute — and scoping the read path would break them. That
is a separate, narrower question than the arbitrary-write hole this issue
reports.

## Verification

```
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  --no-default-features --features test-tauri filesystem:: -- --test-threads=1
test result: ok. 29 passed; 0 failed
```

## Callers checked for regression

Every production caller of `fs.mkdir` / `fs.mv` / `fs.writeFileSync` in
`extensions/*` resolves under the Jan data folder already:
`assistant-extension` (assistants dir), `llamacpp-extension` (models dir,
preset/settings atomic writes, model folder rename), `mlx-extension` (models
dir).
