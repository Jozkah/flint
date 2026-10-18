//! Automations: a typed, validated definition of a run that starts without
//! anyone typing the prompt.
//!
//! An automation names its trigger (by hand, or on a timetable), the prompt, a
//! tool profile, a mandatory budget and the folders it may work in. It is
//! refused on save with every problem listed by field, so a mistake shows up
//! when the automation is written, not the night it should have run.
//!
//! It does not add a second runner. A saved automation compiles to a
//! [`schedule::spec::Task`](crate::core::schedule::spec::Task); a timetable
//! trigger is mirrored into the scheduled-task store (id `auto-<id>`), so the
//! existing tick, the unattended-run rules (denied prompts, auto-mode on,
//! worktree-only writes) and the run history all apply unchanged. Nothing here
//! contacts a network.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::schedule::spec::{
    looks_like_secret, parse_timezone, Budgets, CatchUp, OnBlock, Policy, Schedule, Task, WriteMode, MAX_NAME_CHARS,
    MAX_PROMPT_CHARS,
};
use crate::core::schedule::store::Store;

/// Version of `automations.json`.
pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_FOLDERS: usize = 8;
/// Leaves room for the `auto-` prefix inside the 64-character task id limit.
pub const MAX_ID_CHARS: usize = 56;

/// What starts an automation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Trigger {
    /// Only when someone runs it (`flint cli automation run <id>`).
    Manual,
    /// On a timetable, through the scheduled-task tick.
    Schedule {
        schedule: Schedule,
        /// IANA zone name, e.g. `Europe/Berlin`.
        timezone: String,
    },
}

/// Which tools the run is offered, and whether it may change files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolProfile {
    /// Look only: read, ls, grep, find.
    ReadOnly,
    /// The coding set (adds write, edit, bash), editing in a fresh worktree on
    /// its own branch and never in the folder itself.
    Coding,
    /// An explicit list.
    Custom {
        tools: Vec<String>,
        #[serde(default)]
        write: WriteMode,
    },
}

const READ_ONLY_TOOLS: &[&str] = &["read", "ls", "grep", "find"];
const CODING_TOOLS: &[&str] = &["read", "ls", "grep", "find", "write", "edit", "bash"];

impl ToolProfile {
    pub fn policy(&self) -> Policy {
        match self {
            ToolProfile::ReadOnly => Policy { allow_tools: strings(READ_ONLY_TOOLS), write: WriteMode::ReadOnly },
            ToolProfile::Coding => Policy { allow_tools: strings(CODING_TOOLS), write: WriteMode::Worktree },
            ToolProfile::Custom { tools, write } => Policy { allow_tools: tools.clone(), write: *write },
        }
    }
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// One automation, as written to disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub trigger: Trigger,
    pub prompt: String,
    /// `provider/model`, as every other surface names a model.
    pub model: String,
    /// The folders it may work in, absolute. A run works in one of them (the
    /// first by default) and never anywhere else.
    pub folders: Vec<String>,
    pub tool_profile: ToolProfile,
    /// Limits a run may not pass; every one is required.
    pub budget: Budgets,
    #[serde(default)]
    pub on_block: OnBlock,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// One thing wrong with a definition: where, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

fn problem(field: &str, message: impl Into<String>) -> Problem {
    Problem { field: field.to_string(), message: message.into() }
}

/// Every problem as one message, one per line.
pub fn describe(problems: &[Problem]) -> String {
    problems.iter().map(Problem::to_string).collect::<Vec<_>>().join("\n")
}

/// Parse an automation from JSON. A misspelled or unknown field is an error
/// naming the field, not a silent default.
pub fn parse(text: &str) -> Result<Automation, Vec<Problem>> {
    serde_json::from_str::<Automation>(text).map_err(|e| vec![problem("definition", e.to_string())])
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Why a folder cannot be one an unattended run works in, if it cannot.
fn folder_problem(raw: &str) -> Option<String> {
    let p = Path::new(raw);
    if raw.trim().is_empty() {
        return Some("is empty".into());
    }
    if !p.is_absolute() {
        return Some(format!("'{raw}' is not an absolute path"));
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Some(format!("'{raw}' contains '..'; write the folder out in full"));
    }
    let Ok(canon) = fs::canonicalize(p) else {
        return Some(format!("'{raw}' does not exist"));
    };
    if !canon.is_dir() {
        return Some(format!("'{raw}' is not a folder"));
    }
    if canon.parent().is_none() {
        return Some(format!("'{raw}' is a drive or filesystem root; name the project folder"));
    }
    if home_dir().and_then(|h| fs::canonicalize(h).ok()).is_some_and(|h| h == canon) {
        return Some(format!("'{raw}' is your whole home folder; name a project inside it"));
    }
    None
}

fn canon_key(raw: &str) -> String {
    let p = fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw));
    let s = p.to_string_lossy().to_string();
    let s = s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s);
    if cfg!(windows) { s.to_ascii_lowercase() } else { s }
}

impl Automation {
    /// Everything wrong with this definition, by field. Empty means it can be saved.
    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        if !id_ok(&self.id) {
            out.push(problem(
                "id",
                format!("use letters, digits, '-' or '_', at most {MAX_ID_CHARS} characters (got '{}')", self.id),
            ));
        }
        if self.name.trim().is_empty() {
            out.push(problem("name", "give the automation a name"));
        } else if self.name.chars().count() > MAX_NAME_CHARS {
            out.push(problem("name", format!("longer than {MAX_NAME_CHARS} characters")));
        }
        if self.prompt.trim().is_empty() {
            out.push(problem("prompt", "write what the automation should do"));
        } else if self.prompt.chars().count() > MAX_PROMPT_CHARS {
            out.push(problem("prompt", format!("longer than {MAX_PROMPT_CHARS} characters")));
        } else if looks_like_secret(&self.prompt) {
            out.push(problem(
                "prompt",
                "looks like it contains a key or password; remove it (provider keys are read from the provider settings, not from the prompt)",
            ));
        }
        if self.model.trim().is_empty() || self.model.chars().any(char::is_whitespace) {
            out.push(problem("model", "name a model as provider/model, without spaces"));
        }
        if let Trigger::Schedule { schedule, timezone } = &self.trigger {
            match parse_timezone(timezone) {
                Err(e) => out.push(problem("trigger.timezone", e.message)),
                Ok(tz) => match schedule.compile() {
                    Err(e) => out.push(problem("trigger.schedule", e.message)),
                    Ok(exprs) => {
                        if exprs.iter().all(|e| e.next_fires(tz, chrono::Utc::now(), 1).is_empty()) {
                            out.push(problem("trigger.schedule", "this schedule never fires"));
                        }
                    }
                },
            }
        }
        self.folder_problems(&mut out);
        self.tool_problems(&mut out);
        if let Err(e) = self.budget.validate() {
            out.push(problem("budget", e.message));
        }
        // The scheduled-task rules are the final word on anything missed above.
        if out.is_empty() {
            if let Err(e) = self.to_task(&self.folders[0]).validate() {
                out.push(problem("definition", e.message));
            }
        }
        out
    }

    fn folder_problems(&self, out: &mut Vec<Problem>) {
        if self.folders.is_empty() {
            out.push(problem("folders", "list at least one folder the automation may work in"));
            return;
        }
        if self.folders.len() > MAX_FOLDERS {
            out.push(problem("folders", format!("at most {MAX_FOLDERS} folders")));
        }
        let mut seen = BTreeSet::new();
        for (i, f) in self.folders.iter().enumerate() {
            let field = format!("folders[{i}]");
            if let Some(why) = folder_problem(f) {
                out.push(problem(&field, why));
                continue;
            }
            if !seen.insert(canon_key(f)) {
                out.push(problem(&field, format!("'{f}' is listed twice")));
            }
            if self.policy().write == WriteMode::Worktree && !Path::new(f).join(".git").exists() {
                out.push(problem(
                    &field,
                    format!("'{f}' is not a git repository, and this profile edits in a worktree; use the read_only profile or a repository"),
                ));
            }
        }
    }

    fn tool_problems(&self, out: &mut Vec<Problem>) {
        let policy = self.policy();
        if let ToolProfile::Custom { tools, write } = &self.tool_profile {
            use tauri_plugin_agent_tools::tools::{Capability, BUILTIN_TOOLS};
            if tools.is_empty() {
                out.push(problem("toolProfile.tools", "list the tools the automation may use"));
            }
            for t in tools {
                match BUILTIN_TOOLS.iter().find(|b| b.name == t.as_str()) {
                    None => out.push(problem(
                        "toolProfile.tools",
                        format!("'{t}' is not a built-in tool (see `flint cli schedule tools`)"),
                    )),
                    Some(b) if *write == WriteMode::ReadOnly && matches!(b.capability, Capability::Write | Capability::Exec) => {
                        out.push(problem(
                            "toolProfile.tools",
                            format!("'{t}' can change things but write is read_only; set write to worktree or drop the tool"),
                        ))
                    }
                    Some(_) => {}
                }
            }
        }
        if let Err(e) = policy.validate() {
            if !matches!(self.tool_profile, ToolProfile::Custom { ref tools, .. } if tools.is_empty()) {
                out.push(problem("toolProfile", e.message));
            }
        }
    }

    pub fn policy(&self) -> Policy {
        self.tool_profile.policy()
    }

    pub fn task_id(&self) -> String {
        format!("auto-{}", self.id)
    }

    /// The scheduled task this automation runs as, working in `folder`. A
    /// manual automation gets a placeholder timetable that is never saved to
    /// the schedule store, so nothing fires it.
    pub fn to_task(&self, folder: &str) -> Task {
        let (schedule, timezone) = match &self.trigger {
            Trigger::Schedule { schedule, timezone } => (schedule.clone(), timezone.clone()),
            Trigger::Manual => (
                Schedule::Daily { times: vec![crate::core::schedule::spec::TimeOfDay { hour: 0, minute: 0 }] },
                "UTC".to_string(),
            ),
        };
        Task {
            id: self.task_id(),
            name: self.name.trim().to_string(),
            prompt: self.prompt.clone(),
            schedule,
            timezone,
            model: self.model.clone(),
            project: folder.to_string(),
            profile: None,
            policy: self.policy(),
            budgets: self.budget,
            on_block: self.on_block,
            catch_up: CatchUp::Once,
            enabled: self.enabled,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    /// The task for a run in `folder`, which must be one of this automation's
    /// folders (compared as real paths).
    pub fn task_for_run(&self, folder: Option<&str>) -> Result<Task, String> {
        let chosen = match folder {
            None => self.folders[0].clone(),
            Some(f) => {
                let want = canon_key(f);
                self.folders
                    .iter()
                    .find(|a| canon_key(a) == want)
                    .cloned()
                    .ok_or_else(|| format!("'{f}' is not one of this automation's folders: {}", self.folders.join(", ")))?
            }
        };
        if let Some(why) = folder_problem(&chosen) {
            return Err(format!("the folder {why}"));
        }
        Ok(self.to_task(&chosen))
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct File {
    version: u32,
    automations: Vec<Automation>,
}

/// Automations on disk: `<data folder>/automations/automations.json`.
pub struct AutomationStore {
    dir: PathBuf,
    tasks: Store,
}

impl AutomationStore {
    pub fn new(data_folder: &Path) -> Self {
        AutomationStore { dir: data_folder.join("automations"), tasks: Store::new(data_folder) }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("automations.json")
    }

    pub fn load(&self) -> Result<Vec<Automation>, String> {
        let text = match fs::read_to_string(self.path()) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("automations.json could not be read: {e}")),
        };
        let file: File = serde_json::from_str(&text).map_err(|e| format!("automations.json is not valid: {e}"))?;
        if file.version != SCHEMA_VERSION {
            return Err(format!("automations.json is version {}, this build reads version {SCHEMA_VERSION}", file.version));
        }
        Ok(file.automations)
    }

    pub fn get(&self, id: &str) -> Result<Option<Automation>, String> {
        Ok(self.load()?.into_iter().find(|a| a.id == id))
    }

    fn write(&self, automations: Vec<Automation>) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("the automations folder could not be created: {e}"))?;
        let body = serde_json::to_vec_pretty(&File { version: SCHEMA_VERSION, automations }).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!(".automations.{}.tmp", std::process::id()));
        fs::write(&tmp, body).map_err(|e| format!("automations.json could not be written: {e}"))?;
        fs::rename(&tmp, self.path()).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("automations.json could not be replaced: {e}")
        })
    }

    /// Validate and save, adding or replacing by id. A timetable trigger is
    /// mirrored into the scheduled-task store; a manual one never fires.
    pub fn save(&self, automation: Automation) -> Result<Automation, Vec<Problem>> {
        let problems = automation.problems();
        if !problems.is_empty() {
            return Err(problems);
        }
        let io = |e: String| vec![problem("store", e)];
        let mut all = self.load().map_err(io)?;
        match all.iter_mut().find(|a| a.id == automation.id) {
            Some(existing) => *existing = automation.clone(),
            None => all.push(automation.clone()),
        }
        self.write(all).map_err(io)?;
        let task_id = automation.task_id();
        match &automation.trigger {
            Trigger::Schedule { .. } => {
                self.tasks.save_task(automation.to_task(&automation.folders[0])).map_err(|e| io(e.message))?;
            }
            // Keep the run history of a task that used to be on a timetable,
            // but stop it firing.
            Trigger::Manual => {
                if self.tasks.get_task(&task_id).map_err(|e| io(e.message))?.is_some() {
                    self.tasks.set_enabled(&task_id, false).map_err(|e| io(e.message))?;
                }
            }
        }
        Ok(automation)
    }

    /// Remove an automation, its mirrored task and that task's run history.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let mut all = self.load()?;
        let before = all.len();
        all.retain(|a| a.id != id);
        if all.len() == before {
            return Ok(false);
        }
        self.write(all)?;
        if id_ok(id) {
            let _ = self.tasks.delete_task(&format!("auto-{id}"));
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schedule::spec::TimeOfDay;

    fn folder() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("repo").join(".git")).unwrap();
        d
    }

    fn sample(dir: &Path) -> Automation {
        Automation {
            id: "nightly".into(),
            name: "Nightly review".into(),
            trigger: Trigger::Schedule {
                schedule: Schedule::Weekdays { times: vec![TimeOfDay { hour: 9, minute: 0 }] },
                timezone: "Europe/Berlin".into(),
            },
            prompt: "Summarise yesterday's commits.".into(),
            model: "mock/m".into(),
            folders: vec![dir.join("repo").to_string_lossy().into_owned()],
            tool_profile: ToolProfile::ReadOnly,
            budget: Budgets { max_turns: 10, max_tokens: 40_000, max_wall_clock_secs: 300, max_cost_usd: None },
            on_block: OnBlock::Continue,
            enabled: true,
        }
    }

    fn fields(a: &Automation) -> Vec<String> {
        a.problems().into_iter().map(|p| p.field).collect()
    }

    #[test]
    fn a_good_definition_has_no_problems_and_compiles_to_a_task() {
        let d = folder();
        let a = sample(d.path());
        assert!(a.problems().is_empty(), "{:?}", a.problems());
        let t = a.to_task(&a.folders[0]);
        assert_eq!(t.id, "auto-nightly");
        assert_eq!(t.policy.allow_tools, vec!["read", "ls", "grep", "find"]);
        assert_eq!(t.policy.write, WriteMode::ReadOnly);
        t.validate().unwrap();
    }

    #[test]
    fn every_problem_is_reported_at_once_with_its_field() {
        let d = folder();
        let mut a = sample(d.path());
        a.id = "../x".into();
        a.name = " ".into();
        a.prompt = "use key sk-abcdefghijklmnopqrstuvwx".into();
        a.model = "".into();
        a.trigger = Trigger::Schedule { schedule: Schedule::Cron { expr: "61 * * * *".into() }, timezone: "Mars/Olympus".into() };
        a.folders = vec!["relative".into(), d.path().join("missing").to_string_lossy().into_owned()];
        a.budget.max_turns = 0;
        let f = fields(&a);
        for want in ["id", "name", "prompt", "model", "trigger.timezone", "folders[0]", "folders[1]", "budget"] {
            assert!(f.contains(&want.to_string()), "{want} in {f:?}");
        }
        let msg = describe(&a.problems());
        assert!(msg.contains("prompt: looks like it contains a key"), "{msg}");
        a.trigger = Trigger::Schedule { schedule: Schedule::Cron { expr: "0 0 31 2 *".into() }, timezone: "UTC".into() };
        assert!(fields(&a).contains(&"trigger.schedule".to_string()));
    }

    #[test]
    fn folders_are_checked_for_roots_duplicates_dotdot_and_repositories() {
        let d = folder();
        let repo = d.path().join("repo").to_string_lossy().into_owned();
        let mut a = sample(d.path());
        a.folders = vec![];
        assert_eq!(fields(&a), vec!["folders"]);
        a.folders = vec![repo.clone(), repo.clone()];
        assert!(describe(&a.problems()).contains("listed twice"));
        a.folders = vec![format!("{repo}/../repo")];
        assert!(describe(&a.problems()).contains("'..'"));
        a.folders = vec![if cfg!(windows) { "C:\\".into() } else { "/".to_string() }];
        assert!(describe(&a.problems()).contains("root"));
        // A coding profile edits in a worktree, so the folder must be a repository.
        let plain = d.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        a.folders = vec![plain.to_string_lossy().into_owned()];
        a.tool_profile = ToolProfile::Coding;
        assert!(describe(&a.problems()).contains("not a git repository"));
        a.folders = vec![repo];
        assert!(a.problems().is_empty(), "{:?}", a.problems());
        assert_eq!(a.policy().write, WriteMode::Worktree);
    }

    #[test]
    fn a_custom_profile_must_name_real_tools_and_may_not_write_read_only() {
        let d = folder();
        let mut a = sample(d.path());
        a.tool_profile = ToolProfile::Custom { tools: vec!["read".into(), "nope".into()], write: WriteMode::ReadOnly };
        assert!(describe(&a.problems()).contains("'nope' is not a built-in tool"));
        a.tool_profile = ToolProfile::Custom { tools: vec!["read".into(), "write".into()], write: WriteMode::ReadOnly };
        assert!(describe(&a.problems()).contains("can change things"));
        a.tool_profile = ToolProfile::Custom { tools: vec![], write: WriteMode::ReadOnly };
        assert!(fields(&a).contains(&"toolProfile.tools".to_string()));
        a.tool_profile = ToolProfile::Custom { tools: vec!["read".into(), "grep".into()], write: WriteMode::ReadOnly };
        assert!(a.problems().is_empty(), "{:?}", a.problems());
    }

    #[test]
    fn a_misspelled_or_missing_field_is_refused_by_name() {
        let d = folder();
        let mut v = serde_json::to_value(sample(d.path())).unwrap();
        v["toolprofile"] = serde_json::json!({ "kind": "coding" });
        let e = describe(&parse(&v.to_string()).unwrap_err());
        assert!(e.contains("toolprofile"), "{e}");
        let mut v = serde_json::to_value(sample(d.path())).unwrap();
        v.as_object_mut().unwrap().remove("budget");
        let e = describe(&parse(&v.to_string()).unwrap_err());
        assert!(e.contains("budget"), "a budget is mandatory: {e}");
        let mut v = serde_json::to_value(sample(d.path())).unwrap();
        v["trigger"] = serde_json::json!({ "kind": "webhook" });
        assert!(parse(&v.to_string()).is_err(), "only manual and schedule triggers exist");
    }

    #[test]
    fn saving_validates_stores_and_mirrors_a_timetable_into_the_schedule_store() {
        let d = folder();
        let data = tempfile::tempdir().unwrap();
        let store = AutomationStore::new(data.path());
        let mut bad = sample(d.path());
        bad.budget.max_tokens = 0;
        assert!(store.save(bad).is_err());
        assert!(store.load().unwrap().is_empty(), "nothing is stored when it is refused");

        store.save(sample(d.path())).unwrap();
        assert_eq!(store.load().unwrap().len(), 1);
        let mirrored = Store::new(data.path()).get_task("auto-nightly").unwrap().unwrap();
        assert!(mirrored.enabled && mirrored.project.ends_with("repo"));

        // Replace by id: manual now, so the timetable stops firing.
        let mut manual = sample(d.path());
        manual.trigger = Trigger::Manual;
        store.save(manual).unwrap();
        assert_eq!(store.load().unwrap().len(), 1);
        assert!(!Store::new(data.path()).get_task("auto-nightly").unwrap().unwrap().enabled);

        assert!(store.remove("nightly").unwrap());
        assert!(!store.remove("nightly").unwrap());
        assert!(Store::new(data.path()).get_task("auto-nightly").unwrap().is_none());
    }

    #[test]
    fn a_run_may_only_use_one_of_the_automations_folders() {
        let d = folder();
        let other = d.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let mut a = sample(d.path());
        a.trigger = Trigger::Manual;
        assert_eq!(a.task_for_run(None).unwrap().project, a.folders[0]);
        assert!(a.task_for_run(Some(&a.folders[0])).is_ok());
        let err = a.task_for_run(Some(&other.to_string_lossy())).unwrap_err();
        assert!(err.contains("not one of this automation's folders"), "{err}");
        // A path that merely reaches an allowed folder through `..` is the same folder.
        let via = format!("{}/../repo", other.to_string_lossy());
        assert!(a.task_for_run(Some(&via)).is_ok());
        // A manual automation compiles to a runnable task whose timetable never fires it.
        a.task_for_run(None).unwrap().validate().unwrap();
    }
}
