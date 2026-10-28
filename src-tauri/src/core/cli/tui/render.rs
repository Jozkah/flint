//! Drawing: the frame, the transcript rows, the overlays and every helper that
//! turns app state into styled lines. Moved verbatim out of `tui.rs`.

use super::*;

pub(super) fn banner_lines(banner: &Banner, width: u16) -> Vec<Line<'static>> {
    let accent = Style::new().yellow().bold();
    let label = Style::new().dark_gray();
    let dim = Style::new().dim();
    let indent = " ".repeat(BANNER_INDENT as usize);
    let mut out: Vec<Line<'static>> = Vec::new();

    // A clipped wordmark reads as breakage, so a narrow terminal gets the name
    // as text instead.
    if width >= brand::LOGO_WIDTH + BANNER_INDENT * 2 {
        for art in brand::LOGO {
            out.push(Line::styled(format!("{indent}{art}"), accent));
        }
        out.push(Line::raw(""));
        out.push(Line::styled(
            format!("{indent}interactive agent console · v{}", banner.version),
            dim,
        ));
    } else {
        out.push(Line::from(vec![
            Span::styled(format!("{indent}jan"), accent),
            Span::styled(format!(" v{}", banner.version), dim),
        ]));
    }
    out.push(Line::raw(""));

    let value_max = width.saturating_sub(BANNER_INDENT + 10).max(8) as usize;
    let mut field = |name: &str, value: String| {
        out.push(Line::from(vec![
            Span::styled(format!("{indent}{name:<8}"), label),
            Span::styled(truncate(&value, value_max), dim),
        ]));
    };
    // No `model` row: the header leads with it, bold, two rows above. The
    // location is a different case -- the dock's copy is dim and easy to miss,
    // and the tools act on that directory, so a `jan` started in the wrong one
    // is the mistake worth catching before the first message.
    let location = match &banner.branch {
        Some(branch) => format!("{} ⎇ {branch}", banner.project),
        None => banner.project.clone(),
    };
    field("project", location);
    if let Some(workspace) = banner.workspace.as_ref() {
        field("worktree", workspace.clone());
    }
    field("tools", banner.tools.clone());
    out.push(Line::raw(""));

    for row in hint_rows(BANNER_HINTS, width) {
        out.push(row);
    }
    if banner.awaiting_first_message {
        let long = "type a message to start";
        let invite = if width as usize >= BANNER_INDENT as usize + long.len() {
            long
        } else {
            "type a message"
        };
        out.push(Line::styled(format!("{indent}{invite}"), dim));
    }
    out
}

/// Pack `(key, label)` hints into as few indented rows as `width` allows, so a
/// narrow terminal wraps between hints instead of mid-hint.
pub(super) fn hint_rows(pairs: &[(&str, &str)], width: u16) -> Vec<Line<'static>> {
    let key_style = Style::new().cyan().bold();
    // `hint_spans` opens with one space; the splash indents by two.
    let row = |group: &[(&str, &str)]| {
        let mut spans = vec![Span::raw(" ")];
        spans.extend(hint_spans(key_style, group));
        Line::from(spans)
    };
    let mut groups: Vec<Vec<(&str, &str)>> = Vec::new();
    let mut group: Vec<(&str, &str)> = Vec::new();
    for pair in pairs {
        group.push(*pair);
        if row_width(&row(&group)) > width as usize && group.len() > 1 {
            group.pop();
            groups.push(std::mem::take(&mut group));
            group.push(*pair);
        }
    }
    if !group.is_empty() {
        groups.push(group);
    }
    groups
        .into_iter()
        .map(|group| {
            let full = row(&group);
            if row_width(&full) <= width as usize {
                return full;
            }
            // A hint too wide even on its own keeps its key and drops the
            // description; the key is the part the user has to type.
            row(&group.iter().map(|(key, _)| (*key, "")).collect::<Vec<_>>())
        })
        .collect()
}

/// Rows a `Paragraph` occupies once it word-wraps `lines` at `width`, measured
/// with the same wrap the body uses so the two cannot disagree. ratatui wraps
/// each `Line` independently and never merges across them, so summing this over
/// a run of rows equals measuring their concatenation -- which is what lets
/// `draw` add up cached per-row heights instead of wrapping the whole session.
pub(super) fn wrapped_height(lines: Vec<Line<'static>>, width: u16) -> u16 {
    Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .line_count(width.max(1))
        .min(u16::MAX as usize) as u16
}

/// Sweep the configured glyph back and forth along `message`, replacing the
/// characters it covers rather than displacing them.
///
/// The first cut of this (#8726) inserted the glyph in place of exactly one
/// `char`. An emoji is two cells wide, so every frame made the row one cell
/// wider than the text it was drawn from: the tail shifted right, and at the
/// frame's own width the last character fell off the edge. That is the
/// "letters vanish" bug the feature was reverted for.
///
/// The fix is to spend the glyph's *display width* out of the message: a
/// 2-cell glyph covers two 1-cell characters, so the composed line is always
/// exactly as wide as `message`. Whatever the user configured is measured, so a
/// 1-cell `"~"` covers one character and a 3-cell `"<o>"` covers three.
///
/// The glyph is clamped to the message rather than allowed to overhang, so the
/// last frames of a sweep do not grow the row either.
pub(super) fn wave_sweep_line(message: &str, glyph: &str, frame: usize, text_style: Style) -> Line<'static> {
    use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

    let glyph_width = glyph.width().max(1);
    let chars: Vec<char> = message.chars().collect();
    // Character offsets the glyph can start at without overhanging the end.
    let mut stops: Vec<usize> = Vec::new();
    for i in 0..chars.len() {
        let mut width = 0usize;
        for c in &chars[i..] {
            width += c.width().unwrap_or(0);
            if width >= glyph_width {
                break;
            }
        }
        if width >= glyph_width {
            stops.push(i);
        }
    }
    if stops.is_empty() {
        return Line::from(vec![Span::styled(message.to_string(), text_style)]);
    }

    // Ping-pong across the stops: forward to the end, then back, so the glyph
    // reverses instead of jumping back to the start.
    let cycle = stops.len().saturating_mul(2).saturating_sub(2).max(1);
    let step = frame % cycle;
    let index = if step < stops.len() {
        step
    } else {
        cycle - step
    };
    let start = stops[index];

    // Spend the glyph's width out of the message, so the row's total width is
    // unchanged no matter how wide the glyph is.
    let mut end = start;
    let mut spent = 0usize;
    while end < chars.len() && spent < glyph_width {
        spent += chars[end].width().unwrap_or(0);
        end += 1;
    }

    let head: String = chars[..start].iter().collect();
    let tail: String = chars[end..].iter().collect();
    // A glyph landing on a wider character than itself leaves a gap; pad it so
    // the tail does not slide left under the glyph.
    let pad = " ".repeat(spent.saturating_sub(glyph_width));

    let mut spans = Vec::with_capacity(4);
    if !head.is_empty() {
        spans.push(Span::styled(head, text_style));
    }
    spans.push(Span::styled(glyph.to_string(), Style::new().cyan()));
    if !pad.is_empty() {
        spans.push(Span::styled(pad, text_style));
    }
    if !tail.is_empty() {
        spans.push(Span::styled(tail, text_style));
    }
    Line::from(spans)
}

/// Word-wrap `spans` to `max`, breaking hard at their embedded newlines first.
/// `wrap_spans_at_words` treats `\n` as an ordinary character, so a multi-line
/// command or user message laid out through it alone renders as one run-on line
/// with blank cells where the breaks were.
pub(super) fn wrap_spans_hard(spans: Vec<Span<'static>>, max: usize) -> Vec<Vec<Span<'static>>> {
    let mut segments: Vec<Vec<Span<'static>>> = vec![Vec::new()];
    for span in spans {
        let style = span.style;
        let mut parts = span.content.split('\n').peekable();
        while let Some(part) = parts.next() {
            let part = part.strip_suffix('\r').unwrap_or(part);
            if !part.is_empty() {
                segments
                    .last_mut()
                    .expect("seeded with one segment")
                    .push(Span::styled(part.to_string(), style));
            }
            if parts.peek().is_some() {
                segments.push(Vec::new());
            }
        }
    }
    segments
        .into_iter()
        .flat_map(|segment| markdown::wrap_spans_at_words(segment, max))
        .collect()
}

/// `text` laid out at `max` in one style. The single-span case of
/// `wrap_spans_hard`.
pub(super) fn wrap_text(text: &str, style: Style, max: usize) -> Vec<Vec<Span<'static>>> {
    wrap_spans_hard(vec![Span::styled(text.to_string(), style)], max)
}

/// Prefix each wrapped row with its gutter: `lead` on the first, `cont` on the
/// rest, so the body keeps one left edge no matter how many rows it took.
pub(super) fn gutter_lines(
    rows: Vec<Vec<Span<'static>>>,
    lead: Vec<Span<'static>>,
    cont: Vec<Span<'static>>,
) -> Vec<Line<'static>> {
    rows.into_iter()
        .enumerate()
        .map(|(i, spans)| {
            let mut row = if i == 0 { lead.clone() } else { cont.clone() };
            row.extend(spans);
            Line::from(row)
        })
        .collect()
}

pub(super) const CONTEXT_RAIL_INNER_MAX: usize = 60;

pub(super) const CONTEXT_BANK_WIDTH_MAX: usize = 20;

pub(super) const CONTEXT_BANK_FRACTIONS: [char; 8] = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/// Free space (`.`) and the auto-compact reserve (`B`) stay in the report so
/// the rail and the percentage partition still cover the whole window, but the
/// breakdown lists only what the conversation actually consumes -- the rail
/// above already states the remaining and reserved capacity.
pub(super) fn is_consumed_segment(segment: &ContextSegment) -> bool {
    !matches!(segment.key, '.' | 'B')
}

pub(super) fn context_segment_style(key: char) -> Style {
    match key {
        'M' => Style::new().cyan(),
        '.' => Style::new().dark_gray(),
        'B' => Style::new().magenta(),
        _ => Style::new().yellow(),
    }
}

pub(super) fn context_rail_style(glyph: char) -> Style {
    match glyph {
        '=' => Style::new().cyan(),
        '^' => Style::new().yellow().bold(),
        '.' => Style::new().dark_gray(),
        '╳' => Style::new().magenta(),
        _ => Style::new().dim(),
    }
}

/// Place centered labels on a fixed-width scale. Earlier labels win: pass the
/// live markers (fill, threshold) before the fixed scale ends so a low fill
/// never loses its annotation to the `0%`/`0K` endpoint. A label that would
/// collide with an earlier one is omitted; the exact values remain in the
/// headline, so tight scales never render garbled text.
pub(super) fn context_marker_line(width: usize, labels: &[(usize, String)]) -> String {
    let mut chars = vec![' '; width];
    for (center, text) in labels {
        let len = text.chars().count().min(width);
        let start = center
            .saturating_sub(len / 2)
            .min(width.saturating_sub(len));
        if chars[start..start + len].iter().any(|c| *c != ' ') {
            continue;
        }
        for (offset, ch) in text.chars().take(len).enumerate() {
            chars[start + offset] = ch;
        }
    }
    chars.into_iter().collect::<String>().trim_end().to_string()
}

/// One category's share of the full window, rounded to eighth-block precision.
/// A non-zero share always gets at least the thinnest visible block.
pub(super) fn context_bank_bar(percent: f64, width: usize) -> (String, String) {
    let mut eighths = (percent.clamp(0.0, 100.0) * width as f64 * 8.0 / 100.0).round() as usize;
    if percent > 0.0 {
        eighths = eighths.max(1);
    }
    eighths = eighths.min(width * 8);

    let full = eighths / 8;
    let fraction = eighths % 8;
    let mut filled = "█".repeat(full);
    if fraction > 0 {
        filled.push(CONTEXT_BANK_FRACTIONS[fraction]);
    }
    let empty = "░".repeat(width.saturating_sub(filled.chars().count()));
    (filled, empty)
}

/// Plain `/context` summary: current usage and autocompaction threshold first,
/// followed by seven equal-scale category bars.
pub(super) fn context_lines(report: &ContextReport, width: usize) -> Vec<Line<'static>> {
    let max = width.max(1);
    let percents = report.percents();
    let fill_pct = report.fill as f64 / report.window.max(1) as f64 * 100.0;
    let window_k = format_window(report.window);
    let buffer = report
        .segments
        .iter()
        .find(|segment| segment.key == 'B')
        .map_or(0, |segment| segment.tokens);
    let compact_at = report.window.saturating_sub(buffer);
    let compact_pct = compact_at as f64 / report.window.max(1) as f64 * 100.0;
    let headroom = compact_at.saturating_sub(report.fill);
    let provenance = if report.fill_reported {
        "provider"
    } else {
        "estimated"
    };

    if width < 32 {
        let mut rows = vec![
            vec![Span::styled(
                format!(
                    "{}/{} ({fill_pct:.1}%, {provenance})",
                    format_tokens(report.fill),
                    window_k,
                ),
                Style::new().bold(),
            )],
            vec![Span::styled(
                format!("{} before auto-compact", format_tokens(headroom)),
                Style::new().bold(),
            )],
            vec![Span::styled(
                "Context breakdown (estimated)",
                Style::new().dim(),
            )],
        ];
        for (segment, percent) in report
            .segments
            .iter()
            .zip(&percents)
            .filter(|(segment, _)| is_consumed_segment(segment))
        {
            rows.push(vec![Span::raw(format!(
                "{} {} ({percent:.1}%)",
                segment.label,
                format_tokens(segment.tokens),
            ))]);
        }
        return rows
            .into_iter()
            .map(|spans| Line::from(clip_spans(spans, max)))
            .collect();
    }

    let mut rows: Vec<Vec<Span<'static>>> = vec![
        vec![Span::styled(
            format!(
                "{} · {} / {} tokens used ({fill_pct:.1}%, {provenance})",
                report.model_id,
                format_tokens(report.fill),
                window_k,
            ),
            Style::new().bold(),
        )],
        Vec::new(),
    ];

    let inner = width.saturating_sub(2).min(CONTEXT_RAIL_INNER_MAX);
    let rail_width = inner + 2;
    let fill_pos = ((report.fill as f64 / report.window.max(1) as f64 * inner as f64).round()
        as usize)
        .clamp(1, inner);
    let compact_pos = ((compact_at as f64 / report.window.max(1) as f64 * inner as f64).round()
        as usize)
        .clamp(1, inner);

    rows.push(vec![Span::styled("Context window", Style::new().dim())]);
    if width >= 50 {
        rows.push(vec![Span::styled(
            context_marker_line(
                rail_width,
                &[
                    (fill_pos, format!("{fill_pct:.1}%")),
                    (compact_pos, format!("{compact_pct:.0}%")),
                    (0, "0%".to_string()),
                    (rail_width - 1, "100%".to_string()),
                ],
            ),
            Style::new().dim(),
        )]);
    }

    let mut rail_cells: Vec<char> = (0..inner)
        .map(|index| {
            if index < fill_pos {
                '='
            } else if index < compact_pos {
                '.'
            } else {
                '╳'
            }
        })
        .collect();
    rail_cells[compact_pos - 1] = '|';
    rail_cells[fill_pos - 1] = '^';
    let mut rail = vec![Span::styled("|", Style::new().dim())];
    rail.extend(
        rail_cells
            .into_iter()
            .map(|glyph| Span::styled(glyph.to_string(), context_rail_style(glyph))),
    );
    rail.push(Span::styled("|", Style::new().dim()));
    rows.push(rail);

    if width >= 50 {
        rows.push(vec![Span::styled(
            context_marker_line(
                rail_width,
                &[
                    (fill_pos, format_tokens(report.fill)),
                    (compact_pos, format_tokens(compact_at)),
                    (0, "0K".to_string()),
                    (rail_width - 1, format_tokens(report.window)),
                ],
            ),
            Style::new().dim(),
        )]);
    }
    rows.push(Vec::new());
    rows.push(vec![Span::styled(
        format!(
            "{} tokens available before auto-compact",
            format_tokens(headroom)
        ),
        Style::new().bold(),
    )]);
    rows.push(Vec::new());
    rows.push(vec![Span::styled(
        "Context breakdown (estimated)",
        Style::new().dim(),
    )]);

    let label_width = report
        .segments
        .iter()
        .filter(|segment| is_consumed_segment(segment))
        .map(|segment| segment.label.chars().count())
        .max()
        .unwrap_or_default();
    for (segment, percent) in report
        .segments
        .iter()
        .zip(&percents)
        .filter(|(segment, _)| is_consumed_segment(segment))
    {
        let tokens = format_tokens(segment.tokens);
        let prefix = format!("{:<label_width$} {:>5.1}%  [", segment.label, percent);
        let suffix = format!("]  {tokens}");
        let fixed = prefix.chars().count() + suffix.chars().count();
        let bank_width = width.saturating_sub(fixed).clamp(1, CONTEXT_BANK_WIDTH_MAX);
        let (filled, empty) = context_bank_bar(*percent, bank_width);
        let style = context_segment_style(segment.key);
        rows.push(vec![
            Span::raw(prefix),
            Span::styled(filled, style),
            Span::styled(empty, Style::new().dark_gray()),
            Span::raw(suffix),
        ]);
    }

    rows.into_iter()
        .map(|spans| Line::from(clip_spans(spans, max)))
        .collect()
}

/// Truncate a styled row to `max` columns, counting characters so multi-byte
/// block glyphs are never cut in the middle of their UTF-8 encoding.
pub(super) fn clip_spans(spans: Vec<Span<'static>>, max: usize) -> Vec<Span<'static>> {
    let mut out = Vec::with_capacity(spans.len());
    let mut used = 0usize;
    for span in spans {
        let len = span.content.chars().count();
        if used + len <= max {
            used += len;
            out.push(span);
            continue;
        }
        let room = max.saturating_sub(used);
        if room > 0 {
            let kept: String = span.content.chars().take(room).collect();
            out.push(Span::styled(kept, span.style));
        }
        break;
    }
    out
}

/// Max diff rows rendered under a tool result before collapsing the tail. The
/// transcript scrolls, so a whole edit is worth showing; only pathological
/// machine-generated diffs hit this.
pub(super) const DIFF_MAX_ROWS: usize = 1000;

/// Max diff rows in the permission prompt, which does not scroll: its box grows
/// upward into the transcript and shares the space with the decision list, so a
/// long diff has to collapse rather than crowd out the options.
pub(super) const DIFF_PREVIEW_MAX_ROWS: usize = 20;

/// Cells a `tool_row` spends on its gutter and tag, subtracted from the draw
/// width before the label is wrapped.
pub(super) const TOOL_ROW_RESERVE: u16 = 6;

/// Columns held back for the live row's elapsed badge. Fixed rather than
/// measured so the body's wrap points never move as the counter ticks; wide
/// enough for the four digits a single tool call will not outlive.
pub(super) const ELAPSED_RESERVE: usize = 8;

/// Rows one tool label may occupy before it elides. A label is wrapped rather
/// than cut so a long command stays readable, but a heredoc body would
/// otherwise push the conversation off screen; the full text is still under
/// Ctrl-O.
pub(super) const TOOL_ROW_MAX_LINES: usize = 8;

/// Diff row backgrounds. Desaturated on purpose: the syntax-highlighted
/// foreground is drawn on top of them, so the tint has to read as added/removed
/// at a glance without swallowing the code. The light pair is the same idea
/// inverted -- pale green/red under dark syntax text -- for a light terminal.
pub(super) const DIFF_ADD_BG: Color = Color::Rgb(22, 52, 32);

pub(super) const DIFF_DEL_BG: Color = Color::Rgb(66, 26, 30);

pub(super) const DIFF_ADD_BG_LIGHT: Color = Color::Rgb(198, 239, 206);

pub(super) const DIFF_DEL_BG_LIGHT: Color = Color::Rgb(255, 205, 210);

/// Pure selector so the light branch is tested without the process-wide flag.
pub(super) fn diff_bg(added: bool, light: bool) -> Color {
    match (added, light) {
        (true, false) => DIFF_ADD_BG,
        (true, true) => DIFF_ADD_BG_LIGHT,
        (false, false) => DIFF_DEL_BG,
        (false, true) => DIFF_DEL_BG_LIGHT,
    }
}

/// User-turn bubble background: a subtle slate that reads as a filled card
/// under the message's own foreground, on either terminal theme. The desktop
/// equivalent is the `bg-secondary` chat bubble.
pub(super) const USER_BUBBLE_BG: Color = Color::Rgb(40, 44, 58);

pub(super) const USER_BUBBLE_BG_LIGHT: Color = Color::Rgb(226, 232, 240);

pub(super) fn user_bubble_bg_for(light: bool) -> Color {
    if light {
        USER_BUBBLE_BG_LIGHT
    } else {
        USER_BUBBLE_BG
    }
}

pub(super) fn user_bubble_bg() -> Color {
    user_bubble_bg_for(theme::is_light())
}

/// User-turn text: the inverse of the bubble background so the message keeps
/// real contrast on either theme -- near-white on the dark bubble, near-black on
/// the light one -- rather than inheriting the terminal foreground.
pub(super) const USER_BUBBLE_FG: Color = Color::Rgb(233, 236, 242);

pub(super) const USER_BUBBLE_FG_LIGHT: Color = Color::Rgb(28, 32, 42);

pub(super) fn user_bubble_fg_for(light: bool) -> Color {
    if light {
        USER_BUBBLE_FG_LIGHT
    } else {
        USER_BUBBLE_FG
    }
}

pub(super) fn user_bubble_fg() -> Color {
    user_bubble_fg_for(theme::is_light())
}

/// Tint a run of gutter rows as one filled bubble: every span carries the
/// background and each row is padded to the widest so the block reads as a card
/// rather than a ragged run of tinted fragments. The padded width is capped at
/// the frame so the extra column never forces a wrap.
pub(super) fn band_rows(lines: Vec<Line<'static>>, bg: Color) -> Vec<Line<'static>> {
    let target = lines.iter().map(row_width).max().unwrap_or(0);
    lines
        .into_iter()
        .map(|line| {
            let pad = target.saturating_sub(row_width(&line)) + 1;
            let mut spans: Vec<Span<'static>> = line
                .spans
                .into_iter()
                .map(|s| Span::styled(s.content, s.style.bg(bg)))
                .collect();
            spans.push(Span::styled(" ".repeat(pad), Style::new().bg(bg)));
            Line::from(spans)
        })
        .collect()
}

pub(super) fn diff_add_bg() -> Color {
    diff_bg(true, theme::is_light())
}

pub(super) fn diff_del_bg() -> Color {
    diff_bg(false, theme::is_light())
}

/// Selection style shared by every arrow-navigable list (ask, permission, slash
/// hints, path hints, pickers). Palette-only on purpose: `reversed()` swaps in
/// the terminal's default foreground as a background, which lands as an opaque
/// white block matching nothing else on screen. Bold survives `Style::patch`
/// even where a row's spans set their own colors, so it marks the row
/// everywhere; the cyan reaches `SELECT_MARK` and any unstyled label, and both
/// follow the terminal's own theme.
pub(super) fn select_style() -> Style {
    Style::new().cyan().bold()
}

pub(super) const SELECT_MARK: &str = "\u{25b6} ";

/// Render focused-diff text as a boxed panel: a light rule frames the change,
/// `+` rows on a green background and `-` rows on a red one across the whole row
/// (so the change reads as a band), `@@` headers dim-cyan. Every row keeps its
/// syntax highlighting, changed or not; only the background says what happened.
/// Content is truncated to what `width` leaves after the gutter and the frame,
/// and each row padded so the right border aligns.
/// Collapses to `max_rows` with a `(+N more)` tail before the closing rule.
/// `gutter` indents the panel (tool-row alignment under a result; empty in the
/// prompt).
pub(super) fn diff_lines(
    diff: &str,
    width: usize,
    max_rows: usize,
    gutter: &'static str,
    lang: Option<&str>,
) -> Vec<Line<'static>> {
    let max = panel_inner(width, gutter);
    let all: Vec<&str> = diff.lines().collect();
    let shown = all.len().min(max_rows);
    let truncated = all.len() > shown;

    // Truncate before highlighting so the width arithmetic is unchanged.
    let kept: Vec<String> = all[..shown].iter().map(|l| truncate(l, max)).collect();
    // Highlight the body with the `-`/`+` markers stripped, so a multi-line
    // string or comment keeps its colour across the hunk instead of restarting
    // on every row; the markers are re-attached with their own colour below.
    // Hunk headers are not code and stay out of it.
    let bodies: Vec<&str> = kept.iter().map(|l| split_diff_marker(l).1).collect();
    let highlighted: Option<Vec<Vec<Span<'static>>>> = match lang {
        Some(l) if !l.is_empty() => Some(highlight::block(&bodies, l)),
        _ => None,
    };

    let mut rows: Vec<Line<'static>> = Vec::with_capacity(shown + 1);
    for (i, line) in kept.iter().enumerate() {
        let (marker, body) = split_diff_marker(line);
        if marker.starts_with('@') {
            rows.push(Line::styled(line.clone(), Style::new().cyan().dim()));
            continue;
        }
        let bg = match marker.as_bytes().first() {
            Some(b'-') => Some(diff_del_bg()),
            Some(b'+') => Some(diff_add_bg()),
            _ => None,
        };
        let mut spans = Vec::with_capacity(2);
        if !marker.is_empty() {
            // On a tinted row the marker takes the strong colour and the code
            // keeps its own; elsewhere it recedes.
            let marker_style = match marker.as_bytes().first() {
                Some(b'-') => Style::new().red().bold(),
                Some(b'+') => Style::new().green().bold(),
                _ => Style::new().dim(),
            };
            spans.push(Span::styled(marker.to_string(), marker_style));
        }
        match &highlighted {
            Some(h) => spans.extend(h[i].iter().cloned()),
            // Dimming an unhighlighted body would fight the tint behind it.
            None if bg.is_some() => spans.push(Span::raw(body.to_string())),
            None => spans.push(Span::styled(body.to_string(), Style::new().dim())),
        }
        // The tint rides on the line so `boxed_panel` can carry it across the
        // padding too, making the band reach the right border.
        let row = Line::from(spans);
        rows.push(match bg {
            Some(bg) => row.style(Style::new().bg(bg)),
            None => row,
        });
    }
    if truncated {
        rows.push(Line::styled(
            format!("(+{} more)", all.len() - shown),
            Style::new().dim(),
        ));
    }
    boxed_panel(rows, width, gutter)
}

/// Split a diff row into its leading marker and the code after it. A `@@` hunk
/// header is returned whole as the marker, since none of it is code.
pub(super) fn split_diff_marker(line: &str) -> (&str, &str) {
    if line.starts_with("@@") {
        return (line, "");
    }
    match line.as_bytes().first() {
        Some(b'-') | Some(b'+') | Some(b' ') => line.split_at(1),
        _ => ("", line),
    }
}

/// Total display width of a row's spans.
pub(super) fn row_width(row: &Line<'_>) -> usize {
    row.spans.iter().map(|s| s.content.chars().count()).sum()
}

/// Content columns a panel of total `width` has left after its gutter and the
/// four the frame spends (`│ ` and ` │`). Callers size their rows with this so
/// the closing border lands inside the terminal instead of wrapping onto a line
/// of its own.
pub(super) fn panel_inner(width: usize, gutter: &str) -> usize {
    width.saturating_sub(gutter.chars().count() + 4).max(1)
}

/// Frame styled rows in a light box, right-padded to the widest row (clamped to
/// what `width` leaves for content). Rows carry their own spans so style can vary
/// within a row (syntax highlighting); `gutter` prefixes every line to indent the
/// panel. A row's line-level style is folded into its spans, since the framed
/// line replaces it with the border's own style, and a row-level background also
/// fills the interior padding so a highlighted row reads as a band from border to
/// border rather than stopping at the end of its text.
pub(super) fn boxed_panel(rows: Vec<Line<'static>>, width: usize, gutter: &'static str) -> Vec<Line<'static>> {
    let inner = rows
        .iter()
        .map(row_width)
        .max()
        .unwrap_or(0)
        .clamp(1, panel_inner(width, gutter));
    let border = Style::new().dark_gray();
    let mut out = Vec::with_capacity(rows.len() + 2);
    out.push(Line::from(vec![
        Span::styled(gutter, border),
        Span::styled(format!("┌{}┐", "─".repeat(inner + 2)), border),
    ]));
    for row in rows {
        let pad = inner.saturating_sub(row_width(&row));
        let row_style = row.style;
        // Interior spacing carries the row's background but not its foreground:
        // the frame itself stays neutral, so only the padding between the
        // borders is tinted.
        let fill = match row_style.bg {
            Some(bg) => border.bg(bg),
            None => border,
        };
        let mut spans = vec![
            Span::styled(gutter, border),
            Span::styled("│", border),
            Span::styled(" ", fill),
        ];
        spans.extend(
            row.spans
                .into_iter()
                .map(|s| Span::styled(s.content, row_style.patch(s.style))),
        );
        spans.push(Span::styled(format!("{} ", " ".repeat(pad)), fill));
        spans.push(Span::styled("│", border));
        out.push(Line::from(spans));
    }
    out.push(Line::from(vec![
        Span::styled(gutter, border),
        Span::styled(format!("└{}┘", "─".repeat(inner + 2)), border),
    ]));
    out
}

/// A command as the transcript shows it: each line's internal whitespace
/// collapsed, but the line structure kept, so a heredoc or a script written one
/// step per line reads the way it was authored. `RowKind::Tool` breaks on those
/// newlines and wraps whatever is still too wide.
pub(super) fn collapse_command(cmd: &str) -> String {
    cmd.lines()
        .map(single_line)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_string()
}

pub(super) fn tool_activity(name: &str, args: &serde_json::Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let base = |p: &str| {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(p)
            .to_string()
    };
    match name {
        "bash" | "shell" | "exec" => {
            let cmd = s("command");
            // Untruncated: the row wraps at the draw width, so the command
            // fills the terminal rather than eliding at a fixed 80.
            match (bash_job_id(args), cmd.trim()) {
                (Some(job), "") => format!("Waiting for background job {job}"),
                (Some(_), cmd) => format!("Waiting for: {}", collapse_command(cmd)),
                (None, "") => "Executing command".to_string(),
                (None, cmd) => format!("Executing: {}", collapse_command(cmd)),
            }
        }
        "grep" | "search" => "Searching".to_string(),
        "find" | "glob" => "Finding files".to_string(),
        "read" => format!("Reading {}", base(s("path"))),
        "list" | "ls" => "Listing files".to_string(),
        "write" => format!("Writing {}", base(s("path"))),
        "edit" => format!("Editing {}", base(s("path"))),
        "dispatch_subagent" => format!("Dispatching subagent: {}", s("subagent_name")),
        "await_subagent" => format!(
            "Awaiting subagent: {}",
            subagent_name_from_run_id(s("run_id"))
        ),
        "create_subagent" => format!("Creating subagent: {}", s("name")),
        "list_subagents" => "Listing subagents".to_string(),
        "web_search" => {
            let q = s("query");
            if q.is_empty() {
                "Searching the web".to_string()
            } else {
                format!("Searching the web: {q}")
            }
        }
        "web_fetch" => {
            let u = s("url");
            if u.is_empty() {
                "Fetching a page".to_string()
            } else {
                format!("Fetching: {u}")
            }
        }
        "ask" => "Asking a question".to_string(),
        "todo" => format!("{} {}", todo_op_verb(args, false), todo_target_label(args)),
        // Skill/memory tools already produce active labels ("Updating memory: X").
        _ => describe_tool_call(name, args),
    }
}

/// Present/past-tense verb for a `todo` tool call, keyed on its `op` argument.
pub(super) fn todo_op_verb(args: &serde_json::Value, past: bool) -> &'static str {
    match (args.get("op").and_then(|v| v.as_str()).unwrap_or(""), past) {
        ("init", false) => "Planning",
        ("init", true) => "Planned",
        ("start", false) => "Starting",
        ("start", true) => "Started",
        ("done", false) => "Completing",
        ("done", true) => "Completed",
        ("drop", false) => "Abandoning",
        ("drop", true) => "Abandoned",
        ("rm", false) => "Removing",
        ("rm", true) => "Removed",
        ("append", false) => "Adding",
        ("append", true) => "Added",
        ("view", false) => "Checking",
        ("view", true) => "Checked",
        (_, false) => "Updating",
        (_, true) => "Updated",
    }
}

/// Concise subject for a `todo` tool call's verb: the named task/phase, an
/// item count for `append`, or "todos" as a generic fallback.
pub(super) fn todo_target_label(args: &serde_json::Value) -> String {
    if let Some(task) = args.get("task").and_then(|v| v.as_str()) {
        return format!("task: {task}");
    }
    if let Some(phase) = args.get("phase").and_then(|v| v.as_str()) {
        if let Some(items) = args.get("items").and_then(|v| v.as_array()) {
            if !items.is_empty() {
                let n = items.len();
                return format!("{n} task{} to {phase}", if n == 1 { "" } else { "s" });
            }
        }
        return format!("phase: {phase}");
    }
    if let Some(list) = args.get("list").and_then(|v| v.as_array()) {
        let n = list.len();
        return format!("{n} phase{}", if n == 1 { "" } else { "s" });
    }
    if args.get("all").and_then(|v| v.as_bool()) == Some(true) {
        return "all tasks".to_string();
    }
    "todos".to_string()
}

/// Detailed one-line label for a subagent's own tool call, shown in the live
/// panel. Unlike `tool_activity` (deliberately terse for the parent transcript),
/// this keeps the concrete command/path/pattern so consecutive calls are
/// distinguishable ("git log -5" vs "git diff", not two "Executing git" rows).
pub(super) fn subagent_activity(name: &str, args: &serde_json::Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "bash" | "shell" | "exec" => {
            let cmd = s("command");
            // The live panel gives each call exactly one row, so this one stays
            // flattened where the transcript's label keeps its breaks.
            match (bash_job_id(args), cmd.trim()) {
                (Some(job), "") => format!("awaiting job {job}"),
                (Some(_), cmd) => format!("awaiting $ {}", single_line(cmd)),
                (None, "") => "command".to_string(),
                (None, cmd) => format!("$ {}", single_line(cmd)),
            }
        }
        "grep" | "search" => format!("grep {}", s("pattern")),
        "find" | "glob" => format!("find {}", s("pattern")),
        "read" => format!("read {}", s("path")),
        "list" | "ls" => format!("ls {}", s("path")),
        "write" => format!("write {}", s("path")),
        "edit" => format!("edit {}", s("path")),
        _ => tool_activity(name, args),
    }
}

/// Past-tense counterpart to `tool_activity` for a finalized single call
/// ("Reading main.rs" -> "Read main.rs"); falls back to `describe_tool_call`.
pub(super) fn tool_finished(name: &str, args: &serde_json::Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let base = |p: &str| {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(p)
            .to_string()
    };
    match name {
        "bash" | "shell" | "exec" => {
            let cmd = s("command");
            match (bash_job_id(args), cmd.trim()) {
                (Some(job), "") => format!("Collected background job {job}"),
                (Some(_), cmd) => format!("Collected: {}", collapse_command(cmd)),
                (None, "") => "Ran command".to_string(),
                (None, cmd) => format!("Ran: {}", collapse_command(cmd)),
            }
        }
        "grep" | "search" => "Searched".to_string(),
        "find" | "glob" => "Found files".to_string(),
        "read" => format!("Read {}", base(s("path"))),
        "list" | "ls" => "Listed files".to_string(),
        "write" => format!("Wrote {}", base(s("path"))),
        "edit" => format!("Edited {}", base(s("path"))),
        "dispatch_subagent" => format!("Dispatched subagent: {}", s("subagent_name")),
        "await_subagent" => format!(
            "Subagent {} returned",
            subagent_name_from_run_id(s("run_id"))
        ),
        "create_subagent" => format!("Created subagent: {}", s("name")),
        "list_subagents" => "Listed subagents".to_string(),
        "web_search" => {
            let q = s("query");
            if q.is_empty() {
                "Searched the web".to_string()
            } else {
                format!("Searched the web: {q}")
            }
        }
        "web_fetch" => {
            let u = s("url");
            if u.is_empty() {
                "Fetched a page".to_string()
            } else {
                format!("Fetched: {u}")
            }
        }
        "ask" => "Asked a question".to_string(),
        "todo" => format!("{} {}", todo_op_verb(args, true), todo_target_label(args)),
        _ => describe_tool_call(name, args),
    }
}

/// A one-line tool row: `│ <tag> <text>` with a styled tag and body.
/// What a still-streaming call has revealed about itself so far. Derived from
/// the raw arguments, and cached: deriving it costs a full scan and unescape of
/// everything received, which at file scale is far too much to repeat on every
/// 50ms frame when the underlying bytes usually haven't moved.
#[derive(Default)]
pub(super) struct StartingPreview {
    /// Destination path, available well before the body since `path` is short
    /// and models emit it first.
    pub(super) path: Option<String>,
    /// Trailing lines of the file body, newest last, syntax-highlighted from
    /// `path`'s extension. `None` until a `write` call's `content` field opens.
    pub(super) tail: Option<Vec<Vec<Span<'static>>>>,
    /// Body lines scrolled off the top of `tail`.
    pub(super) skipped: usize,
    /// The shell command as it streams in, for a `bash`/`shell`/`exec` call, so
    /// the in-flight row shows the command being typed into the same terminal box
    /// the running call becomes. `None` for every other tool.
    pub(super) command: Option<String>,
}

/// A pending resend of a failed upstream request, from `StreamEvent::Retry`.
pub(super) struct RetryWait {
    pub(super) attempt: u32,
    pub(super) max_attempts: u32,
    /// When the resend goes out, for the countdown.
    pub(super) at: Instant,
    pub(super) reason: String,
}

/// The input row while a resend is pending: a countdown until it goes out,
/// then the attempt itself, which can take as long as a connect timeout.
pub(super) fn retry_wait_label(wait: &RetryWait, now: Instant) -> String {
    let left = wait.at.saturating_duration_since(now);
    let when = if left.is_zero() {
        "retrying".to_string()
    } else {
        format!("retrying in {}s", left.as_secs_f32().ceil() as u64)
    };
    format!(
        "{when} (attempt {}/{})... {}",
        wait.attempt, wait.max_attempts, wait.reason
    )
}

/// A tool call announced by the model whose arguments are still arriving.
pub(super) struct StartingCall {
    pub(super) id: String,
    pub(super) name: String,
    /// Raw JSON arguments accumulated so far -- a truncated prefix of the
    /// object the model is emitting, not valid JSON until the call completes.
    pub(super) args: String,
    pub(super) preview: StartingPreview,
    /// `args.len()` when `preview` was derived. The buffer is append-only, so
    /// an unchanged length means unchanged content and the cache holds.
    pub(super) preview_at: Option<usize>,
}

impl StartingCall {
    pub(super) fn new(id: String, name: String) -> Self {
        Self {
            id,
            name,
            args: String::new(),
            preview: StartingPreview::default(),
            preview_at: None,
        }
    }

    /// Re-derive the preview if new argument bytes have arrived since the last
    /// derivation. Called from the render path, so the work happens at most
    /// once per frame *and* at most once per delta, whichever is rarer.
    pub(super) fn refresh_preview(&mut self) {
        if self.preview_at == Some(self.args.len()) {
            return;
        }
        self.preview_at = Some(self.args.len());
        self.preview.path =
            partial_json_field(&self.args, "path").map(unescape_partial_json_string);
        // A shell command streams as one short string; keep it so the row can
        // type it into a terminal box rather than sit on "Preparing bash".
        self.preview.command = matches!(self.name.as_str(), "bash" | "shell" | "exec")
            .then(|| partial_json_field(&self.args, "command"))
            .flatten()
            .map(unescape_partial_json_string);
        let body = (self.name == "write")
            .then(|| partial_json_field(&self.args, "content"))
            .flatten()
            .map(unescape_partial_json_string);
        let Some(body) = body else {
            self.preview.tail = None;
            self.preview.skipped = 0;
            return;
        };
        // `rsplit` walks back from the end and stops once the window is full,
        // so a large body never materializes a line list it would discard.
        // `split` (not `lines`) so a trailing newline shows as the empty line
        // the model just opened, which is where the next content will land.
        let mut tail: Vec<&str> = body.rsplit('\n').take(STREAM_TAIL_LINES).collect();
        tail.reverse();
        let total = body.bytes().filter(|&b| b == b'\n').count() + 1;
        self.preview.skipped = total - tail.len();
        // The last line is the one still being written; the rest are finished.
        let open = tail.len().saturating_sub(1);
        let clamped: Vec<(String, bool)> = tail
            .iter()
            .enumerate()
            .map(|(i, line)| clamp_preview_line(line, i == open))
            .collect();
        let window: Vec<&str> = clamped.iter().map(|(text, _)| text.as_str()).collect();
        // Highlighted here rather than in the row builder so it happens once
        // per derivation rather than once per frame; highlighting 12 lines
        // costs ~4.6ms, and this window is a fresh cache key every time the
        // body grows.
        let lang = self.preview.path.clone().unwrap_or_default();
        let mut rows = highlight::block(&window, &lang);
        for (i, (row, (_, truncated))) in rows.iter_mut().zip(&clamped).enumerate() {
            if !truncated {
                continue;
            }
            let marker = Span::styled("\u{2026}", Style::new().dark_gray());
            if i == open {
                row.insert(0, marker);
            } else {
                row.push(marker);
            }
        }
        self.preview.tail = Some(rows);
    }
}

/// Clamp one preview line to `STREAM_MAX_LINE_CHARS`, reporting whether
/// anything was dropped.
///
/// `open` marks the line still being written, which keeps its tail: that is
/// where new bytes land, so it is the end that shows the write progressing. A
/// finished line keeps its head, where it reads from.
pub(super) fn clamp_preview_line(line: &str, open: bool) -> (String, bool) {
    // A line can only exceed the char budget if it exceeds it in bytes.
    if line.len() <= STREAM_MAX_LINE_CHARS {
        return (line.to_string(), false);
    }
    let count = line.chars().count();
    if count <= STREAM_MAX_LINE_CHARS {
        return (line.to_string(), false);
    }
    let at = |n: usize| line.char_indices().nth(n).map_or(line.len(), |(i, _)| i);
    let kept = if open {
        &line[at(count - STREAM_MAX_LINE_CHARS)..]
    } else {
        &line[..at(STREAM_MAX_LINE_CHARS)]
    };
    (kept.to_string(), true)
}

impl StartingCall {
    /// One-line "what is this call doing" for a compact row, resolved as far as
    /// the arguments allow: the destination once `path` has streamed, the tool
    /// name alone before that.
    pub(super) fn activity_label(&mut self) -> String {
        self.refresh_preview();
        match self.preview.path.as_deref() {
            Some(path) if !path.is_empty() => format!("{} {path}", self.name),
            _ => format!("{}…", self.name),
        }
    }
}

/// How many trailing lines of a streaming file body stay on screen. Enough to
/// see the model actually working without the preview owning the viewport.
pub(super) const STREAM_TAIL_LINES: usize = 12;

/// Minimum width of the line-number gutter, so a short preview doesn't jitter
/// sideways as the count crosses 10 / 100.
pub(super) const STREAM_GUTTER_MIN: usize = 3;

/// Longest preview line handed to the highlighter. Minified content (a bundle,
/// a JSON blob) is one line that grows for the whole write, and both costs it
/// drives are linear in its length: syntect re-highlights the line on every
/// delta, and the wrapped row count grows with it until the preview owns the
/// viewport. Wide enough to fill any real terminal row, so nothing a user could
/// have read is dropped.
pub(super) const STREAM_MAX_LINE_CHARS: usize = 300;

/// Pull one *string-valued* field out of a JSON object that is still streaming
/// and therefore almost certainly truncated mid-value.
///
/// A real parser can't help here: the input is a prefix like
/// `{"path":"a.html","content":"<!doctype html>\n<html` with no closing quote
/// or brace. This scans for `"<field>"` followed by `:` and an opening quote,
/// then walks the value honoring backslash escapes, stopping at the closing
/// quote *or* at end-of-input -- whichever comes first. Returns the raw
/// (still escaped) value; see `unescape_partial_json_string`.
pub(super) fn partial_json_field<'a>(raw: &'a str, field: &str) -> Option<&'a str> {
    let mut rest = raw;
    let needle = format!("\"{field}\"");
    loop {
        let at = rest.find(&needle)?;
        let after = &rest[at + needle.len()..];
        let after_colon = after.trim_start();
        // `"content"` could also appear inside some earlier string value; if
        // what follows isn't `: "`, keep looking.
        let Some(after_colon) = after_colon.strip_prefix(':') else {
            rest = &rest[at + needle.len()..];
            continue;
        };
        let Some(value) = after_colon.trim_start().strip_prefix('"') else {
            rest = &rest[at + needle.len()..];
            continue;
        };
        let mut escaped = false;
        for (i, c) in value.char_indices() {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                return Some(&value[..i]);
            }
        }
        // No closing quote: the value is still streaming, take all of it.
        return Some(value);
    }
}

/// Turn a raw JSON string body into display text, tolerating a truncated tail.
///
/// The stream can cut anywhere, including the middle of an escape sequence, so
/// drop a dangling `\` and a partial `\uXXXX` before handing the rest to the
/// parser. Falls back to the raw text if it still won't parse -- a preview is
/// never worth failing a render over.
pub(super) fn unescape_partial_json_string(raw: &str) -> String {
    let mut s = raw;
    // Partial `\uXXXX`: 0-3 hex digits arrived so far.
    if let Some(at) = s.rfind("\\u") {
        let tail = &s[at + 2..];
        if tail.len() < 4 && tail.chars().all(|c| c.is_ascii_hexdigit()) {
            s = &s[..at];
        }
    }
    // Dangling escape: an odd number of trailing backslashes means the last one
    // is opening an escape whose payload hasn't arrived.
    let trailing_slashes = s.chars().rev().take_while(|&c| c == '\\').count();
    if trailing_slashes % 2 == 1 {
        s = &s[..s.len() - 1];
    }
    serde_json::from_str::<String>(&format!("\"{s}\"")).unwrap_or_else(|_| s.to_string())
}

/// Rows for one in-flight tool call.
///
/// A `write` whose body has started arriving renders as a live preview: the
/// destination, a tail window of the content with line numbers, and a footer
/// marking it as still streaming. Everything else -- and a `write` before its
/// `content` field opens -- falls back to a one-line throbber, which is all
/// there is to say about a call whose arguments haven't arrived.
///
/// Derivation is cached on the call (see `refresh_preview`) and re-runs only
/// when the argument buffer has grown, so it costs at most one rescan per
/// frame -- and, because `drain_stream_events` collapses a burst of deltas into
/// one frame, far fewer than one per delta. A rescan is still linear in the
/// whole buffer (~1.4ms at 314KB), so a multi-megabyte write would make each
/// *frame* expensive: if that shows up, unescape only from the last
/// `STREAM_TAIL_LINES` newline escapes instead of the whole body. Line length
/// is already bounded by `STREAM_MAX_LINE_CHARS`, without which minified
/// content cost 650ms per delta at 53KB and grew from there.
pub(super) fn starting_call_lines(call: &mut StartingCall, frame: &str, width: u16) -> Vec<Line<'static>> {
    call.refresh_preview();
    // A shell call types its command into the same terminal box the running
    // call becomes, so there is no "Preparing bash" stage and the dispatch is a
    // seamless swap.
    if matches!(call.name.as_str(), "bash" | "shell" | "exec") {
        let command = call.preview.command.clone().unwrap_or_default();
        return typing_terminal_lines(&command, frame, width);
    }
    let Some(tail) = call.preview.tail.as_ref() else {
        let label = match call.preview.path.as_deref() {
            // Even without a body, the path lands early enough to be worth
            // showing -- "Preparing write" alone says nothing about what. Any
            // path-carrying tool reaches here, so the name comes from the call.
            Some(path) if !path.is_empty() => format!("Preparing {}: {path}", call.name),
            _ => format!("Preparing {}", call.name),
        };
        return vec![tool_row(
            frame,
            Style::new().cyan(),
            &label,
            Style::new().cyan().dim(),
        )];
    };

    let mut out = Vec::new();
    out.push(Line::from(vec![
        Span::styled("│ ", Style::new().dark_gray()),
        Span::styled("Write: ", Style::new().cyan()),
        Span::styled(
            call.preview.path.clone().unwrap_or_default(),
            Style::new().cyan().dim(),
        ),
    ]));

    let start = call.preview.skipped;
    let gutter = (start + tail.len())
        .to_string()
        .len()
        .max(STREAM_GUTTER_MIN);
    if start > 0 {
        out.push(Line::from(vec![
            Span::styled("│ ", Style::new().dark_gray()),
            Span::styled(
                format!("… ({})", pluralize("earlier line", start)),
                Style::new().dark_gray(),
            ),
        ]));
    }
    for (offset, code) in tail.iter().enumerate() {
        let mut spans = vec![
            Span::styled("│ ", Style::new().dark_gray()),
            Span::styled(
                format!("{:>gutter$} ", start + offset + 1, gutter = gutter),
                Style::new().dark_gray(),
            ),
        ];
        spans.extend(code.iter().cloned());
        out.push(Line::from(spans));
    }
    out.push(Line::from(vec![
        Span::styled("│ ", Style::new().dark_gray()),
        Span::styled(format!("{frame} "), Style::new().cyan()),
        Span::styled("… (streaming)", Style::new().dark_gray()),
    ]));
    out
}

/// A tool row laid out at `width`: `tag` in the gutter, `label` wrapped
/// beneath it with continuations aligned under the label rather than under the
/// tag, bounded by `TOOL_ROW_MAX_LINES`. Shared by the committed `RowKind::Tool`
/// and the live group row so the running command and the finished one wrap
/// identically -- the row must not re-flow at the moment it resolves.
///
/// `suffix` rides the end of the last row (the live row's elapsed badge). The
/// wrap reserves `ELAPSED_RESERVE` for it up front instead of measuring it, so a
/// counter ticking past 9s or 99s cannot re-flow the command above it.
pub(super) fn tool_row_lines(
    tag: &str,
    tag_style: Style,
    label: &str,
    label_style: Style,
    reserve: u16,
    width: u16,
    suffix: Option<(String, Style)>,
) -> Vec<Line<'static>> {
    let held = if suffix.is_some() { ELAPSED_RESERVE } else { 0 };
    let max = (width.saturating_sub(reserve) as usize)
        .saturating_sub(held)
        .max(1);
    let mut rows = wrap_text(label, label_style, max);
    if rows.len() > TOOL_ROW_MAX_LINES {
        rows.truncate(TOOL_ROW_MAX_LINES);
        if let Some(last) = rows.last_mut() {
            last.push(Span::styled(" …", label_style));
        }
    }
    if let Some((text, style)) = suffix {
        rows.last_mut()
            .expect("wrap_text yields at least one row")
            .push(Span::styled(format!(" {text}"), style));
    }
    gutter_lines(
        rows,
        vec![
            Span::styled("│ ", Style::new().dark_gray()),
            Span::styled(format!("{tag} "), tag_style),
        ],
        vec![
            Span::styled("│ ", Style::new().dark_gray()),
            Span::raw(" ".repeat(tag.chars().count() + 1)),
        ],
    )
}

pub(super) fn tool_row(tag: &str, tag_style: Style, text: &str, text_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::styled("│ ", Style::new().dark_gray()),
        Span::styled(format!("{tag} "), tag_style),
        Span::styled(text.to_string(), text_style),
    ])
}

/// Per-call detail lines for an expanded tool group: each call's finished label
/// with its result summary (and diff, if any) indented under the summary row.
pub(super) fn group_detail_lines(group: &ToolGroup, width: u16) -> Vec<Line<'static>> {
    let max = width.saturating_sub(8) as usize;
    let mut out = Vec::new();
    // A single-call group's summary row already IS that call's `done` label, so
    // repeating it here would duplicate it; only multi-call groups (whose
    // summary is a counted breakdown) need the per-call headers.
    let show_headers = group.calls.len() > 1;
    let (tag_gutter, cont_gutter) = if show_headers {
        ("│     ", "│       ")
    } else {
        ("│   ", "│     ")
    };
    for call in &group.calls {
        if show_headers {
            out.extend(gutter_lines(
                wrap_text(&call.done, Style::new().dim(), max),
                vec![
                    Span::styled("│   ", Style::new().dark_gray()),
                    Span::styled("▸ ", Style::new().cyan()),
                ],
                vec![Span::styled("│     ", Style::new().dark_gray())],
            ));
        }
        if let Some(content) = &call.content {
            let (tag, tag_style) = if call.is_error {
                ("✗", Style::new().red())
            } else {
                ("✓", Style::new().green())
            };
            // Expanded view shows the full output verbatim: the tag rides the
            // first line, the rest indent to align under it, and a line wider
            // than the terminal wraps rather than eliding -- this is the surface
            // the transcript's one-line summary sends the user to. Empty content
            // still gets a bare tag row.
            out.extend(gutter_lines(
                wrap_text(content, Style::new().dim(), max),
                vec![
                    Span::styled(tag_gutter, Style::new().dark_gray()),
                    Span::styled(format!("{tag} "), tag_style),
                ],
                vec![Span::styled(cont_gutter, Style::new().dark_gray())],
            ));
            if let Some(diff) = &call.diff {
                for line in diff_lines(diff, width as usize, DIFF_MAX_ROWS, cont_gutter, None) {
                    out.push(line);
                }
            }
        }
    }
    out
}

/// Classify a collapsible tool into a breakdown noun and whether it is a
/// read-style op (drives the "Read" vs "Ran" verb in a group summary).
pub(super) fn tool_kind(name: &str) -> (&'static str, bool) {
    match name {
        n if n.starts_with("memory") => ("memory note", true),
        n if n.starts_with("skill") => ("skill", true),
        "read" => ("file", true),
        "list" | "ls" => ("directory", true),
        "grep" | "search" => ("search", false),
        "find" | "glob" => ("file search", false),
        "bash" | "shell" | "exec" => ("command", false),
        _ => ("tool call", false),
    }
}

/// Short sentence summarizing a finished tool group, e.g. "Read 3 memory notes,
/// 1 skill" or "Read 20 files; ran 12 commands". Read-style nouns get a "Read"
/// clause and executed nouns a "ran" clause, so the verb always agrees with its
/// noun (never "Ran 1 directory"). Each clause preserves first-seen order.
pub(super) fn group_summary(nouns: &[(&str, bool)]) -> String {
    group_clauses(nouns, "Read", "ran")
}

/// The one-line header a folded trace collapses to, with a step count so the
/// fold advertises how much it hides. A finished run gets a static `▸` and past
/// tense (`▸ Worked · N steps` / `▸ Thought · N steps`); the active run -- still
/// streaming, its current step shown live below -- gets the spinner and present
/// tense (`⠋ Working · N steps` / `⠋ Thinking · N steps`), so the condensed live
/// view reads as one moving header over the current step rather than a growing
/// pile of settled rows.
pub(super) fn trace_header_line(run: &TraceRun, active: bool, frame: &str) -> Line<'static> {
    let (marker, verb) = if active {
        let verb = if run.tool_ran { "Working" } else { "Thinking" };
        (format!("{frame} "), verb)
    } else {
        let verb = if run.tool_ran { "Worked" } else { "Thought" };
        ("▸ ".to_string(), verb)
    };
    let unit = if run.steps == 1 { "step" } else { "steps" };
    Line::from(vec![
        Span::styled(marker, Style::new().cyan()),
        Span::styled(
            format!("{verb} · {} {unit}", run.steps),
            Style::new().cyan().dim(),
        ),
    ])
}

/// Live rows for the still-open tool group: a braille throbber in place of the
/// static `▸` tag, the running call's label, and elapsed time, so the user can
/// see it's actively working and how long it's taken. Rebuilt fresh every draw
/// (not stored in `transcript`) since the group's row there is only overwritten
/// on the next tool call, not every tick.
///
/// The label wraps exactly as the committed row will, so a long command is
/// readable *while* it runs -- which is when the user most wants to check what
/// they approved -- and the row does not re-lay itself out the instant the call
/// resolves. The elapsed badge is dark rather than dim cyan: at the tail of a
/// wrapped command it has to read as chrome, not as another argument.
pub(super) fn running_group_rows(group: &ToolGroup, spinner_frame: usize, width: u16) -> Vec<Line<'static>> {
    let frame = SPINNER[spinner_frame % SPINNER.len()];
    let elapsed = group.started.elapsed().as_secs();
    tool_row_lines(
        frame,
        Style::new().cyan(),
        &group.activity(),
        Style::new().cyan().dim(),
        TOOL_ROW_RESERVE,
        width,
        Some((format!("({elapsed}s)"), Style::new().dark_gray())),
    )
}

/// Live output kept per running command. Past this the front is dropped: the
/// view shows a tail, and the tool hands over the authoritative full output when
/// the call finishes.
pub(super) const LIVE_OUTPUT_MAX_BYTES: usize = 64 * 1024;

/// Rendered rows of live command output, so a long-running command fills at most
/// this much of the viewport.
pub(super) const LIVE_OUTPUT_TAIL_LINES: usize = 12;

/// Indent of the live shell panel, matching a single-call group's detail box so
/// the running command and its expanded result sit on the same column.
pub(super) const SHELL_PANEL_GUTTER: &str = "│   ";

/// The unframed prompt + output rows for a shell command. The command is the
/// first line as a `$ ` prompt, so a box around these reads as a terminal rather
/// than a detached wall of output; only a bounded tail of output is kept so a
/// chatty command cannot fill the viewport.
pub(super) fn shell_body_rows(
    command: &str,
    output: &str,
    width: u16,
    gutter: &'static str,
) -> Vec<Line<'static>> {
    let max = panel_inner(width as usize, gutter);
    let mut rows: Vec<Line<'static>> =
        wrap_text(command, Style::new().bold(), max.saturating_sub(2))
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let mut spans = vec![Span::styled(
                    if i == 0 { "$ " } else { "  " },
                    Style::new().cyan().bold(),
                )];
                spans.extend(chunk);
                Line::from(spans)
            })
            .collect();
    if !output.is_empty() {
        let all: Vec<&str> = output.lines().collect();
        let skipped = all.len().saturating_sub(LIVE_OUTPUT_TAIL_LINES);
        if skipped > 0 {
            rows.push(Line::styled(
                format!("… ({})", pluralize("earlier line", skipped)),
                Style::new().dark_gray(),
            ));
        }
        for line in &all[skipped..] {
            rows.extend(
                wrap_text(line, Style::new().dim(), max)
                    .into_iter()
                    .map(Line::from),
            );
        }
    }
    rows
}

/// The running command as a live terminal view: the framed prompt and output
/// plus a trailing status line (spinner + elapsed), so the box stands in for the
/// plain "Executing:" activity row instead of sitting beneath it. The command
/// itself types in earlier, in the in-flight box, as its argument tokens stream
/// (see `typing_terminal_lines`); by the time it runs it is shown whole.
pub(super) fn running_terminal_lines(
    command: &str,
    output: &str,
    elapsed: u64,
    spinner_frame: usize,
    width: u16,
) -> Vec<Line<'static>> {
    let mut rows = shell_body_rows(command, output, width, SHELL_PANEL_GUTTER);
    let frame = SPINNER[spinner_frame % SPINNER.len()];
    rows.push(Line::from(vec![
        Span::styled(format!("{frame} "), Style::new().cyan()),
        Span::styled(format!("{elapsed}s"), Style::new().dark_gray()),
    ]));
    boxed_panel(rows, width as usize, SHELL_PANEL_GUTTER)
}

/// The command being typed, framed like the running terminal it becomes: the
/// partial `$ command` prompt and a "typing" status line where the running box
/// shows elapsed, so dispatch is a seamless swap -- the prompt does not move,
/// only the status turns over. Shown even before the first command byte, so a
/// shell call never sits on a plain "Preparing bash" throbber.
pub(super) fn typing_terminal_lines(command: &str, frame: &str, width: u16) -> Vec<Line<'static>> {
    let mut rows = shell_body_rows(command, "", width, SHELL_PANEL_GUTTER);
    if rows.is_empty() {
        // No command bytes yet: still show the prompt so the box reads as a
        // terminal waiting for input rather than an empty frame.
        rows.push(Line::from(Span::styled("$ ", Style::new().cyan().bold())));
    }
    rows.push(Line::from(vec![
        Span::styled(format!("{frame} "), Style::new().cyan()),
        Span::styled("typing…", Style::new().dark_gray()),
    ]));
    boxed_panel(rows, width as usize, SHELL_PANEL_GUTTER)
}

/// Bucket `nouns` into read-style and run-style clauses (first-seen order,
/// counted and pluralized) and join them with the given verbs, so the verb
/// always agrees with its noun (never "Ran 1 directory").
pub(super) fn group_clauses(nouns: &[(&str, bool)], read_verb: &str, run_verb: &str) -> String {
    let mut read: Vec<(&str, usize)> = Vec::new();
    let mut run: Vec<(&str, usize)> = Vec::new();
    for &(n, is_read) in nouns {
        let bucket = if is_read { &mut read } else { &mut run };
        match bucket.iter_mut().find(|(name, _)| *name == n) {
            Some((_, c)) => *c += 1,
            None => bucket.push((n, 1)),
        }
    }
    let clause = |items: &[(&str, usize)]| {
        items
            .iter()
            .map(|(n, c)| pluralize(n, *c))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut out = String::new();
    if !read.is_empty() {
        out = format!("{read_verb} {}", clause(&read));
    }
    if !run.is_empty() {
        let verb = if out.is_empty() {
            let mut c = run_verb.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        } else {
            format!("; {run_verb}")
        };
        out.push_str(&format!("{verb} {}", clause(&run)));
    }
    out
}

/// "3 memory notes", "1 skill", "2 searches", "1 directory".
pub(super) fn pluralize(noun: &str, n: usize) -> String {
    if n == 1 {
        return format!("1 {noun}");
    }
    let plural = if let Some(stem) = noun.strip_suffix('y') {
        format!("{stem}ies")
    } else if noun.ends_with("ch") || noun.ends_with('s') {
        format!("{noun}es")
    } else {
        format!("{noun}s")
    };
    format!("{n} {plural}")
}

/// The `/agents` detail body for the subagent `run_id`: header, stats, dispatch
/// brief, and the tail of its collapsed call history that fits in `height`. An
/// agent that has finished (its panel gone) shows a short "finished" note, since
/// the inspector reads live panels only.
pub(super) fn agent_detail_lines(
    subagents: &[SubagentPanel],
    run_id: Option<&str>,
    width: u16,
    height: u16,
) -> Vec<Line<'static>> {
    let dim = Style::new().dark_gray();
    let Some(panel) = run_id.and_then(|id| subagents.iter().find(|p| p.run_id == id)) else {
        return vec![Line::styled(
            "this subagent has finished. Press Esc to go back.".to_string(),
            dim,
        )];
    };
    let max = (width.max(8) as usize).saturating_sub(2);
    let mut out = vec![Line::from(vec![
        Span::styled(panel.name.clone(), Style::new().magenta().bold()),
        Span::styled(format!("  ({})", panel.run_id), dim),
    ])];
    let mut stats = format!("{} tools · {} req", panel.calls.len(), panel.requests);
    if panel.queued {
        stats.push_str(&format!(" · queued ({})", panel.waiting));
    }
    out.push(Line::styled(stats, dim));
    if let Some(brief) = panel.task.lines().find(|l| !l.trim().is_empty()) {
        out.push(Line::from(""));
        out.extend(
            wrap_text(brief.trim(), Style::new().dim().italic(), max)
                .into_iter()
                .map(Line::from),
        );
    }
    out.push(Line::from(""));
    out.push(Line::styled("recent calls".to_string(), dim));
    if panel.calls.is_empty() {
        out.push(Line::styled("  (no tool calls yet)".to_string(), dim));
        return out;
    }
    let runs = collapse_runs(&panel.calls);
    // Reserve the rows already used plus one for a possible "+N earlier" head,
    // then show the tail so the most recent calls are the ones that survive.
    let budget = (height as usize).saturating_sub(out.len()).max(1);
    let (hidden, shown) = if runs.len() <= budget {
        (0, &runs[..])
    } else {
        let start = runs.len() - budget.saturating_sub(1);
        (start, &runs[start..])
    };
    if hidden > 0 {
        out.push(Line::styled(format!("  +{hidden} earlier"), dim));
    }
    for (label, n) in shown {
        let text = if *n > 1 {
            format!("{label} ×{n}")
        } else {
            label.clone()
        };
        let style = if *n >= STUCK_REPEAT_THRESHOLD {
            Style::new().red()
        } else {
            Style::new().dim()
        };
        out.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(truncate(&text, max), style),
        ]));
    }
    out
}

/// The info block above the detail screen's actions: aligned labels, the state
/// in colour, and the config path so "where do I edit this" is answerable
/// without leaving the screen.
pub(super) fn mcp_detail_lines(
    detail: &McpDetail,
    auth_flow: Option<&McpAuthFlow>,
    spinner: &str,
    width: u16,
) -> Vec<Line<'static>> {
    use crate::core::mcp::oauth::AuthStatus;
    let server = &detail.server;
    let dim = Style::new().dark_gray();
    let good = Style::new().green();
    let bad = Style::new().red();
    let warn = Style::new().yellow();
    let busy = Style::new().cyan().bold();

    // A sign-in in flight for *this* server takes over the Auth row and pins the
    // consent url below, so its progress is on the screen the user is looking at.
    let signing_in = auth_flow.filter(|f| f.server == server.name);

    let mut rows: Vec<(&str, Vec<Span<'static>>)> = Vec::new();

    let status = if !server.active {
        vec![Span::styled("- disabled", dim)]
    } else if server.connected {
        vec![Span::styled("✓ connected", good)]
    } else {
        vec![Span::styled("✗ not connected", bad)]
    };
    rows.push(("Status", status));

    let auth = if let Some(flow) = signing_in {
        let label = match &flow.stage {
            McpAuthStage::Discovering => "signing in - contacting the provider...",
            McpAuthStage::AwaitingRedirect => {
                "signing in - waiting for you to finish in the browser"
            }
        };
        vec![Span::styled(format!("{spinner} {label}"), busy)]
    } else {
        match &server.auth {
        AuthStatus::NotApplicable => vec![Span::styled("- not required (stdio)", dim)],
        AuthStatus::StaticHeader => {
            vec![Span::styled("✓ Authorization header (configured)", good)]
        }
        AuthStatus::Authenticated { expires_at, granted } => {
            let mut spans = vec![Span::styled("✓ authenticated", good)];
            if let Some(at) = expires_at {
                spans.push(Span::styled(
                    format!("  (expires in {})", until_label(*at)),
                    dim,
                ));
            }
            // AH-135: the authority the token carries, next to the fact that it
            // works.
            if !granted.is_empty() {
                spans.push(Span::styled(format!("  scopes: {}", granted.join(" ")), dim));
            }
            spans
        }
        AuthStatus::Expired { renewable, .. } => vec![Span::styled(
            if *renewable {
                "! expired (renewable)"
            } else {
                "! expired - re-authenticate"
            },
            warn,
        )],
        AuthStatus::StaleResource => vec![Span::styled(
            "! tokens were issued for a different url",
            warn,
        )],
        AuthStatus::ScopeMismatch { declared, requested, .. } => vec![Span::styled(
            format!(
                "! token asked for [{}], configuration declares [{}] - re-authenticate",
                requested.join(" "),
                declared.join(" ")
            ),
            warn,
        )],
        AuthStatus::InvalidScopes { detail } => {
            vec![Span::styled(format!("✗ {detail}"), bad)]
        }
        AuthStatus::Unauthenticated => vec![Span::styled("✗ not authenticated", bad)],
        }
    };
    rows.push(("Auth", auth));

    let endpoint_label = if server.transport == "stdio" {
        "Command"
    } else {
        "URL"
    };
    rows.push((
        endpoint_label,
        vec![Span::styled(server.endpoint.clone(), dim)],
    ));
    rows.push((
        "Config location",
        vec![Span::styled(tilde_path(&server.config_path), dim)],
    ));
    if let Some(implementation) = &server.implementation {
        rows.push(("Server", vec![Span::styled(implementation.clone(), dim)]));
    }
    if !server.capabilities.is_empty() {
        rows.push((
            "Capabilities",
            vec![Span::styled(server.capabilities.join(" · "), dim)],
        ));
    }
    rows.push(("Tools", vec![tools_span(&detail.tools)]));

    // One label column for every row, so the values line up the way the screen
    // is meant to read.
    let pad = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0) + 2;
    let mut out = vec![
        Line::from(Span::styled(
            server.name.clone(),
            Style::new().cyan().bold(),
        )),
        Line::raw(""),
    ];
    for (key, value) in rows {
        let mut spans = vec![Span::styled(
            format!("{key}:{}", " ".repeat(pad - key.len())),
            Style::new().bold(),
        )];
        spans.extend(value);
        out.push(clamp_line(Line::from(spans), width));
    }

    // While the redirect is pending, point at the browser prompt rather than
    // printing the consent url here: a wrapped url is click-truncated by the
    // terminal past its first line, which drops `code_challenge` and fails PKCE.
    // The confirm popup opens the full url, and skipping it copies the url into
    // the transcript instead.
    if let Some(McpAuthStage::AwaitingRedirect) = signing_in.map(|f| &f.stage) {
        out.push(Line::raw(""));
        out.push(Line::from(Span::styled(
            "Answer the browser prompt to finish signing in.",
            Style::new().bold(),
        )));
        out.push(Line::from(Span::styled(
            "Esc cancels the sign-in.",
            dim,
        )));
    }

    out.push(Line::raw(""));
    out
}

pub(super) fn tools_span(tools: &ToolsState) -> Span<'static> {
    let dim = Style::new().dark_gray();
    match tools {
        ToolsState::Unavailable => Span::styled("- connect to list", dim),
        ToolsState::Loading => Span::styled("listing...", dim),
        ToolsState::Ready(names) if names.is_empty() => Span::styled("none exposed", dim),
        ToolsState::Ready(names) => Span::styled(format!("{} tools", names.len()), dim),
        ToolsState::Failed(e) => Span::styled(e.clone(), Style::new().red()),
    }
}

/// A coarse "in 42m" / "in 3h" for a unix-second deadline. Coarse on purpose:
/// the exact second a token dies is never what the reader wants to know.
pub(super) fn until_label(expires_at: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match expires_at.saturating_sub(now) {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86400),
    }
}

/// Truncate a composed line to `width`, so a long url or path cannot push the
/// panel's border off the frame. Spans are kept whole where they fit and the
/// overflowing one is cut with an ellipsis.
///
/// Two cells short of `width` on purpose: callers pass the *inner* width of a
/// bordered panel, and a line that exactly fills it wraps into a second row,
/// which pushes the action list down by one for as long as the value is long.
///
/// Measured in display cells, not chars: a CJK server name or an emoji in a tool
/// name is two cells wide, so a char count would let it overrun the border.
pub(super) fn clamp_line(line: Line<'static>, width: u16) -> Line<'static> {
    use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

    let max = width.saturating_sub(2) as usize;
    if max == 0 {
        return Line::raw("");
    }
    let total: usize = line.spans.iter().map(|s| s.content.width()).sum();
    if total <= max {
        return line;
    }
    let mut used = 0usize;
    let mut spans: Vec<Span<'static>> = Vec::new();
    for span in line.spans {
        let len = span.content.width();
        if used + len <= max.saturating_sub(1) {
            used += len;
            spans.push(span);
            continue;
        }
        // The ellipsis takes the last cell; a wide glyph that would straddle the
        // boundary is dropped rather than half-drawn.
        let room = max.saturating_sub(used + 1);
        let mut cut = String::new();
        let mut cut_width = 0usize;
        for c in span.content.chars() {
            let w = c.width().unwrap_or(0);
            if cut_width + w > room {
                break;
            }
            cut_width += w;
            cut.push(c);
        }
        spans.push(Span::styled(format!("{cut}…"), span.style));
        break;
    }
    Line::from(spans)
}

/// Blank lines to prepend so a transcript shorter than the body viewport pins
/// to the bottom (terminal-chat feel) instead of top-anchoring with a gap
/// below. Zero once the wrapped content fills or overflows `inner_h`, so the
/// scrollback path is left untouched.
pub(super) fn transcript_top_padding(total: u16, inner_h: u16) -> u16 {
    inner_h.saturating_sub(total)
}

/// One contiguous run of body lines. A committed transcript row is held by
/// index alone, so its cached lines are cloned only when the viewport reaches
/// it; volatile content -- a running group's spinner row, expanded detail, the
/// streaming tail -- is rebuilt every frame regardless and carries its lines
/// inline.
pub(super) struct Segment {
    pub(super) idx: Option<usize>,
    pub(super) height: u16,
    pub(super) lines: Option<Vec<Line<'static>>>,
}

impl Segment {
    pub(super) fn eager(idx: Option<usize>, lines: Vec<Line<'static>>, width: u16) -> Segment {
        Segment {
            idx,
            height: wrapped_height(lines.clone(), width),
            lines: Some(lines),
        }
    }
}

/// Whether the body currently ends on a blank line, so `draw` knows if the
/// streaming tail needs a separator above it. Reads the last rendered line
/// rather than the last row's source, since a row renders to several lines.
pub(super) fn trailing_blank(tail: &[Line<'static>], transcript: &[Row], width: u16) -> bool {
    let blank = |line: &Line<'static>| line.spans.iter().all(|s| s.content.trim().is_empty());
    match tail.last() {
        Some(line) => blank(line),
        None => transcript
            .last()
            .is_none_or(|row| row.lines(width).last().is_none_or(blank)),
    }
}

/// Rows the status panel may take, given the frame it has to share. The
/// conversation is the point of the screen, so the panel is what gives way: it
/// gets what is left after the header, rule, input, dock and
/// `MIN_TRANSCRIPT_ROWS`, capped at `PANEL_MAX_ROWS`, and disappears entirely
/// on a frame with nothing to spare.
pub(super) fn panel_budget(frame_h: u16, input_h: u16) -> usize {
    // header, transcript air, rule, input, dock
    let fixed = 1 + TRANSCRIPT_BOTTOM_PAD + 1 + input_h + 1;
    frame_h
        .saturating_sub(fixed + MIN_TRANSCRIPT_ROWS)
        .min(PANEL_MAX_ROWS as u16) as usize
}

pub(super) fn draw(f: &mut Frame, app: &mut App) {
    // Cached before anything reads it: the status panel sizes the layout, so a
    // stale width would mis-size the frame a resize lands on. The body spans
    // the full frame width (its border is top-only).
    app.view_width = f.area().width.max(1);
    let prompt_owns = app.prompt_owns_screen();
    if let Some(picker) = app.model_picker.as_ref().filter(|_| !prompt_owns) {
        draw_model_picker(f, f.area(), picker, &app.model);
        return;
    }
    // Every frame, so a finished plan hides on wall-clock time even with the
    // session idle -- the loop redraws on its tick either way, and ratatui
    // emits nothing until the panel actually changes.
    app.refresh_todo_deadline();
    // Before the layout reads `scrollback`: a drag held past an edge keeps
    // pulling content into view a row per frame.
    autoscroll_selection(app);
    let input_h = input_box_height(app, f.area().width);
    // Live state -- the plan and the running fan-out -- is docked, not woven
    // into the transcript: it describes *now*, and it is what the eye wants
    // right where the typing happens. Built at most once per frame, since its
    // own height sizes the layout, and clamped to what the frame can spare so a
    // short terminal loses panel rows rather than conversation.
    let panel_lines = app
        .picker
        .is_none()
        .then(|| {
            let width = f.area().width.max(1);
            status_panel(app, width, panel_budget(f.area().height, input_h))
        })
        .filter(|l| !l.is_empty());
    let panel_h = panel_lines.as_ref().map_or(0, |l| l.len() as u16);
    // The header stays pinned at the top; the working dir/branch and the
    // transient key hints share the single row *below* the input, so the whole
    // "where am I, what's happening" block reads as one unit at the bottom edge
    // next to where the user types, instead of being split across both ends and
    // spending two rows on it. The panel sits directly above the input box --
    // the last thing in view right before where the user types, not competing
    // with the header for attention. The separator rule is its own row *below*
    // the panel (rather than the body's own bottom border) so the live state
    // reads as part of the input dock, above the line, instead of stranded
    // between the rule and the prompt. A zero-length slot collapses away, so a
    // session with neither todos nor subagents renders exactly as before.
    let raw = Layout::vertical([
        Constraint::Length(1),                     // 0: header
        Constraint::Min(1),                        // 1: body
        Constraint::Length(TRANSCRIPT_BOTTOM_PAD), // 2: air
        Constraint::Length(panel_h),               // 3: status panel
        Constraint::Length(1),                     // 4: separator rule
        Constraint::Length(input_h),               // 5: input
        Constraint::Length(1),                     // 6: path + key hints
    ])
    .split(f.area());
    let panel_area = raw[3];
    let chunks = [raw[0], raw[1], raw[5], raw[6]];

    f.render_widget(header(app), chunks[0]);
    // Drawn for every path (picker included) so the dock always reads the same.
    f.render_widget(Block::default().borders(Borders::TOP), raw[4]);

    // Top border only, so wrapping uses the full width; the border row reduces
    // the vertical viewport.
    let width = chunks[1].width.max(1);

    // The /agents inspector is a live view: rebuild its rows from the running
    // fan-out each frame so a finishing or newly-dispatched child appears
    // without reopening. Sequential borrows: read subagents, then write picker.
    if app.picker.as_ref().map(|p| p.kind) == Some(PickerKind::Agents) {
        let items = agent_picker_items(&app.subagents);
        if let Some(p) = app.picker.as_mut() {
            p.selected = p.selected.min(items.len().saturating_sub(1));
            p.items = items;
        }
    }
    // Background shell jobs can finish while the inspector is open. Rebuild
    // the rows from the same live maps that drive the footer indicator so the
    // view never leaves a collected job visible.
    if app.picker.as_ref().map(|p| p.kind) == Some(PickerKind::BackgroundShells) {
        let items = background_shell_picker_items(&app.active_bg_jobs, &app.bash_jobs);
        if let Some(p) = app.picker.as_mut() {
            p.selected = p.selected.min(items.len().saturating_sub(1));
            p.items = items;
        }
    }

    if let Some(picker) = app.picker.as_ref().filter(|_| !prompt_owns) {
        app.row_index.clear();
        let toml_path = app.agent_dir.join("agent.toml");
        draw_picker(
            f,
            chunks[1],
            picker,
            &toml_path,
            app.mcp_detail.as_ref(),
            app.mcp_auth.as_ref(),
            &app.subagents,
            app.agent_detail.as_deref(),
            app.spinner(),
        );
        f.render_widget(input_box(app), chunks[2]);
        f.render_widget(dock_line(app, chunks[3].width), chunks[3]);
        // The `/mcp` sign-in confirm lives here too: the picker path returns
        // before the overlay chain below, so without this the "open a browser?"
        // prompt never shows on the one screen that raises it.
        if let Some(confirm) = &app.browser_confirm {
            draw_browser_confirm_overlay(f, confirm, chunks[2], chunks[1]);
        }
        return;
    }

    // ---- Measure ----
    // Every committed row contributes only its *height* here, read from the row
    // cache in O(1); the rows the viewport actually shows are the only ones
    // materialized and word-wrapped, in the pass below. Laying the whole
    // session out every frame is what made a long transcript crawl: the body
    // Paragraph wrapped all of it twice (once to count, once to render), so the
    // per-frame cost tracked history rather than what was on screen.
    let mut segs: Vec<Segment> = Vec::with_capacity(app.transcript.len() + 8);
    let mut content_h: u16 = 0;
    let mut reveal_at: Option<u16> = None;
    let frame = app.spinner();
    // Traces fold their run of reasoning/tool rows to one header unless the user
    // expanded it. A finished run (an answer follows) folds whole to a static
    // `Thought/Worked` header. The active run's settled steps fold to a live
    // `Thinking/Working` header, leaving only the current step (the running box /
    // live tail) below -- the condensed live view. The `bool` is that live flag.
    let last_answer = app.last_answer_idx();
    let mut collapsed_headers: HashMap<usize, (TraceRun, bool)> = HashMap::new();
    for run in app.trace_runs() {
        if last_answer.is_some_and(|a| run.end < a) && !app.expanded_traces.contains(&run.start) {
            collapsed_headers.insert(run.start, (run, false));
        }
    }
    if let Some(run) = app.active_fold() {
        if !app.expanded_traces.contains(&run.start) {
            collapsed_headers.insert(run.start, (run, true));
        }
    }
    let hidden_trace_rows: std::collections::HashSet<usize> = collapsed_headers
        .values()
        .flat_map(|(r, _)| (r.start + 1)..=r.end)
        .collect();
    for (i, row) in app.transcript.iter().enumerate() {
        // A collapsed trace shows a single header at its start and hides the
        // rest of its rows.
        if hidden_trace_rows.contains(&i) {
            continue;
        }
        if let Some((run, active)) = collapsed_headers.get(&i) {
            let line = trace_header_line(run, *active, frame);
            let seg = Segment::eager(Some(i), vec![line], width);
            if app.reveal == Some(i) {
                reveal_at = Some(content_h);
            }
            content_h = content_h.saturating_add(seg.height);
            segs.push(seg);
            continue;
        }
        if app.reveal == Some(i) {
            reveal_at = Some(content_h);
        }
        // Every committed row re-renders at the current width, so a resize
        // re-flows prose, re-boxes diffs and re-truncates labels. The running
        // group's row animates, so it can never come from the row cache.
        let seg = match app
            .tool_group
            .as_ref()
            .filter(|g| g.idx == i && g.is_running())
        {
            Some(g) => {
                // A running command that has started printing renders as a live
                // terminal box (prompt + streaming output + spinner/elapsed),
                // which stands in for the plain "Executing:" activity row. Every
                // other running call -- and a command still inside its grace
                // window -- keeps that row.
                let panel = app.live_shell_panel(g, app.spinner_frame, width);
                let rows = if panel.is_empty() {
                    running_group_rows(g, app.spinner_frame, width)
                } else {
                    panel
                };
                Segment::eager(Some(i), rows, width)
            }
            None => Segment {
                idx: Some(i),
                height: row.height(width),
                lines: None,
            },
        };
        content_h = content_h.saturating_add(seg.height);
        segs.push(seg);
        if app.expanded.contains(&i) {
            // Detail rows map back to the same owning idx (not `None`), so a
            // click anywhere in an expanded block collapses it -- not just on
            // its header row, which may have scrolled out of view once the
            // block grew past the viewport (long reasoning, many tool calls).
            let running_group = app.tool_group.as_ref().filter(|g| g.idx == i);
            let detail = app
                .groups
                .iter()
                .find(|g| g.idx == i)
                // The still-running group isn't finalized into `groups` yet,
                // but its row is already clickable/expandable like any other.
                .or(running_group)
                .map(|group| group_detail_lines(group, width))
                .or_else(|| {
                    app.reasoning_blocks
                        .iter()
                        .find(|r| r.idx == i)
                        .map(|block| block.detail.clone())
                })
                .or_else(|| {
                    app.subagent_blocks
                        .iter()
                        .find(|b| b.idx == i)
                        .map(|block| block.detail_lines(width))
                });
            if let Some(detail) = detail {
                let seg = Segment::eager(Some(i), detail, width);
                content_h = content_h.saturating_add(seg.height);
                segs.push(seg);
            }
        }
    }

    // Streaming prose and the awaiting throbbers have no transcript index; they
    // are rebuilt every frame and ride along as one trailing segment.
    let mut tail: Vec<Line<'static>> = Vec::new();
    if !app.assistant_buf.is_empty() || !app.reasoning_segs.is_empty() {
        // Native reasoning is placed beside the live prose by its offset, so the
        // shared renderer dims/folds it exactly like inline-tag providers.
        let live = live_assistant_lines(
            &app.assistant_buf,
            &app.reasoning_segs,
            width,
            !app.show_reasoning,
            app.stream_reasoning,
        );
        if !live.is_empty() {
            // Mirror `gap` so the separator above the live block matches what
            // its commit will emit: a band change (prose after a tool call) gets
            // a blank, but streaming reasoning shares the tool band and gets
            // none, so a tool call runs straight into the reasoning below it.
            let leading = live_leading_kind(&app.assistant_buf, &app.reasoning_segs)
                .unwrap_or(Kind::Prose);
            if band(app.last_kind) != band(leading)
                && !trailing_blank(&tail, &app.transcript, width)
            {
                tail.push(Line::raw(""));
            }
            // Live tail: same renderer as finalized messages, so an open
            // (unterminated) wrapped reasoning block dims and grows during streaming.
            tail.extend(live);
        }
    }
    // Awaiting throbbers render last: below the assistant's reasoning/message
    // so the "still waiting" state trails the prose that led up to the wait.
    // A child with a live panel already shows its own throbber in the fan-out
    // block, so only orphaned waits (the child ended, its result has not
    // landed) get a row -- otherwise every parallel dispatch is listed twice.
    let orphaned: Vec<&String> = app
        .awaiting
        .iter()
        .filter(|(_, run_id, _)| !app.subagents.iter().any(|p| &p.run_id == run_id))
        .map(|(_, _, name)| name)
        .collect();
    // These throbbers are tool-band rows, so they only need a separator when the
    // row above is a different band. After reasoning or a tool call (both the
    // tool band) they run straight on; only answer prose (or a user/meta line)
    // above them earns a blank. What precedes is the live tail if one rendered,
    // else the last committed row.
    let preceding_kind = if tail.is_empty() {
        app.last_kind
    } else {
        live_trailing_kind(&app.assistant_buf, &app.reasoning_segs).unwrap_or(Kind::Prose)
    };
    if (!orphaned.is_empty() || !app.starting.is_empty())
        && band(preceding_kind) != band(Kind::Tool)
        && !trailing_blank(&tail, &app.transcript, width)
    {
        tail.push(Line::raw(""));
    }
    for name in orphaned {
        tail.push(tool_row(
            frame,
            Style::new().cyan(),
            &format!("Awaiting subagent: {name}"),
            Style::new().cyan().dim(),
        ));
    }
    // In-progress tool calls whose arguments are still streaming: a throbber
    // trails the prose until the full call (with args) arrives and renders its
    // own row.
    for call in &mut app.starting {
        tail.extend(starting_call_lines(call, frame, width));
    }
    if !tail.is_empty() {
        let seg = Segment::eager(None, tail, width);
        content_h = content_h.saturating_add(seg.height);
        segs.push(seg);
    }

    // TOP border only: the rule under the transcript is now its own row below
    // the todo HUD (see the layout above), not this block's bottom border.
    let inner_h = chunks[1].height.saturating_sub(1);
    let pad = transcript_top_padding(content_h, inner_h);
    if pad > 0 {
        segs.insert(
            0,
            Segment {
                idx: None,
                height: pad,
                lines: Some(vec![Line::raw(""); pad as usize]),
            },
        );
        reveal_at = reveal_at.map(|n| n.saturating_add(pad));
    }
    let total = content_h.saturating_add(pad);
    let max_back = total.saturating_sub(inner_h);
    if let Some(target) = reveal_at {
        // Position the region near the top of the viewport; clamps to pinned
        // bottom when it is already close enough to the end.
        app.scrollback = max_back.saturating_sub(target);
    }
    app.reveal = None;
    app.scrollback = app.scrollback.min(max_back);
    let scroll = max_back - app.scrollback;

    // ---- Materialize the visible window ----
    // Only segments overlapping [scroll, scroll + inner_h) are cloned, so the
    // Paragraph below wraps a viewport's worth of lines instead of the session.
    let end = scroll.saturating_add(inner_h);
    let mut visible: Vec<Line<'static>> = Vec::new();
    // Parallel to the *screen* rows of the body, in wrapped coordinates: which
    // transcript index (if any) owns each one, so a mouse click can be mapped
    // back to a region to toggle.
    let mut row_index: Vec<Option<usize>> = Vec::with_capacity(inner_h as usize);
    let mut first_start: Option<u16> = None;
    let mut at: u16 = 0;
    for seg in segs {
        let seg_end = at.saturating_add(seg.height);
        if seg_end > scroll && at < end {
            first_start.get_or_insert(at);
            visible.extend(match seg.lines {
                Some(lines) => lines,
                // Committed rows are cloned out of the cache only here.
                None => seg
                    .idx
                    .and_then(|i| app.transcript.get(i))
                    .map(|row| row.lines(width))
                    .unwrap_or_default(),
            });
            let visible_rows = seg_end.min(end).saturating_sub(at.max(scroll));
            row_index.extend(std::iter::repeat_n(seg.idx, visible_rows as usize));
        }
        at = seg_end;
        if at >= end {
            break;
        }
    }
    row_index.resize(inner_h as usize, None);

    // What the body still has to skip inside the first partially-scrolled
    // segment; everything before it was never materialized.
    let offset = scroll.saturating_sub(first_start.unwrap_or(scroll));
    let body = Paragraph::new(visible)
        .wrap(Wrap { trim: false })
        .block(Block::default().borders(Borders::TOP));
    f.render_widget(body.scroll((offset, 0)), chunks[1]);
    // The anchor is a screen cell, so content moving under it has to move it
    // too, or an auto-scrolled drag would keep re-selecting the same rows.
    if let Some(sel) = app.selection.as_mut().filter(|s| s.dragging) {
        let delta = scroll as i32 - app.last_scroll as i32;
        if delta != 0 {
            sel.anchor.1 = (sel.anchor.1 as i32 - delta).clamp(0, u16::MAX as i32) as u16;
            sel.moved = true;
        }
    }
    app.transcript_rect = chunks[1];
    app.last_scroll = scroll;
    app.row_index = row_index;

    // Keep the caret row visible when the input outgrows the box, wherever the
    // caret is and whether or not a turn is running (steering types here too),
    // and put the terminal's own cursor on it so an IME composes at the caret.
    let mut input_scroll = 0u16;
    let mut caret_at = None;
    if composer_live(app) && chunks[2].width > 0 {
        let visible = chunks[2].height.saturating_sub(1);
        let (total, col, row) = composer_caret(&app.input, app.cursor, chunks[2].width);
        input_scroll = row.saturating_sub(visible.saturating_sub(1)).min(total.saturating_sub(visible));
        if visible > 0 && app.context_view.is_none() {
            caret_at = Some((chunks[2].x + col, chunks[2].y + row - input_scroll));
        }
    }
    if let Some(lines) = panel_lines {
        f.render_widget(Paragraph::new(lines), panel_area);
    }
    f.render_widget(input_box(app).scroll((input_scroll, 0)), chunks[2]);
    if let Some(at) = caret_at {
        f.set_cursor_position(at);
    }
    f.render_widget(dock_line(app, chunks[3].width), chunks[3]);
    // The `/context` overlay renders on top of (never instead of) the finished
    // frame, so the spinner and streamed output keep animating behind it
    // mid-turn. A centered bordered popup over the body, titled like the
    // pickers, with the readout re-laid out by the same `context_lines` the
    // old transcript row used - the numbers and layout are unchanged, only the
    // surface (a popup the user closes with Esc) differs. The rect is clamped
    // to the frame and never indexes a zero-width/zero-height area, so it
    // stays correct at tiny terminal sizes.
    if let Some(view) = &app.context_view {
        let body = chunks[1];
        // The rect is sized before the content, because the readout's height
        // depends on the width it is laid out at. Borders cost two columns and
        // two rows, so the content width is the popup's inner width -- laying
        // out at the popup's *outer* width would push the rail's right edge
        // under the border and silently clip it.
        let outer_w = body.width.saturating_sub(2).max(1);
        let content_w = outer_w.saturating_sub(2).max(1);
        let lines: Vec<Line<'static>> = match view {
            ContextView::Loading => vec![Line::raw("computing context...")],
            ContextView::Ready(report) => context_lines(report, content_w as usize),
        };
        // Two rows for the borders. A frame too short to hold the whole readout
        // gets as much of it as fits rather than nothing.
        let height = (lines.len() as u16 + 2).min(body.height);
        let rect = ratatui::layout::Rect {
            x: body.x + body.width.saturating_sub(outer_w) / 2,
            y: body.y + body.height.saturating_sub(height) / 2,
            width: outer_w,
            height,
        };
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::new().cyan())
            .title(Span::styled(
                " context ",
                Style::new().on_cyan().black().bold(),
            ));
        let inner = block.inner(rect);
        // A frame with no room for the popup draws nothing -- and must still
        // fall through to the prompts below, so this never returns from `draw`.
        if rect.width > 0 && rect.height > 0 {
            f.render_widget(ratatui::widgets::Clear, rect);
            f.render_widget(block, rect);
        }
        if inner.width > 0 && inner.height > 0 {
            f.render_widget(Paragraph::new(lines), inner);
        }
    }

    // Login prompts are modal and user-initiated (only reachable while idle), so
    // they outrank the queues below: nothing else may take keystrokes meant for
    // a secret.
    if let Some(prompt) = &app.login {
        let height = (LOGIN_PROMPT_ROWS + u16::from(prompt.error.is_some())).min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_login(f, rect, prompt);
    } else if let Some(confirm) = &app.browser_confirm {
        draw_browser_confirm_overlay(f, confirm, chunks[2], chunks[1]);
    } else if let Some(prompt) = &app.settings_prompt {
        let toml_path = app.agent_dir.join("agent.toml");
        let height = (settings_prompt_lines(prompt, &toml_path, chunks[2].width.saturating_sub(2))
            .len() as u16
            + 2)
        .min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_settings_prompt(f, rect, prompt, &toml_path);
    } else if let Some(prompt) = &app.mcp_prompt {
        let height = (mcp_prompt_lines(prompt, chunks[2].width.saturating_sub(2)).len() as u16 + 2)
            .min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_mcp_prompt(f, rect, prompt);
    } else if let Some(prompt) = &app.provider_prompt {
        let height = (4 + 3 + u16::from(prompt.error.is_some())).min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_provider_prompt(f, rect, prompt);
    } else if !app.ask_queue.is_empty() {
        let queue_len = app.ask_queue.len();
        let ask = app.ask_queue.front_mut().expect("checked non-empty above");
        let height = ask.box_height(chunks[2].width).min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_ask(f, rect, ask, queue_len);
    } else if let Some(pending) = app.pending() {
        let inner_w = chunks[2].width.saturating_sub(2);
        let detail_rows = pending.detail_lines(inner_w).len() as u16;
        let diff_rows = pending.diff_preview(inner_w).len() as u16;
        let height =
            (pending.options().len() as u16 + detail_rows + diff_rows + 2).min(chunks[1].height);
        let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
        let rect = ratatui::layout::Rect {
            x: chunks[2].x,
            y,
            width: chunks[2].width,
            height,
        };
        draw_permission(f, rect, pending, app.pending_queue.len());
    } else {
        // Dock the slash-command hints above the input box, growing upward
        // and clamped to the body so they never overrun the transcript.
        let matches = app.slash_matches();
        if !matches.is_empty() {
            let height = (matches.len() as u16 + 2).min(chunks[1].height);
            let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
            let rect = ratatui::layout::Rect {
                x: chunks[2].x,
                y,
                width: chunks[2].width,
                height,
            };
            draw_slash_hints(f, rect, &matches, app.slash_selected);
        } else if app.has_path_hints() {
            let height = (app.path_hints.len() as u16 + 2).min(chunks[1].height);
            let y = chunks[2].y.saturating_sub(height).max(chunks[1].y);
            let rect = ratatui::layout::Rect {
                x: chunks[2].x,
                y,
                width: chunks[2].width,
                height,
            };
            draw_path_hints(f, rect, &app.path_hints, app.path_hint_selected);
        }
    }

    // Last, over the finished frame, so the highlight covers every surface --
    // transcript, dock, overlays -- without each having to know about it.
    if let Some(sel) = app.selection {
        let area = f.area();
        let buf = f.buffer_mut();
        if std::mem::take(&mut app.copy_armed) {
            let text = selection_text(buf, sel, area);
            if !text.trim().is_empty() {
                app.copied = Some((Instant::now(), text.lines().count()));
                app.copy_request = Some(text);
            }
        }
        for (row, c0, c1) in sel.spans(area.width) {
            for col in c0..=c1 {
                if let Some(cell) = buf.cell_mut((col, row)) {
                    let style = cell.style().add_modifier(Modifier::REVERSED);
                    cell.set_style(style);
                }
            }
        }
    }
}

pub(super) fn draw_ask(f: &mut Frame, area: Rect, ask: &mut PendingAsk, queue_len: usize) {
    use ratatui::widgets::{Clear, List, ListItem, ListState};

    let dim = Style::new().dark_gray();
    // Whole seconds until the auto-select deadline, rounded up (ceil) so a
    // still-live prompt reads `1s` rather than `0s`. `None` once the deadline
    // has passed (the resolution event is imminent or already dropped this
    // prompt) or when no timeout is configured.
    let mut parts = vec![format!(
        "question {}/{}",
        ask.question_index + 1,
        ask.request.questions.len()
    )];
    if queue_len > 1 {
        parts.push(format!("request 1/{queue_len}"));
    }
    if let Some(secs) = ask.remaining_secs(std::time::Instant::now()) {
        parts.push(format!("{secs}s"));
    }
    let title = format!(" {} ", parts.join(" \u{b7} "));
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(title, Style::new().on_cyan().black().bold()));
    let inner = block.inner(area);
    let question = ask.question_lines(inner.width);
    let items = ask.option_lines(inner.width);
    let heights: Vec<u16> = items.iter().map(|item| item.len() as u16).collect();
    let rows = Layout::vertical([
        Constraint::Length(question.len() as u16),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(inner);

    f.render_widget(Clear, area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(question), rows[0]);

    let list = List::new(items.into_iter().map(ListItem::new).collect::<Vec<_>>())
        .highlight_style(select_style())
        .highlight_symbol(SELECT_MARK);
    let mut state = ListState::default();
    state.select(Some(ask.selected));
    f.render_stateful_widget(list, rows[1], &mut state);

    // Hitboxes come from the same heights the list just laid out, offset by the
    // scroll the list chose to keep the selection visible -- an item may be
    // several rows tall, and a box clamped to the space above the input may not
    // show every item at all.
    ask.rect = area;
    ask.row_hitboxes.clear();
    let mut y = rows[1].y;
    let bottom = rows[1].y.saturating_add(rows[1].height);
    for (index, height) in heights.iter().enumerate().skip(state.offset()) {
        for _ in 0..*height {
            if y >= bottom {
                break;
            }
            ask.row_hitboxes.push((y, index));
            y = y.saturating_add(1);
        }
    }

    let help = if ask.editing_custom {
        Line::from(vec![
            Span::styled("Other: ", Style::new().cyan()),
            Span::raw(ask.custom_input.clone()),
            Span::styled("\u{2588}", Style::new().cyan()),
        ])
    } else {
        Line::styled(
            if ask.question().multi {
                "\u{2191}\u{2193} move \u{b7} Space toggle \u{b7} Enter choose \u{b7} \u{2190}\u{2192} question \u{b7} Esc cancel"
            } else {
                "\u{2191}\u{2193} move \u{b7} Enter choose \u{b7} \u{2190}\u{2192} question \u{b7} Esc cancel"
            },
            dim,
        )
    };
    f.render_widget(Paragraph::new(help), rows[2]);
}

/// Rows the `/login` box needs: two borders, the URL, the field, and the help
/// line. An error adds one more (see the `draw` call site).
pub(super) const LOGIN_PROMPT_ROWS: u16 = 5;

/// The `/login` prompt: the API-keys URL, a masked key field, and a help line.
/// The key is never rendered, so a shared screen or scrollback capture cannot
/// leak it.
/// The `/login` box's contents at `width`. Separate from `draw_login` so the
/// call site can size the box from the rows it will actually need: the error
/// carries an arbitrary-length upstream message, and it is the one line in
/// there the user has to be able to read.
pub(super) fn login_prompt_lines(prompt: &LoginPrompt, width: u16) -> Vec<Line<'static>> {
    let dim = Style::new().dark_gray();
    let max = width.max(1) as usize;
    let lead = match &prompt.stage {
        LoginStage::Connecting => vec![Span::styled("starting browser sign-in...", dim)],
        LoginStage::Approving { authorize_url, .. } => vec![
            Span::styled("approve at ", dim),
            Span::styled(authorize_url.clone(), Style::new().cyan()),
        ],
        LoginStage::Paste { .. } => {
            let keys_url = crate::core::cli::auth::provider_by_id(&prompt.provider)
                .map_or("", |provider| provider.api_key.keys_url);
            vec![
                Span::styled("get a key at ", dim),
                Span::styled(keys_url.to_string(), Style::new().cyan()),
            ]
        }
    };
    let mut lines: Vec<Line<'static>> = wrap_spans_hard(lead, max)
        .into_iter()
        .map(Line::from)
        .collect();
    // The code is the one thing the user must compare against the browser, so
    // it gets its own bright line rather than riding the URL's wrap.
    if let LoginStage::Approving { user_code, .. } = &prompt.stage {
        lines.push(Line::from(vec![
            Span::styled("code: ", dim),
            Span::styled(user_code.clone(), Style::new().cyan().bold()),
        ]));
    }
    if let Some(error) = &prompt.error {
        lines.extend(
            wrap_text(error, Style::new().red(), max)
                .into_iter()
                .map(Line::from),
        );
    }
    // The browser question, whichever stage is asking it, reads the same.
    if prompt.unconfirmed_url().is_some() {
        lines.push(Line::styled(
            "open this page in your browser?".to_string(),
            Style::new().yellow(),
        ));
        lines.push(Line::styled(
            "Enter open · n skip · Esc cancel".to_string(),
            dim,
        ));
        return lines;
    }
    match &prompt.stage {
        LoginStage::Connecting => lines.push(Line::styled("Esc cancel".to_string(), dim)),
        LoginStage::Approving { .. } => {
            lines.push(Line::styled(
                "waiting for approval...".to_string(),
                Style::new().yellow(),
            ));
            lines.push(Line::styled(
                "approve from any device · Esc cancel".to_string(),
                dim,
            ));
        }
        LoginStage::Paste { .. } if prompt.verifying => {
            lines.push(Line::styled(
                "verifying...".to_string(),
                Style::new().yellow(),
            ));
            lines.push(Line::styled("Esc cancel".to_string(), dim));
        }
        LoginStage::Paste { .. } => {
            lines.extend(field_lines(
                vec![Span::styled("API key: ", Style::new().bold())],
                &prompt.masked(),
                Style::new(),
                max,
            ));
            lines.push(Line::styled(
                "paste the key · Enter verify · Esc cancel".to_string(),
                dim,
            ));
        }
    }
    lines
}

/// One edited field: `lead` (a label) then the value wrapped beneath it,
/// continuations aligned under the value rather than under the label, with the
/// cursor block on the last row. Shared by the `/login`, `/settings` and MCP
/// prompts -- a value long enough to leave the box is exactly the one the user
/// needs to see, since they are still typing it.
pub(super) fn field_lines(
    lead: Vec<Span<'static>>,
    value: &str,
    value_style: Style,
    width: usize,
) -> Vec<Line<'static>> {
    let lead_w: usize = lead.iter().map(|s| s.content.chars().count()).sum();
    let mut rows = wrap_text(value, value_style, width.saturating_sub(lead_w + 1).max(1));
    rows.last_mut()
        .expect("wrap_text yields at least one row")
        .push(Span::styled("█", Style::new().cyan()));
    gutter_lines(rows, lead, vec![Span::raw(" ".repeat(lead_w))])
}

/// The pending-browser box's contents at `width`, sized by the caller the same
/// way as `login_prompt_lines` -- the URL is the long line that has to be
/// readable, since declining means opening it by hand.
pub(super) fn browser_confirm_lines(confirm: &BrowserConfirm, width: u16) -> Vec<Line<'static>> {
    let dim = Style::new().dark_gray();
    let max = width.max(1) as usize;
    let mut lines: Vec<Line<'static>> = wrap_spans_hard(
        vec![
            Span::styled(format!("{} at ", confirm.purpose), dim),
            Span::styled(confirm.url.clone(), Style::new().cyan()),
        ],
        max,
    )
    .into_iter()
    .map(Line::from)
    .collect();
    lines.push(Line::styled(
        "open this page in your browser?".to_string(),
        Style::new().yellow(),
    ));
    lines.push(Line::styled(
        "Enter open · n skip · Esc skip".to_string(),
        dim,
    ));
    lines
}

/// Draw the "open a browser?" popup above the input. Shared by the normal
/// transcript view and the picker view (the `/mcp` screen), which returns early
/// from `draw` and would otherwise never render it -- leaving the user to click a
/// wrapped, click-truncated consent url instead of pressing Enter here.
pub(super) fn draw_browser_confirm_overlay(
    f: &mut Frame,
    confirm: &BrowserConfirm,
    input: ratatui::layout::Rect,
    body: ratatui::layout::Rect,
) {
    let height = (browser_confirm_lines(confirm, input.width.saturating_sub(2)).len() as u16 + 2)
        .min(body.height);
    let y = input.y.saturating_sub(height).max(body.y);
    let rect = ratatui::layout::Rect {
        x: input.x,
        y,
        width: input.width,
        height,
    };
    draw_browser_confirm(f, rect, confirm);
}

pub(super) fn draw_browser_confirm(f: &mut Frame, area: ratatui::layout::Rect, confirm: &BrowserConfirm) {
    use ratatui::widgets::Clear;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(
            " open a browser? ",
            Style::new().on_cyan().black().bold(),
        ));

    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(
        Paragraph::new(browser_confirm_lines(confirm, inner.width)),
        inner,
    );
}

pub(super) fn draw_login(f: &mut Frame, area: ratatui::layout::Rect, prompt: &LoginPrompt) {
    use ratatui::widgets::Clear;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(
            format!(
                " {} sign-in ",
                crate::core::cli::auth::provider_by_id(&prompt.provider)
                    .map_or("provider", |definition| definition.name)
            ),
            Style::new().on_cyan().black().bold(),
        ));

    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(
        Paragraph::new(login_prompt_lines(prompt, inner.width)),
        inner,
    );
}

/// Docked `/settings` edit prompt, styled like the `/login` dock: description,
/// the current on-disk value, the field being edited, an inline validation
/// error when one fired, and the save/cancel keys.
pub(super) fn draw_settings_prompt(
    f: &mut Frame,
    area: ratatui::layout::Rect,
    prompt: &SettingsPrompt,
    toml_path: &std::path::Path,
) {
    use ratatui::widgets::Clear;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(
            format!(" agent settings: {} ", prompt.def().key),
            Style::new().on_cyan().black().bold(),
        ));

    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(
        Paragraph::new(settings_prompt_lines(prompt, toml_path, inner.width)),
        inner,
    );
}

/// The `/settings` box's contents at `width`, sized by the call site the same
/// way as `login_prompt_lines`. The description, the current value and the
/// enum `valid:` list are all long enough to leave a narrow box.
pub(super) fn settings_prompt_lines(
    prompt: &SettingsPrompt,
    toml_path: &std::path::Path,
    width: u16,
) -> Vec<Line<'static>> {
    let dim = Style::new().dark_gray();
    let def = prompt.def();
    let max = width.max(1) as usize;
    let wrapped = |spans: Vec<Span<'static>>| {
        wrap_spans_hard(spans, max)
            .into_iter()
            .map(Line::from)
            .collect::<Vec<_>>()
    };

    let mut lines = wrapped(vec![
        Span::styled(def.desc, dim),
        Span::styled("   current: ", dim),
        Span::styled(
            current_agent_value(toml_path, def.key).unwrap_or_else(|| "unset".to_string()),
            Style::new().cyan(),
        ),
    ]);
    let meta = match def.kind {
        AgentSettingKind::Int { default, min } => {
            let d = default
                .map(|d| d.to_string())
                .unwrap_or_else(|| "unset".to_string());
            format!("default: {d} · valid: >= {min}")
        }
        AgentSettingKind::Glyph { default, max } => {
            format!("default: {default} · valid: up to {max} chars, empty = off")
        }
        AgentSettingKind::Text { default } => format!("default: {default}"),
        AgentSettingKind::Enum { options, default } => {
            format!("default: {default} · valid: {}", options.join(" | "))
        }
        AgentSettingKind::Bool { default } => {
            format!("default: {default} · valid: true | false")
        }
    };
    lines.extend(wrapped(vec![Span::styled(meta, dim)]));
    if let Some(error) = &prompt.error {
        lines.extend(wrapped(vec![Span::styled(
            error.clone(),
            Style::new().red(),
        )]));
    }
    lines.extend(field_lines(
        vec![Span::styled("value: ", Style::new().bold())],
        &prompt.input,
        Style::new(),
        max,
    ));
    lines.push(Line::styled(
        "Enter save · Esc cancel · clear field to unset (default applies)".to_string(),
        dim,
    ));
    lines
}

/// Dock the MCP add/edit wizard above the input: one row per visible field,
/// the active field highlighted, with a toggle marker on transport/active.
pub(super) fn draw_mcp_prompt(f: &mut Frame, area: ratatui::layout::Rect, prompt: &McpPrompt) {
    use ratatui::widgets::Clear;

    let title = if prompt.editing.is_some() {
        " mcp server: edit "
    } else {
        " mcp server: add "
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(title, Style::new().on_cyan().black().bold()));

    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(mcp_prompt_lines(prompt, inner.width)), inner);
}

/// The MCP wizard's contents at `width`, sized by the call site the same way as
/// `login_prompt_lines`. These fields are being *typed*: a command line, an
/// args string or an env/headers blob easily outruns the box, and clipping the
/// field you are editing leaves no way to see what you entered.
pub(super) fn mcp_prompt_lines(prompt: &McpPrompt, width: u16) -> Vec<Line<'static>> {
    let dim = Style::new().dark_gray();
    let max = width.max(1) as usize;
    let mut lines = Vec::new();
    for field in prompt.visible_fields() {
        let selected = field == prompt.field;
        let (label, value, toggle) = match field {
            McpField::Name => ("name", prompt.name.as_str(), None),
            McpField::Transport => (
                "type",
                prompt.transport.as_str(),
                Some(prompt.transport.as_str()),
            ),
            McpField::Command => ("command", prompt.command.as_str(), None),
            McpField::Args => ("args", prompt.args.as_str(), None),
            McpField::Env => ("env", prompt.env.as_str(), None),
            McpField::Url => ("url", prompt.url.as_str(), None),
            McpField::Headers => ("headers", prompt.headers.as_str(), None),
            McpField::Active => (
                "active",
                if prompt.active { "yes" } else { "no" },
                Some(if prompt.active { "yes" } else { "no" }),
            ),
        };
        let marker = if selected { "› " } else { "  " };
        let style = if selected { Style::new().bold() } else { dim };
        let lead = vec![Span::styled(format!("{marker}{label}: "), style)];
        match toggle {
            // A toggle row is a fixed word, never typed into: no cursor, and
            // nothing long enough to wrap.
            Some(toggle) => {
                let mut spans = lead;
                spans.push(Span::styled(
                    toggle.to_string(),
                    if selected { Style::new().cyan() } else { dim },
                ));
                lines.push(Line::from(spans));
            }
            None if selected => lines.extend(field_lines(lead, value, style, max)),
            None => {
                let lead_w: usize = lead.iter().map(|s| s.content.chars().count()).sum();
                lines.extend(gutter_lines(
                    wrap_text(value, style, max.saturating_sub(lead_w).max(1)),
                    lead,
                    vec![Span::raw(" ".repeat(lead_w))],
                ));
            }
        }
    }
    if let Some(error) = &prompt.error {
        lines.extend(
            wrap_text(error, Style::new().red(), max)
                .into_iter()
                .map(Line::from),
        );
    }
    lines.push(Line::styled(
        "↑/↓ move · Enter save · Space toggle · Esc cancel".to_string(),
        dim,
    ));
    lines
}

/// Dock the provider add/edit wizard above the input: one row per field, the
/// active field highlighted, with the API key masked so it never reaches the
/// screen or scrollback.
pub(super) fn draw_provider_prompt(f: &mut Frame, area: ratatui::layout::Rect, prompt: &ProviderPrompt) {
    use ratatui::widgets::Clear;

    let dim = Style::new().dark_gray();
    let title = if prompt.editing.is_some() {
        " provider: edit "
    } else {
        " provider: add "
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(title, Style::new().on_cyan().black().bold()));

    let mut lines = Vec::new();
    for field in ProviderPrompt::FIELD_ORDER {
        let read_only = prompt.editing.is_some() && field == ProviderField::Name;
        let selected = field == prompt.field && !read_only;
        let (label, value): (&str, String) = match field {
            ProviderField::Name => ("name", prompt.name.clone()),
            ProviderField::BaseUrl => ("base url", prompt.base_url.clone()),
            ProviderField::ApiType => ("api type", prompt.api_type_label()),
            ProviderField::ApiKey => ("api key", prompt.masked_key()),
            ProviderField::Models => ("models", prompt.models.clone()),
        };
        let marker = if selected { "› " } else { "  " };
        let style = if selected {
            Style::new().bold()
        } else if read_only {
            // A renamed provider would orphan its config entry and lose the
            // API key, so the name is fixed while editing.
            Style::new().dark_gray()
        } else {
            dim
        };
        let mut spans = vec![Span::styled(format!("{marker}{label}: "), style)];
        spans.push(Span::styled(value, style));
        if selected {
            spans.push(Span::styled("█", Style::new().cyan()));
        }
        lines.push(Line::from(spans));
    }
    if let Some(error) = &prompt.error {
        lines.push(Line::styled(error.clone(), Style::new().red()));
    }
    let hint = if prompt.editing.is_some() {
        "↑/↓ move · Enter save · Esc cancel (api key: type to replace, blank out to clear)"
    } else {
        "↑/↓ move · Enter save · Esc cancel (on api type: Left/Right toggles openai/anthropic)"
    };
    lines.push(Line::styled(hint.to_string(), dim));

    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(lines), inner);
}

/// the highlighted row reversed. Docked above the input box.
/// Slash hint popup: one row per match (`/name [hint]  description`), the
/// highlighted row reversed. Built-in commands render cyan; installed project
/// skills render magenta so a `/deploy` completion is distinguishable from a
/// command at a glance. Docked above the input box.
pub(super) fn draw_slash_hints(
    f: &mut Frame,
    area: ratatui::layout::Rect,
    matches: &[SlashMatch],
    selected: usize,
) {
    use ratatui::widgets::{Clear, List, ListItem, ListState};

    let dim = Style::new().dark_gray();
    let items: Vec<ListItem> = matches
        .iter()
        .map(|m| match m {
            SlashMatch::Command(c) => {
                let mut spans = vec![Span::styled(c.name, Style::new().cyan().bold())];
                if !c.hint.is_empty() {
                    spans.push(Span::styled(format!(" {}", c.hint), dim));
                }
                let desc = match c.alias_of {
                    Some(canonical) => format!("alias of {canonical}; {}", c.description),
                    None => c.description.to_string(),
                };
                spans.push(Span::styled(format!("  {desc}"), dim));
                ListItem::new(Line::from(spans))
            }
            SlashMatch::PluginCommand {
                name,
                description,
                hints,
            } => {
                let desc = if description.is_empty() {
                    "plugin command".to_string()
                } else {
                    description.clone()
                };
                let mut spans = vec![
                    Span::styled(name.clone(), Style::new().green().bold()),
                    Span::styled(format!("  {desc}"), dim),
                ];
                if !hints.is_empty() {
                    spans.push(Span::styled(
                        format!("  [{}]", hints.join(" ")),
                        Style::new().dark_gray(),
                    ));
                }
                ListItem::new(Line::from(spans))
            }
            SlashMatch::Skill { name, description } => {
                let desc = if description.is_empty() {
                    "project skill".to_string()
                } else {
                    description.clone()
                };
                ListItem::new(Line::from(vec![
                    Span::styled(name.clone(), Style::new().magenta().bold()),
                    Span::styled(format!("  {desc}"), dim),
                ]))
            }
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().dark_gray())
        .title(Span::styled(" commands + skills ", Style::new().dim()));
    f.render_widget(Clear, area);
    let list = List::new(items)
        .block(block)
        .highlight_style(select_style())
        .highlight_symbol(SELECT_MARK);
    let mut state = ListState::default();
    state.select(Some(selected.min(matches.len().saturating_sub(1))));
    f.render_stateful_widget(list, area, &mut state);
}

/// File-path hint popup docked above the input when typing `@query`.
/// Shows matching files/directories; arrow keys to navigate, Tab/Enter to
/// select, Esc to dismiss.
pub(super) fn draw_path_hints(
    f: &mut Frame,
    area: ratatui::layout::Rect,
    entries: &[PathHintItem],
    selected: usize,
) {
    use ratatui::widgets::{Clear, List, ListItem, ListState};

    let dim = Style::new().dark_gray();
    let items: Vec<ListItem> = entries
        .iter()
        .map(|e| {
            let icon = if e.is_dir {
                Span::styled("", Style::new().yellow())
            } else {
                Span::styled("", Style::new().cyan())
            };
            let mut spans = vec![
                icon,
                Span::raw(" "),
                Span::styled(&e.name, Style::new().bold()),
            ];
            let rel = &e.path;
            if rel != &e.name {
                spans.push(Span::styled(format!("  ({rel})"), dim));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().dark_gray())
        .title(Span::styled(" path ", dim));
    f.render_widget(Clear, area);
    let list = List::new(items)
        .block(block)
        .highlight_style(select_style())
        .highlight_symbol(SELECT_MARK);
    let mut state = ListState::default();
    state.select(Some(selected.min(entries.len().saturating_sub(1))));
    f.render_stateful_widget(list, area, &mut state);
}

/// Permission prompt docked above the input: names the tool, capability, and
/// target path, then an arrow-navigable option list (Enter confirms the
/// highlighted choice; `y`/`a`/`n` still work as shortcuts).
pub(super) fn draw_permission(
    f: &mut Frame,
    area: ratatui::layout::Rect,
    pending: &Pending,
    queue_len: usize,
) {
    use ratatui::widgets::{Clear, List, ListItem, ListState};

    let title = if queue_len > 1 {
        format!(" permission required (1 of {queue_len}) ")
    } else {
        " permission required ".to_string()
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().yellow())
        .title(Span::styled(title, Style::new().on_yellow().black().bold()));
    let inner = block.inner(area);
    f.render_widget(Clear, area);
    f.render_widget(block, area);

    let detail = pending.detail_lines(inner.width);
    let diff = pending.diff_preview(inner.width);
    let rows = Layout::vertical([
        Constraint::Length(detail.len() as u16),
        Constraint::Min(diff.len() as u16),
        Constraint::Length(pending.options().len() as u16),
    ])
    .split(inner);
    f.render_widget(Paragraph::new(detail), rows[0]);
    if !diff.is_empty() {
        f.render_widget(Paragraph::new(diff), rows[1]);
    }

    let items: Vec<ListItem> = pending
        .options()
        .into_iter()
        .map(|(_, label)| ListItem::new(Line::raw(label)))
        .collect();
    let list = List::new(items)
        .highlight_style(select_style())
        .highlight_symbol(SELECT_MARK);
    let mut state = ListState::default();
    state.select(Some(pending.selected));
    f.render_stateful_widget(list, rows[2], &mut state);
}

pub(super) fn count_label(label: &str, count: usize, width: u16) -> String {
    let width = width as usize;
    if width == 0 {
        return String::new();
    }
    let count = count.to_string();
    let label_width = width.saturating_sub(count.chars().count() + 1).max(1);
    let label = truncate(label, label_width);
    let used = label.chars().count() + count.chars().count();
    if used >= width {
        return truncate(&format!("{label} {count}"), width);
    }
    format!("{label}{}{}", " ".repeat(width - used), count)
}

pub(super) fn draw_model_picker(f: &mut Frame, area: Rect, picker: &ModelPicker, current_model: &str) {
    use ratatui::widgets::{Clear, List, ListItem, ListState};

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().cyan())
        .title(Span::styled(
            " Models ",
            Style::new().on_cyan().black().bold(),
        ));
    f.render_widget(Clear, area);
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let rows = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(inner);
    let body = rows[0];
    let help = truncate(
        "Enter choose · Left/Right panes · Up/Down move · type to search · Esc close",
        rows[1].width as usize,
    );
    f.render_widget(
        Paragraph::new(Line::styled(help, Style::new().dark_gray())),
        rows[1],
    );
    if body.width == 0 || body.height == 0 {
        return;
    }

    let scope_w = body
        .width
        .saturating_sub(1)
        .min(28)
        .max(body.width.saturating_sub(1).min(14));
    let panes = Layout::horizontal([
        Constraint::Length(scope_w),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .split(body);

    let scope_width = panes[0].width.saturating_sub(2);
    let scope_items: Vec<ListItem> = picker
        .scopes
        .iter()
        .enumerate()
        .map(|(idx, scope)| {
            let style = if idx == picker.active_scope {
                if picker.focus == ModelPickerFocus::Scopes {
                    Style::new().reversed().bold()
                } else {
                    Style::new().reversed()
                }
            } else {
                Style::new()
            };
            ListItem::new(Line::styled(
                count_label(&scope.label, scope.count, scope_width),
                style,
            ))
        })
        .collect();
    let scopes =
        List::new(scope_items).highlight_symbol(if picker.focus == ModelPickerFocus::Scopes {
            "▶ "
        } else {
            "  "
        });
    let mut scope_state = ListState::default();
    if !picker.scopes.is_empty() {
        scope_state.select(Some(picker.active_scope.min(picker.scopes.len() - 1)));
    }
    f.render_stateful_widget(scopes, panes[0], &mut scope_state);

    let divider = (0..panes[1].height)
        .map(|_| Line::styled("│", Style::new().dark_gray()))
        .collect::<Vec<_>>();
    f.render_widget(Paragraph::new(divider), panes[1]);

    if panes[2].width == 0 || panes[2].height == 0 {
        return;
    }
    let right_rows = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(panes[2]);
    let title = picker
        .scopes
        .get(picker.active_scope)
        .and_then(|scope| scope.provider.as_deref())
        .map(|provider| format!("{provider} models"))
        .unwrap_or_else(|| "All available models".to_string());
    f.render_widget(
        Paragraph::new(Line::styled(
            truncate(&title, right_rows[0].width as usize),
            Style::new().bold(),
        )),
        right_rows[0],
    );
    let caret = if picker.focus == ModelPickerFocus::Models {
        "█"
    } else {
        ""
    };
    let search = truncate(
        &format!("⌕ {}{caret}", picker.query),
        right_rows[1].width as usize,
    );
    f.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            search,
            Style::new().dark_gray(),
        )])),
        right_rows[1],
    );

    let model_width = right_rows[2].width.saturating_sub(2) as usize;
    let model_items: Vec<ListItem> = picker
        .items
        .iter()
        .map(|item| {
            ListItem::new(Line::raw(truncate(
                &format!("{} / {}", item.provider, item.model),
                model_width,
            )))
        })
        .collect();
    let models = List::new(model_items)
        .highlight_style(if picker.focus == ModelPickerFocus::Models {
            Style::new().reversed().bold()
        } else {
            Style::new().reversed()
        })
        .highlight_symbol(if picker.focus == ModelPickerFocus::Models {
            "▶ "
        } else {
            "  "
        });
    let mut model_state = ListState::default();
    if !picker.items.is_empty() {
        model_state.select(Some(picker.selected.min(picker.items.len() - 1)));
    }
    f.render_stateful_widget(models, right_rows[2], &mut model_state);

    let detail = picker
        .items
        .get(picker.selected)
        .map(|item| {
            let state = if item.value == current_model {
                "current"
            } else {
                "default"
            };
            format!("{}/{} · {state}", item.provider, item.model)
        })
        .unwrap_or_else(|| "no models match".to_string());
    f.render_widget(
        Paragraph::new(Line::styled(
            truncate(&detail, right_rows[3].width as usize),
            Style::new().dark_gray(),
        )),
        right_rows[3],
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn draw_picker(
    f: &mut Frame,
    area: ratatui::layout::Rect,
    picker: &Picker,
    toml_path: &std::path::Path,
    mcp_detail: Option<&McpDetail>,
    mcp_auth: Option<&McpAuthFlow>,
    subagents: &[SubagentPanel],
    agent_detail: Option<&str>,
    spinner: &str,
) {
    use ratatui::widgets::{List, ListItem, ListState};

    let items: Vec<ListItem> = picker
        .items
        .iter()
        .map(|it| {
            let mut spans = Vec::new();
            if let Some(on) = it.checkbox {
                let (mark, style) = if on {
                    ("[x] ", Style::new().green())
                } else {
                    ("[ ] ", Style::new().dark_gray())
                };
                spans.push(Span::styled(mark, style));
            }
            if let Some(hint) = &it.hint {
                spans.push(Span::styled(format!("{hint}  "), Style::new().dark_gray()));
            }
            spans.push(Span::raw(it.label.clone()));
            ListItem::new(Line::from(spans))
        })
        .collect();
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(picker.title()))
        .highlight_style(select_style())
        .highlight_symbol(SELECT_MARK);
    let mut state = ListState::default();
    state.select(Some(picker.selected));

    // The settings menu keeps two rows under the list for the selected
    // setting's description, default, valid range, and current value - the
    // rows themselves stay terse (`key  = value`) because the detail footer
    // explains what each knob does.
    if picker.kind == PickerKind::AgentSettings {
        let list_area = Rect {
            height: area.height.saturating_sub(2),
            ..area
        };
        f.render_stateful_widget(list, list_area, &mut state);
        if let Some(def) = picker
            .items
            .get(picker.selected)
            .and_then(|it| AGENT_SETTINGS.iter().find(|d| d.key == it.value))
        {
            let current =
                current_agent_value(toml_path, def.key).unwrap_or_else(|| "unset".to_string());
            let meta = match def.kind {
                AgentSettingKind::Int { default, min } => {
                    let d = default
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| "unset".to_string());
                    format!("default: {d} · valid: >= {min} · current: {current}")
                }
                AgentSettingKind::Glyph { default, max } => {
                    format!(
                        "default: {default} · valid: up to {max} chars, empty = off · current: {current}"
                    )
                }
                AgentSettingKind::Text { default } => {
                    format!("default: {default} · current: {current}")
                }
                AgentSettingKind::Enum { options, default } => {
                    format!(
                        "default: {default} · valid: {} · current: {current}",
                        options.join(" | ")
                    )
                }
                AgentSettingKind::Bool { default } => {
                    format!("default: {default} · valid: true | false · current: {current}")
                }
            };
            let dim = Style::new().dark_gray();
            f.render_widget(
                Paragraph::new(vec![
                    Line::styled(def.desc.to_string(), dim),
                    Line::styled(meta, dim),
                ]),
                Rect {
                    y: list_area.y + list_area.height,
                    height: area.height - list_area.height,
                    ..area
                },
            );
        }
    } else if let (PickerKind::McpServer, Some(detail)) = (picker.kind, mcp_detail) {
        // The info block and the actions share one border: they are one screen,
        // and two stacked frames would read as two unrelated panels.
        let block = Block::default().borders(Borders::ALL).title(picker.title());
        let inner = block.inner(area);
        f.render_widget(block, area);

        let info = mcp_detail_lines(detail, mcp_auth, spinner, inner.width);
        // A frame too short for the whole block gives its rows to the actions:
        // an info line the user cannot act on is worth less than the action row
        // it would displace.
        let info_h = (info.len() as u16).min(inner.height.saturating_sub(1));
        let (info_area, list_area) = (
            Rect {
                height: info_h,
                ..inner
            },
            Rect {
                y: inner.y + info_h,
                height: inner.height - info_h,
                ..inner
            },
        );
        f.render_widget(Paragraph::new(info), info_area);
        f.render_stateful_widget(list.block(Block::default()), list_area, &mut state);
    } else if picker.kind == PickerKind::AgentDetail {
        // One subagent's live detail: rendered from the panels, not the picker
        // rows, so it updates in place as the child works and empties when it
        // finishes.
        let block = Block::default().borders(Borders::ALL).title(picker.title());
        let inner = block.inner(area);
        f.render_widget(block, area);
        let lines = agent_detail_lines(subagents, agent_detail, inner.width, inner.height);
        f.render_widget(Paragraph::new(lines), inner);
    } else {
        f.render_stateful_widget(list, area, &mut state);
    }
}

/// Render a duration as a compact `"12s"` / `"3m12s"` / `"1h04m"` label.
/// Output tokens per second, flooring the duration at 100ms so a near-instant
/// turn cannot produce a divide-by-tiny spike.
pub(super) fn tokens_per_second(output_tokens: u64, duration_ms: u64) -> f64 {
    let d = duration_ms.max(100);
    output_tokens as f64 * 1000.0 / d as f64
}

/// Rows the docked status panel may occupy. Both columns elide to fit; a short
/// terminal shrinks the budget further (see `draw`), and a terminal with no
/// room left for the conversation drops the panel entirely.
pub(super) const PANEL_MAX_ROWS: usize = 8;

/// Conversation rows the panel may never eat into. Below this the panel gives
/// up its own rows first: the transcript is the point of the screen.
pub(super) const MIN_TRANSCRIPT_ROWS: u16 = 4;

/// Blank rows between the last transcript row and the dock below it. The body is
/// bottom-pinned, so without this the model's closing line sits flush against the
/// panel -- or, with no panel, against the separator rule over the input -- and
/// the conversation and the dock read as one block. Unconditional: air that
/// appears only on some frames is a layout that jumps.
pub(super) const TRANSCRIPT_BOTTOM_PAD: u16 = 1;

/// Narrowest terminal that still gets two side-by-side columns. Under it they
/// stack, plan first, because a 30-column half fits neither a task nor an agent.
pub(super) const PANEL_SPLIT_MIN_WIDTH: u16 = 76;

/// Cells between the two columns, including the divider glyph.
pub(super) const PANEL_GUTTER: u16 = 3;

/// Detail rows one agent may occupy under its stats line, when the budget
/// stretches that far: the dispatch brief and the current activity.
pub(super) const AGENT_MAX_ROWS: usize = 3;

/// A trailing run of identical calls this long reads as a spin, not progress, so
/// the collapsed `×N` marker turns red to flag it. Aligned with the loop's own
/// poll dampener, which nudges around the same point.
pub(super) const STUCK_REPEAT_THRESHOLD: usize = 4;

/// Length of the trailing run of the last entry in `calls`: 0 when empty, 1 when
/// the last call differs from the one before it. Lets the panel collapse a spin
/// (`read_agent …` repeated dozens of times) into one `×N` line instead of
/// showing the newest copy alone, with only the tool counter to betray the loop.
pub(super) fn trailing_repeat(calls: &[String]) -> usize {
    match calls.last() {
        None => 0,
        Some(last) => calls.iter().rev().take_while(|l| *l == last).count(),
    }
}

/// The live fan-out, as a column: one stats line per child plus as much detail
/// as `rows` allows.
///
/// Parallel agents are otherwise unreadable -- N growing sections, with the
/// interesting question (which of these is progressing, and is one about to
/// blow its context) answerable only by counting rows. Here every child gets
/// the same shape, so the whole fan-out reads at a glance and holds a fixed
/// height as the work runs.
pub(super) fn agents_column(
    panels: &mut [SubagentPanel],
    context_window: u64,
    width: u16,
    rows: usize,
    frame: &str,
) -> Vec<Line<'static>> {
    if panels.is_empty() || rows == 0 {
        return Vec::new();
    }
    let dim = Style::new().dark_gray();
    let max = width.max(8) as usize;
    let mut out = vec![Line::from(vec![
        Span::styled("≡ ", Style::new().magenta()),
        Span::styled(
            pluralize("agent", panels.len()),
            Style::new().magenta().bold(),
        ),
    ])];

    // Fit as many children as the budget allows at one line each, keeping the
    // last row for the count of those that did not fit.
    let body = rows - 1;
    let (shown, hidden) = if panels.len() <= body {
        (panels.len(), 0)
    } else {
        (
            body.saturating_sub(1),
            panels.len() - body.saturating_sub(1),
        )
    };
    // Whatever is left over after one line each is spread evenly as detail.
    let per = (body - shown)
        .checked_div(shown)
        .map_or(0, |n| n.min(AGENT_MAX_ROWS - 1));

    for panel in panels.iter_mut().take(shown) {
        let mut spans = vec![Span::styled(
            format!("{} ", if panel.queued { "·" } else { frame }),
            Style::new().magenta(),
        )];
        if panel.queued {
            // Parked on the `max_parallel_subagents` cap; the child has not
            // started, so there are no live stats -- its queue position instead.
            spans.push(Span::styled(
                truncate(&panel.name, max.saturating_sub(14)),
                Style::new().magenta().dim(),
            ));
            spans.push(Span::styled(
                format!("  queued ({})", panel.waiting),
                Style::new().yellow(),
            ));
        } else {
            spans.push(Span::styled(
                truncate(&panel.name, max.saturating_sub(20)),
                Style::new().magenta(),
            ));
            // Compact stats: side by side with the plan there is no room for
            // "33 tools  ·  24 req", and the units are obvious in context.
            let mut stats = format!("  {}t · {}r", panel.calls.len(), panel.requests);
            // Only once the child has reported usage; "0%" before its first
            // response would read as a stalled agent rather than a starting one.
            // `context_window` arrives as 0 when the session has disproven it,
            // and the share is clamped: a child on a model with a larger window
            // than the parent's config would otherwise report past 100%.
            if panel.prompt_tokens > 0 && context_window > 0 {
                let pct = (panel.prompt_tokens as f64 / context_window as f64 * 100.0).min(100.0);
                stats.push_str(&format!(" · {pct:.1}%"));
            }
            spans.push(Span::styled(stats, dim));
        }
        out.push(Line::from(spans));

        if per == 0 {
            continue;
        }
        // The dispatch brief says what this child is *for*. Split on the task's
        // own newlines rather than word-wrapping: models write these as
        // structured briefs whose first line is the summary.
        let brief = panel.task.lines().find(|l| !l.trim().is_empty());
        let repeats = trailing_repeat(&panel.calls);
        let activity = if repeats >= STUCK_REPEAT_THRESHOLD {
            // A run of identical calls is a spin: show the count in red so it
            // reads as stuck rather than working, even while the newest copy is
            // still streaming as `active`.
            panel
                .calls
                .last()
                .map(|label| (format!("{label} ×{repeats}"), Style::new().red()))
        } else {
            match panel.active.as_mut() {
                Some(call) => Some((
                    format!("{frame} {}", call.activity_label()),
                    Style::new().cyan().dim(),
                )),
                None => panel
                    .calls
                    .last()
                    .map(|label| {
                        let text = if repeats > 1 {
                            format!("{label} ×{repeats}")
                        } else {
                            label.clone()
                        };
                        (text, Style::new().dim())
                    })
                    .or_else(|| {
                        (!panel.queued).then(|| ("starting…".to_string(), Style::new().dim()))
                    }),
            }
        };
        // With only one detail row the activity wins: what it is doing now is
        // worth more than what it was asked, which the transcript already shows.
        let detail: Vec<(String, Style)> = match (per, brief, activity) {
            (1, _, Some(a)) => vec![a],
            (1, Some(b), None) => vec![(b.trim().to_string(), Style::new().dim().italic())],
            (_, Some(b), Some(a)) => {
                vec![(b.trim().to_string(), Style::new().dim().italic()), a]
            }
            (_, None, Some(a)) => vec![a],
            (_, Some(b), None) => vec![(b.trim().to_string(), Style::new().dim().italic())],
            _ => Vec::new(),
        };
        for (text, style) in detail {
            out.push(Line::from(vec![
                Span::raw("   "),
                Span::styled(truncate(&text, max.saturating_sub(3)), style),
            ]));
        }
    }
    if hidden > 0 {
        // The overflow row points at the `/agents` inspector, which lists the
        // whole live fan-out with per-agent detail -- the dock only has room for
        // the newest few. Compact form when the (often half-width) column can't
        // fit the hint.
        let hinted = format!("  +{hidden} more · /agents");
        if hinted.chars().count() <= max {
            out.push(Line::from(vec![
                Span::styled(format!("  +{hidden} more · "), dim),
                Span::styled("/agents", Style::new().cyan()),
            ]));
        } else {
            out.push(Line::from(vec![Span::styled(
                format!("  +{hidden} more running"),
                dim,
            )]));
        }
    }
    out.truncate(rows);
    out
}

/// Token counts as `43K` / `1.1K` / `840` -- three significant characters, so a
/// column of them stays the same width as the numbers grow.
pub(super) fn compact_tokens(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=9_999 => format!("{:.1}K", n as f64 / 1000.0),
        10_000..=999_999 => format!("{}K", n / 1000),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

/// Per-turn receipt: wall-clock, context sent, tokens produced, elapsed, rate.
pub(super) fn turn_stats_line(prompt_tokens: u64, output_tokens: u64, elapsed: Duration) -> Line<'static> {
    let secs = elapsed.as_secs_f64();
    let rate = tokens_per_second(output_tokens, elapsed.as_millis() as u64);
    let dim = Style::new().dark_gray();
    let mut spans = vec![Span::styled(local_timestamp(), dim)];
    for (glyph, value) in [
        ("↑", compact_tokens(prompt_tokens)),
        ("↓", compact_tokens(output_tokens)),
        ("⏱", format!("{secs:.1}s")),
        ("⚡", format!("{rate:.1}/s")),
    ] {
        spans.push(Span::styled(format!("  {glyph} "), dim));
        spans.push(Span::styled(value, Style::new().dim()));
    }
    Line::from(spans)
}

/// `YYYY-MM-DD HH:MM` in local time, without pulling in a date library:
/// `chrono` is already a dependency, so this is just the formatting choice.
pub(super) fn local_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

pub(super) fn format_elapsed(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// Frames the shimmer rests between sweeps, so the wave reads as a pulse
/// rather than a continuously scrolling band.
pub(super) const SHIMMER_PAUSE: usize = 4;

/// Sweep a crest across `text`, one character per spinner frame: `palette` is
/// `[crest, trail, base]`, applied to the character under the crest, the one
/// behind it, and everything else.
///
/// Folded reasoning is the one stretch of a run that produces no output at all
/// -- no prose, no tool rows, nothing moving -- so the badge is the only thing
/// that can say the model is still going. The sweep animates in place, without
/// changing the text's width, so nothing to its left shifts as it runs.
pub(super) fn shimmer_spans(text: &str, palette: [Style; 3], frame: usize) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let head = frame % (chars.len() + SHIMMER_PAUSE);
    chars
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let style = match head.checked_sub(i) {
                Some(0) => palette[0],
                Some(1) => palette[1],
                _ => palette[2],
            };
            Span::styled(c.to_string(), style)
        })
        .collect()
}

pub(super) fn header(app: &App) -> Paragraph<'static> {
    Paragraph::new(Line::from(header_spans(app)))
}

pub(super) fn header_spans(app: &App) -> Vec<Span<'static>> {
    let (status, style): (String, Style) = if let Some(kind) = app.compacting {
        (kind.label().to_string(), Style::new().magenta().bold())
    } else if app.run_compacting.is_some() {
        ("compacting".to_string(), Style::new().magenta().bold())
    } else if app.retrying.is_some() {
        ("retrying".to_string(), Style::new().yellow().bold())
    } else if app.mcp_auth.is_some() {
        // A sign-in runs while the model is otherwise idle; the badge stands in
        // for `[ready]` so the pending auth is visible even off the `/mcp` screen.
        (format!("{} signing in", app.spinner()), Style::new().cyan().bold())
    } else if app.status == Status::Idle {
        ("ready".to_string(), Style::new().green())
    } else if !app.show_reasoning {
        // Reasoning folding is on: show the live thought state in place of the
        // generic 'working'. [thinking] while a  block streams; [thought for
        // Ns] for the rest of the turn once it closes.
        match app.reasoning_status() {
            Some(s) => s,
            None => ("working".to_string(), Style::new().cyan().bold()),
        }
    } else {
        ("working".to_string(), Style::new().cyan().bold())
    };
    let turn = match app.turn {
        (0, _) => String::new(),
        (n, 0) => format!("turn {n}  "),
        (n, m) => format!("turn {n}/{m}  "),
    };
    let elapsed = app
        .run_started
        .map(|t| format!("  {}", format_elapsed(t.elapsed().as_secs())))
        .unwrap_or_default();
    // No name chip: the splash names the app (see `Banner`), and the header's
    // columns are better spent on state that changes. The wave mark stands in
    // for the name in one glyph, then the model, bold so the row still has an
    // anchor on the left; an unset model says so rather than opening the row
    // with blanks.
    let mut spans = vec![
        Span::styled(format!(" {}", brand::WAVE), Style::new().yellow()),
        if app.model.is_empty() {
            Span::styled(" no model", Style::new().red().bold())
        } else {
            Span::styled(
                format!(" {}", app.header_model_label()),
                Style::new().bold(),
            )
        },
    ];
    // Reasoning-effort badge: `effort high` after the model, so the configured
    // reasoning depth is visible at a glance. Reported low/medium/high exactly
    // as set, so the display always matches what is sent upstream.
    spans.push(Span::styled(
        format!("  effort {}", app.reasoning_effort),
        Style::new().yellow(),
    ));
    // Wall-clock (local) segment, mirroring the reference status line's leading
    // HH:MM. Shown only while a run is active: a clock that ticks once per
    // minute repaints the screen only on the minute, which clears the terminal's
    // text selection mid-drag less often. An idle frame must be fully static so
    // the transcript stays selectable/copyable (the 50ms ticker then emits no
    // output at all).
    if app.run_started.is_some() {
        spans.push(Span::styled(
            format!("  {}", chrono::Local::now().format("%H:%M")),
            Style::new().dim(),
        ));
    }
    spans.push(Span::raw(format!("  {turn}")));
    // Round to nearest K for display clarity, and label the source the window
    // came from (configured override, catalog, or fallback) so the reader can
    // tell whether it was authored or inferred.
    let used_k = if app.tokens == 0 {
        0
    } else {
        (app.tokens + 500) / 1000
    };
    spans.push(Span::raw(format!(
        "ctx {}K/{}K {}  ",
        used_k,
        app.context_window / 1000,
        app.context_window_source.label()
    )));
    spans.push(Span::styled(elapsed, Style::new().dim()));
    // Output rate segment: last completed turn's tokens/sec, cached so it holds
    // steady instead of flickering to 0 between turns.
    if let Some(rate) = app.tokens_per_sec {
        spans.push(Span::styled(format!("  {rate:.1}/s"), Style::new().dim()));
    }
    // Active-goal indicator: `◎ /goal active <duration>` (cyan while running,
    // green once achieved), so an unattended run shows the goal is still live.
    if let Some(goal) = app.goal.as_ref() {
        use crate::core::agent::goal::GoalStatus;
        let (label, gstyle) = match goal.status {
            GoalStatus::Active => (
                format!("  ◎ /goal active {}", fmt_duration(goal.elapsed_secs())),
                Style::new().cyan().bold(),
            ),
            GoalStatus::Achieved => ("  ◎ /goal done".to_string(), Style::new().green()),
        };
        spans.push(Span::styled(label, gstyle));
    }
    // Plan-mode badge: `PLAN · read only`. Only shown in Plan mode; normal mode
    // keeps its existing layout unchanged (spec).
    if app.run_mode == crate::core::agent::plan::RunMode::Plan {
        spans.push(Span::styled(
            "  PLAN · read only",
            Style::new().magenta().bold(),
        ));
    }
    spans.push(Span::raw("  "));
    if app.is_thinking() {
        spans.push(Span::styled("[", style));
        spans.extend(shimmer_spans(
            &status,
            [
                Style::new().yellow().bold(),
                Style::new().yellow(),
                Style::new().yellow().dim(),
            ],
            app.spinner_frame,
        ));
        spans.push(Span::styled("]", style));
    } else {
        spans.push(Span::styled(format!("[{status}]"), style));
    }
    spans
}

/// One task row: ` <glyph> <text>`, styled by status. Pending is dim,
/// in-progress accent, completed dim+strikethrough, abandoned red+strikethrough
/// with a distinct `☒` glyph.
pub(super) fn todo_task_row(task: &crate::core::agent::todo::TodoItem, max: usize) -> Line<'static> {
    use crate::core::agent::todo::TodoStatus;
    let (glyph, style) = match task.status {
        TodoStatus::Pending => ("☐", Style::new().dim()),
        TodoStatus::InProgress => ("☐", Style::new().cyan()),
        TodoStatus::Completed => ("☑", Style::new().dim().add_modifier(Modifier::CROSSED_OUT)),
        TodoStatus::Abandoned => ("☒", Style::new().red().add_modifier(Modifier::CROSSED_OUT)),
    };
    Line::from(vec![
        Span::raw(" "),
        Span::styled(format!("{glyph} "), style),
        Span::styled(truncate(&task.content, max), style),
    ])
}

/// Which phase holds the in-progress task, if any.
pub(super) fn active_phase(todos: &crate::core::agent::todo::TodoList) -> Option<usize> {
    use crate::core::agent::todo::TodoStatus;
    todos
        .phases
        .iter()
        .position(|p| p.tasks.iter().any(|t| t.status == TodoStatus::InProgress))
}

/// `done/total` over a phase's tasks; abandoned counts as closed.
pub(super) fn phase_progress(phase: &crate::core::agent::todo::TodoPhase) -> (usize, usize) {
    use crate::core::agent::todo::TodoStatus;
    let done = phase
        .tasks
        .iter()
        .filter(|t| matches!(t.status, TodoStatus::Completed | TodoStatus::Abandoned))
        .count();
    (done, phase.tasks.len())
}

/// 1-based index of the phase the plan is on, for the `idx/count` suffix. With
/// no active task (all done, or none started) this counts the fully finished
/// phases, so a completed plan reads `N/N`.
pub(super) fn phase_position(todos: &crate::core::agent::todo::TodoList) -> usize {
    active_phase(todos).map(|i| i + 1).unwrap_or_else(|| {
        todos
            .phases
            .iter()
            .filter(|p| {
                let (done, total) = phase_progress(p);
                done == total
            })
            .count()
            .max(1)
    })
}

/// Head line of the plan column: the phase the plan is on, how far into it the
/// agent is, and the command that opens the editor.
///
/// ```text
/// Todos · 1/2 · backend 1/3   /todo
/// ```
pub(super) fn todo_pin(todos: &crate::core::agent::todo::TodoList) -> Line<'static> {
    let mut spans = vec![Span::styled("Todos", Style::new().cyan().bold())];
    if todos.phases.len() > 1 {
        spans.push(Span::styled(
            format!(" · {}/{}", phase_position(todos), todos.phases.len()),
            Style::new().cyan(),
        ));
    }
    // The phase in flight, or the last one, so a finished plan still reports.
    let idx = active_phase(todos).unwrap_or(todos.phases.len().saturating_sub(1));
    if let Some(phase) = todos.phases.get(idx) {
        let (done, total) = phase_progress(phase);
        let label = if todos.phases.len() > 1 {
            format!(" · {} {done}/{total}", phase.name)
        } else {
            format!(" · {done}/{total}")
        };
        spans.push(Span::styled(label, Style::new().dim()));
    }
    spans.push(Span::styled(
        "   /todo".to_string(),
        Style::new().dark_gray(),
    ));
    Line::from(spans)
}

/// The plan as a column, capped at `rows`:
///
/// ```text
/// Todos · 1/2 · backend 1/3   /todo
///  ☑ scaffold
///  ☐ wire routes
///  +3 more
/// ```
///
/// Only the phase in flight expands its tasks -- the head line already names it
/// and counts the rest, so a header per phase would spend rows repeating that.
pub(super) fn todo_column(
    todos: &crate::core::agent::todo::TodoList,
    width: u16,
    rows: usize,
) -> Vec<Line<'static>> {
    if todos.is_empty() || rows == 0 {
        return Vec::new();
    }
    let mut lines = vec![todo_pin(todos)];
    let idx = active_phase(todos).unwrap_or(todos.phases.len().saturating_sub(1));
    let Some(phase) = todos.phases.get(idx) else {
        return lines;
    };
    let max = width.saturating_sub(4).max(8) as usize;
    let body = rows - 1;
    let (shown, hidden) = if phase.tasks.len() <= body {
        (phase.tasks.len(), 0)
    } else {
        // Keep the last row for the count of what did not fit.
        let shown = body.saturating_sub(1);
        (shown, phase.tasks.len() - shown)
    };
    for task in phase.tasks.iter().take(shown) {
        lines.push(todo_task_row(task, max));
    }
    if hidden > 0 {
        lines.push(Line::from(vec![Span::styled(
            format!("  +{hidden} more"),
            Style::new().dark_gray(),
        )]));
    }
    lines.truncate(rows);
    lines
}

/// Pad `lines` to exactly `rows` entries so a column keeps its shape when the
/// other one is taller.
pub(super) fn pad_column(mut lines: Vec<Line<'static>>, rows: usize) -> Vec<Line<'static>> {
    lines.resize_with(rows, || Line::raw(""));
    lines
}

/// Set two columns side by side, `left` padded out to `left_w` and separated by
/// a dim divider. Callers pass columns already clamped to their own widths.
pub(super) fn join_columns(
    left: Vec<Line<'static>>,
    right: Vec<Line<'static>>,
    left_w: u16,
) -> Vec<Line<'static>> {
    let rows = left.len().max(right.len());
    let (left, right) = (pad_column(left, rows), pad_column(right, rows));
    left.into_iter()
        .zip(right)
        .map(|(l, r)| {
            let pad = (left_w as usize).saturating_sub(spans_width(&l.spans));
            let mut spans = l.spans;
            spans.push(Span::raw(" ".repeat(pad)));
            spans.push(Span::styled(" │ ", Style::new().dark_gray()));
            spans.extend(r.spans);
            Line::from(spans)
        })
        .collect()
}

/// The docked status panel: the plan on the left, the live fan-out on the
/// right, both bounded by `rows`.
///
/// Neither belongs in the transcript -- they describe *now*, not what was said
/// -- so they sit above the input where the eye already is, and they use the
/// width instead of stacking. When the terminal is too narrow to split, the
/// columns stack (plan first, since it is the shorter of the two); when it is
/// too short, `rows` shrinks and each column elides its own tail.
pub(super) fn status_panel(app: &mut App, width: u16, rows: usize) -> Vec<Line<'static>> {
    if rows == 0 {
        return Vec::new();
    }
    let frame = app.spinner();
    // The active resolved window drives the subagent share; it is always
    // known (configured, catalog, or fallback), so it is always a denominator.
    let context_window = app.context_window;
    let has_todos = !app.todos.is_empty() && !app.todos_expired();
    let has_agents = !app.subagents.is_empty();
    match (has_todos, has_agents) {
        (false, false) => Vec::new(),
        (true, false) => todo_column(&app.todos, width, rows),
        (false, true) => agents_column(&mut app.subagents, context_window, width, rows, frame),
        (true, true) if width < PANEL_SPLIT_MIN_WIDTH => {
            // Stacked: the plan keeps its head line plus whatever is left after
            // the agents, which are the thing actually moving.
            let agents = agents_column(
                &mut app.subagents,
                context_window,
                width,
                rows.saturating_sub(1),
                frame,
            );
            let mut out = todo_column(&app.todos, width, rows - agents.len());
            out.extend(agents);
            out
        }
        (true, true) => {
            let left_w = (width.saturating_sub(PANEL_GUTTER)) / 2;
            let right_w = width.saturating_sub(left_w + PANEL_GUTTER);
            let left = todo_column(&app.todos, left_w, rows);
            let right = agents_column(&mut app.subagents, context_window, right_w, rows, frame);
            join_columns(left, right, left_w)
        }
    }
}

/// Max content rows the input box grows to before it scrolls internally.
pub(super) const MAX_INPUT_ROWS: u16 = 8;

/// Build a footer hint line from `(key, label)` pairs, with the key bright and
/// bold so it stands out against the dim label text.
pub(super) fn hint_spans(key_style: Style, pairs: &[(&str, &str)]) -> Vec<Span<'static>> {
    let mut spans = vec![Span::raw(" ")];
    for (i, (key, label)) in pairs.iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(key.to_string(), key_style));
        if !label.is_empty() {
            spans.push(Span::styled(format!(" {label}"), Style::new().dim()));
        }
    }
    spans
}

/// Abbreviate a leading `$HOME` to `~`, so the line reads as a location rather
/// than an absolute path. Non-home paths are returned unchanged.
pub(super) fn tilde_path(path: &std::path::Path) -> String {
    let full = path.to_string_lossy().into_owned();
    // Not `HOME`: that variable is usually unset on Windows, so reading it
    // directly meant the abbreviation silently never happened there and the
    // dock rendered a full `C:\Users\...` path where every other platform
    // showed `~`.
    let Some(home) = crate::core::app::commands::jan_home_dir() else {
        return full;
    };
    let home = home.as_path();
    match path.strip_prefix(home) {
        // The home dir itself, not a `~`-prefixed child.
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => full,
    }
}

/// Working-dir + branch spans, the left half of the dock row.
pub(super) fn path_spans(app: &App) -> Vec<Span<'static>> {
    let mut spans = vec![
        Span::styled("📂 ", Style::new().dark_gray()),
        Span::styled(tilde_path(&app.project_root), Style::new().dark_gray()),
    ];
    if let Some(branch) = app.git_branch.as_ref() {
        spans.push(Span::styled(
            format!(" ⎇ {}", branch),
            Style::new().dark_gray(),
        ));
    }
    spans
}

/// Display width of a row, in cells. `Span::width` is grapheme-aware, which a
/// char count is not: the dock opens with an emoji that occupies two cells.
pub(super) fn spans_width(spans: &[Span<'static>]) -> usize {
    spans.iter().map(Span::width).sum()
}

/// The single row below the input: location on the left, key hints and status
/// on the right. Two separate rows spent a whole line of a small terminal on
/// text that is static all session; merged, the location keeps its place and
/// the hints keep theirs, and only a terminal too narrow for both drops the
/// location.
pub(super) fn dock_line(app: &App, width: u16) -> Paragraph<'static> {
    let hints = footer_spans(app);
    let mut spans = path_spans(app);
    let (used, hint_w) = (spans_width(&spans), spans_width(&hints));
    // `hint_spans` already opens with a pad; a gap of at least two keeps the
    // location from running into it.
    if used + hint_w + 2 > width as usize {
        return Paragraph::new(Line::from(hints));
    }
    spans.push(Span::raw(" ".repeat(width as usize - used - hint_w)));
    spans.extend(hints);
    Paragraph::new(Line::from(spans))
}

pub(super) fn footer_spans(app: &App) -> Vec<Span<'static>> {
    if !app.pending_queue.is_empty() {
        return hint_spans(
            Style::new().yellow().bold(),
            &[
                ("↑/↓", "select"),
                ("Enter", "confirm"),
                ("Esc", "deny"),
                ("Ctrl-C", "cancel"),
            ],
        );
    }
    if let Some(picker) = &app.picker {
        return vec![Span::styled(picker.action_hint(), Style::new().dim())];
    }
    // Briefly, and never over a prompt whose keys the user needs: a copy is
    // invisible otherwise, and a transcript note would shift the rows the
    // pointer is still sitting on.
    if let Some(lines) = app.copy_notice() {
        let plural = if lines == 1 { "" } else { "s" };
        return vec![Span::styled(
            format!(" copied {lines} line{plural}"),
            Style::new().green().bold(),
        )];
    }
    let key_style = Style::new().cyan().bold();
    let mut spans = match app.status {
        Status::Running => hint_spans(
            key_style,
            &[
                ("Esc/Ctrl-C", "cancel"),
                ("PgUp/PgDn", "scroll"),
                ("Ctrl-O", "expand all"),
            ],
        ),
        // Idle is the default state, so a cheat sheet here is permanent noise.
        // Discovery is already covered without it: the session opens with the
        // splash (`Banner`, which names `/help`), and `/help` carries the full
        // list (see `KEY_BINDINGS`). Keep only the leading pad `hint_spans`
        // emits, so a queue count or detail suffix lands in the same column as
        // the other states.
        Status::Idle => vec![Span::raw(" ")],
    };
    // Standing indicators lead the row in both states, newest concern leftmost:
    // pending queue, then background shells still running unattended.
    let bg_shells = app.active_bg_jobs.len();
    if bg_shells > 0 {
        let plural = if bg_shells == 1 { "" } else { "s" };
        spans.insert(
            0,
            Span::styled(
                format!("⚙ {bg_shells} bg shell{plural} · /shells  "),
                Style::new().magenta().bold(),
            ),
        );
    }
    let queue_count = app.message_queue.len();
    if queue_count > 0 {
        spans.insert(
            0,
            Span::styled(
                format!("⏳ Pending ({queue_count})  "),
                Style::new().yellow().bold(),
            ),
        );
    }
    if !app.detail.is_empty() {
        // Only separate from a preceding hint; on a bare idle footer the detail
        // is the whole line and should start at the same column as the hints.
        let pad = if spans.len() > 1 { "   " } else { "" };
        spans.push(Span::styled(
            format!("{pad}{}", app.detail),
            Style::new().dim(),
        ));
    }
    spans
}
