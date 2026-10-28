//! One shared check for a name that becomes a single path component under a
//! store (imported skill/plugin names, hub file segments). Rejects what a plain
//! `/` and `..` test misses on Windows: drive-relative `C:foo`, alternate data
//! streams, reserved device names and trailing dots or spaces.

use std::path::{Component, Path};

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// `name` unchanged when it is exactly one normal path component.
pub(crate) fn safe_component(name: &str) -> Result<&str, String> {
    let bad = || format!("invalid item name: {name:?}");
    if name.trim().is_empty() || name != name.trim() {
        return Err(bad());
    }
    if name.contains(['/', '\\', ':', '\0']) || name.ends_with('.') || name.ends_with(' ') {
        return Err(bad());
    }
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(bad()),
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(bad());
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_drive_relative_reserved_and_ads_names() {
        for bad in [
            "C:foo", "CON", "con", "nul.txt", "x.", "x ", "a:b", "..", ".", "", "a/b", "a\\b",
            "COM1", "lpt9.md", " a",
        ] {
            assert!(safe_component(bad).is_err(), "{bad:?} must be rejected");
        }
        for good in ["caveman", "my-skill_2", "a.b", ".hidden", "console"] {
            assert_eq!(safe_component(good), Ok(good));
        }
    }
}
