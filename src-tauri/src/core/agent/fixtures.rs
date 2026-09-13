//! Shared builders for harness tests. AH-011.
//!
//! Every module that needed a repository, a session's events or a set of
//! permission rules was building them by hand: a `temp_dir().join(format!(...))`
//! here, a `create_dir_all` there, a JSON envelope written by hand somewhere
//! else. That is how two tests come to disagree about what a run looks like,
//! and how a test ends up asserting against a shape the harness never
//! produces.
//!
//! These builders produce the real things -- a real `git init`, real envelopes
//! through [`event_log::append`], real `ToolPermissions` -- so a test that uses
//! them cannot drift from what the harness does. They are ordinary code rather
//! than `#[cfg(test)]` items, because the integration tests in `tests/` and the
//! smoke harness need them too, and a fixture that only unit tests can reach
//! is a fixture that gets hand-rolled again in the places that cannot.
//!
//! Everything a builder creates is removed when it is dropped, including after
//! a panic: a failing test must not leave a directory behind for the next run
//! to trip over.

use std::path::{Path, PathBuf};

use tauri_plugin_agent_tools::identity::{InvocationId, RunId, SessionId};
use tauri_plugin_agent_tools::permissions::{PermissionDefault, ToolPermissions};

/// A throwaway directory that cleans itself up.
///
/// Named by the caller's tag plus this process and thread, so two tests -- and
/// two test binaries running at once -- never share one.
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn new(tag: &str) -> Workspace {
        let root = std::env::temp_dir().join(format!(
            "jan-fixture-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Workspace { root }
    }

    /// Write one file, creating the directories above it.
    pub fn file(self, relative: &str, body: &str) -> Workspace {
        let full = self.root.join(relative);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("the directory above the file");
        }
        std::fs::write(full, body).expect("write the file");
        self
    }

    /// Write several at once.
    pub fn files(mut self, files: &[(&str, &str)]) -> Workspace {
        for (path, body) in files {
            self = self.file(path, body);
        }
        self
    }

    /// The project's own policy, which is what the gate reads.
    pub fn agent_toml(self, body: &str) -> Workspace {
        self.file(".jan/agent/agent.toml", body)
    }

    /// Make it a git repository with everything committed.
    ///
    /// A real `git init`, so what the vcs readers see is what git produces
    /// rather than a fixture's idea of it.
    pub fn git(self) -> Workspace {
        self.git_run(&["init", "-q", "-b", "main"]);
        self.git_run(&["config", "user.email", "fixture@example.invalid"]);
        self.git_run(&["config", "user.name", "Fixture"]);
        self.git_run(&["add", "-A"]);
        self.git_run(&["commit", "-qm", "the repository as it stands"]);
        self
    }

    /// Run one git command in it, and say what it printed.
    pub fn git_run(&self, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .expect("git is on the path");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn join(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// What a file holds now, or empty when it is not there.
    pub fn read(&self, relative: &str) -> String {
        std::fs::read_to_string(self.root.join(relative)).unwrap_or_default()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The three ids a run is made of, already parsed.
///
/// A run id is `<session>#run-<n>` and an invocation is `<run>#<n>`: the
/// relationships are in the ids, and a test that spells them by hand is a test
/// that can spell them wrong.
pub fn ids(session: &str, run: &str) -> (SessionId, RunId, InvocationId) {
    let session_id = SessionId::parse(session).expect("a session id");
    let run_id = RunId::parse(format!("{session}#run-{run}")).expect("a run id");
    let invocation = InvocationId::parse(format!("{session}#run-{run}#1")).expect("an invocation");
    (session_id, run_id, invocation)
}

/// A session's events, written the way the harness writes them.
pub struct Events {
    data: PathBuf,
    session: String,
    run: String,
    invocation: String,
    seq: usize,
}

impl Events {
    /// Start recording a run in `data`.
    pub fn new(data: &Path, session: &str, run: &str) -> Events {
        let (_, run_id, invocation) = ids(session, run);
        Events {
            data: data.to_path_buf(),
            session: session.to_string(),
            run: run_id.into_string(),
            invocation: invocation.into_string(),
            seq: 0,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run
    }

    /// One event, through the same append every surface uses.
    pub fn event(&mut self, kind: &str, payload: serde_json::Value) -> &mut Events {
        use tauri_plugin_agent_tools::event_log::{append, NewEvent};
        self.seq += 1;
        let id = format!("{}:{}:{}", self.run, kind, self.seq);
        let invocation = if kind.starts_with("run.") {
            String::new()
        } else {
            self.invocation.clone()
        };
        append(
            &self.data,
            NewEvent {
                id,
                session: self.session.clone(),
                run: self.run.clone(),
                invocation,
                kind: kind.to_string(),
                payload,
            },
        )
        .expect("the event is recorded");
        self
    }

    /// A run that started, made one request, called one tool and ended.
    ///
    /// The ordinary shape, so a test that needs "a run that happened" does not
    /// have to decide what that means.
    pub fn ordinary_run(&mut self, tool: &str) -> &mut Events {
        self.event(
            "run.started",
            serde_json::json!({ "model": "fixture/m", "source": "fixture" }),
        );
        self.event(
            "message.completed",
            serde_json::json!({ "phase": "dispatched", "model": "fixture/m" }),
        );
        self.event("tool.requested", serde_json::json!({ "tool": tool }));
        self.event("tool.succeeded", serde_json::json!({ "tool": tool }));
        self.event(
            "run.ended",
            serde_json::json!({ "stoppedBy": "done", "source": "fixture" }),
        );
        self
    }
}

/// Permission rules, without each test re-deciding what the defaults mean.
pub struct Rules {
    default: PermissionDefault,
    allow: Vec<String>,
    deny: Vec<String>,
    allow_write: Vec<String>,
}

impl Rules {
    /// Everything allowed: what a surface with no policy had before one
    /// existed.
    pub fn permissive() -> Rules {
        Rules {
            default: PermissionDefault::Allow,
            allow: Vec::new(),
            deny: Vec::new(),
            allow_write: Vec::new(),
        }
    }

    /// Reads allowed, everything else asked for.
    pub fn read_only() -> Rules {
        Rules { default: PermissionDefault::ReadOnly, ..Rules::permissive() }
    }

    pub fn deny(mut self, rule: &str) -> Rules {
        self.deny.push(rule.to_string());
        self
    }

    pub fn allow(mut self, rule: &str) -> Rules {
        self.allow.push(rule.to_string());
        self
    }

    pub fn allow_write(mut self, rule: &str) -> Rules {
        self.allow_write.push(rule.to_string());
        self
    }

    pub fn build(self) -> ToolPermissions {
        ToolPermissions::new(self.default, &self.allow, &self.deny, &self.allow_write)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_is_real_and_goes_away_with_itself() {
        let kept;
        {
            let workspace = Workspace::new("basic")
                .files(&[("src/a.rs", "pub fn a() {}\n"), ("README.md", "# x\n")])
                .agent_toml("[tools]\ndeny = [\"bash\"]\n");
            kept = workspace.path().to_path_buf();
            assert!(workspace.join("src/a.rs").is_file());
            assert_eq!(workspace.read("README.md"), "# x\n");
            assert!(workspace.join(".jan/agent/agent.toml").is_file());
        }
        assert!(!kept.exists(), "the workspace outlived itself");
    }

    #[test]
    fn a_git_workspace_is_a_real_repository() {
        let workspace = Workspace::new("git").file("a.txt", "one\n").git();
        assert_eq!(workspace.git_run(&["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert!(workspace.git_run(&["status", "--porcelain"]).is_empty(), "not committed");
        assert!(!workspace.git_run(&["rev-parse", "HEAD"]).is_empty(), "no commit");
    }

    #[test]
    fn recorded_events_are_the_ones_the_harness_would_write() {
        let data = Workspace::new("events");
        let mut events = Events::new(data.path(), "s-fixture", "one");
        events.ordinary_run("read");

        let written =
            tauri_plugin_agent_tools::event_log::read_session(data.path(), "s-fixture").unwrap();
        let kinds: Vec<&str> = written.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "run.started",
                "message.completed",
                "tool.requested",
                "tool.succeeded",
                "run.ended"
            ]
        );
        // The relationships are in the ids, not asserted separately.
        assert!(written.iter().all(|e| e.run == events.run_id()));
        assert!(written
            .iter()
            .filter(|e| !e.kind.starts_with("run."))
            .all(|e| e.invocation.starts_with(events.run_id())));
    }

    #[test]
    fn the_ids_a_run_is_made_of_belong_to_each_other() {
        let (session, run, invocation) = ids("s-ids", "seven");
        assert!(run.belongs_to(&session));
        assert!(invocation.belongs_to(&run));
    }

    #[test]
    fn rules_say_what_they_mean() {
        let subject = tauri_plugin_agent_tools::subject::Subject::MainAgent;
        let denied = Rules::permissive().deny("bash").build();
        assert!(denied.is_denied("bash", &subject));
        assert!(!denied.is_denied("read", &subject));

        let read_only = Rules::read_only().allow_write("write").build();
        assert!(read_only.is_allowed("write", &subject));
        assert!(!read_only.is_allowed("bash", &subject));
    }
}
