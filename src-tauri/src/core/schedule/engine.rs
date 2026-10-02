//! Which tasks are due, as a pure function of the clock and what has been seen.
//!
//! `due` reads no clock, no disk and no process list: the caller passes the
//! time, the per-task watermarks (the instant up to which fires have already
//! been considered), the tasks, and which of them have a run in flight. It
//! returns what to start, what was dropped and why, and the watermarks to
//! store. Everything a scheduler gets wrong -- double fires, missed runs after
//! sleep, a clock that jumps, a daylight-saving change -- is decided here where
//! it can be tested with a fake clock.
//!
//! Rules:
//! * A fire at most [`GRACE_SECS`] old is *on time*; an older one was *missed*
//!   (the app was closed, asleep, or busy) and follows the task's catch-up
//!   policy. Fires older than [`LOOKBACK_DAYS`] are forgotten.
//! * A task seen for the first time, or just enabled, starts at `now`: nothing
//!   is made up for the period before it existed.
//! * A task with a run still in flight skips the fire and says so, except under
//!   `all_capped` catch-up, where the remaining missed runs wait their turn.
//! * One task starts at most one run per tick, and at most `max_fires` start in
//!   a tick; a task that did not get its turn keeps its watermark, so it is
//!   first in line next tick.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::spec::{CatchUp, Task};

pub const GRACE_SECS: i64 = 120;
pub const LOOKBACK_DAYS: i64 = 7;
/// Most missed runs `all_capped` catches up.
pub const CATCH_UP_CAP: usize = 5;
pub const MAX_FIRES_PER_TICK: usize = 4;

/// Most fire instants held for one task in one tick; only the newest matter.
const ENUMERATION_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FireKind {
    OnTime,
    CatchUp,
}

/// A run to start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fire {
    pub task_id: String,
    pub scheduled_for: DateTime<Utc>,
    pub kind: FireKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// The previous run had not finished.
    StillRunning,
    /// Missed, and the task's policy is to forget it.
    CatchUpSkipped,
    /// Missed, and another run covers it (`once`), or it is past the cap.
    Superseded,
    /// The task's schedule no longer compiles.
    InvalidSchedule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub task_id: String,
    pub scheduled_for: DateTime<Utc>,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Due {
    pub fires: Vec<Fire>,
    pub skipped: Vec<Skipped>,
    /// New watermarks, to merge over the stored ones.
    pub watermarks: BTreeMap<String, DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_fires: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_fires: MAX_FIRES_PER_TICK }
    }
}

/// What is due at `now`.
pub fn due(
    now: DateTime<Utc>,
    tasks: &[Task],
    watermarks: &BTreeMap<String, DateTime<Utc>>,
    running: &BTreeSet<String>,
    limits: Limits,
) -> Due {
    let mut out = Due::default();
    let mut ordered: Vec<&Task> = tasks.iter().collect();
    ordered.sort_by(|a, b| a.id.cmp(&b.id));
    for task in ordered {
        if !task.enabled {
            out.watermarks.insert(task.id.clone(), now);
            continue;
        }
        let Some(&mark) = watermarks.get(&task.id) else {
            out.watermarks.insert(task.id.clone(), now);
            continue;
        };
        if mark > now {
            // The clock went back. Wait it out rather than fire twice.
            continue;
        }
        let start = mark.max(now - Duration::days(LOOKBACK_DAYS));
        let missed = match fires_in(task, start, now) {
            Ok(m) => m,
            Err(()) => {
                out.skipped.push(Skipped { task_id: task.id.clone(), scheduled_for: now, reason: SkipReason::InvalidSchedule });
                out.watermarks.insert(task.id.clone(), now);
                continue;
            }
        };
        if missed.is_empty() {
            out.watermarks.insert(task.id.clone(), now);
            continue;
        }
        let (late, on_time): (Vec<_>, Vec<_>) = missed.into_iter().partition(|f| (now - *f).num_seconds() > GRACE_SECS);
        let mut candidates: Vec<(DateTime<Utc>, FireKind)> = Vec::new();
        let mut dropped: Vec<(DateTime<Utc>, SkipReason)> = Vec::new();
        match task.catch_up {
            CatchUp::Skip => dropped.extend(late.iter().map(|f| (*f, SkipReason::CatchUpSkipped))),
            CatchUp::Once => {
                if on_time.is_empty() {
                    if let Some((last, rest)) = late.split_last() {
                        candidates.push((*last, FireKind::CatchUp));
                        dropped.extend(rest.iter().map(|f| (*f, SkipReason::Superseded)));
                    }
                } else {
                    dropped.extend(late.iter().map(|f| (*f, SkipReason::Superseded)));
                }
            }
            CatchUp::AllCapped => {
                let keep = late.len().saturating_sub(CATCH_UP_CAP);
                dropped.extend(late[..keep].iter().map(|f| (*f, SkipReason::Superseded)));
                candidates.extend(late[keep..].iter().map(|f| (*f, FireKind::CatchUp)));
            }
        }
        if let Some((last, rest)) = on_time.split_last() {
            candidates.push((*last, FireKind::OnTime));
            dropped.extend(rest.iter().map(|f| (*f, SkipReason::Superseded)));
        }

        if candidates.is_empty() {
            push_skips(&mut out, &task.id, dropped);
            out.watermarks.insert(task.id.clone(), now);
            continue;
        }

        if running.contains(&task.id) {
            if task.catch_up == CatchUp::AllCapped && candidates.iter().any(|(_, k)| *k == FireKind::CatchUp) {
                // The missed runs wait for this one to end; nothing moves.
                continue;
            }
            dropped.extend(candidates.iter().map(|(f, _)| (*f, SkipReason::StillRunning)));
            push_skips(&mut out, &task.id, dropped);
            out.watermarks.insert(task.id.clone(), now);
            continue;
        }

        if out.fires.len() >= limits.max_fires {
            // Out of turns this tick; keep the watermark, try first next time.
            continue;
        }
        let (first_at, first_kind) = candidates[0];
        out.fires.push(Fire { task_id: task.id.clone(), scheduled_for: first_at, kind: first_kind });
        push_skips(&mut out, &task.id, dropped);
        if candidates.len() > 1 {
            // More catch-up behind it: it starts after this one ends.
            out.watermarks.insert(task.id.clone(), first_at);
        } else {
            out.watermarks.insert(task.id.clone(), now);
        }
    }
    out
}

fn push_skips(out: &mut Due, task_id: &str, mut dropped: Vec<(DateTime<Utc>, SkipReason)>) {
    dropped.sort_by_key(|(at, _)| *at);
    // A history of thousands of forgotten minutes helps nobody.
    let from = dropped.len().saturating_sub(20);
    for (at, reason) in dropped.into_iter().skip(from) {
        out.skipped.push(Skipped { task_id: task_id.to_string(), scheduled_for: at, reason });
    }
}

/// Every fire of `task` in `(after, until]`, merged across its expressions.
fn fires_in(task: &Task, after: DateTime<Utc>, until: DateTime<Utc>) -> Result<Vec<DateTime<Utc>>, ()> {
    let tz = task.tz().map_err(|_| ())?;
    let exprs = task.schedule.compile().map_err(|_| ())?;
    let mut all: Vec<DateTime<Utc>> = Vec::new();
    for e in exprs {
        all.extend(e.fires_between(tz, after, until, ENUMERATION_LIMIT));
    }
    all.sort();
    all.dedup();
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::fixtures::task;
    use crate::core::schedule::spec::{Schedule, TimeOfDay};

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn marks(pairs: &[(&str, &str)]) -> BTreeMap<String, DateTime<Utc>> {
        pairs.iter().map(|(k, v)| (k.to_string(), utc(v))).collect()
    }

    fn run(now: &str, tasks: &[Task], w: &BTreeMap<String, DateTime<Utc>>) -> Due {
        due(utc(now), tasks, w, &BTreeSet::new(), Limits::default())
    }

    fn daily(id: &str, h: u8, m: u8) -> Task {
        let mut t = task(id);
        t.schedule = Schedule::Daily { times: vec![TimeOfDay { hour: h, minute: m }] };
        t
    }

    #[test]
    fn a_task_fires_on_time_once_and_not_again() {
        let t = [daily("a", 9, 0)];
        let first = run("2026-05-02T09:00:20Z", &t, &marks(&[("a", "2026-05-02T08:59:50Z")]));
        assert_eq!(first.fires.len(), 1);
        assert_eq!(first.fires[0].kind, FireKind::OnTime);
        assert_eq!(first.fires[0].scheduled_for, utc("2026-05-02T09:00:00Z"));
        // The watermark moved to now; the next tick sees nothing new.
        let second = run("2026-05-02T09:00:50Z", &t, &first.watermarks);
        assert!(second.fires.is_empty() && second.skipped.is_empty());
    }

    #[test]
    fn a_new_task_starts_at_now_and_does_not_backfill() {
        let t = [daily("a", 9, 0)];
        let d = run("2026-05-02T12:00:00Z", &t, &BTreeMap::new());
        assert!(d.fires.is_empty());
        assert_eq!(d.watermarks["a"], utc("2026-05-02T12:00:00Z"));
    }

    #[test]
    fn a_disabled_task_never_fires_and_does_not_backfill_when_enabled() {
        let mut t = daily("a", 9, 0);
        t.enabled = false;
        let d = run("2026-05-02T09:00:10Z", &[t.clone()], &marks(&[("a", "2026-05-01T00:00:00Z")]));
        assert!(d.fires.is_empty());
        t.enabled = true;
        let later = run("2026-05-02T09:05:00Z", &[t], &d.watermarks);
        assert!(later.fires.is_empty(), "enabled after the fire time: nothing to catch up");
    }

    #[test]
    fn catch_up_once_runs_the_newest_missed_fire_once() {
        let t = [daily("a", 9, 0)];
        // Asleep for three days.
        let d = run("2026-05-04T15:00:00Z", &t, &marks(&[("a", "2026-05-01T10:00:00Z")]));
        assert_eq!(d.fires.len(), 1);
        assert_eq!(d.fires[0].kind, FireKind::CatchUp);
        assert_eq!(d.fires[0].scheduled_for, utc("2026-05-04T09:00:00Z"));
        assert_eq!(d.skipped.len(), 2);
        assert!(d.skipped.iter().all(|s| s.reason == SkipReason::Superseded));
        assert_eq!(d.watermarks["a"], utc("2026-05-04T15:00:00Z"));
    }

    #[test]
    fn catch_up_skip_forgets_missed_fires_but_still_runs_on_time_ones() {
        let mut t = daily("a", 9, 0);
        t.catch_up = CatchUp::Skip;
        let d = run("2026-05-04T15:00:00Z", &[t.clone()], &marks(&[("a", "2026-05-01T10:00:00Z")]));
        assert!(d.fires.is_empty());
        assert_eq!(d.skipped.len(), 3);
        assert!(d.skipped.iter().all(|s| s.reason == SkipReason::CatchUpSkipped));
        let on_time = run("2026-05-04T09:00:30Z", &[t], &marks(&[("a", "2026-05-04T08:00:00Z")]));
        assert_eq!(on_time.fires.len(), 1);
    }

    #[test]
    fn an_on_time_fire_covers_missed_ones_under_once() {
        let t = [daily("a", 9, 0)];
        let d = run("2026-05-04T09:00:30Z", &t, &marks(&[("a", "2026-05-01T10:00:00Z")]));
        assert_eq!(d.fires.len(), 1);
        assert_eq!(d.fires[0].kind, FireKind::OnTime);
        assert_eq!(d.skipped.len(), 2);
    }

    #[test]
    fn all_capped_runs_the_newest_few_one_per_tick_oldest_first() {
        let mut t = Task { schedule: Schedule::Cron { expr: "0 * * * *".into() }, ..task("a") };
        t.catch_up = CatchUp::AllCapped;
        let tasks = [t];
        // Ten hourly fires missed (08:00..17:00 are late at 18:30).
        let mut w = marks(&[("a", "2026-05-02T07:30:00Z")]);
        let mut ran = Vec::new();
        for _ in 0..8 {
            let d = run("2026-05-02T18:30:00Z", &tasks, &w);
            let Some(f) = d.fires.first() else { break };
            ran.push(f.scheduled_for);
            w.extend(d.watermarks);
        }
        assert_eq!(ran.len(), CATCH_UP_CAP);
        assert!(ran.windows(2).all(|p| p[0] < p[1]), "oldest first: {ran:?}");
        assert_eq!(ran.last().copied(), Some(utc("2026-05-02T18:00:00Z")), "ends with the newest missed");
        assert_eq!(ran[0], utc("2026-05-02T14:00:00Z"));
    }

    #[test]
    fn a_run_in_flight_skips_the_fire_and_says_so() {
        let t = [daily("a", 9, 0)];
        let running: BTreeSet<String> = ["a".to_string()].into();
        let d = due(utc("2026-05-02T09:00:10Z"), &t, &marks(&[("a", "2026-05-02T08:00:00Z")]), &running, Limits::default());
        assert!(d.fires.is_empty());
        assert_eq!(d.skipped, vec![Skipped { task_id: "a".into(), scheduled_for: utc("2026-05-02T09:00:00Z"), reason: SkipReason::StillRunning }]);
        assert_eq!(d.watermarks["a"], utc("2026-05-02T09:00:10Z"));
    }

    #[test]
    fn all_capped_catch_up_waits_for_the_running_job_instead_of_dropping() {
        let mut t = daily("a", 9, 0);
        t.catch_up = CatchUp::AllCapped;
        let running: BTreeSet<String> = ["a".to_string()].into();
        let w = marks(&[("a", "2026-05-01T10:00:00Z")]);
        let d = due(utc("2026-05-03T15:00:00Z"), &[t], &w, &running, Limits::default());
        assert!(d.fires.is_empty() && d.skipped.is_empty() && d.watermarks.is_empty());
    }

    #[test]
    fn the_tick_cap_defers_tasks_without_losing_their_fires() {
        let tasks: Vec<Task> = (0..6).map(|i| daily(&format!("t{i}"), 9, 0)).collect();
        let mut w: BTreeMap<String, DateTime<Utc>> =
            tasks.iter().map(|t| (t.id.clone(), utc("2026-05-02T08:00:00Z"))).collect();
        let d = due(utc("2026-05-02T09:00:10Z"), &tasks, &w, &BTreeSet::new(), Limits { max_fires: 4 });
        assert_eq!(d.fires.len(), 4);
        w.extend(d.watermarks);
        // The two left over still fire next tick (as on-time, within grace).
        let d2 = due(utc("2026-05-02T09:00:40Z"), &tasks, &w, &BTreeSet::new(), Limits { max_fires: 4 });
        let ids: Vec<&str> = d2.fires.iter().map(|f| f.task_id.as_str()).collect();
        assert_eq!(ids, vec!["t4", "t5"]);
    }

    #[test]
    fn a_clock_that_goes_backwards_fires_nothing_twice() {
        let t = [daily("a", 9, 0)];
        let d = run("2026-05-02T08:59:00Z", &t, &marks(&[("a", "2026-05-02T09:05:00Z")]));
        assert!(d.fires.is_empty());
        assert!(d.watermarks.is_empty(), "the watermark is left alone");
    }

    #[test]
    fn a_long_absence_only_looks_back_a_week() {
        let t = [Task { schedule: Schedule::Cron { expr: "*/1 * * * *".into() }, catch_up: CatchUp::AllCapped, ..task("a") }];
        let d = run("2026-06-01T12:00:00Z", &t, &marks(&[("a", "2025-01-01T00:00:00Z")]));
        assert_eq!(d.fires.len(), 1);
        assert!(d.fires[0].scheduled_for >= utc("2026-05-25T12:00:00Z"));
    }

    #[test]
    fn daylight_saving_gap_and_overlap_each_fire_exactly_once() {
        let mut t = daily("a", 2, 30);
        t.timezone = "America/New_York".into();
        let tasks = [t];
        // Spring-forward day: 02:30 does not exist; the run lands at 03:00 EDT = 07:00Z.
        let gap = run("2026-03-08T07:00:30Z", &tasks, &marks(&[("a", "2026-03-08T06:59:00Z")]));
        assert_eq!(gap.fires.len(), 1);
        assert_eq!(gap.fires[0].scheduled_for, utc("2026-03-08T07:00:00Z"));
        let again = run("2026-03-08T07:01:10Z", &tasks, &gap.watermarks);
        assert!(again.fires.is_empty());

        let mut o = daily("a", 1, 30);
        o.timezone = "America/New_York".into();
        let overlap_tasks = [o];
        // Fall-back day: 01:30 happens at 05:30Z and again at 06:30Z; only the first runs.
        let first = run("2026-11-01T05:30:10Z", &overlap_tasks, &marks(&[("a", "2026-11-01T05:20:00Z")]));
        assert_eq!(first.fires.len(), 1);
        let second = run("2026-11-01T06:30:10Z", &overlap_tasks, &marks(&[("a", "2026-11-01T06:20:00Z")]));
        assert!(second.fires.is_empty(), "the repeated 01:30 does not run again");
    }

    #[test]
    fn a_task_with_an_invalid_schedule_is_skipped_not_fatal() {
        let bad = Task { schedule: Schedule::Cron { expr: "nonsense".into() }, ..task("bad") };
        let good = daily("good", 9, 0);
        let w = marks(&[("bad", "2026-05-02T08:00:00Z"), ("good", "2026-05-02T08:00:00Z")]);
        let d = run("2026-05-02T09:00:10Z", &[bad, good], &w);
        assert_eq!(d.fires.len(), 1);
        assert_eq!(d.fires[0].task_id, "good");
        assert_eq!(d.skipped[0].reason, SkipReason::InvalidSchedule);
    }

    #[test]
    fn several_times_a_day_merge_into_one_ordered_series() {
        let t = Task {
            schedule: Schedule::Daily {
                times: vec![TimeOfDay { hour: 9, minute: 0 }, TimeOfDay { hour: 9, minute: 30 }, TimeOfDay { hour: 17, minute: 0 }],
            },
            catch_up: CatchUp::Skip,
            ..task("a")
        };
        let mut w = marks(&[("a", "2026-05-02T08:59:00Z")]);
        let mut seen = Vec::new();
        for now in ["2026-05-02T09:00:20Z", "2026-05-02T09:30:20Z", "2026-05-02T17:00:20Z"] {
            let d = run(now, &[t.clone()], &w);
            seen.extend(d.fires.iter().map(|f| f.scheduled_for));
            w.extend(d.watermarks);
        }
        assert_eq!(seen, vec![utc("2026-05-02T09:00:00Z"), utc("2026-05-02T09:30:00Z"), utc("2026-05-02T17:00:00Z")]);
    }
}
