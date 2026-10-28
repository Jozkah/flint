//! Make untrusted text safe to print to a terminal.
//!
//! Model, tool and server text can carry escape sequences (cursor moves, a
//! bare `\r` that overwrites the line, bidi overrides) that rewrite what a
//! human reads, for example hiding the real command in a permission prompt.
//! `display_safe` leaves ordinary text alone and shows each dangerous
//! character as visible text instead.

use std::borrow::Cow;

fn is_unsafe(c: char) -> bool {
    match c {
        '\n' | '\t' => false,
        c if c.is_ascii_control() => true,
        '\u{80}'..='\u{9f}' => true,
        '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => true,
        _ => false,
    }
}

/// `s` with control, C1 and bidi-override characters made visible: C0 as `^X`
/// (`ESC` is `^[`), DEL as `^?`, a carriage return as `\r`, C1 and bidi as
/// `\u{..}`. Newline and tab are kept. Borrows when nothing needs changing.
pub(crate) fn display_safe(s: &str) -> Cow<'_, str> {
    if !s.chars().any(is_unsafe) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if !is_unsafe(c) {
            out.push(c);
        } else if c == '\r' {
            out.push_str("\\r");
        } else if c == '\u{7f}' {
            out.push_str("^?");
        } else if c.is_ascii_control() {
            out.push('^');
            out.push(((c as u8) ^ 0x40) as char);
        } else {
            out.push_str(&format!("\\u{{{:04x}}}", c as u32));
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esc_and_cr_escaped() {
        assert_eq!(display_safe("a\x1b[2Kb\rc"), "a^[[2Kb\\rc");
        assert_eq!(display_safe("x\u{7f}y"), "x^?y");
        assert_eq!(display_safe("\u{202e}evil"), "\\u{202e}evil");
        assert_eq!(display_safe("\u{9b}31m"), "\\u{009b}31m");
    }

    #[test]
    fn newline_tab_preserved() {
        assert_eq!(display_safe("a\n\tb"), "a\n\tb");
    }

    #[test]
    fn plain_text_borrowed() {
        assert!(matches!(display_safe("hello \u{4e16}\u{754c}"), Cow::Borrowed(_)));
    }

    #[test]
    fn prompt_detail_cannot_hide_command() {
        let shown = display_safe("rm -rf /\rls");
        assert!(shown.contains("rm -rf /"));
        assert!(!shown.contains('\r'));
    }
}
