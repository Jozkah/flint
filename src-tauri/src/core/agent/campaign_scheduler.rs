//! Which campaign tasks to start next. Pure: no IO, no clock.
//!
//! The renderer calls this whenever something changed (a task settled, the
//! user raised `campaigns.maxParallel`, a pane freed up) and acts on the
//! answer. `max_parallel` is passed in, not read from the record, so a changed
//! setting applies to a running campaign at once.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::core::agent::campaign::{Campaign, CampaignStatus, TaskStatus, MAX_PARALLEL_CAP};

/// What the renderer knows that the record does not.
#[derive(Default, Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveState {
    /// Task ids with a run actually going on screen right now. Counted in
    /// addition to tasks the record says are live, never twice.
    pub live_tasks: Vec<String>,
    /// Panes that are free to open, when that is a tighter limit than
    /// `max_parallel`.
    pub free_panes: Option<u32>,
    /// Tokens live runs have used so far, by task id. The budget counts the
    /// larger of this and what the record holds.
    pub live_tokens: BTreeMap<String, u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    /// Create the session and worktree and run this task.
    #[serde(rename_all = "camelCase")]
    Start { task_id: String },
    /// A dependency can no longer be merged, so this task cannot run.
    #[serde(rename_all = "camelCase")]
    Block { task_id: String, because: String },
}

fn dependency_dead(status: TaskStatus) -> bool {
    matches!(status, TaskStatus::Cancelled)
}

/// Tasks to start now, in plan order, and tasks to block.
///
/// A task starts when it is `pending` or `queued`, every dependency is
/// `merged`, the campaign is `running`, and a slot is free. Slots are
/// `min(max_parallel, MAX_PARALLEL_CAP, free_panes)` minus tasks already live.
/// Once the token budget is spent nothing starts. A pending task whose
/// dependency was cancelled is blocked rather than left waiting forever.
pub fn next_actions(campaign: &Campaign, live: &LiveState, max_parallel: u32) -> Vec<Action> {
    if campaign.status != CampaignStatus::Running {
        return Vec::new();
    }
    let mut actions = Vec::new();
    let status_of = |id: &str| campaign.task(id).map(|t| t.status);

    for t in &campaign.tasks {
        if !matches!(t.status, TaskStatus::Pending | TaskStatus::Queued) {
            continue;
        }
        if let Some(dead) = t.depends_on.iter().find(|d| status_of(d).is_some_and(dependency_dead)) {
            actions.push(Action::Block {
                task_id: t.id.clone(),
                because: format!("dependency {dead} was cancelled"),
            });
        }
    }

    if let Some(budget) = campaign.limits.token_budget {
        let spent: u64 = campaign
            .tasks
            .iter()
            .map(|t| {
                let worker = t.tokens_used.max(live.live_tokens.get(&t.id).copied().unwrap_or(0));
                worker.saturating_add(t.verify_tokens)
            })
            .sum();
        if spent >= budget {
            return actions;
        }
    }

    let counted: BTreeSet<&str> = campaign
        .tasks
        .iter()
        .filter(|t| t.status.is_live())
        .map(|t| t.id.as_str())
        .chain(live.live_tasks.iter().map(String::as_str))
        .collect();
    let mut cap = max_parallel.clamp(1, MAX_PARALLEL_CAP);
    if let Some(panes) = live.free_panes {
        // Free panes are on top of what is already running.
        cap = cap.min(counted.len() as u32 + panes);
    }
    let mut slots = (cap as usize).saturating_sub(counted.len());

    for t in &campaign.tasks {
        if slots == 0 {
            break;
        }
        if !matches!(t.status, TaskStatus::Pending | TaskStatus::Queued) {
            continue;
        }
        if counted.contains(t.id.as_str()) {
            continue;
        }
        let ready = t.depends_on.iter().all(|d| status_of(d) == Some(TaskStatus::Merged));
        if ready {
            actions.push(Action::Start { task_id: t.id.clone() });
            slots -= 1;
        }
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::campaign::tests::{campaign, plan};

    fn starts(actions: &[Action]) -> Vec<&str> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Start { task_id } => Some(task_id.as_str()),
                _ => None,
            })
            .collect()
    }

    fn set(c: &mut Campaign, id: &str, s: TaskStatus) {
        c.tasks.iter_mut().find(|t| t.id == id).unwrap().status = s;
    }

    fn five_independent() -> Campaign {
        campaign((0..5).map(|i| plan(&format!("t{i}"), &[], &[&format!("p{i}")])).collect())
    }

    #[test]
    fn independent_tasks_start_in_plan_order_up_to_the_cap() {
        let c = five_independent();
        let a = next_actions(&c, &LiveState::default(), 3);
        assert_eq!(starts(&a), ["t0", "t1", "t2"]);
    }

    #[test]
    fn running_tasks_use_up_slots() {
        let mut c = five_independent();
        set(&mut c, "t0", TaskStatus::Running);
        set(&mut c, "t1", TaskStatus::AwaitingInput);
        let a = next_actions(&c, &LiveState::default(), 3);
        assert_eq!(starts(&a), ["t2"]);
        set(&mut c, "t2", TaskStatus::Running);
        assert!(next_actions(&c, &LiveState::default(), 3).is_empty());
    }

    #[test]
    fn live_runs_the_record_does_not_know_about_count_once() {
        let mut c = five_independent();
        set(&mut c, "t0", TaskStatus::Running);
        let live = LiveState { live_tasks: vec!["t0".into(), "t1".into()], free_panes: None, ..Default::default() };
        // t0 is in both and counts once; t1 is live but still queued in the record.
        assert_eq!(starts(&next_actions(&c, &live, 3)), ["t2"]);
    }

    #[test]
    fn dependencies_gate_on_merged_not_on_completed() {
        let mut c = campaign(vec![plan("a", &[], &["a"]), plan("b", &["a"], &["b"]), plan("c", &["a", "b"], &["c"])]);
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 4)), ["a"]);
        set(&mut c, "a", TaskStatus::Verified);
        assert!(next_actions(&c, &LiveState::default(), 4).is_empty());
        set(&mut c, "a", TaskStatus::Merged);
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 4)), ["b"]);
        set(&mut c, "b", TaskStatus::Merged);
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 4)), ["c"]);
    }

    #[test]
    fn a_task_waits_until_every_dependency_is_merged() {
        let mut c = campaign(vec![plan("a", &[], &["a"]), plan("b", &[], &["b"]), plan("c", &["a", "b"], &["c"])]);
        set(&mut c, "a", TaskStatus::Merged);
        set(&mut c, "b", TaskStatus::Running);
        assert!(next_actions(&c, &LiveState::default(), 4).is_empty());
    }

    #[test]
    fn a_retry_queued_task_is_picked_again() {
        let mut c = campaign(vec![plan("a", &[], &["a"]), plan("b", &[], &["b"])]);
        set(&mut c, "a", TaskStatus::Queued);
        set(&mut c, "b", TaskStatus::Failed);
        c.tasks[0].attempt = 1;
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 4)), ["a"]);
    }

    #[test]
    fn blocked_failed_and_finished_tasks_never_start() {
        let mut c = five_independent();
        for (i, s) in [TaskStatus::Blocked, TaskStatus::Failed, TaskStatus::Conflict, TaskStatus::Interrupted, TaskStatus::Cancelled]
            .into_iter()
            .enumerate()
        {
            set(&mut c, &format!("t{i}"), s);
        }
        assert!(next_actions(&c, &LiveState::default(), 4).is_empty());
    }

    #[test]
    fn only_a_running_campaign_schedules() {
        let mut c = five_independent();
        for s in [CampaignStatus::Planned, CampaignStatus::Paused, CampaignStatus::Interrupted, CampaignStatus::Reviewing] {
            c.status = s;
            assert!(next_actions(&c, &LiveState::default(), 4).is_empty(), "{s:?}");
        }
    }

    #[test]
    fn the_setting_is_clamped_and_free_panes_tighten_it() {
        let c = campaign((0..8).map(|i| plan(&format!("t{i}"), &[], &[&format!("p{i}")])).collect());
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 50)).len(), 6);
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 0)).len(), 1);
        let live = LiveState { live_tasks: vec![], free_panes: Some(2), ..Default::default() };
        assert_eq!(starts(&next_actions(&c, &live, 6)).len(), 2);
        let none = LiveState { live_tasks: vec![], free_panes: Some(0), ..Default::default() };
        assert!(next_actions(&c, &none, 6).is_empty());
    }

    #[test]
    fn raising_the_cap_applies_to_a_running_campaign_at_once() {
        let mut c = five_independent();
        set(&mut c, "t0", TaskStatus::Running);
        set(&mut c, "t1", TaskStatus::Running);
        assert!(next_actions(&c, &LiveState::default(), 2).is_empty());
        assert_eq!(starts(&next_actions(&c, &LiveState::default(), 4)), ["t2", "t3"]);
    }

    #[test]
    fn a_spent_token_budget_stops_new_starts() {
        let mut c = five_independent();
        c.limits.token_budget = Some(1000);
        c.tasks[0].status = TaskStatus::Completed;
        c.tasks[0].tokens_used = 1000;
        assert!(starts(&next_actions(&c, &LiveState::default(), 4)).is_empty());
        c.tasks[0].tokens_used = 999;
        assert!(!starts(&next_actions(&c, &LiveState::default(), 4)).is_empty());
    }

    #[test]
    fn a_task_behind_a_cancelled_dependency_is_blocked_not_left_waiting() {
        let mut c = campaign(vec![plan("a", &[], &["a"]), plan("b", &["a"], &["b"]), plan("z", &[], &["z"])]);
        set(&mut c, "a", TaskStatus::Cancelled);
        let a = next_actions(&c, &LiveState::default(), 4);
        assert_eq!(starts(&a), ["z"]);
        assert!(a.contains(&Action::Block { task_id: "b".into(), because: "dependency a was cancelled".into() }));
    }

    /// The same fixtures the renderer's fallback is driven with
    /// (`web-app/src/lib/__tests__/campaignScheduler.parity.test.ts`).
    #[test]
    fn the_shared_fixtures_decide_the_same_way() {
        let raw = include_str!("../../../../web-app/src/lib/campaignScheduler.fixtures.json");
        let cases: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["name"].as_str().unwrap().to_string();
            let tasks = case["tasks"].as_array().unwrap();
            let plans = tasks
                .iter()
                .map(|t| {
                    let deps: Vec<&str> = t["dependsOn"].as_array().unwrap().iter().map(|d| d.as_str().unwrap()).collect();
                    plan(t["id"].as_str().unwrap(), &deps, &[])
                })
                .collect();
            let mut c = campaign(plans);
            c.status = serde_json::from_value(case["status"].clone()).unwrap();
            c.limits.token_budget = case["tokenBudget"].as_u64();
            for (i, t) in tasks.iter().enumerate() {
                c.tasks[i].status = serde_json::from_value(t["status"].clone()).unwrap();
                c.tasks[i].tokens_used = t["tokensUsed"].as_u64().unwrap_or(0);
                c.tasks[i].verify_tokens = t["verifyTokens"].as_u64().unwrap_or(0);
            }
            let live: LiveState = serde_json::from_value(case["live"].clone()).unwrap();
            let got = next_actions(&c, &live, case["maxParallel"].as_u64().unwrap() as u32);
            assert_eq!(serde_json::to_value(&got).unwrap(), case["expect"], "{name}");
        }
    }
}
