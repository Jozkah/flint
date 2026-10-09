//! `flint cli schedule add | edit | delete | enable | disable | preview |
//! cancel | tools | time-zones | os`: the Settings > Schedules page, from the
//! terminal. Validation, next-fire maths and every file write live in
//! `core::schedule`, shared with the desktop commands.

use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

use super::schedule::{data_folder, invalid, stamp, store_err};
use crate::core::schedule::runner;
use crate::core::schedule::spec::{
    new_task_id, parse_timezone, Budgets, CatchUp, OnBlock, Policy, Schedule, Task, TimeOfDay, WriteMode,
};
use crate::core::schedule::store::Store;

/// What `schedule add` and `schedule edit` take. Every field is optional on an
/// edit; `add` requires the ones a task cannot do without.
#[derive(Debug, Default, Clone)]
pub struct TaskInput {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub project: Option<String>,
    pub timezone: Option<String>,
    pub profile: Option<String>,
    pub daily: Option<String>,
    pub weekdays: Option<String>,
    pub weekly: Option<String>,
    pub cron: Option<String>,
    pub allow_tools: Vec<String>,
    pub write: Option<WriteMode>,
    pub on_block: Option<OnBlock>,
    pub catch_up: Option<CatchUp>,
    pub max_turns: Option<u32>,
    pub max_tokens: Option<u64>,
    pub max_wall_clock_secs: Option<u64>,
    pub max_cost_usd: Option<f64>,
    pub disabled: bool,
}

const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn parse_times(text: &str) -> Result<Vec<TimeOfDay>, HarnessError> {
    text.split(',')
        .map(|t| {
            TimeOfDay::parse(t)
                .ok_or_else(|| invalid(format!("'{}' is not a time of day (use HH:MM, 24-hour)", t.trim())))
        })
        .collect()
}

fn parse_days(text: &str) -> Result<Vec<u8>, HarnessError> {
    text.split(',')
        .map(|d| {
            let d = d.trim().to_ascii_lowercase();
            if let Ok(n) = d.parse::<u8>() {
                return (n <= 6)
                    .then_some(n)
                    .ok_or_else(|| invalid("days are 0 (Sunday) to 6 (Saturday)"));
            }
            DAY_NAMES
                .iter()
                .position(|n| d.starts_with(n))
                .map(|i| i as u8)
                .ok_or_else(|| invalid(format!("'{d}' is not a day of the week")))
        })
        .collect()
}

/// The schedule the flags name, if any. `--weekly` reads `mon,wed@09:00,17:00`.
fn parse_schedule(input: &TaskInput) -> Result<Option<Schedule>, HarnessError> {
    let given = [&input.daily, &input.weekdays, &input.weekly, &input.cron]
        .iter()
        .filter(|v| v.is_some())
        .count();
    if given > 1 {
        return Err(invalid("choose one of --daily, --weekdays, --weekly or --cron"));
    }
    if let Some(t) = &input.daily {
        return Ok(Some(Schedule::Daily { times: parse_times(t)? }));
    }
    if let Some(t) = &input.weekdays {
        return Ok(Some(Schedule::Weekdays { times: parse_times(t)? }));
    }
    if let Some(w) = &input.weekly {
        let (days, times) = w
            .split_once('@')
            .ok_or_else(|| invalid("--weekly reads DAYS@TIMES, e.g. mon,wed@09:00"))?;
        return Ok(Some(Schedule::Weekly { days: parse_days(days)?, times: parse_times(times)? }));
    }
    Ok(input.cron.as_ref().map(|expr| Schedule::Cron { expr: expr.clone() }))
}

/// The zone named by `TZ` when it is a real one, else UTC. A task always
/// stores its zone, so this is only the default for `schedule add`.
fn default_timezone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|z| parse_timezone(z).is_ok())
        .unwrap_or_else(|| "UTC".to_string())
}

fn apply_input(task: &mut Task, input: &TaskInput) -> Result<(), HarnessError> {
    if let Some(v) = &input.name {
        task.name = v.clone();
    }
    if let Some(v) = &input.prompt {
        task.prompt = v.clone();
    }
    if let Some(v) = &input.model {
        task.model = v.clone();
    }
    if let Some(v) = &input.project {
        let path = std::fs::canonicalize(v).map_err(|e| invalid(format!("project folder '{v}': {e}")))?;
        let text = path.to_string_lossy().to_string();
        // canonicalize on Windows yields a verbatim path; keep the plain one.
        task.project = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
    }
    if let Some(v) = &input.timezone {
        task.timezone = v.clone();
    }
    if let Some(v) = &input.profile {
        task.profile = if v.is_empty() { None } else { Some(v.clone()) };
    }
    if let Some(s) = parse_schedule(input)? {
        task.schedule = s;
    }
    if !input.allow_tools.is_empty() {
        task.policy.allow_tools = input.allow_tools.clone();
    }
    if let Some(w) = input.write {
        task.policy.write = w;
    }
    if let Some(v) = input.on_block {
        task.on_block = v;
    }
    if let Some(v) = input.catch_up {
        task.catch_up = v;
    }
    if let Some(v) = input.max_turns {
        task.budgets.max_turns = v;
    }
    if let Some(v) = input.max_tokens {
        task.budgets.max_tokens = v;
    }
    if let Some(v) = input.max_wall_clock_secs {
        task.budgets.max_wall_clock_secs = v;
    }
    if let Some(v) = input.max_cost_usd {
        task.budgets.max_cost_usd = Some(v);
    }
    if input.disabled {
        task.enabled = false;
    }
    Ok(())
}

fn not_found(id: &str) -> HarnessError {
    HarnessError::new(ErrorKind::NotFound, format!("no scheduled task '{id}'")).at(Stage::Startup)
}

fn print_task(task: &Task, json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(task).unwrap_or_default());
        return;
    }
    let next = task
        .next_fires(chrono::Utc::now(), 1)
        .ok()
        .and_then(|f| f.first().copied())
        .map(|f| stamp(f.timestamp_millis() as u64))
        .unwrap_or_else(|| "-".to_string());
    println!(
        "{}  {}  next {}  {}",
        task.id,
        if task.enabled { "enabled" } else { "disabled" },
        next,
        task.name
    );
}

/// One line per task, for the TUI's `/schedule` and anything else that cannot
/// print to stdout.
pub fn summary_lines() -> Result<Vec<String>, String> {
    let store = Store::new(&data_folder());
    let tasks = store.load_tasks().map_err(|e| e.message)?;
    let now = chrono::Utc::now();
    Ok(tasks
        .iter()
        .map(|t| {
            let next = t
                .next_fires(now, 1)
                .ok()
                .and_then(|f| f.first().copied())
                .map(|f| stamp(f.timestamp_millis() as u64))
                .unwrap_or_else(|| "-".to_string());
            format!("{}  {}  next {}  {}", t.id, if t.enabled { "on " } else { "off" }, next, t.name)
        })
        .collect())
}

/// Start a run now, detached. Returns the run id.
pub fn start_now(id: &str) -> Result<String, String> {
    use crate::core::schedule::runner::{start_run, SupervisorLauncher};
    use crate::core::schedule::store::Trigger;
    let data = data_folder();
    let store = Store::new(&data);
    let task = store
        .get_task(id)
        .map_err(|e| e.message)?
        .ok_or_else(|| format!("no scheduled task '{id}'"))?;
    let record = start_run(&store, &data, &SupervisorLauncher, &task, Trigger::Manual, chrono::Utc::now())
        .map_err(|e| e.message)?;
    Ok(record.id)
}

/// `flint cli schedule add`
pub fn add(input: TaskInput, json: bool) -> Result<(), HarnessError> {
    let missing = |what: &str| invalid(format!("{what} is required to add a task"));
    let name = input.name.clone().ok_or_else(|| missing("--name"))?;
    let prompt = input.prompt.clone().ok_or_else(|| missing("--prompt"))?;
    let model = input.model.clone().ok_or_else(|| missing("--model"))?;
    if input.allow_tools.is_empty() {
        return Err(invalid("--allow-tool is required (repeat it for each tool the task may use)"));
    }
    if parse_schedule(&input)?.is_none() {
        return Err(invalid("choose when it runs: --daily, --weekdays, --weekly or --cron"));
    }
    let mut task = Task {
        id: new_task_id(),
        name,
        prompt,
        schedule: Schedule::Cron { expr: String::new() },
        timezone: default_timezone(),
        model,
        project: String::new(),
        profile: None,
        policy: Policy { allow_tools: Vec::new(), write: WriteMode::ReadOnly },
        budgets: Budgets { max_turns: 30, max_tokens: 200_000, max_wall_clock_secs: 1800, max_cost_usd: None },
        on_block: OnBlock::Continue,
        catch_up: CatchUp::Once,
        enabled: true,
        created_at_ms: 0,
        updated_at_ms: 0,
    };
    let mut input = input;
    if input.project.is_none() {
        input.project = Some(".".to_string());
    }
    apply_input(&mut task, &input)?;
    let saved = Store::new(&data_folder()).save_task(task).map_err(store_err)?;
    print_task(&saved, json);
    Ok(())
}

/// `flint cli schedule edit <id>`
pub fn edit(id: &str, input: TaskInput, json: bool) -> Result<(), HarnessError> {
    let store = Store::new(&data_folder());
    let mut task = store.get_task(id).map_err(store_err)?.ok_or_else(|| not_found(id))?;
    apply_input(&mut task, &input)?;
    let saved = store.save_task(task).map_err(store_err)?;
    print_task(&saved, json);
    Ok(())
}

/// `flint cli schedule enable|disable <id>`
pub fn set_enabled(id: &str, enabled: bool, json: bool) -> Result<(), HarnessError> {
    let task = Store::new(&data_folder()).set_enabled(id, enabled).map_err(store_err)?;
    print_task(&task, json);
    Ok(())
}

/// `flint cli schedule delete <id>`: removes the task and its run history.
pub fn delete(id: &str) -> Result<(), HarnessError> {
    let removed = Store::new(&data_folder()).delete_task(id).map_err(store_err)?;
    if !removed {
        return Err(not_found(id));
    }
    println!("Deleted {id} and its run history.");
    Ok(())
}

/// `flint cli schedule preview`: the next fire times of a task, or of a
/// schedule given by flags before anything is saved.
pub fn preview(id: Option<&str>, input: TaskInput, count: usize, json: bool) -> Result<(), HarnessError> {
    use chrono::{DateTime, Utc};
    let (schedule, tz_name) = match id {
        Some(id) => {
            let task = Store::new(&data_folder()).get_task(id).map_err(store_err)?.ok_or_else(|| not_found(id))?;
            (task.schedule, task.timezone)
        }
        None => (
            parse_schedule(&input)?
                .ok_or_else(|| invalid("give a task id, or --daily, --weekdays, --weekly or --cron"))?,
            input.timezone.clone().unwrap_or_else(default_timezone),
        ),
    };
    let tz = parse_timezone(&tz_name).map_err(|e| invalid(e.message))?;
    let exprs = schedule.compile().map_err(|e| invalid(e.message))?;
    let count = count.clamp(1, 20);
    let mut all: Vec<DateTime<Utc>> = Vec::new();
    for e in exprs {
        all.extend(e.next_fires(tz, Utc::now(), count));
    }
    all.sort();
    all.dedup();
    all.truncate(count);
    if all.is_empty() {
        return Err(invalid("this schedule never fires"));
    }
    let cron = schedule.to_cron().unwrap_or_default();
    if json {
        println!("{}", serde_json::json!({ "cron": cron, "timezone": tz_name, "next": all }));
        return Ok(());
    }
    println!("cron: {} ({tz_name}; times below are in your local time)", cron.join(" | "));
    for t in all {
        println!("{}", stamp(t.timestamp_millis() as u64));
    }
    Ok(())
}

/// `flint cli schedule cancel <id> <run>`: stop a run in flight.
pub fn cancel_run(task_id: &str, run_id: &str) -> Result<(), HarnessError> {
    let data = data_folder();
    let store = Store::new(&data);
    let run = store
        .get_run(task_id, run_id)
        .map_err(store_err)?
        .ok_or_else(|| HarnessError::new(ErrorKind::NotFound, "no such run").at(Stage::Startup))?;
    if run.status.is_ended() {
        println!("That run already ended ({:?}).", run.status);
        return Ok(());
    }
    if let Some(job) = run.job_id.as_deref() {
        tauri_plugin_agent_tools::worker::cancel(&data, &runner::owner_for(task_id), job)
            .map_err(|e| HarnessError::new(ErrorKind::Io, e.message().to_string()).at(Stage::Startup))?;
    }
    runner::settle(&store, &data);
    println!("Cancelled {run_id}.");
    Ok(())
}

/// `flint cli schedule tools`: the built-in tools a task can be allowed.
pub fn tools(json: bool) -> Result<(), HarnessError> {
    use tauri_plugin_agent_tools::tools::{Capability, BUILTIN_TOOLS};
    let rows: Vec<(&str, &str)> = BUILTIN_TOOLS
        .iter()
        .map(|t| {
            (
                t.name,
                match t.capability {
                    Capability::Read => "read",
                    Capability::Write => "write",
                    Capability::Exec => "exec",
                    Capability::Net => "net",
                },
            )
        })
        .collect();
    if json {
        let v: Vec<_> = rows.iter().map(|(n, c)| serde_json::json!({ "name": n, "capability": c })).collect();
        println!("{}", serde_json::Value::Array(v));
    } else {
        for (n, c) in rows {
            println!("{c:<6} {n}");
        }
    }
    Ok(())
}

/// `flint cli schedule time-zones`
pub fn time_zones() {
    for tz in chrono_tz::TZ_VARIANTS {
        println!("{}", tz.name());
    }
}

/// `flint cli schedule os status|enable|disable`: the entry that ticks while
/// Flint is closed. `enable` installs it only with `--yes`, after showing what
/// it will write.
pub fn os(action: &str, interval_minutes: Option<u32>, yes: bool, json: bool) -> Result<(), HarnessError> {
    use crate::core::schedule::os_scheduler as osx;
    let io = |m: String| HarnessError::new(ErrorKind::Io, m).at(Stage::Startup);
    let exe = tauri_plugin_agent_tools::worker::supervisor_binary().map_err(|e| io(e.message().to_string()))?;
    let home = dirs::home_dir().ok_or_else(|| io("this user has no home folder".into()))?;
    let platform = osx::Platform::current();
    let installer = osx::SystemInstaller;
    let install = osx::Install::new(exe, data_folder(), interval_minutes.unwrap_or(osx::DEFAULT_INTERVAL_MINUTES))
        .with_headless_host(osx::headless_host(platform, &installer, &osx::system_root()));
    let status = |detail: Option<String>| osx::status(platform, &install, &home, &installer, detail);
    let show = |s: &osx::OsStatus| {
        if json {
            println!("{}", serde_json::to_string_pretty(s).unwrap_or_default());
        } else {
            println!("{}: {}", s.platform_label, if s.installed { "installed" } else { "not installed" });
            println!("runs: {}", s.tick_command);
            for line in &s.preview {
                println!("  {line}");
            }
            if let Some(d) = &s.detail {
                println!("note: {d}");
            }
        }
    };
    match action {
        "status" => show(&status(None)),
        "enable" => {
            if !yes {
                show(&status(None));
                return Err(invalid("this writes the entry above; run again with --yes to install it"));
            }
            let detail = osx::enable(platform, &install, &home, &installer).err();
            let s = status(detail);
            show(&s);
            if !s.installed {
                return Err(io(s.detail.unwrap_or_else(|| "the entry was not installed".into())));
            }
        }
        "disable" => {
            let detail = osx::disable(platform, &install, &home, &installer).err();
            show(&status(detail));
        }
        other => return Err(invalid(format!("unknown os action '{other}' (status, enable, disable)"))),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::fixtures::task;

    #[test]
    fn schedule_flags_parse_and_conflict() {
        let mut i = TaskInput { daily: Some("09:00, 17:30".into()), ..Default::default() };
        assert_eq!(
            parse_schedule(&i).unwrap(),
            Some(Schedule::Daily { times: vec![TimeOfDay { hour: 9, minute: 0 }, TimeOfDay { hour: 17, minute: 30 }] })
        );
        i.cron = Some("0 9 * * *".into());
        assert!(parse_schedule(&i).is_err());

        let mut w = TaskInput { weekly: Some("mon,Wed@08:15".into()), ..Default::default() };
        assert_eq!(
            parse_schedule(&w).unwrap(),
            Some(Schedule::Weekly { days: vec![1, 3], times: vec![TimeOfDay { hour: 8, minute: 15 }] })
        );
        w.weekly = Some("mon 08:15".into());
        assert!(parse_schedule(&w).is_err());

        let bad = TaskInput { daily: Some("25:00".into()), ..Default::default() };
        assert!(parse_schedule(&bad).is_err());
    }

    #[test]
    fn apply_input_changes_only_what_was_given() {
        let mut t = task("task-1");
        let before = t.clone();
        let i = TaskInput {
            max_turns: Some(5),
            write: Some(WriteMode::Worktree),
            allow_tools: vec!["read".into()],
            ..Default::default()
        };
        apply_input(&mut t, &i).unwrap();
        assert_eq!(t.budgets.max_turns, 5);
        assert_eq!(t.policy.write, WriteMode::Worktree);
        assert_eq!(t.policy.allow_tools, vec!["read".to_string()]);
        assert_eq!(t.name, before.name);
        assert_eq!(t.schedule, before.schedule);
    }

    #[test]
    fn add_edit_enable_delete_round_trip_through_the_store() {
        crate::core::app::commands::with_temp_data_folder(|data| {
            let project = data.join("proj");
            std::fs::create_dir_all(&project).unwrap();
            add(
                TaskInput {
                    name: Some("Digest".into()),
                    prompt: Some("Summarise the repo".into()),
                    model: Some("mock/m".into()),
                    project: Some(project.to_string_lossy().into()),
                    daily: Some("09:00".into()),
                    allow_tools: vec!["read".into()],
                    timezone: Some("UTC".into()),
                    ..Default::default()
                },
                true,
            )
            .unwrap();
            let store = Store::new(data);
            let id = store.load_tasks().unwrap()[0].id.clone();
            edit(&id, TaskInput { max_turns: Some(7), ..Default::default() }, true).unwrap();
            assert_eq!(store.get_task(&id).unwrap().unwrap().budgets.max_turns, 7);
            set_enabled(&id, false, true).unwrap();
            assert!(!store.get_task(&id).unwrap().unwrap().enabled);
            assert!(edit(&id, TaskInput { daily: Some("nope".into()), ..Default::default() }, true).is_err());
            delete(&id).unwrap();
            assert!(store.load_tasks().unwrap().is_empty());
            assert!(delete(&id).is_err());
        });
    }
}
