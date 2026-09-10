# janhq/jan#8831 (fixes #8811) — copying a TUI code block copies its frame

- Upstream PR: https://github.com/janhq/jan/pull/8831 (open, by lorenzozanee)
- Upstream issue: https://github.com/janhq/jan/issues/8811
- Priority: P2 (agent TUI usability: copied commands cannot be pasted and run)
- Status in this fork: **adapted** (`dc2afa6`), applied as reviewed

## Applies to us

`selection_text` in `src-tauri/src/core/cli/tui.rs` is identical in the fork: it
concatenates the symbols of every selected cell and trims trailing padding, so
the box-drawing frame and `│` gutter drawn around a code block land on the
clipboard with the code.

## Review

One file, +51/-6. A new `copy_selection_line` drops leading and trailing cells
that are panel chrome — box-drawing glyphs or padding **in the panel's
dark-gray style** — and skips rows that are only a border. Keying on the style
as well as the glyph means a `│` in the user's own code, drawn in the normal
style, is kept. No I/O, network, dependency or permission change; applied
cleanly with line offsets.

## Verification

```
cargo test --lib --no-default-features --features cli selection_text   2 passed
```

The upstream test (`selection_text_strips_box_frame_from_copied_code`) was not
run against the old code here; it asserts the stripped output directly.
