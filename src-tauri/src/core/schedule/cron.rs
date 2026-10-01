//! A small five-field cron evaluator that works in an IANA time zone.
//!
//! Written here rather than pulled in so the two places a wall clock lies --
//! the hour a time zone skips and the hour it repeats -- are decided in one
//! readable spot:
//!
//! * A time inside a spring-forward gap (02:30 where the clock jumps 02:00 to
//!   03:00) runs at the first instant that does exist, the end of the gap.
//! * A time inside a fall-back overlap (01:30 happens twice) runs once, at the
//!   first of the two.
//!
//! Fields: `minute hour day-of-month month day-of-week`. Each field takes `*`,
//! numbers, `a-b` ranges, `a,b` lists and `/n` steps; months and weekdays also
//! take three-letter names, and weekday 7 is Sunday. When both day-of-month and
//! day-of-week are restricted a day matches if either does (the traditional
//! cron rule). `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` work.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Serialize;

/// A cron expression that did not parse, with the field it failed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CronError {
    pub message: String,
}

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CronError {}

fn err<T>(message: impl Into<String>) -> Result<T, CronError> {
    Err(CronError { message: message.into() })
}

/// A parsed cron expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    days_restricted: bool,
    weekdays_restricted: bool,
    source: String,
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// How far ahead a search for the next fire looks before giving up, so an
/// expression that can never match (31 February) ends instead of looping.
const HORIZON_DAYS: i64 = 366 * 8;

struct Field<'a> {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'a [&'static str],
    /// What the first name stands for (`jan` is 1, `sun` is 0).
    name_base: u32,
}

fn atom(text: &str, f: &Field) -> Result<u32, CronError> {
    let lower = text.to_ascii_lowercase();
    if let Some(i) = f.names.iter().position(|n| *n == lower) {
        return Ok(i as u32 + f.name_base);
    }
    match text.parse::<u32>() {
        Ok(n) => Ok(n),
        Err(_) => err(format!("'{text}' is not a valid {} value", f.name)),
    }
}

fn parse_field(text: &str, f: &Field) -> Result<u64, CronError> {
    if text.is_empty() {
        return err(format!("the {} field is empty", f.name));
    }
    let weekday = f.name == "day of week";
    let mut bits = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = match s.parse() {
                    Ok(n) if n > 0 => n,
                    _ => return err(format!("the {} step '{s}' must be a positive number", f.name)),
                };
                (r, Some(step))
            }
            None => (part, None),
        };
        let (lo, hi) = if range == "*" {
            (f.min, f.max)
        } else if let Some((a, b)) = range.split_once('-') {
            (atom(a, f)?, atom(b, f)?)
        } else {
            let v = atom(range, f)?;
            // `5/10` means "from 5, every 10", up to the end of the field.
            (v, if step.is_some() { f.max } else { v })
        };
        let top = if weekday { 7 } else { f.max };
        if lo < f.min || hi > top || lo > hi {
            return err(format!("the {} range {lo}-{hi} is outside {}-{}", f.name, f.min, top));
        }
        let step = step.unwrap_or(1);
        let mut v = lo;
        while v <= hi {
            // Sunday is both 0 and 7.
            bits |= 1u64 << if weekday && v == 7 { 0 } else { v };
            v += step;
        }
    }
    Ok(bits)
}

impl CronExpr {
    pub fn parse(text: &str) -> Result<CronExpr, CronError> {
        let trimmed = text.trim();
        let expanded = match trimmed.to_ascii_lowercase().as_str() {
            "@hourly" => "0 * * * *",
            "@daily" | "@midnight" => "0 0 * * *",
            "@weekly" => "0 0 * * 0",
            "@monthly" => "0 0 1 * *",
            "@yearly" | "@annually" => "0 0 1 1 *",
            _ => trimmed,
        };
        let parts: Vec<&str> = expanded.split_whitespace().collect();
        if parts.len() != 5 {
            return err(format!(
                "a cron expression has five fields (minute hour day month weekday), found {}",
                parts.len()
            ));
        }
        let minutes = parse_field(parts[0], &Field { name: "minute", min: 0, max: 59, names: &[], name_base: 0 })?;
        let hours = parse_field(parts[1], &Field { name: "hour", min: 0, max: 23, names: &[], name_base: 0 })?;
        let days = parse_field(parts[2], &Field { name: "day of month", min: 1, max: 31, names: &[], name_base: 0 })?;
        let months = parse_field(parts[3], &Field { name: "month", min: 1, max: 12, names: &MONTHS, name_base: 1 })?;
        let weekdays =
            parse_field(parts[4], &Field { name: "day of week", min: 0, max: 6, names: &WEEKDAYS, name_base: 0 })?;
        Ok(CronExpr {
            minutes,
            hours: hours as u32,
            days: days as u32,
            months: months as u16,
            weekdays: weekdays as u8,
            days_restricted: !parts[2].starts_with('*'),
            weekdays_restricted: !parts[4].starts_with('*'),
            source: trimmed.to_string(),
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        if self.months & (1 << date.month()) == 0 {
            return false;
        }
        let dom = self.days & (1 << date.day()) != 0;
        let dow = self.weekdays & (1 << date.weekday().num_days_from_sunday()) != 0;
        match (self.days_restricted, self.weekdays_restricted) {
            (true, true) => dom || dow,
            (true, false) => dom,
            (false, true) => dow,
            (false, false) => true,
        }
    }

    /// Every fire strictly after `after` and not after `until`, oldest first,
    /// at most `limit` of them.
    pub fn fires_between(&self, tz: Tz, after: DateTime<Utc>, until: DateTime<Utc>, limit: usize) -> Vec<DateTime<Utc>> {
        if until <= after || limit == 0 {
            return Vec::new();
        }
        // A day either side covers every offset a zone has used.
        let first = after.with_timezone(&tz).date_naive() - Duration::days(1);
        let last = until.with_timezone(&tz).date_naive() + Duration::days(1);
        let mut out: Vec<DateTime<Utc>> = Vec::new();
        let mut day = first;
        while day <= last {
            if self.day_matches(day) {
                for h in 0..24u32 {
                    if self.hours & (1 << h) == 0 {
                        continue;
                    }
                    for m in 0..60u32 {
                        if self.minutes & (1 << m) == 0 {
                            continue;
                        }
                        let naive = day.and_hms_opt(h, m, 0).expect("hour and minute are in range");
                        if let Some(at) = resolve(tz, naive) {
                            if at > after && at <= until {
                                out.push(at);
                            }
                        }
                    }
                }
            }
            day += Duration::days(1);
        }
        out.sort();
        out.dedup();
        out.truncate(limit);
        out
    }

    /// The next `count` fires strictly after `after`.
    pub fn next_fires(&self, tz: Tz, after: DateTime<Utc>, count: usize) -> Vec<DateTime<Utc>> {
        let mut out: Vec<DateTime<Utc>> = Vec::new();
        let mut from = after;
        let end = after + Duration::days(HORIZON_DAYS);
        while out.len() < count && from < end {
            let to = (from + Duration::days(40)).min(end);
            let got = self.fires_between(tz, from, to, count - out.len());
            out.extend(got);
            from = to;
        }
        out
    }
}

/// The instant a wall-clock time stands for in `tz`; see the module notes for
/// the skipped and repeated hour.
fn resolve(tz: Tz, naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, _) => Some(first.with_timezone(&Utc)),
        LocalResult::None => {
            // In a gap: the first minute that exists is where the gap ends.
            let mut probe = naive;
            for _ in 0..(24 * 60) {
                probe += Duration::minutes(1);
                match tz.from_local_datetime(&probe) {
                    LocalResult::Single(t) => return Some(t.with_timezone(&Utc)),
                    LocalResult::Ambiguous(first, _) => return Some(first.with_timezone(&Utc)),
                    LocalResult::None => {}
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn invalid_expressions_are_refused_with_a_reason() {
        for bad in [
            "", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *",
            "* * * * 8", "*/0 * * * *", "a * * * *", "5-1 * * * *", "1,,2 * * * *", "*/x * * * *",
        ] {
            assert!(CronExpr::parse(bad).is_err(), "{bad:?} should not parse");
        }
        assert!(CronExpr::parse("61 * * * *").unwrap_err().message.contains("minute"));
    }

    #[test]
    fn lists_ranges_steps_names_and_macros_parse() {
        assert!(CronExpr::parse("0,30 9-17/2 * jan-mar mon-fri").is_ok());
        assert!(CronExpr::parse("*/15 * * * *").is_ok());
        assert!(CronExpr::parse("5/20 * * * *").is_ok());
        assert!(CronExpr::parse("0 0 * * 7").is_ok());
        for m in ["@hourly", "@daily", "@weekly", "@monthly", "@yearly"] {
            assert!(CronExpr::parse(m).is_ok(), "{m}");
        }
    }

    #[test]
    fn a_daily_time_fires_each_day_in_the_zone() {
        let c = CronExpr::parse("30 9 * * *").unwrap();
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        let f = c.next_fires(tz, utc("2026-01-10T00:00:00Z"), 3);
        // Berlin is UTC+1 in January.
        assert_eq!(f, vec![utc("2026-01-10T08:30:00Z"), utc("2026-01-11T08:30:00Z"), utc("2026-01-12T08:30:00Z")]);
    }

    #[test]
    fn the_start_is_exclusive_and_the_end_inclusive() {
        let c = CronExpr::parse("0 12 * * *").unwrap();
        let tz: Tz = "UTC".parse().unwrap();
        let at = utc("2026-03-01T12:00:00Z");
        assert!(c.fires_between(tz, at, at + Duration::hours(1), 9).is_empty());
        assert_eq!(c.fires_between(tz, at - Duration::hours(1), at, 9), vec![at]);
    }

    #[test]
    fn a_time_in_the_spring_forward_gap_runs_once_when_the_gap_ends() {
        // US clocks jump 02:00 -> 03:00 on 2026-03-08 in New York.
        let c = CronExpr::parse("30 2 * * *").unwrap();
        let tz: Tz = "America/New_York".parse().unwrap();
        let f = c.fires_between(tz, utc("2026-03-07T00:00:00Z"), utc("2026-03-10T00:00:00Z"), 10);
        assert_eq!(f.len(), 3, "{f:?}");
        // 03-07 02:30 EST = 07:30Z; 03-08 gap -> 03:00 EDT = 07:00Z; 03-09 02:30 EDT = 06:30Z.
        assert_eq!(f[0], utc("2026-03-07T07:30:00Z"));
        assert_eq!(f[1], utc("2026-03-08T07:00:00Z"));
        assert_eq!(f[2], utc("2026-03-09T06:30:00Z"));
    }

    #[test]
    fn a_gap_does_not_double_fire_with_a_job_at_the_gap_end() {
        let c = CronExpr::parse("0,30 2,3 * * *").unwrap();
        let tz: Tz = "America/New_York".parse().unwrap();
        let day = c.fires_between(tz, utc("2026-03-08T00:00:00Z"), utc("2026-03-09T00:00:00Z"), 20);
        let mut sorted = day.clone();
        sorted.dedup();
        assert_eq!(day, sorted, "no instant appears twice");
        // 03:00 and 03:30 EDT only (02:00/02:30 collapse into 03:00).
        assert_eq!(day, vec![utc("2026-03-08T07:00:00Z"), utc("2026-03-08T07:30:00Z")]);
    }

    #[test]
    fn a_time_in_the_fall_back_overlap_runs_once_at_the_first_occurrence() {
        // Clocks fall 02:00 EDT -> 01:00 EST on 2026-11-01 in New York.
        let c = CronExpr::parse("30 1 * * *").unwrap();
        let tz: Tz = "America/New_York".parse().unwrap();
        let f = c.fires_between(tz, utc("2026-11-01T00:00:00Z"), utc("2026-11-02T00:00:00Z"), 10);
        assert_eq!(f, vec![utc("2026-11-01T05:30:00Z")], "01:30 EDT, not the repeated 01:30 EST");
    }

    #[test]
    fn day_of_month_and_weekday_combine_with_or_when_both_are_set() {
        let tz: Tz = "UTC".parse().unwrap();
        // The 13th, or any Friday.
        let c = CronExpr::parse("0 0 13 * fri").unwrap();
        let f = c.fires_between(tz, utc("2026-02-01T00:00:00Z"), utc("2026-02-28T23:59:00Z"), 20);
        let days: Vec<u32> = f.iter().map(|d| d.day()).collect();
        assert_eq!(days, vec![6, 13, 20, 27]);
        let only_dom = CronExpr::parse("0 0 13 * *").unwrap();
        assert_eq!(only_dom.fires_between(tz, utc("2026-02-01T00:00:00Z"), utc("2026-02-28T23:59:00Z"), 20).len(), 1);
    }

    #[test]
    fn sunday_is_zero_or_seven() {
        let tz: Tz = "UTC".parse().unwrap();
        let a = CronExpr::parse("0 8 * * 0").unwrap().next_fires(tz, utc("2026-03-01T00:00:00Z"), 2);
        let b = CronExpr::parse("0 8 * * 7").unwrap().next_fires(tz, utc("2026-03-01T00:00:00Z"), 2);
        assert_eq!(a, b);
        assert_eq!(a[0].weekday(), chrono::Weekday::Sun);
    }

    #[test]
    fn an_expression_that_can_never_match_ends_the_search() {
        let tz: Tz = "UTC".parse().unwrap();
        let c = CronExpr::parse("0 0 31 2 *").unwrap();
        assert!(c.next_fires(tz, utc("2026-01-01T00:00:00Z"), 1).is_empty());
    }

    #[test]
    fn leap_day_is_found_across_years() {
        let tz: Tz = "UTC".parse().unwrap();
        let c = CronExpr::parse("0 0 29 2 *").unwrap();
        let f = c.next_fires(tz, utc("2026-01-01T00:00:00Z"), 1);
        assert_eq!(f, vec![utc("2028-02-29T00:00:00Z")]);
    }
}
