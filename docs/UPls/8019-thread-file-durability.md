# janhq/jan#8019 — an interrupted write corrupts a thread's message store

- Upstream: https://github.com/janhq/jan/issues/8019
- Kind: issue, open upstream
- Priority: P0 (data loss)
- Status in this fork: **fixed** (`57ea06b`)

## Applies to us

Yes, and more broadly than reported.

- `write_messages_to_file` (`src-tauri/src/core/threads/helpers.rs`) rewrote
  `messages.jsonl` with `File::create` — truncate first, write second — on every
  `modify_message` and `delete_message`.
- `thread.json` was written the same way with `fs::write` by `create_thread`,
  `modify_thread` and `update_thread_metadata`. A torn `thread.json` is skipped
  by `list_threads`, so the conversation disappears from the sidebar outright.
- `create_message` appends a line. An append interrupted mid-line leaves an
  unterminated fragment, and the next append glued a new message onto it.
- `read_messages_from_file` failed the whole thread on any unparseable line.

## Reproduction

`src-tauri/src/core/threads/durability_tests.rs`. Against the old code four of
the new cases fail: a torn final line makes the thread unreadable, an append
after a torn tail is swallowed by it, an append after a complete-but-unterminated
tail is lost, and a blocked rewrite reports success while writing straight into
the real file.

## Fix

- Every thread file goes through `write_file_atomically`: write a staging file
  beside the target, `sync_all`, rename over. A failed rewrite leaves the
  original untouched and removes the staging file.
- `append_message_line` settles an unterminated tail before appending: an
  unparseable fragment (what a crash leaves) is cut off; a tail that parses and
  only lacked its newline is kept and terminated.
- The reader skips an unparseable **final, unterminated** line with a warning.
  Corruption anywhere else still fails loudly — silently dropping a bad line with
  good lines after it would hide real damage.

## Verification

```
cargo test --lib --no-default-features --features test-tauri threads::   41 passed
cargo test --lib --no-default-features --features test-tauri              807 passed
```
