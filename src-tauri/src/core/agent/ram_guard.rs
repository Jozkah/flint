//! A free-memory guard for local inference and heavy work (`[agent]
//! min_free_ram_mb`, `min_free_vram_mb`).
//!
//! Loading a model, or carrying on with one, on a machine that is out of RAM
//! does not fail politely: Windows starts paging the whole desktop, a llama.cpp
//! process is killed by the OOM handler, and the user loses unrelated work. The
//! guard checks before each turn instead. Low memory is first waited out for a
//! short grace period (another process may be about to exit); if it stays low
//! the run stops with a clear message the user can resume from once there is
//! room, rather than pushing on.
//!
//! The thresholds are opt-in: unset, nothing is read and nothing changes. The
//! readings come from the hardware plugin, so the Windows implementation is the
//! one the rest of the app already trusts. A reading that cannot be taken is
//! "unknown", and unknown never blocks a run: the guard exists to prevent a
//! crash, not to invent a refusal.

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

/// Body keys the loop carries the thresholds in. Private to the loop like the
/// other `jan_` keys; never forwarded upstream.
const BODY_MIN_FREE_RAM_MB: &str = "jan_min_free_ram_mb";
const BODY_MIN_FREE_VRAM_MB: &str = "jan_min_free_vram_mb";

/// How long low memory is waited out before the run stops, and how often it is
/// re-read meanwhile.
pub(crate) const GRACE: Duration = Duration::from_secs(20);
pub(crate) const POLL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Thresholds {
    pub min_free_ram_mb: Option<u64>,
    pub min_free_vram_mb: Option<u64>,
}

impl Thresholds {
    pub(crate) fn is_set(&self) -> bool {
        self.min_free_ram_mb.is_some() || self.min_free_vram_mb.is_some()
    }
}

/// What the machine has free right now. `None` is unknown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Reading {
    pub free_ram_mb: Option<u64>,
    pub free_vram_mb: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    Ok,
    /// Below a threshold; the text names which and by how much.
    Low(String),
}

pub(crate) fn evaluate(t: &Thresholds, r: &Reading) -> Verdict {
    if let (Some(min), Some(free)) = (t.min_free_ram_mb, r.free_ram_mb) {
        if free < min {
            return Verdict::Low(format!(
                "free RAM is {free} MB, below the {min} MB set by min_free_ram_mb"
            ));
        }
    }
    if let (Some(min), Some(free)) = (t.min_free_vram_mb, r.free_vram_mb) {
        if free < min {
            return Verdict::Low(format!(
                "free VRAM is {free} MB, below the {min} MB set by min_free_vram_mb"
            ));
        }
    }
    Verdict::Ok
}

/// Read the machine. Only what a threshold asks for is read.
pub(crate) fn read(t: &Thresholds) -> Reading {
    Reading {
        // A 0 reading means the probe failed, not that the machine has no RAM.
        free_ram_mb: t
            .min_free_ram_mb
            .map(|_| tauri_plugin_hardware::available_memory_mb())
            .filter(|mb| *mb > 0),
        free_vram_mb: t.min_free_vram_mb.and_then(|_| tauri_plugin_hardware::free_vram_mb()),
    }
}

/// Set or clear the thresholds on a run's body. A child run's keys are cleared:
/// the parent already guards the machine, and a subagent must not inherit a
/// stale copy.
pub(crate) fn annotate(body: &mut Value, t: &Thresholds, is_child: bool) {
    let Some(obj) = body.as_object_mut() else { return };
    for (key, value) in [
        (BODY_MIN_FREE_RAM_MB, t.min_free_ram_mb),
        (BODY_MIN_FREE_VRAM_MB, t.min_free_vram_mb),
    ] {
        match value {
            Some(mb) if !is_child => {
                obj.insert(key.to_string(), Value::from(mb));
            }
            _ => {
                obj.remove(key);
            }
        }
    }
}

pub(crate) fn from_body(body: &Value) -> Thresholds {
    let get = |key: &str| body.get(key).and_then(Value::as_u64);
    Thresholds {
        min_free_ram_mb: get(BODY_MIN_FREE_RAM_MB),
        min_free_vram_mb: get(BODY_MIN_FREE_VRAM_MB),
    }
}

/// Wait for room: `Ok` as soon as a reading clears the thresholds, `Err` with
/// the last reason once `grace` has passed. `read` and `sleep` are injected so
/// the timing is testable without a clock.
pub(crate) async fn wait_for_room<R, S, Fut>(
    t: &Thresholds,
    grace: Duration,
    poll: Duration,
    mut read: R,
    mut sleep: S,
) -> Result<(), String>
where
    R: FnMut() -> Reading,
    S: FnMut(Duration) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut waited = Duration::ZERO;
    loop {
        match evaluate(t, &read()) {
            Verdict::Ok => return Ok(()),
            Verdict::Low(reason) => {
                if waited >= grace {
                    return Err(reason);
                }
                log::warn!("agent: low memory, waiting for room: {reason}");
                sleep(poll).await;
                waited += poll;
            }
        }
    }
}

/// The guard the turn loop calls before each model request. A no-op unless the
/// run carries thresholds. It only awaits `tokio::time::sleep`, so the run's
/// ambient cancellation drops it like any other await.
pub(crate) async fn guard(body: &Value) -> Result<(), String> {
    let t = from_body(body);
    if !t.is_set() {
        return Ok(());
    }
    // One cheap read first: the common case is plenty of room.
    if evaluate(&t, &read(&t)) == Verdict::Ok {
        return Ok(());
    }
    wait_for_room(&t, GRACE, POLL, || read(&t), tokio::time::sleep)
        .await
        .map_err(|reason| {
            format!(
                "Paused before the next turn: {reason}. Free some memory and resume; \
                 nothing was started that could not be."
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn t(ram: Option<u64>, vram: Option<u64>) -> Thresholds {
        Thresholds { min_free_ram_mb: ram, min_free_vram_mb: vram }
    }

    #[test]
    fn unset_thresholds_never_block() {
        let r = Reading { free_ram_mb: Some(1), free_vram_mb: Some(1) };
        assert_eq!(evaluate(&t(None, None), &r), Verdict::Ok);
        assert!(!t(None, None).is_set());
    }

    #[test]
    fn ram_below_the_threshold_is_low_and_at_it_is_fine() {
        let low = Reading { free_ram_mb: Some(1999), free_vram_mb: None };
        let edge = Reading { free_ram_mb: Some(2000), free_vram_mb: None };
        assert!(
            matches!(evaluate(&t(Some(2000), None), &low), Verdict::Low(m) if m.contains("1999") && m.contains("2000"))
        );
        assert_eq!(evaluate(&t(Some(2000), None), &edge), Verdict::Ok);
    }

    #[test]
    fn vram_is_checked_independently() {
        let r = Reading { free_ram_mb: Some(10_000), free_vram_mb: Some(512) };
        assert!(matches!(evaluate(&t(Some(2000), Some(1024)), &r), Verdict::Low(m) if m.contains("VRAM")));
    }

    #[test]
    fn an_unknown_reading_never_blocks() {
        let r = Reading { free_ram_mb: None, free_vram_mb: None };
        assert_eq!(evaluate(&t(Some(2000), Some(2000)), &r), Verdict::Ok);
    }

    #[test]
    fn thresholds_round_trip_through_the_body_and_children_are_cleared() {
        let mut body = serde_json::json!({});
        annotate(&mut body, &t(Some(1500), Some(900)), false);
        assert_eq!(from_body(&body), t(Some(1500), Some(900)));
        annotate(&mut body, &t(Some(1500), Some(900)), true);
        assert_eq!(from_body(&body), t(None, None));
        annotate(&mut body, &t(Some(1500), None), false);
        annotate(&mut body, &t(None, None), false);
        assert_eq!(from_body(&body), t(None, None));
    }

    #[tokio::test]
    async fn waiting_returns_as_soon_as_room_appears() {
        let readings = RefCell::new(vec![
            Reading { free_ram_mb: Some(100), free_vram_mb: None },
            Reading { free_ram_mb: Some(100), free_vram_mb: None },
            Reading { free_ram_mb: Some(4000), free_vram_mb: None },
        ]);
        let slept = RefCell::new(0u32);
        let out = wait_for_room(
            &t(Some(2000), None),
            Duration::from_secs(20),
            Duration::from_secs(2),
            || readings.borrow_mut().remove(0),
            |_| {
                *slept.borrow_mut() += 1;
                async {}
            },
        )
        .await;
        assert!(out.is_ok());
        assert_eq!(*slept.borrow(), 2);
    }

    #[tokio::test]
    async fn waiting_gives_up_after_the_grace_period_with_the_reason() {
        let slept = RefCell::new(0u32);
        let out = wait_for_room(
            &t(Some(2000), None),
            Duration::from_secs(6),
            Duration::from_secs(2),
            || Reading { free_ram_mb: Some(100), free_vram_mb: None },
            |_| {
                *slept.borrow_mut() += 1;
                async {}
            },
        )
        .await;
        assert!(out.unwrap_err().contains("min_free_ram_mb"));
        assert_eq!(*slept.borrow(), 3, "3 polls of 2s fill a 6s grace");
    }

    #[tokio::test]
    async fn the_guard_is_a_no_op_without_thresholds() {
        assert!(guard(&serde_json::json!({})).await.is_ok());
    }

    #[tokio::test]
    async fn a_threshold_no_machine_can_meet_is_refused_against_the_real_reading() {
        // Zero grace: the guard's decision without its wait.
        let thresholds = t(Some(u64::MAX / 2), None);
        let out = wait_for_room(&thresholds, Duration::ZERO, POLL, || read(&thresholds), |_| async {}).await;
        assert!(out.is_err(), "no machine has that much free RAM");
    }

    #[test]
    fn the_real_reading_is_plausible() {
        let r = read(&t(Some(1), None));
        assert!(r.free_ram_mb.unwrap() > 0);
        assert_eq!(r.free_vram_mb, None, "no VRAM threshold, no VRAM read");
    }
}
