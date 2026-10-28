use super::*;

/// Rows the message box occupies: 1 content row for the idle/working
/// placeholder, or the wrapped input height clamped to `MAX_INPUT_ROWS` while
/// editing, plus one row of air above the dock. The box is borderless, so the
/// two rows this used to add on top of its content were simply blank.
pub(super) fn input_box_height(app: &App, width: u16) -> u16 {
    let content = if app.picker.is_none()
        && app.blocking_dock().is_none()
        && !(app.status == Status::Running && app.input.is_empty())
    {
        let inner = width.saturating_sub(2).max(1);
        let rows = Paragraph::new(input_content_lines(&app.input, app.cursor))
            .wrap(Wrap { trim: false })
            .line_count(inner)
            .max(1) as u16;
        rows.min(MAX_INPUT_ROWS)
    } else {
        1
    };
    content + 1
}

/// Whether the message box is showing the editable composer (rather than a
/// status line, a picker's "selecting" note or a dock that owns the keyboard).
/// Mirrors the branch order of [`input_box`].
pub(super) fn composer_live(app: &App) -> bool {
    let empty = app.input.is_empty();
    if empty && (app.compacting.is_some() || app.run_compacting.is_some() || app.retrying.is_some()) {
        return false;
    }
    if app.picker.is_some() || (app.status == Status::Running && empty) {
        return false;
    }
    app.blocking_dock().is_none()
}

/// `(total_rows, caret_col, caret_row)` of the composer laid out at `width`.
/// The layout is the one the box is drawn with: the styled lines are rendered
/// into a scratch buffer by the same wrapping `Paragraph`, and the caret is the
/// one reverse-video cell they carry. Nothing here re-implements word wrap, so
/// the answer cannot drift from what is on screen (wide characters included).
pub(super) fn composer_caret(input: &str, cursor: usize, width: u16) -> (u16, u16, u16) {
    use ratatui::widgets::Widget;
    let width = width.max(1);
    let para = Paragraph::new(input_content_lines(input, cursor)).wrap(Wrap { trim: false });
    let total = para.line_count(width).clamp(1, u16::MAX as usize) as u16;
    let area = ratatui::layout::Rect::new(0, 0, width, total);
    let mut buf = ratatui::buffer::Buffer::empty(area);
    para.render(area, &mut buf);
    for row in 0..total {
        for col in 0..width {
            if buf[(col, row)].style().add_modifier.contains(Modifier::REVERSED) {
                return (total, col, row);
            }
        }
    }
    (total, 0, total - 1)
}

/// Visible input as styled lines: `> ` on the first line, 2-space hang on
/// continuations, and a solid block cursor at the byte offset `cursor` (the
/// character under the cursor is drawn in reverse video; at end of line a
/// reversed space forms the block). Wrapping is left to the Paragraph so long
/// single lines fold within the box width.
pub(super) fn input_content_lines(input: &str, cursor: usize) -> Vec<Line<'static>> {
    let arrow = Span::styled("> ", Style::new().cyan().bold());
    let segments: Vec<&str> = input.split('\n').collect();
    let last = segments.len() - 1;
    // Locate the segment + in-segment byte offset holding the caret.
    let (mut caret_seg, mut caret_off) = (last, segments[last].len());
    let mut acc = 0usize;
    for (i, seg) in segments.iter().enumerate() {
        let seg_end = acc + seg.len();
        if cursor <= seg_end {
            caret_seg = i;
            caret_off = cursor - acc;
            break;
        }
        acc = seg_end + 1; // skip the '\n'
    }
    segments
        .into_iter()
        .enumerate()
        .map(|(i, seg)| {
            let prefix = if i == 0 {
                arrow.clone()
            } else {
                Span::raw("  ")
            };
            let mut spans = vec![prefix];
            if i == caret_seg {
                let (a, b) = seg.split_at(caret_off);
                if !a.is_empty() {
                    spans.push(Span::raw(a.to_string()));
                }
                // Big fixed block cursor: reverse-video the char under the
                // cursor, or a reversed space when at the end of the line.
                let mut chars = b.chars();
                let under = chars.next().unwrap_or(' ');
                spans.push(Span::styled(
                    under.to_string(),
                    Style::new().add_modifier(Modifier::REVERSED),
                ));
                let rest: String = chars.collect();
                if !rest.is_empty() {
                    spans.push(Span::raw(rest));
                }
            } else if !seg.is_empty() {
                spans.push(Span::raw(seg.to_string()));
            }
            Line::from(spans)
        })
        .collect()
}

pub(super) fn input_box(app: &App) -> Paragraph<'static> {
    let block = Block::default();
    if let Some(kind) = app.compacting.filter(|_| app.input.is_empty()) {
        // Compaction puts nothing in the transcript while it runs, so the input
        // row carries the throbber and the elapsed seconds.
        let elapsed = app
            .compact_started
            .map(|t| format!(" {}", format_elapsed(t.elapsed().as_secs())))
            .unwrap_or_default();
        Paragraph::new(Line::from(vec![
            Span::styled(format!("{} ", app.spinner()), Style::new().magenta()),
            Span::styled(
                format!("{} conversation…{elapsed}", kind.label()),
                Style::new().dim().italic(),
            ),
        ]))
        .block(block)
    } else if let Some(started) = app.run_compacting.filter(|_| app.input.is_empty()) {
        // The run is waiting on the summarizer; without this the row reads
        // "working" through a round trip that can take a while.
        Paragraph::new(Line::from(vec![
            Span::styled(format!("{} ", app.spinner()), Style::new().magenta()),
            Span::styled(
                format!("compacting conversation… {}", format_elapsed(started.elapsed().as_secs())),
                Style::new().dim().italic(),
            ),
        ]))
        .block(block)
    } else if let Some(wait) = app.retrying.as_ref().filter(|_| app.input.is_empty()) {
        // Without this the row reads "working" through up to the whole retry
        // budget, indistinguishable from a slow model.
        Paragraph::new(Line::from(vec![
            Span::styled(format!("{} ", app.spinner()), Style::new().yellow()),
            Span::styled(retry_wait_label(wait, Instant::now()), Style::new().dim().italic()),
        ]))
        .block(block)
    } else if app.picker.is_some() {
        Paragraph::new(Line::styled("selecting…", Style::new().dim().italic())).block(block)
    } else if app.status == Status::Running && app.input.is_empty() {
        // Show queue status when running with empty input
        if app.message_queue.is_empty() {
            // The spinner carries the fast motion; the action word turns over
            // on a slower cadence, cycling "working" synonyms -- or "thinking"
            // synonyms in orange while a reasoning block streams -- so the row
            // reads alive without shifting under the eye.
            let step = app.spinner_frame / WORD_ROTATE_FRAMES;
            let (word, style) = if app.reasoning_open() {
                (
                    THINKING_WORDS[step % THINKING_WORDS.len()],
                    // Same theme-aware accent as markdown bold, so reasoning
                    // reads consistently on light and dark terminals.
                    Style::new().fg(theme::strong_accent()).italic(),
                )
            } else {
                (
                    WORKING_WORDS[step % WORKING_WORDS.len()],
                    Style::new().dim().italic(),
                )
            };
            // With `wave` set, the glyph travels along the action word in place
            // of the leading throbber: one moving thing per row, not two.
            let message = format!("{word}…");
            let mut spans = Vec::with_capacity(6);
            match wave_glyph() {
                Some(glyph) => {
                    spans.extend(wave_sweep_line(&message, &glyph, app.spinner_frame, style).spans)
                }
                None => {
                    spans.push(Span::styled(
                        format!("{} ", app.spinner()),
                        Style::new().cyan(),
                    ));
                    spans.push(Span::styled(message, style));
                }
            }
            spans.push(Span::styled(
                " (Esc to cancel, type to steer the agent)",
                Style::new().dim().italic(),
            ));
            Paragraph::new(Line::from(spans)).block(block)
        } else {
            let n = app.message_queue.len();
            Paragraph::new(Line::from(vec![
                Span::styled(format!("{} ", app.spinner()), Style::new().yellow()),
                Span::styled(
                    format!("⏳ Pending ({n}) — /cancel to remove, type to steer"),
                    Style::new().yellow(),
                ),
            ]))
            .block(block)
        }
    } else if let Some(what) = app.blocking_dock() {
        // The dock owns the keyboard while it is open, so this field takes
        // nothing: say so instead of showing a cursor that will never move.
        Paragraph::new(Line::styled(
            format!("{what} - the field is inactive"),
            Style::new().dim().italic(),
        ))
        .block(block)
    } else if app.input.is_empty() {
        // Same `> ` prompt as the typing view, then a fixed (non-blinking)
        // block cursor in front of the placeholder.
        let placeholder = if app.status == Status::Running {
            "Type to steer the agent"
        } else {
            "Type here to chat with agent"
        };
        let cursor_spans: Vec<Span<'static>> = vec![
            Span::styled("> ", Style::new().cyan().bold()),
            Span::styled(" ", Style::new().add_modifier(Modifier::REVERSED)),
            Span::raw(" "),
            Span::styled(placeholder, Style::new().dim().italic()),
        ];
        Paragraph::new(Line::from(cursor_spans)).block(block)
    } else {
        Paragraph::new(input_content_lines(&app.input, app.cursor))
            .wrap(Wrap { trim: false })
            .block(block)
    }
}
