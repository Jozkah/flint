use super::*;

/// SGR mouse report: `CSI < Cb ; Cx ; Cy M` (press) or `m` (release).
///
/// Crossterm turns a complete sequence into `Event::Mouse`. When an IME burst
/// splits the bytes, the parser resyncs past `ESC[<` and the payload
/// (`65;50;42M`) is delivered as ordinary text -- the tokens in #8813. The
/// same leak shows up with a truncated CSI prefix (`[<...`, `<...`, or 8-bit
/// CSI `0x9b<...`). Match the full form and every truncated prefix so none of
/// them type into the composer.
///
/// The `<` marker is required. Without it `1;2;3m` and `38;5;196m` -- ordinary
/// text, and the shape of an SGR colour sequence in a pasted log -- were deleted
/// from whatever was pasted or typed.
pub(super) fn sgr_mouse_report_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?:\x1b\[<|\x9b<|\[<|<)\d{1,3};\d{1,4};\d{1,4}[Mm]").unwrap()
    })
}

/// A report that lost its whole prefix to a desynced parser: `65;50;42M`. Only
/// the uppercase terminator and a button code a mouse can send (wheel, drag,
/// press, with or without modifier bits) count, and only where text is typed a
/// character at a time -- never in a paste, where it is far likelier to be text.
pub(super) fn bare_sgr_mouse_report_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(\d{1,3});\d{1,4};\d{1,4}M$").unwrap())
}

pub(super) fn is_mouse_button_code(code: u32) -> bool {
    // Modifier bits (shift 4, alt 8, ctrl 16) ride on top of the button.
    matches!(code & !(4 | 8 | 16), 0..=3 | 32..=35 | 64..=67)
}

pub(super) fn strip_sgr_mouse_reports(text: &str) -> String {
    sgr_mouse_report_re().replace_all(text, "").into_owned()
}

/// Byte length of one SGR mouse report occupying the end of `text`, if any.
pub(super) fn trailing_sgr_mouse_report_len(text: &str, allow_bare: bool) -> Option<usize> {
    let marked = sgr_mouse_report_re()
        .find_iter(text)
        .last()
        .filter(|m| m.end() == text.len())
        .map(|m| m.len());
    if marked.is_some() || !allow_bare {
        return marked;
    }
    let caps = bare_sgr_mouse_report_re().captures(text)?;
    let code: u32 = caps[1].parse().ok()?;
    is_mouse_button_code(code).then(|| caps[0].len())
}

pub(super) fn drain_trailing_sgr_mouse_reports(buf: &mut String, cursor: &mut usize, allow_bare: bool) {
    while let Some(n) = trailing_sgr_mouse_report_len(&buf[..*cursor], allow_bare) {
        let start = *cursor - n;
        buf.drain(start..*cursor);
        *cursor = start;
    }
}

/// Route a bracketed paste event to the active input owner. The order mirrors
/// the key path (`handle_ask_key`, then `handle_key`): each docked prompt owns
/// the keyboard while open, so a paste must land in its fields rather than the
/// chat composer (where a pasted API key would echo). An overlay that owns the
/// keyboard but has no text field drops the paste; it must never fall through
/// to the composer hidden behind it.
pub(super) fn route_paste_event(app: &mut App, event: Event) {
    let Event::Paste(text) = event else {
        return;
    };
    if let Some(prompt) = app.login.as_mut() {
        // A pasted API key belongs to the login field, not the chat composer
        // (where it would echo).
        prompt.paste(&text);
        return;
    }
    // A yes/no question has no text field: the paste is dropped.
    if app.browser_confirm.is_some() {
        return;
    }
    if let Some(prompt) = app.settings_prompt.as_mut() {
        prompt.paste(&text);
        return;
    }
    if let Some(prompt) = app.mcp_prompt.as_mut() {
        prompt.paste(&text);
        return;
    }
    if let Some(prompt) = app.provider_prompt.as_mut() {
        prompt.paste(&text);
        return;
    }
    if !app.ask_queue.is_empty() {
        handle_ask_paste(app, &text);
        return;
    }
    // The context view and a waiting permission prompt take keys, not text.
    if app.context_view.is_some() || !app.pending_queue.is_empty() {
        return;
    }
    if let Some(picker) = app.model_picker.as_mut() {
        // The model picker's only text field is its filter.
        if picker.focus == ModelPickerFocus::Models {
            picker
                .query
                .extend(text.chars().filter(|c| !c.is_control()));
            picker.refresh_items();
        }
        return;
    }
    // List pickers navigate by key and have no text field.
    if app.picker.is_some() {
        return;
    }
    // Bracketed paste of a split SGR report is the same leak as typing it
    // a character at a time; strip before the composer sees it.
    let text = normalize_paste(&strip_sgr_mouse_reports(&text));
    app.input_insert_str(&text);
}

/// The plain character a key event types, for burst detection: no Ctrl/Alt/Super,
/// a character, Enter (as a newline) or Tab. Releases and repeats do not count.
pub(super) fn burst_char(key: &KeyEvent) -> Option<char> {
    if key.kind != KeyEventKind::Press
        || key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER)
    {
        return None;
    }
    match key.code {
        KeyCode::Char(c) => Some(c),
        KeyCode::Enter => Some('\n'),
        KeyCode::Tab => Some('\t'),
        _ => None,
    }
}

/// Whether a run of plain keys that arrived together is a paste and not fast
/// typing: eight or more characters, or at least three with a newline that is
/// not just the last one (a quick `ok` + Enter still submits).
pub(super) fn burst_is_paste(chars: &[char]) -> bool {
    chars.len() >= 8
        || (chars.len() >= 3 && chars[..chars.len() - 1].contains(&'\n'))
}

/// Fold the plain key presses in `events` that read as one paste into a single
/// `Event::Paste`; everything else, and runs too short to be a paste, pass
/// through unchanged and in order. Pure, so the heuristic is testable without a
/// terminal. Key releases inside a run are dropped with it.
pub(super) fn coalesce_burst(events: Vec<Event>) -> Vec<Event> {
    fn flush(run: &mut Vec<(char, Event)>, out: &mut Vec<Event>) {
        let chars: Vec<char> = run.iter().map(|(c, _)| *c).collect();
        if burst_is_paste(&chars) {
            out.push(Event::Paste(chars.into_iter().collect()));
        } else {
            out.extend(run.drain(..).map(|(_, e)| e));
        }
        run.clear();
    }
    let mut out = Vec::with_capacity(events.len());
    let mut run: Vec<(char, Event)> = Vec::new();
    for event in events {
        if let Event::Key(key) = &event {
            if let Some(c) = burst_char(key) {
                run.push((c, event));
                continue;
            }
            // A release between the presses of a run belongs to the run.
            if key.kind == KeyEventKind::Release && !run.is_empty() {
                continue;
            }
        }
        flush(&mut run, &mut out);
        out.push(event);
    }
    flush(&mut run, &mut out);
    out
}

/// Clean pasted text for the composer: `\r\n` and lone `\r` become `\n`, tabs
/// and newlines are kept, every other control character (ESC, BEL, ...) is
/// dropped.
pub(super) fn normalize_paste(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Append bracketed paste to the active custom answer only.
pub(super) fn handle_ask_paste(app: &mut App, text: &str) {
    if let Some(ask) = app.ask_queue.front_mut() {
        if ask.editing_custom {
            ask.custom_input.push_str(text);
        }
    }
}
