//! Inbound control and notify-when-idle (docs/AGENT_MESSAGING.md).
//!
//! `inbound: hold` stores a message undelivered until the recipient's user
//! approves (delivered once) or denies (dropped) it; one nobody answers within
//! [`HELD_TTL_MS`] is dropped and its sender told. A notify-when-idle
//! subscription asks for one short notice when a session next finishes a turn
//! with nothing queued, or is deleted. Both reuse the mailbox: the notices are
//! ordinary messages (`origin: notice`) from the watched session, so they pass
//! the same limits, loop guard and inbound control as any other mail. Nothing
//! here can approve a permission or change a setting.

use super::*;

/// One notify-when-idle request, kept in `mailbox/subscriptions.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleSub {
    pub asker: String,
    pub target: String,
    pub created_at: i64,
    /// The asker's chain when it subscribed, so the notice continues it and a
    /// loop of subscribe-and-wake still ends at the hop limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainContext>,
}

/// What a subscribe call did.
#[derive(Debug, Clone, PartialEq)]
pub struct SubscribeReceipt {
    pub expires_at: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IdleEvent {
    Idle,
    Deleted,
}

fn quoted(name: &str) -> String {
    name.replace(['\r', '\n', '"'], " ").trim().to_string()
}

impl Mailbox {
    fn subs_path(&self) -> PathBuf {
        self.root.join("subscriptions.json")
    }

    fn read_subs(&self) -> Vec<IdleSub> {
        std::fs::read(self.subs_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_subs(&self, subs: &[IdleSub]) -> Result<()> {
        write_json_atomically(&self.subs_path(), &subs)
    }

    fn name_of(&self, session_id: &str) -> String {
        self.read_registry()
            .ok()
            .and_then(|r| r.get(session_id).map(|s| quoted(&s.display_name)))
            .unwrap_or_else(|| session_id.to_string())
    }

    // -- held mail ---------------------------------------------------------

    /// When the next sweep is due, kept on disk so every process sharing the
    /// mailbox folder skips the sweep until then (AGTB-023).
    fn sweep_due_path(&self) -> PathBuf {
        self.root.join("sweep-due")
    }

    /// The stored due time, `None` when missing or unreadable (sweep now).
    fn sweep_due(&self) -> Option<i64> {
        std::fs::read_to_string(self.sweep_due_path())
            .ok()
            .and_then(|t| t.trim().parse().ok())
    }

    /// Forget the stored due time, so the next sweep runs.
    pub(super) fn clear_sweep_due(&self) {
        let _ = std::fs::remove_file(self.sweep_due_path());
    }

    /// Store when the next sweep is due: the earliest remaining deadline, but
    /// never later than `now + HELD_TTL_MS`. That cap is what makes the stored
    /// time safe across processes without anyone lowering it: every held
    /// message and subscription added after this sweep read the state gets a
    /// deadline at least [`HELD_TTL_MS`] after its own `now`, so it can never
    /// fall due before the stored time. The one path that writes an earlier
    /// deadline (rebuilding a corrupt delivery state) clears the file instead.
    fn store_sweep_due(&self, now: i64, earliest: Option<i64>) {
        let cap = now + HELD_TTL_MS;
        let due = earliest.map_or(cap, |e| e.min(cap));
        let _ = write_json_atomically(&self.sweep_due_path(), &due);
    }

    /// Drop what `ids` held past [`HELD_TTL_MS`]. Under the lock; returns what
    /// was dropped and the earliest deadline of what is still held.
    fn expire_held_locked(&self, ids: &[String]) -> (Vec<(String, MailEnvelope)>, Option<i64>) {
        let now = self.now();
        let mut out = Vec::new();
        let mut earliest: Option<i64> = None;
        for id in ids {
            // Cheap precheck: most sessions hold nothing.
            let has_held = std::fs::read_to_string(self.state_path(id))
                .map(|t| t.contains("\"held\""))
                .unwrap_or(false);
            if !has_held {
                continue;
            }
            let (inbox, mut state) = self.inbox_with_state(id);
            let mut dropped = Vec::new();
            for e in &inbox {
                if let Some(entry) = state.get(&e.id) {
                    if entry.status == DeliveryStatus::Held {
                        let deadline = entry.at + HELD_TTL_MS;
                        if deadline <= now {
                            dropped.push(e.clone());
                        } else {
                            earliest = Some(earliest.map_or(deadline, |d| d.min(deadline)));
                        }
                    }
                }
            }
            if dropped.is_empty() {
                continue;
            }
            for e in &dropped {
                state.insert(
                    e.id.clone(),
                    DeliveryEntry {
                        status: DeliveryStatus::Dropped,
                        at: now,
                    },
                );
            }
            if write_json_atomically(&self.state_path(id), &state).is_err() {
                // Still due: the next sweep tries again.
                earliest = Some(now);
                continue;
            }
            out.extend(dropped.into_iter().map(|e| (id.clone(), e)));
        }
        (out, earliest)
    }

    /// Tell the sender of a held message that it was dropped. A notice that is
    /// itself dropped is not announced, so two sessions cannot chase each
    /// other's notices. Best effort: the sender may be gone or limited.
    pub(super) fn tell_dropped(&self, target_id: &str, e: &MailEnvelope, why: &str) {
        if e.origin == Origin::Notice {
            return;
        }
        let text = format!(
            "Your message {} to \"{}\" {why}.",
            e.id,
            self.name_of(target_id)
        );
        let extras = SendExtras {
            chain: Some(ChainContext::of(e, self.now())),
            sender_may_be_gone: true,
        };
        let _ = self.send_with(
            target_id,
            &e.from.session_id,
            &text,
            None,
            Origin::Notice,
            extras,
        );
    }

    fn report_expired(&self, expired: Vec<(String, MailEnvelope)>) {
        for (target, e) in expired {
            notify(&target, &e.id);
            self.tell_dropped(
                &target,
                &e,
                "expired: its recipient's user did not approve it within 5 minutes",
            );
        }
    }

    /// Expire what one session holds past its deadline, and tell the senders.
    pub(super) fn sweep_held(&self, session_id: &str) {
        let expired = {
            let _guard = lock();
            self.expire_held_locked(&[session_id.to_string()]).0
        };
        self.report_expired(expired);
    }

    /// Expire held mail and idle subscriptions everywhere. Called from the
    /// entry points the renderer and the tools poll, so a deadline passes even
    /// for a session nobody is looking at.
    ///
    /// Runs only when due: the earliest deadline is stored on disk, so a poll
    /// before then (from any process) reads one small file instead of the
    /// registry and every session's state (AGTB-023).
    pub(super) fn sweep_all(&self) {
        let now = self.now();
        if self.sweep_due().is_some_and(|due| now < due) {
            return;
        }
        let (expired, lapsed) = {
            let _guard = lock();
            let ids: Vec<String> = self
                .read_registry()
                .map(|r| {
                    r.values()
                        .filter(|s| !s.deleted)
                        .map(|s| s.id.clone())
                        .collect()
                })
                .unwrap_or_default();
            let (expired, held_due) = self.expire_held_locked(&ids);
            let mut subs = self.read_subs();
            let (lapsed, kept): (Vec<IdleSub>, Vec<IdleSub>) = subs
                .drain(..)
                .partition(|s| s.created_at + IDLE_SUB_TTL_MS <= now);
            let mut due = held_due;
            if !lapsed.is_empty() && self.write_subs(&kept).is_err() {
                due = Some(now);
            }
            if let Some(sub_due) = kept.iter().map(|s| s.created_at + IDLE_SUB_TTL_MS).min() {
                due = Some(due.map_or(sub_due, |d| d.min(sub_due)));
            }
            self.store_sweep_due(now, due);
            (expired, lapsed)
        };
        self.report_expired(expired);
        for s in lapsed {
            self.notice_to_asker(
                &s,
                &format!(
                    "Your idle subscription to \"{}\" expired after 12 hours; no idle notice is pending.",
                    self.name_of(&s.target)
                ),
            );
        }
    }

    /// Messages waiting for `session_id`'s user to approve, oldest first.
    pub fn held_messages(&self, session_id: &str) -> Result<Vec<MailEnvelope>> {
        check_session_id(session_id)?;
        self.sweep_all();
        let _guard = lock();
        let (inbox, state) = self.inbox_with_state(session_id);
        let mut held: Vec<MailEnvelope> = inbox
            .into_iter()
            .filter(|e| Self::status_in(&state, &e.id) == DeliveryStatus::Held)
            .collect();
        held.sort_by_key(|e| e.created_at);
        Ok(held)
    }

    fn resolve_held(&self, session_id: &str, message_id: &str, approve: bool) -> Result<bool> {
        check_session_id(session_id)?;
        if !valid_id(message_id) {
            return Ok(false);
        }
        self.sweep_all();
        let done = {
            let _guard = lock();
            let (inbox, mut state) = self.inbox_with_state(session_id);
            let held = inbox.iter().any(|e| e.id == message_id)
                && Self::status_in(&state, message_id) == DeliveryStatus::Held;
            if held {
                state.insert(
                    message_id.to_string(),
                    DeliveryEntry {
                        status: if approve {
                            DeliveryStatus::Queued
                        } else {
                            DeliveryStatus::Dropped
                        },
                        at: self.now(),
                    },
                );
                write_json_atomically(&self.state_path(session_id), &state)?;
            }
            held
        };
        if done {
            notify(session_id, message_id);
        }
        Ok(done)
    }

    /// The user approved a held message: it is delivered like any queued mail,
    /// once. `false` when it is no longer held (expired, or already decided).
    pub fn approve_held(&self, session_id: &str, message_id: &str) -> Result<bool> {
        self.resolve_held(session_id, message_id, true)
    }

    /// The user denied a held message: it is dropped and never delivered.
    pub fn deny_held(&self, session_id: &str, message_id: &str) -> Result<bool> {
        self.resolve_held(session_id, message_id, false)
    }

    // -- notify when idle ----------------------------------------------------

    /// Whether `target_id` is idle with nothing queued for it now.
    pub fn idle_now(&self, target_id: &str) -> bool {
        let registry = self.read_registry().unwrap_or_default();
        let Some(target) = registry.get(target_id) else {
            return false;
        };
        if target.deleted || self.status_of(target) != SessionStatus::Idle {
            return false;
        }
        let _guard = lock();
        let (inbox, state) = self.inbox_with_state(target_id);
        !inbox
            .iter()
            .any(|e| Self::status_in(&state, &e.id) == DeliveryStatus::Queued)
    }

    /// Ask for one notice when `target_id` next finishes a turn with nothing
    /// queued, or is deleted. One subscription per asker and target (asking
    /// again restarts its 12 hours); at most [`MAX_IDLE_SUBS_PER_SESSION`] per
    /// asker.
    pub fn subscribe_idle(&self, asker: &str, target_id: &str) -> Result<SubscribeReceipt> {
        let _guard = lock();
        let registry = self.read_registry()?;
        let me = self.live_caller(&registry, asker)?;
        check_session_id(target_id)
            .map_err(|_| MailboxError::new(code::UNKNOWN_SESSION, "no session has that id"))?;
        if target_id == asker {
            return Err(MailboxError::new(
                code::SELF_TARGET,
                "a session cannot watch itself",
            ));
        }
        let target = registry
            .get(target_id)
            .ok_or_else(|| MailboxError::new(code::UNKNOWN_SESSION, "no session has that id"))?;
        if target.deleted {
            return Err(MailboxError::new(
                code::SESSION_DELETED,
                "that session was deleted",
            ));
        }
        if target.archived {
            return Err(MailboxError::new(
                code::SESSION_ARCHIVED,
                "that session is archived",
            ));
        }
        let now = self.now();
        let mut subs = self.read_subs();
        subs.retain(|s| !(s.asker == asker && s.target == target_id));
        if subs.iter().filter(|s| s.asker == asker).count() >= MAX_IDLE_SUBS_PER_SESSION {
            return Err(MailboxError::new(
                code::RATE_LIMITED,
                format!("at most {MAX_IDLE_SUBS_PER_SESSION} idle subscriptions per session"),
            ));
        }
        subs.push(IdleSub {
            asker: asker.to_string(),
            target: target_id.to_string(),
            created_at: now,
            chain: me.chain.clone(),
        });
        self.write_subs(&subs)?;
        Ok(SubscribeReceipt {
            expires_at: now + IDLE_SUB_TTL_MS,
        })
    }

    /// Idle subscriptions currently held by `asker`.
    pub fn idle_subscriptions(&self, asker: &str) -> Vec<IdleSub> {
        self.read_subs()
            .into_iter()
            .filter(|s| s.asker == asker)
            .collect()
    }

    fn notice_to_asker(&self, sub: &IdleSub, text: &str) -> bool {
        let extras = SendExtras {
            chain: sub.chain.clone(),
            sender_may_be_gone: true,
        };
        self.send_with(
            &sub.target,
            &sub.asker,
            text,
            None,
            Origin::Notice,
            extras,
        )
        .is_ok()
    }

    /// `target_id` finished a turn (or was deleted): send each asker its one
    /// notice. A finished turn with mail still queued for the session is not
    /// idle yet, so the subscription waits for the turn that follows.
    fn fire_idle(&self, target_id: &str, event: IdleEvent) {
        let fired: Vec<IdleSub> = {
            let _guard = lock();
            let subs = self.read_subs();
            if !subs.iter().any(|s| s.target == target_id) {
                return;
            }
            if event == IdleEvent::Idle {
                let (inbox, state) = self.inbox_with_state(target_id);
                let queued = inbox
                    .iter()
                    .any(|e| Self::status_in(&state, &e.id) == DeliveryStatus::Queued);
                if queued {
                    return;
                }
            }
            // The subscriptions stay on disk until their notice is appended,
            // so a failed send does not lose them.
            subs.into_iter()
                .filter(|s| s.target == target_id)
                .collect()
        };
        let name = self.name_of(target_id);
        let text = match event {
            IdleEvent::Idle => format!("\"{name}\" finished its turn and is idle with nothing queued."),
            IdleEvent::Deleted => format!("\"{name}\" was deleted."),
        };
        let mut delivered: Vec<&IdleSub> = Vec::new();
        for sub in &fired {
            let gone = self
                .session(&sub.asker)
                .map_or(true, |a| a.deleted);
            // A deleted target never fires again, and a gone asker cannot be
            // told: both end the subscription. Otherwise it is kept for retry.
            if self.notice_to_asker(sub, &text) || gone || event == IdleEvent::Deleted {
                delivered.push(sub);
            }
        }
        if !delivered.is_empty() {
            let _guard = lock();
            let mut subs = self.read_subs();
            let before = subs.len();
            subs.retain(|s| {
                !delivered
                    .iter()
                    .any(|d| d.asker == s.asker && d.target == s.target && d.created_at == s.created_at)
            });
            if subs.len() != before {
                let _ = self.write_subs(&subs);
            }
        }
    }

    /// A run of `session_id` ended.
    pub(super) fn on_turn_ended(&self, session_id: &str) {
        self.fire_idle(session_id, IdleEvent::Idle);
    }

    /// `session_id` was deleted: its watchers are told, and what it was
    /// watching is forgotten.
    pub(super) fn on_session_deleted(&self, session_id: &str) {
        self.fire_idle(session_id, IdleEvent::Deleted);
        let _guard = lock();
        let subs = self.read_subs();
        if subs.iter().any(|s| s.asker == session_id) {
            let kept: Vec<IdleSub> = subs.into_iter().filter(|s| s.asker != session_id).collect();
            let _ = self.write_subs(&kept);
        }
    }
}
