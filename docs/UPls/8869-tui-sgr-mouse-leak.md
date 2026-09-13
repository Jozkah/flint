# janhq/jan#8869 (fixes #8813) — SGR mouse reports leak into the agent TUI composer

- Upstream PR: https://github.com/janhq/jan/pull/8869 (open, by gokay-ai)
- Upstream issue: https://github.com/janhq/jan/issues/8813
- Priority: P2 (agent CLI input corruption; the ledger's automatic P0 label for
  #8813 came from the word "leak" and does not reflect data loss)
- Status in this fork: **adapted**, applied as reviewed

## Applies to us

The fork ships the same agent TUI (`src-tauri/src/core/cli/tui.rs`) with SGR
mouse tracking enabled (`?1006h`) and no filtering of desynced reports. When an
IME interleaves bytes with a wheel report, crossterm loses `ESC[<` and the
payload (`65;50;42M`) is typed into the composer.

## Review

One file. The change adds a regex (`regex` is already a dependency), drains a
trailing report from the composer after each inserted character, strips reports
from bracketed paste, and adds five tests. No I/O, network, permission or
dependency change. It applied cleanly with line offsets.

Edge noted: a user typing a literal `n;n;nM` token exactly would see it removed.
That shape does not occur in ordinary prose or code, and upstream accepted the
same trade.

## Verification

```
cargo test --lib --no-default-features --features cli sgr   5 passed
```

Mutation: removing the drain from `input_insert` fails three of the five tests.
