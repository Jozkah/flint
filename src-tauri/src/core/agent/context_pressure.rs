//! Warning the user as the context window fills (AH-077).
//!
//! The window is finite, and the interesting moment is *before* it overflows:
//! once a request is refused, or a compaction has already rewritten the
//! history, the choice of what to drop has been made for the user. This says
//! how full the window is while there is still room to act.
//!
//! One shape of the warning, shared by the TUI and the headless CLI, so the
//! two never drift into telling the user different things. Whether the count
//! came from the provider or from Flint's own estimate is part of what is said:
//! an estimate that reads like a measurement is worse than no number at all.

/// The share of the window in use at which the warning is worth making.
pub const WARN_PCT: u64 = 80;

/// How full the window is, when that is worth saying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pressure {
    /// Whole percent of the window in use.
    pub percent: u64,
    pub used: u64,
    pub window: u64,
    /// Tokens left before compaction takes over (window minus the reserve).
    pub headroom: u64,
    /// True when `used` is the provider's own count rather than an estimate.
    pub measured: bool,
}

/// The pressure worth reporting, or `None`.
///
/// `None` when the window is unknown (nothing to be a share of), when nothing
/// has been counted yet, or when there is still room: a warning that fires at
/// every level is one the user learns to ignore.
pub fn pressure(used: u64, window: u64, reserve: u64, measured: bool) -> Option<Pressure> {
    if window == 0 || used == 0 {
        return None;
    }
    let percent = used.saturating_mul(100) / window;
    if percent < WARN_PCT {
        return None;
    }
    Some(Pressure {
        percent,
        used,
        window,
        headroom: window.saturating_sub(reserve).saturating_sub(used),
        measured,
    })
}

/// Thousands separators, so a six-digit count can be read at a glance.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// What to tell the user, in one line.
///
/// Says the share, the figures behind it, where the numbers came from, and
/// what can be done about it -- in that order, because the share is what makes
/// someone read the rest.
pub fn line(p: &Pressure) -> String {
    let source = if p.measured {
        "counted by the provider"
    } else {
        "Jan's estimate"
    };
    let counts = format!(
        "{} of {} tokens, {source}",
        grouped(p.used),
        grouped(p.window)
    );
    if p.headroom == 0 {
        format!(
            "{}% of the context window is in use ({counts}): the next turn auto-compacts. /context shows what is using it",
            p.percent
        )
    } else {
        format!(
            "{}% of the context window is in use ({counts}): {} tokens before auto-compact. /compact now, or /context to see what is using it",
            p.percent,
            grouped(p.headroom)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_said_with_room_to_spare_or_no_window() {
        assert_eq!(pressure(50_000, 100_000, 10_000, true), None);
        assert_eq!(pressure(79_999, 100_000, 10_000, true), None);
        // An unknown window is not a full one, and an empty one is not a
        // warning either.
        assert_eq!(pressure(50_000, 0, 10_000, true), None);
        assert_eq!(pressure(0, 100_000, 10_000, true), None);
    }

    #[test]
    fn the_warning_carries_the_share_the_figures_and_where_they_came_from() {
        let p = pressure(82_000, 100_000, 10_000, true).expect("a warning");
        assert_eq!(
            (p.percent, p.used, p.window, p.headroom, p.measured),
            (82, 82_000, 100_000, 8_000, true)
        );
        let text = line(&p);
        assert!(text.starts_with("82% of the context window is in use"), "{text}");
        assert!(text.contains("82,000 of 100,000 tokens, counted by the provider"), "{text}");
        assert!(text.contains("8,000 tokens before auto-compact"), "{text}");
        assert!(text.contains("/compact"), "{text}");
    }

    /// An estimate says so: a guess that reads like a measurement is worse
    /// than no number.
    #[test]
    fn an_estimate_is_named_as_one() {
        let p = pressure(90_000, 100_000, 10_000, false).expect("a warning");
        let text = line(&p);
        assert!(text.contains("Jan's estimate"), "{text}");
        assert!(!text.contains("counted by the provider"), "{text}");
    }

    /// Past the compaction line there is no headroom left to offer.
    #[test]
    fn no_headroom_says_the_next_turn_compacts() {
        let p = pressure(95_000, 100_000, 10_000, true).expect("a warning");
        assert_eq!(p.headroom, 0);
        let text = line(&p);
        assert!(text.contains("the next turn auto-compacts"), "{text}");
        assert!(!text.contains("before auto-compact"), "{text}");
    }
}
