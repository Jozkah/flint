//! What a scheduled task is, and what makes one safe enough to save.
//!
//! A task runs with nobody watching, so the things an interactive run leaves to
//! the person -- which tools it may use, when it must stop, whether it may write
//! -- are fixed here, at save time, and refused if they are missing:
//!
//! * the policy is an explicit allow-list of tools and read-only unless the
//!   task asks for a fresh worktree, where it may write on its own branch;
//! * the budgets (turns, tokens, wall clock) are mandatory and bounded;
//! * the prompt may not carry a credential -- it is stored in plain JSON, and a
//!   key belongs in the provider settings where the run finds it by itself.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use super::cron::{CronError, CronExpr};

/// Version of the `tasks.json` layout and of a run record.
pub const SCHEMA_VERSION: u32 = 1;

/// Upper bounds a budget may not exceed; a "mandatory budget" that can be set
/// to a million turns is not one.
pub const MAX_TURNS_LIMIT: u32 = 200;
pub const MAX_TOKENS_LIMIT: u64 = 5_000_000;
pub const MAX_WALL_CLOCK_LIMIT_SECS: u64 = 6 * 60 * 60;

pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_PROMPT_CHARS: usize = 20_000;
pub const MAX_TIMES_PER_DAY: usize = 24;

/// A time of day on the task's own clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TimeOfDay {
    pub hour: u8,
    pub minute: u8,
}

impl TimeOfDay {
    pub fn parse(text: &str) -> Option<TimeOfDay> {
        let (h, m) = text.trim().split_once(':')?;
        let (hour, minute) = (h.parse::<u8>().ok()?, m.parse::<u8>().ok()?);
        (hour < 24 && minute < 60).then_some(TimeOfDay { hour, minute })
    }
}

/// When a task runs. The presets compile to cron, so the editor, the preview
/// and the engine all agree on one meaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// Every day at each of these times.
    Daily { times: Vec<TimeOfDay> },
    /// Monday to Friday at each of these times.
    Weekdays { times: Vec<TimeOfDay> },
    /// On these days (0 = Sunday .. 6 = Saturday) at each of these times.
    Weekly { days: Vec<u8>, times: Vec<TimeOfDay> },
    /// A cron expression typed by hand.
    Cron { expr: String },
}

impl Schedule {
    /// The cron expressions that express this schedule. A preset with times on
    /// different minutes needs one expression per minute; their fires merge.
    pub fn to_cron(&self) -> Result<Vec<String>, ScheduleError> {
        let (times, dow): (&[TimeOfDay], String) = match self {
            Schedule::Cron { expr } => return Ok(vec![expr.trim().to_string()]),
            Schedule::Daily { times } => (times, "*".to_string()),
            Schedule::Weekdays { times } => (times, "1-5".to_string()),
            Schedule::Weekly { days, times } => {
                let set: BTreeSet<u8> = days.iter().copied().collect();
                if set.is_empty() {
                    return Err(ScheduleError::new("pick at least one day of the week"));
                }
                if set.iter().any(|d| *d > 6) {
                    return Err(ScheduleError::new("weekdays are 0 (Sunday) to 6 (Saturday)"));
                }
                (times, set.iter().map(u8::to_string).collect::<Vec<_>>().join(","))
            }
        };
        if times.is_empty() {
            return Err(ScheduleError::new("pick at least one time of day"));
        }
        if times.len() > MAX_TIMES_PER_DAY {
            return Err(ScheduleError::new(format!("at most {MAX_TIMES_PER_DAY} times per day")));
        }
        let mut by_minute: std::collections::BTreeMap<u8, BTreeSet<u8>> = Default::default();
        for t in times {
            if t.hour > 23 || t.minute > 59 {
                return Err(ScheduleError::new("a time of day is 00:00 to 23:59"));
            }
            by_minute.entry(t.minute).or_default().insert(t.hour);
        }
        Ok(by_minute
            .into_iter()
            .map(|(minute, hours)| {
                let hours = hours.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
                format!("{minute} {hours} * * {dow}")
            })
            .collect())
    }

    /// Parse every expression, so a bad one is refused rather than silently
    /// never firing.
    pub fn compile(&self) -> Result<Vec<CronExpr>, ScheduleError> {
        self.to_cron()?
            .iter()
            .map(|e| CronExpr::parse(e).map_err(ScheduleError::from))
            .collect()
    }
}

/// Why a schedule or task could not be saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScheduleError {
    pub message: String,
}

impl ScheduleError {
    pub fn new(message: impl Into<String>) -> Self {
        ScheduleError { message: message.into() }
    }
}

fn bad(message: impl Into<String>) -> ScheduleError {
    ScheduleError::new(message)
}

impl From<CronError> for ScheduleError {
    fn from(e: CronError) -> Self {
        ScheduleError { message: e.message }
    }
}

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ScheduleError {}

/// How a task treats runs it missed (the app was closed or asleep).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatchUp {
    /// Forget missed runs.
    Skip,
    /// Run once for however many were missed.
    #[default]
    Once,
    /// Run each missed one, newest few only (see `engine::CATCH_UP_CAP`).
    AllCapped,
}

/// What the run does when a tool call needs a person's approval: nobody is
/// there, so it is denied, and the task either goes on without it or ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnBlock {
    #[default]
    Continue,
    End,
}

/// Where a run may write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
    /// No edits, no shell commands that change anything.
    #[default]
    ReadOnly,
    /// Edits land in a fresh worktree on their own branch, never in the folder
    /// itself.
    Worktree,
}

/// The tools a task may use, frozen when it is saved.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    /// Tool names. A tool not listed is not available to the run.
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub write: WriteMode,
}

/// Limits a run may not pass; every one is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    pub max_turns: u32,
    pub max_tokens: u64,
    pub max_wall_clock_secs: u64,
}

/// One scheduled task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub schedule: Schedule,
    /// IANA zone name, e.g. `Europe/Berlin`.
    pub timezone: String,
    /// `provider/model`, as every other surface names a model.
    pub model: String,
    /// Absolute path of the project folder the run works in.
    pub project: String,
    /// A Cowork profile to run under, if any.
    #[serde(default)]
    pub profile: Option<String>,
    pub policy: Policy,
    pub budgets: Budgets,
    #[serde(default)]
    pub on_block: OnBlock,
    #[serde(default)]
    pub catch_up: CatchUp,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

fn yes() -> bool {
    true
}

static SECRET_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?ix)
        \bsk-[A-Za-z0-9_\-]{16,}
        | \b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}
        | \bxox[abprs]-[A-Za-z0-9\-]{10,}
        | \bAKIA[0-9A-Z]{16}\b
        | \bAIza[0-9A-Za-z_\-]{30,}
        | \bbearer\s+[A-Za-z0-9._~+/\-=]{16,}
        | -----BEGIN\ [A-Z\ ]*PRIVATE\ KEY-----
        | \b(?:api[_-]?key|secret|password|passwd|token|access[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/\-=]{12,}
        "#,
    )
    .expect("secret pattern")
});

/// Whether a text looks like it carries a credential.
pub fn looks_like_secret(text: &str) -> bool {
    SECRET_LIKE.is_match(text)
}

/// A new id: short, URL- and path-safe.
pub fn new_task_id() -> String {
    format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

/// Whether an id is safe to use as a directory name.
pub fn id_is_safe(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn parse_timezone(name: &str) -> Result<Tz, ScheduleError> {
    name.trim()
        .parse::<Tz>()
        .map_err(|_| ScheduleError::new(format!("'{name}' is not a time zone name (use a name like Europe/Berlin)")))
}

impl Task {
    pub fn tz(&self) -> Result<Tz, ScheduleError> {
        parse_timezone(&self.timezone)
    }

    /// Refuse a task that could not run safely and unattended.
    pub fn validate(&self) -> Result<(), ScheduleError> {
        if !id_is_safe(&self.id) {
            return Err(bad("the task id must be letters, digits, '-' or '_'"));
        }
        if self.name.trim().is_empty() {
            return Err(bad("give the task a name"));
        }
        if self.name.chars().count() > MAX_NAME_CHARS {
            return Err(bad(format!("the name is longer than {MAX_NAME_CHARS} characters")));
        }
        if self.prompt.trim().is_empty() {
            return Err(bad("write what the task should do"));
        }
        if self.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(bad(format!("the prompt is longer than {MAX_PROMPT_CHARS} characters")));
        }
        if looks_like_secret(&self.prompt) {
            return Err(bad(
                "the prompt looks like it contains a key or password; remove it (provider keys are \
                 read from the provider settings, not from the prompt)",
            ));
        }
        if self.model.trim().is_empty() {
            return Err(bad("choose a model"));
        }
        if !std::path::Path::new(&self.project).is_absolute() {
            return Err(bad("the project folder must be an absolute path"));
        }
        if let Some(p) = &self.profile {
            if p.trim().is_empty() {
                return Err(bad("the Cowork profile name is empty"));
            }
        }
        self.tz()?;
        let exprs = self.schedule.compile()?;
        // A schedule that never fires (31 February) is a mistake, not a task.
        let tz = self.tz()?;
        let now = Utc::now();
        if exprs.iter().all(|e| e.next_fires(tz, now, 1).is_empty()) {
            return Err(bad("this schedule never fires"));
        }
        self.policy.validate()?;
        self.budgets.validate()
    }

    /// The next `count` fire times after `after`, across all the schedule's
    /// expressions, soonest first.
    pub fn next_fires(&self, after: DateTime<Utc>, count: usize) -> Result<Vec<DateTime<Utc>>, ScheduleError> {
        let tz = self.tz()?;
        let mut all: Vec<DateTime<Utc>> = Vec::new();
        for e in self.schedule.compile()? {
            all.extend(e.next_fires(tz, after, count));
        }
        all.sort();
        all.dedup();
        all.truncate(count);
        Ok(all)
    }
}

impl Policy {
    pub fn validate(&self) -> Result<(), ScheduleError> {
        if self.allow_tools.is_empty() {
            return Err(ScheduleError::new(
                "list the tools the task may use; a task with no tools can only answer from the prompt",
            ));
        }
        for t in &self.allow_tools {
            if t.trim().is_empty() || t.len() > 80 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(ScheduleError::new(format!("'{t}' is not a tool name")));
            }
            if t == "*" {
                return Err(ScheduleError::new("a task needs an explicit list of tools, not '*'"));
            }
        }
        Ok(())
    }
}

impl Budgets {
    pub fn validate(&self) -> Result<(), ScheduleError> {
        if self.max_turns == 0 || self.max_tokens == 0 || self.max_wall_clock_secs == 0 {
            return Err(bad("set a limit for turns, tokens and time; a task cannot run without them"));
        }
        if self.max_turns > MAX_TURNS_LIMIT {
            return Err(bad(format!("at most {MAX_TURNS_LIMIT} turns")));
        }
        if self.max_tokens > MAX_TOKENS_LIMIT {
            return Err(bad(format!("at most {MAX_TOKENS_LIMIT} tokens")));
        }
        if self.max_wall_clock_secs > MAX_WALL_CLOCK_LIMIT_SECS {
            return Err(bad(format!("at most {} hours of running time", MAX_WALL_CLOCK_LIMIT_SECS / 3600)));
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn task(id: &str) -> Task {
        Task {
            id: id.to_string(),
            name: "Morning digest".into(),
            prompt: "Summarise what changed in the repo since yesterday.".into(),
            schedule: Schedule::Daily { times: vec![TimeOfDay { hour: 9, minute: 0 }] },
            timezone: "UTC".into(),
            model: "mock/m".into(),
            project: std::env::temp_dir().to_string_lossy().to_string(),
            profile: None,
            policy: Policy { allow_tools: vec!["read".into(), "grep".into()], write: WriteMode::ReadOnly },
            budgets: Budgets { max_turns: 12, max_tokens: 50_000, max_wall_clock_secs: 600 },
            on_block: OnBlock::Continue,
            catch_up: CatchUp::Once,
            enabled: true,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::task;
    use super::*;

    fn t(h: u8, m: u8) -> TimeOfDay {
        TimeOfDay { hour: h, minute: m }
    }

    #[test]
    fn presets_compile_to_cron() {
        assert_eq!(Schedule::Daily { times: vec![t(9, 0)] }.to_cron().unwrap(), vec!["0 9 * * *"]);
        assert_eq!(Schedule::Weekdays { times: vec![t(8, 30)] }.to_cron().unwrap(), vec!["30 8 * * 1-5"]);
        assert_eq!(
            Schedule::Weekly { days: vec![5, 1, 1], times: vec![t(7, 15)] }.to_cron().unwrap(),
            vec!["15 7 * * 1,5"]
        );
    }

    #[test]
    fn several_times_share_an_expression_per_minute() {
        let s = Schedule::Daily { times: vec![t(9, 0), t(13, 0), t(17, 30), t(9, 0)] };
        assert_eq!(s.to_cron().unwrap(), vec!["0 9,13 * * *", "30 17 * * *"]);
        assert_eq!(s.compile().unwrap().len(), 2);
    }

    #[test]
    fn a_preset_without_times_or_days_is_refused() {
        assert!(Schedule::Daily { times: vec![] }.to_cron().is_err());
        assert!(Schedule::Weekly { days: vec![], times: vec![t(9, 0)] }.to_cron().is_err());
        assert!(Schedule::Weekly { days: vec![7], times: vec![t(9, 0)] }.to_cron().is_err());
        assert!(Schedule::Daily { times: vec![t(24, 0)] }.to_cron().is_err());
    }

    #[test]
    fn raw_cron_is_validated_when_the_task_is() {
        let mut task = task("a");
        task.schedule = Schedule::Cron { expr: "61 * * * *".into() };
        assert!(task.validate().unwrap_err().message.contains("minute"));
        task.schedule = Schedule::Cron { expr: "0 0 31 2 *".into() };
        assert!(task.validate().unwrap_err().message.contains("never"));
        task.schedule = Schedule::Cron { expr: "*/10 * * * *".into() };
        task.validate().unwrap();
    }

    #[test]
    fn a_good_task_validates_and_previews_its_next_fires() {
        let task = task("a");
        task.validate().unwrap();
        let after = DateTime::parse_from_rfc3339("2026-05-01T10:00:00Z").unwrap().with_timezone(&Utc);
        let f = task.next_fires(after, 5).unwrap();
        assert_eq!(f.len(), 5);
        assert_eq!(f[0].to_rfc3339(), "2026-05-02T09:00:00+00:00");
    }

    #[test]
    fn budgets_are_mandatory_and_bounded() {
        let mut x = task("a");
        for zeroed in [
            Budgets { max_turns: 0, ..x.budgets },
            Budgets { max_tokens: 0, ..x.budgets },
            Budgets { max_wall_clock_secs: 0, ..x.budgets },
            Budgets { max_turns: MAX_TURNS_LIMIT + 1, ..x.budgets },
            Budgets { max_tokens: MAX_TOKENS_LIMIT + 1, ..x.budgets },
            Budgets { max_wall_clock_secs: MAX_WALL_CLOCK_LIMIT_SECS + 1, ..x.budgets },
        ] {
            x.budgets = zeroed;
            assert!(x.validate().is_err(), "{zeroed:?}");
        }
    }

    #[test]
    fn a_task_file_without_budgets_does_not_load() {
        let mut v = serde_json::to_value(task("a")).unwrap();
        v.as_object_mut().unwrap().remove("budgets");
        assert!(serde_json::from_value::<Task>(v).is_err());
        let mut v = serde_json::to_value(task("a")).unwrap();
        v["budgets"].as_object_mut().unwrap().remove("maxTurns");
        assert!(serde_json::from_value::<Task>(v).is_err());
    }

    #[test]
    fn the_policy_needs_an_explicit_allow_list() {
        let mut x = task("a");
        x.policy.allow_tools.clear();
        assert!(x.validate().is_err());
        x.policy.allow_tools = vec!["*".into()];
        assert!(x.validate().is_err());
        assert_eq!(task("a").policy.write, WriteMode::ReadOnly);
    }

    #[test]
    fn a_prompt_with_a_credential_is_refused() {
        for secret in [
            "use key sk-abcdefghijklmnopqrstuvwx to call it",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
            "api_key=abcdEFGH12345678",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "-----BEGIN RSA PRIVATE KEY-----",
        ] {
            let mut x = task("a");
            x.prompt = secret.into();
            assert!(x.validate().unwrap_err().message.contains("key or password"), "{secret}");
        }
        let mut ok = task("a");
        ok.prompt = "Check that the token refresh code still handles expiry.".into();
        ok.validate().unwrap();
    }

    #[test]
    fn identity_and_zone_are_checked() {
        let mut x = task("../escape");
        assert!(x.validate().is_err());
        x = task("a");
        x.timezone = "Mars/Olympus".into();
        assert!(x.validate().unwrap_err().message.contains("time zone"));
        x = task("a");
        x.project = "relative".into();
        assert!(x.validate().is_err());
        x.project = std::env::temp_dir().to_string_lossy().to_string();
        x.name = "  ".into();
        assert!(x.validate().is_err());
    }

    #[test]
    fn defaults_are_catch_up_once_and_continue_on_block() {
        assert_eq!(CatchUp::default(), CatchUp::Once);
        assert_eq!(OnBlock::default(), OnBlock::Continue);
        let v = serde_json::json!({
            "id": "a", "name": "n", "prompt": "p",
            "schedule": {"kind": "daily", "times": [{"hour": 9, "minute": 0}]},
            "timezone": "UTC", "model": "m/x", "project": std::env::temp_dir(),
            "policy": {"allowTools": ["read"]},
            "budgets": {"maxTurns": 5, "maxTokens": 1000, "maxWallClockSecs": 60}
        });
        let task: Task = serde_json::from_value(v).unwrap();
        assert_eq!(task.catch_up, CatchUp::Once);
        assert!(task.enabled);
        assert_eq!(task.policy.write, WriteMode::ReadOnly);
    }

    #[test]
    fn time_of_day_parses() {
        assert_eq!(TimeOfDay::parse("09:05"), Some(t(9, 5)));
        assert_eq!(TimeOfDay::parse("24:00"), None);
        assert_eq!(TimeOfDay::parse("x"), None);
    }
}
