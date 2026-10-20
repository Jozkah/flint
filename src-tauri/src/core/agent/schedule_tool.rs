//! The `schedule_task` tool: an agent creating, listing and deleting scheduled
//! tasks, and running something once at a given time.
//!
//! A scheduled task is unattended work, so everything that makes it riskier
//! than the current run is decided here, in plain data, before anything is
//! saved or asked:
//!
//! * a task can never be looser than the session that creates it: its tools
//!   are a subset of that session's offered tools, it may write only in a fresh
//!   worktree (never in a read-only or plan-mode session), and its folder is the
//!   session's project or inside it;
//! * the budgets are bounded well under the scheduler's own limits;
//! * the caller shows [`Plan::approval_text`] -- prompt, schedule, folder and
//!   mode -- and asks the person every time. Nothing in this module saves.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri_plugin_agent_tools::tools::{Capability, BUILTIN_TOOLS};

use crate::core::schedule::spec::{
    new_task_id, Budgets, CatchUp, OnBlock, Policy, Schedule, Task, TimeOfDay, WriteMode,
};

/// What an agent-created task may use unless it asks for more, within what the
/// session itself may use.
const DEFAULT_TOOLS: &[&str] = &["read", "grep", "find", "ls"];
const MAX_TURNS: u32 = 40;
const MAX_TOKENS: u64 = 500_000;
const MAX_WALL_CLOCK_SECS: u64 = 3_600;

/// What the creating session is, which bounds what it may create.
pub struct Creator {
    pub project_root: PathBuf,
    pub model: String,
    /// Plan mode: nothing may be written, so neither may a task it creates.
    pub plan_mode: bool,
    /// The tools this session was offered (`None`: every built-in).
    pub allowed_tools: Option<BTreeSet<String>>,
    /// Tools the project denies this session.
    pub denied_tools: BTreeSet<String>,
}

#[derive(Debug, PartialEq)]
pub enum Plan {
    List,
    Create(Box<Task>),
    Delete { id: String },
}

impl Plan {
    /// What the person is asked to approve. Shows the whole task: the prompt it
    /// will run unattended, when, where, and in what mode.
    pub fn approval_text(&self, tasks: &[Task]) -> Option<String> {
        match self {
            Plan::List => None,
            Plan::Delete { id } => {
                let name = tasks.iter().find(|t| &t.id == id).map_or(id.as_str(), |t| t.name.as_str());
                Some(format!("delete the scheduled task \"{name}\" ({id})"))
            }
            Plan::Create(t) => {
                let mode = match t.policy.write {
                    WriteMode::ReadOnly => "read-only (no edits, no commands that change anything)",
                    WriteMode::Worktree => "may edit, in its own worktree branch (never this folder)",
                };
                Some(format!(
                    "create an unattended scheduled task \"{}\"\n  prompt: {}\n  schedule: {} ({})\n  folder: {}\n  mode: {}\n  tools: {}\n  model: {}\n  limits: {} turns, {} tokens, {} s",
                    t.name,
                    t.prompt,
                    t.schedule.describe(),
                    t.timezone,
                    t.project,
                    mode,
                    t.policy.allow_tools.join(", "),
                    t.model,
                    t.budgets.max_turns,
                    t.budgets.max_tokens,
                    t.budgets.max_wall_clock_secs,
                ))
            }
        }
    }
}

fn text<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or_default().trim()
}

fn parse_schedule(value: &Value) -> Result<Schedule, String> {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or_default();
    let times = || -> Result<Vec<TimeOfDay>, String> {
        value
            .get("times")
            .and_then(Value::as_array)
            .ok_or_else(|| "schedule.times is a list like [\"09:00\"]".to_string())?
            .iter()
            .map(|t| {
                t.as_str()
                    .and_then(TimeOfDay::parse)
                    .ok_or_else(|| format!("{t} is not a time like 09:30"))
            })
            .collect()
    };
    match kind {
        "daily" => Ok(Schedule::Daily { times: times()? }),
        "weekdays" => Ok(Schedule::Weekdays { times: times()? }),
        "weekly" => {
            let days = value
                .get("days")
                .and_then(Value::as_array)
                .ok_or("schedule.days is a list like [1, 3] (0 = Sunday)")?
                .iter()
                .filter_map(|d| d.as_u64().map(|d| d as u8))
                .collect();
            Ok(Schedule::Weekly { days, times: times()? })
        }
        "cron" => Ok(Schedule::Cron { expr: value.get("expr").and_then(Value::as_str).unwrap_or_default().to_string() }),
        "once" => Ok(Schedule::Once { at: value.get("at").and_then(Value::as_str).unwrap_or_default().to_string() }),
        other => Err(format!("schedule.kind {other:?} is not one of daily, weekdays, weekly, cron, once")),
    }
}

/// `path` is `root` or inside it, by lexical comparison of absolute paths (the
/// folder need not exist yet to be refused).
fn inside(root: &Path, path: &Path) -> bool {
    let norm = |p: &Path| p.components().collect::<PathBuf>();
    path.is_absolute() && norm(path).starts_with(norm(root))
}

/// Turn the model's arguments into a plan, refusing anything the session could
/// not do itself. Pure: no store, no prompt.
pub fn plan(args: &Value, creator: &Creator) -> Result<Plan, String> {
    match args.get("action").and_then(Value::as_str).unwrap_or("list") {
        "list" => Ok(Plan::List),
        "delete" => {
            let id = text(args, "id");
            if id.is_empty() {
                return Err("delete needs the task's id (see action list)".into());
            }
            Ok(Plan::Delete { id: id.to_string() })
        }
        "create" => create(args, creator).map(|t| Plan::Create(Box::new(t))),
        other => Err(format!("action {other:?} is not list, create or delete")),
    }
}

fn create(args: &Value, creator: &Creator) -> Result<Task, String> {
    let schedule = parse_schedule(args.get("schedule").ok_or("create needs a schedule")?)?;

    let write = match text(args, "write") {
        "" | "read_only" => WriteMode::ReadOnly,
        "worktree" => WriteMode::Worktree,
        other => return Err(format!("write {other:?} is not read_only or worktree")),
    };
    if write == WriteMode::Worktree && creator.plan_mode {
        return Err("this session is in plan mode (read-only), so it cannot schedule a task that edits".into());
    }

    let tools: Vec<String> = match args.get("allow_tools").and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(|t| t.as_str().map(str::to_string)).collect(),
        None => DEFAULT_TOOLS.iter().map(|t| t.to_string()).collect(),
    };
    for tool in &tools {
        let Some(def) = BUILTIN_TOOLS.iter().find(|t| t.name == tool) else {
            return Err(format!("{tool:?} is not a built-in tool a task can use"));
        };
        if creator.denied_tools.contains(tool)
            || creator.allowed_tools.as_ref().is_some_and(|a| !a.contains(tool))
        {
            return Err(format!("this session may not use {tool}, so it cannot hand it to a task"));
        }
        if def.capability != Capability::Read && write != WriteMode::Worktree {
            return Err(format!(
                "{tool} can change things; a read-only task cannot have it. Set write to worktree, or drop it"
            ));
        }
    }

    let project = match text(args, "project") {
        "" => creator.project_root.clone(),
        p => PathBuf::from(p),
    };
    if !inside(&creator.project_root, &project) {
        return Err(format!(
            "a task can only run in this session's folder ({}) or inside it",
            creator.project_root.display()
        ));
    }

    let clamp = |key: &str, default: u64, max: u64| {
        args.get(key).and_then(Value::as_u64).unwrap_or(default).clamp(1, max)
    };
    let model = match text(args, "model") {
        "" => creator.model.clone(),
        m => m.to_string(),
    };

    let task = Task {
        id: new_task_id(),
        name: text(args, "name").to_string(),
        prompt: text(args, "prompt").to_string(),
        schedule,
        timezone: match text(args, "timezone") {
            "" => "UTC".to_string(),
            tz => tz.to_string(),
        },
        model,
        project: project.to_string_lossy().to_string(),
        profile: None,
        policy: Policy { allow_tools: tools, write },
        budgets: Budgets {
            max_turns: clamp("max_turns", 20, MAX_TURNS as u64) as u32,
            max_tokens: clamp("max_tokens", 200_000, MAX_TOKENS),
            max_wall_clock_secs: clamp("max_wall_clock_secs", 900, MAX_WALL_CLOCK_SECS),
            max_cost_usd: None,
        },
        on_block: OnBlock::Continue,
        // An agent-made task does not run for time that passed while the app
        // was closed: nobody scheduled that run knowing it would be late.
        catch_up: CatchUp::Skip,
        enabled: true,
        created_at_ms: 0,
        updated_at_ms: 0,
    };
    task.validate().map_err(|e| e.message)?;
    Ok(task)
}

/// The tasks as the model reads them.
pub fn render_list(tasks: &[Task]) -> String {
    if tasks.is_empty() {
        return "no scheduled tasks".to_string();
    }
    tasks
        .iter()
        .map(|t| {
            format!(
                "{} \"{}\": {} ({}), {}, folder {}{}",
                t.id,
                t.name,
                t.schedule.describe(),
                t.timezone,
                match t.policy.write {
                    WriteMode::ReadOnly => "read-only",
                    WriteMode::Worktree => "worktree",
                },
                t.project,
                if t.enabled { "" } else { " [disabled]" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn creator() -> Creator {
        Creator {
            project_root: std::env::temp_dir().join("proj"),
            model: "mock/m".into(),
            plan_mode: false,
            allowed_tools: None,
            denied_tools: BTreeSet::new(),
        }
    }

    fn args(extra: Value) -> Value {
        let mut base = json!({
            "action": "create",
            "name": "digest",
            "prompt": "summarise the repo",
            "schedule": { "kind": "daily", "times": ["09:00"] },
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn a_default_task_is_read_only_in_the_session_folder_and_skips_missed_runs() {
        let Plan::Create(t) = plan(&args(json!({})), &creator()).unwrap() else { panic!() };
        assert_eq!(t.policy.write, WriteMode::ReadOnly);
        assert_eq!(t.policy.allow_tools, ["read", "grep", "find", "ls"]);
        assert_eq!(PathBuf::from(&t.project), creator().project_root);
        assert_eq!(t.catch_up, CatchUp::Skip);
        let text = Plan::Create(t).approval_text(&[]).unwrap();
        for part in ["summarise the repo", "every day at 09:00", "read-only", "proj"] {
            assert!(text.contains(part), "{part} in {text}");
        }
    }

    #[test]
    fn a_task_is_never_looser_than_its_session() {
        // Writes need a worktree, and a plan-mode session cannot grant one.
        assert!(plan(&args(json!({"allow_tools": ["write"]})), &creator()).is_err());
        let mut plan_mode = creator();
        plan_mode.plan_mode = true;
        assert!(plan(&args(json!({"write": "worktree", "allow_tools": ["write"]})), &plan_mode).is_err());
        assert!(plan(&args(json!({"write": "worktree", "allow_tools": ["write"]})), &creator()).is_ok());
        // A tool the session was not offered, or the project denies, is not passed on.
        let mut narrow = creator();
        narrow.allowed_tools = Some(["read".to_string()].into());
        assert!(plan(&args(json!({"allow_tools": ["read", "grep"]})), &narrow).is_err());
        let mut denied = creator();
        denied.denied_tools = ["grep".to_string()].into();
        assert!(plan(&args(json!({})), &denied).is_err());
        // Another folder is not this session's to schedule in.
        let other = std::env::temp_dir().join("elsewhere");
        assert!(plan(&args(json!({"project": other.to_string_lossy()})), &creator()).is_err());
        let inside = creator().project_root.join("sub");
        assert!(plan(&args(json!({"project": inside.to_string_lossy()})), &creator()).is_ok());
    }

    #[test]
    fn budgets_are_bounded_and_bad_input_is_refused() {
        let Plan::Create(t) = plan(&args(json!({"max_turns": 9999, "max_tokens": 99999999})), &creator()).unwrap()
        else {
            panic!()
        };
        assert_eq!((t.budgets.max_turns, t.budgets.max_tokens), (MAX_TURNS, MAX_TOKENS));
        assert!(plan(&args(json!({"schedule": {"kind": "hourly"}})), &creator()).is_err());
        assert!(plan(&args(json!({"prompt": "  "})), &creator()).is_err());
        assert!(plan(&json!({"action": "delete"}), &creator()).is_err());
        assert_eq!(plan(&json!({}), &creator()).unwrap(), Plan::List);
    }

    #[test]
    fn a_one_time_task_in_the_past_is_refused_and_one_in_the_future_is_not() {
        let past = json!({"schedule": {"kind": "once", "at": "2020-01-01T09:00"}});
        assert!(plan(&args(past), &creator()).is_err());
        let year = chrono::Utc::now().format("%Y").to_string().parse::<i32>().unwrap() + 1;
        let future = json!({"schedule": {"kind": "once", "at": format!("{year}-03-04T09:30")}});
        let Plan::Create(t) = plan(&args(future), &creator()).unwrap() else { panic!() };
        assert!(t.schedule.is_once());
        assert_eq!(t.schedule.to_cron().unwrap(), vec!["30 9 4 3 *"]);
    }
}
