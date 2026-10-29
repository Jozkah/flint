//! Invisible Unicode stripped from untrusted text before the model reads it.
//!
//! Tag characters (U+E0000-E007F) spell out hidden instructions a person
//! cannot see; bidi overrides and isolates reorder what they can; zero-width
//! characters and invisible operators hide anything between visible text. None
//! of it is something a reader asked for, so it is removed silently.
//!
//! The same set and the same rule live in `web-app/src/lib/invisibleText.ts`;
//! both are tested against `tests/fixtures/invisible-unicode.json`, so they
//! cannot drift apart. A single zero-width joiner or non-joiner between two
//! visible non-ASCII characters is kept: Persian, Arabic and Indic text need
//! it to spell words, and emoji sequences need it to join. Anywhere else (next
//! to ASCII, or in a run of joiners) it is stripped. Variation
//! selectors are stripped too, except FE0E/FE0F (text/emoji presentation), so
//! an emoji keeps its look while a hidden payload in selectors is removed.

/// Whether `c` is stripped. A leading U+FEFF is handled by [`strip`].
pub fn is_invisible(c: char) -> bool {
    matches!(
        c as u32,
        0xE0000..=0xE007F
            | 0x202A..=0x202E
            | 0x2066..=0x2069
            | 0x200B..=0x200F
            | 0x2060..=0x2064
            | 0xFEFF
            // Variation selectors carry a hidden payload one bit at a time.
            // FE0E and FE0F are left alone: they pick text or emoji
            // presentation and stripping them changes what an emoji looks like.
            | 0xFE00..=0xFE0D
            | 0xE0100..=0xE01EF
            // Soft hyphen, Arabic letter mark, Mongolian vowel separator.
            | 0x00AD
            | 0x061C
            | 0x180E
    )
}

/// `text` without invisible characters, and how many were removed. A BOM at
/// the very start is kept: whatever strips BOMs from files already did, and
/// this is not the place to disagree with it.
pub fn strip(text: &str) -> (String, usize) {
    if !text.chars().any(|c| is_invisible(c)) {
        return (text.to_string(), 0);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut removed = 0;
    for (i, &c) in chars.iter().enumerate() {
        let joiner_kept = matches!(c, '\u{200C}' | '\u{200D}')
            && i > 0
            && chars.get(i + 1).is_some_and(|&n| joinable(n))
            && joinable(chars[i - 1]);
        if is_invisible(c) && !(i == 0 && c == '\u{FEFF}') && !joiner_kept {
            removed += 1;
        } else {
            out.push(c);
        }
    }
    (out, removed)
}

/// A visible non-ASCII character a joiner may sit beside.
fn joinable(c: char) -> bool {
    !c.is_ascii() && !c.is_whitespace() && !is_invisible(c)
}

/// [`strip`] for call sites that only want the text.
pub fn clean(text: String) -> String {
    match strip(&text) {
        (_, 0) => text,
        (stripped, _) => stripped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: String,
    }

    #[test]
    fn the_shared_fixture_strips_the_same_inputs_as_the_web_app() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/invisible-unicode.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let (got, removed) = strip(&case.input);
            assert_eq!(got, case.expected, "{}", case.name);
            assert_eq!(
                removed,
                case.input.chars().count() - case.expected.chars().count(),
                "{}",
                case.name
            );
            assert_eq!(clean(case.input.clone()), case.expected, "{}", case.name);
        }
    }
}
