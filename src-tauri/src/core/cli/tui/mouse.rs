//! Mouse input: clicks, wheel scrolling, drag selection and copying the
//! selection to the system clipboard. Moved verbatim out of `tui.rs`.

use super::*;

/// Wheel, drag-to-select and click-to-expand. Press/release are split: the
/// toggle fires on release and only when the pointer never moved, so a drag that
/// starts on a folded row selects text instead of expanding it.
pub(super) fn handle_mouse(app: &mut App, mouse: MouseEvent) {
    // Wheel scrolls the transcript (clamped to `max_back` on the next draw);
    // one notch matches a single arrow-key step. Scrolling moves the content out
    // from under a finished selection, so it drops one.
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            app.clear_selection();
            app.scrollback = app.scrollback.saturating_add(1);
        }
        MouseEventKind::ScrollDown => {
            app.clear_selection();
            app.scrollback = app.scrollback.saturating_sub(1);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            app.copy_armed = false;
            let mode = if mouse.modifiers.contains(KeyModifiers::ALT) {
                SelectionMode::Block
            } else {
                SelectionMode::Linear
            };
            app.selection = Some(Selection::new((mouse.column, mouse.row), mode));
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if let Some(sel) = app.selection.as_mut() {
                let at = (mouse.column, mouse.row);
                sel.moved |= at != sel.anchor;
                sel.head = at;
            }
        }
        MouseEventKind::Up(MouseButton::Left) => {
            let Some(sel) = app.selection.as_mut() else {
                return;
            };
            sel.dragging = false;
            if sel.moved {
                // The text lives in the rendered buffer, which only `draw` has;
                // it copies on the next frame (<=50ms).
                app.copy_armed = true;
            } else {
                app.clear_selection();
                click_region(app, mouse.column, mouse.row);
            }
        }
        _ => {}
    }
}

/// A click that never became a drag: expand or collapse the region whose summary
/// row it landed on. Ignores clicks outside the transcript viewport or on rows
/// that aren't a region's own summary row (detail lines, blank padding, etc).
pub(super) fn click_region(app: &mut App, column: u16, row: u16) {
    let rect = app.transcript_rect;
    if column < rect.x
        || column >= rect.x + rect.width
        || row <= rect.y
        || row >= rect.y + rect.height.saturating_sub(1)
    {
        return;
    }
    // Top border consumes one row; the rest maps 1:1 onto `row_index`, which is
    // built in the body's own wrapped screen coordinates.
    let body_row = (row - rect.y - 1) as usize;
    if let Some(Some(idx)) = app.row_index.get(body_row) {
        // A folded trace header expands its whole run; any other row toggles its
        // own detail.
        if app.is_folded_trace_start(*idx) {
            app.toggle_trace(*idx);
        } else {
            app.toggle_region(*idx);
        }
    }
}

/// Extend a held drag past the top or bottom edge of the transcript by scrolling
/// a row per frame toward the pointer. Only nudges `scrollback`; `draw` clamps it
/// and shifts the anchor by however much the view actually moved.
pub(super) fn autoscroll_selection(app: &mut App) {
    let Some(sel) = app.selection.filter(|s| s.dragging) else {
        return;
    };
    let rect = app.transcript_rect;
    if rect.height <= 2 {
        return;
    }
    if sel.head.1 <= rect.y {
        app.scrollback = app.scrollback.saturating_add(1);
    } else if sel.head.1 >= rect.y + rect.height.saturating_sub(1) {
        app.scrollback = app.scrollback.saturating_sub(1);
    }
}

/// Lift the selected cells out of a rendered frame. Rows are joined with
/// newlines and stripped of trailing padding, so a copied command pastes as the
/// command and not as the width of the terminal.
pub(super) fn selection_text(buf: &Buffer, sel: Selection, area: Rect) -> String {
    sel.spans(area.width)
        .into_iter()
        .filter(|(row, _, _)| *row < area.height)
        .filter_map(|(row, c0, c1)| {
            // Wide glyphs park an empty symbol in their second cell, so plain
            // concatenation already reconstructs them.
            let cells = (c0..=c1).filter_map(|col| buf.cell((col, row))).collect();
            copy_selection_line(cells)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn copy_selection_line(cells: Vec<&ratatui::buffer::Cell>) -> Option<String> {
    let is_panel_chrome = |cell: &&ratatui::buffer::Cell| {
        cell.style().fg == Some(ratatui::style::Color::DarkGray)
            && matches!(cell.symbol(), "│" | "┌" | "└" | "┐" | "┘" | "─" | "┊" | " ")
    };

    let Some(start) = cells.iter().position(|cell| !is_panel_chrome(cell)) else {
        let has_corner_or_rule = cells
            .iter()
            .any(|cell| matches!(cell.symbol(), "┌" | "└" | "┐" | "┘" | "─"));
        return if has_corner_or_rule {
            None
        } else {
            Some(String::new())
        };
    };
    let Some(end) = cells.iter().rposition(|cell| !is_panel_chrome(cell)) else {
        return Some(String::new());
    };
    let line: String = cells[start..=end]
        .iter()
        .map(|cell| cell.symbol())
        .collect();

    Some(line.trim_end().to_string())
}

/// Writes `text` to the macOS pasteboard through `pbcopy`.
///
/// Not `arboard`: its AppKit write logs `-[NSPasteboard _setData:...] returns
/// false` to stderr whenever the pasteboard is contended, and stderr is the
/// terminal the TUI is drawing on, so the line lands on top of the screen.
#[cfg(target_os = "macos")]
pub(super) fn set_system_clipboard(text: String) {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = std::io::Write::write_all(&mut stdin, text.as_bytes());
    }
    let _ = child.wait();
}

#[cfg(not(target_os = "macos"))]
pub(super) fn set_system_clipboard(text: String) {
    let Ok(mut clip) = arboard::Clipboard::new() else {
        return;
    };
    // X11/Wayland ownership lives with the setter, so this thread parks
    // inside `wait()` until something else claims the clipboard; returning
    // immediately would drop the text on the floor.
    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        let _ = clip.set().wait().text(text);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = clip.set_text(text);
    }
}

/// Put a selection on the system clipboard by both routes available to a TUI:
/// the OS clipboard, which serves it for as long as this process runs, and
/// OSC 52, which hands it to the terminal emulator so it survives `jan`
/// exiting and crosses an ssh/tmux session. OSC 52 goes second so that where it
/// is supported the terminal ends up owning the selection.
pub(super) fn copy_to_clipboard(text: &str) {
    let owned = text.to_string();
    std::thread::spawn(move || set_system_clipboard(owned));
    // The cap is on what the terminal receives, which is the base64 text:
    // 4 bytes for every 3 of the selection.
    if text.len() <= OSC52_MAX_BYTES / 4 * 3 {
        use base64::Engine;
        let payload = base64::engine::general_purpose::STANDARD.encode(text);
        let mut out = io::stdout();
        let _ = write!(out, "\x1b]52;c;{payload}\x07");
        let _ = out.flush();
    }
}

pub(super) async fn handle_ask_mouse(
    app: &mut App,
    mouse: MouseEvent,
    registry: &crate::core::agent::interaction::AskRegistry,
) -> bool {
    if app.blocking_dock().is_some() {
        return false;
    }
    let Some(ask) = app.ask_queue.front_mut() else {
        return false;
    };
    if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        return true;
    }
    let inside = mouse.column >= ask.rect.x
        && mouse.column < ask.rect.x.saturating_add(ask.rect.width)
        && mouse.row >= ask.rect.y
        && mouse.row < ask.rect.y.saturating_add(ask.rect.height);
    if !inside {
        return true;
    }
    let Some((_, selected)) = ask
        .row_hitboxes
        .iter()
        .find(|(row, _)| *row == mouse.row)
        .copied()
    else {
        return true;
    };
    ask.selected = selected;
    let submit = ask.choose();
    if submit {
        resolve_front_ask(app, registry, false).await;
    }
    true
}
