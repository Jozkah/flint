# janhq/jan#8806 (fixes #8804, #8780) — a repaint path for the agent TUI

- Upstream PR: https://github.com/janhq/jan/pull/8806 (merged; f891b16, da436ca)
- Issues: #8804 (a `wall(1)` broadcast corrupts the frame for good), #8780
  (resizing blacks the TUI out)
- Status in this fork: **adapted** (`5b734a2`); #8804 and #8780 **fixed**

## Why not a cherry-pick

The two commits do not apply to the fork's `tui.rs`, and the PR also carries
a `GateContext` refactor that conflicts with the fork's subject-aware
permission gate. Only the repaint path was reimplemented.

## Root cause

ratatui diffs the new frame against its previous buffer and emits only the
cells that changed. A foreign write to the TTY changes the physical screen and
neither buffer, so the diff never repaints those cells. An emulator reflowing
during a drag resize does the same, and when it settles back at the starting
size ratatui's own autoresize sees no change either. The fork's event drain
had no `Event::Resize` arm, and there was no redraw key.

## Fix

- `Event::Resize` and Ctrl-L request a full repaint. Ctrl-L is honoured ahead
  of every mode guard and inside a docked ask, and is never typed.
- The repaint resets the diff baseline with `Terminal::resize(size)` — not
  `clear()`, whose cursor-position query is a blocking DSR round trip — inside
  the synchronized-update frame, so the terminal flips from the damaged frame
  straight to the repaired one. Kitty keeps skipping synchronized output
  (#8782, already in the fork).
- Triggered only, never per frame; display only.

## Reproductions (TestBackend, deterministic)

- `repaint_restores_cells_a_foreign_write_corrupted`: a write through the
  backend survives a plain redraw (the bug), and is gone after the repaint.
- `a_resize_that_ends_at_the_same_size_still_repaints`: same-size resize damage
  survives autoresize, and only the resize event repairs it (#8780).
- `a_resize_to_a_new_size_draws_the_whole_new_frame`, Ctrl-L in the composer
  and in an ask, draft/scroll preserved, no cursor query.

A live `wall` and a kitty drag were not available on this Windows host.

## Verification

```
cargo test --lib --no-default-features --features cli   1476 passed (x5)
```
