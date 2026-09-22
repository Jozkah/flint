//! Telling somebody a run finished, or needs them (AH-185, AH-184).
//!
//! A headless run that has been going for ten minutes and now wants an
//! approval is invisible: whoever started it has moved on. So a project can
//! declare, in `agent.toml`, what should happen when a run reaches a moment
//! worth knowing about:
//!
//! ```toml
//! [notify]
//! # A command run locally (AH-185). Argument-vector form only: no shell.
//! command = ["notify-send", "Flint"]
//! # An endpoint to POST to (AH-184).
//! webhook = "https://example.invalid/hooks/jan"
//! # Which moments. Default: the run ending, and a run waiting for a person.
//! events = ["run.ended", "needs.attention"]
//! ```
//!
//! What is deliberately *not* sent: the prompt, the model's answer, tool
//! output, file contents, credentials. A notification says which run, what
//! happened and when. Everything else is in the transcript, which stays where
//! it is -- sending a run's content to an endpoint is not what "tell me when
//! it finishes" asks for, and an endpoint is a place data does not come back
//! from.
//!
//! Delivery never decides the run. A webhook that times out, refuses or cannot
//! be reached is reported and dropped: a run that has finished has finished,
//! and failing it because nobody could be told would turn a courtesy into a
//! new way to lose work.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long a delivery may take before it is abandoned. A notification is
/// worth a few seconds, and nothing more: the run is already over.
pub const DELIVERY_DEADLINE: Duration = Duration::from_secs(5);

/// The moments a project can ask to hear about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moment {
    /// The run ended, however it ended.
    RunEnded,
    /// The run is waiting for a person: an approval, or a question.
    NeedsAttention,
}

impl Moment {
    pub fn kind(self) -> &'static str {
        match self {
            Moment::RunEnded => "run.ended",
            Moment::NeedsAttention => "needs.attention",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "run.ended" | "run_ended" => Some(Moment::RunEnded),
            "needs.attention" | "needs_attention" => Some(Moment::NeedsAttention),
            _ => None,
        }
    }
}

/// `[notify]`, as a project declares it.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct NotifySection {
    /// A local command, as an argument vector: program first. Never a shell
    /// string -- a string would be one quoting mistake away from running
    /// something else.
    #[serde(default)]
    pub command: Vec<String>,
    /// An endpoint to POST the notification to (AH-184).
    #[serde(default)]
    pub webhook: Option<String>,
    /// Which moments. Empty means both.
    #[serde(default)]
    pub events: Vec<String>,
}

/// The declared configuration, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Notify {
    pub command: Vec<String>,
    pub webhook: Option<String>,
    pub moments: Vec<Moment>,
}

/// What is wrong with a `[notify]` section, in the harness's own words.
pub fn check(section: &NotifySection) -> Result<Option<Notify>, tauri_plugin_agent_tools::harness_error::HarnessError> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    let invalid = |message: String| {
        HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
    };
    if section.command.is_empty() && section.webhook.is_none() {
        return Ok(None);
    }
    if section.command.iter().any(|part| part.trim().is_empty()) {
        return Err(invalid(
            "[notify].command has an empty argument; give the program first, then its arguments"
                .to_string(),
        ));
    }
    let webhook = match section.webhook.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(url) => {
            // A notification leaves the machine. Where it goes is worth being
            // strict about: a scheme this does not speak is a URL nobody can
            // be sure about, and silently not delivering is worse than saying
            // so at startup.
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err(invalid(format!(
                    "[notify].webhook must be an http or https URL; {url:?} is not one"
                )));
            }
            Some(url.to_string())
        }
    };
    let mut moments = Vec::new();
    for declared in &section.events {
        match Moment::parse(declared) {
            Some(moment) => moments.push(moment),
            None => {
                return Err(invalid(format!(
                    "[notify].events has {declared:?}, which is not a moment this knows \
                     (run.ended, needs.attention)"
                )))
            }
        }
    }
    if moments.is_empty() {
        moments = vec![Moment::RunEnded, Moment::NeedsAttention];
    }
    Ok(Some(Notify {
        command: section.command.clone(),
        webhook,
        moments,
    }))
}

/// What is sent. Deliberately small: which run, what happened, when, and a
/// one-line summary that carries no content of its own.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub kind: &'static str,
    pub session: String,
    /// The run, when the surface knows it. `None` rather than a stand-in: a
    /// session id in a field labelled `run` is a wrong answer, and a consumer
    /// that keys on it would key on the wrong thing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    pub at: String,
    /// A short, contentless line: "the run ended: completed", "waiting for
    /// approval of a bash call". Never the prompt, the answer or tool output.
    pub summary: String,
}

impl Notification {
    pub fn new(
        moment: Moment,
        session: &str,
        run: Option<&str>,
        summary: impl Into<String>,
    ) -> Self {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            kind: moment.kind(),
            session: session.to_string(),
            run: run.map(str::to_string),
            at: rfc3339(seconds),
            summary: tauri_plugin_agent_tools::harness_error::scrub(&summary.into()),
        }
    }
}

fn rfc3339(seconds: u64) -> String {
    // The same shape the event log writes, without pulling in a date library
    // for one line of output.
    let days = seconds / 86_400;
    let time = seconds % 86_400;
    let (mut y, mut remaining) = (1970i64, days as i64);
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while remaining >= lengths[month] {
        remaining -= lengths[month];
        month += 1;
    }
    format!(
        "{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        month + 1,
        remaining + 1,
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// How a delivery went. Nothing here fails a run.
#[derive(Debug, Clone, PartialEq)]
pub enum Delivered {
    /// It went out, and the other end took it.
    Sent(String),
    /// It did not, and this is why. Worth logging, never worth failing a run
    /// over: a run that has finished has finished.
    Failed(String),
    /// Nothing was configured for this moment.
    NotAsked,
}

/// Whether this moment is one the project asked about.
pub fn wants(notify: &Notify, moment: Moment) -> bool {
    notify.moments.contains(&moment)
}

/// Run the declared command with the notification as its last argument (JSON).
///
/// Argument-vector form only, no shell: the program is exactly what was named,
/// and the notification arrives as one argument rather than being spliced into
/// a command line where a quote would change what runs.
pub fn run_command(notify: &Notify, note: &Notification, project_root: &Path) -> Delivered {
    if notify.command.is_empty() {
        return Delivered::NotAsked;
    }
    let payload = serde_json::to_string(note).unwrap_or_default();
    let mut command = std::process::Command::new(&notify.command[0]);
    command
        .args(&notify.command[1..])
        .arg(&payload)
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    {
        use jan_process::CommandConsole;
        command.background();
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Delivered::Failed(format!(
                "[notify].command '{}' could not be started: {e}",
                notify.command[0]
            ))
        }
    };
    let deadline = std::time::Instant::now() + DELIVERY_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return Delivered::Sent(format!("ran {}", notify.command[0]))
            }
            Ok(Some(status)) => {
                return Delivered::Failed(format!(
                    "[notify].command '{}' exited with {status}",
                    notify.command[0]
                ))
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Delivered::Failed(format!(
                    "[notify].command '{}' did not finish within {}s and was stopped",
                    notify.command[0],
                    DELIVERY_DEADLINE.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                return Delivered::Failed(format!(
                    "[notify].command '{}' could not be waited on: {e}",
                    notify.command[0]
                ))
            }
        }
    }
}

/// POST the notification to the declared endpoint (AH-184).
pub async fn post_webhook(notify: &Notify, note: &Notification) -> Delivered {
    let Some(url) = notify.webhook.as_deref() else {
        return Delivered::NotAsked;
    };
    let client = match crate::core::net::tls::apply12(reqwest::Client::builder().timeout(DELIVERY_DEADLINE)).build() {
        Ok(client) => client,
        Err(e) => return Delivered::Failed(format!("the webhook client could not be built: {e}")),
    };
    match client.post(url).json(note).send().await {
        Ok(response) if response.status().is_success() => {
            Delivered::Sent(format!("posted to the endpoint ({})", response.status()))
        }
        Ok(response) => Delivered::Failed(format!(
            "the webhook endpoint answered {}",
            response.status()
        )),
        Err(e) => Delivered::Failed(format!(
            "the webhook could not be delivered: {}",
            tauri_plugin_agent_tools::harness_error::scrub(&e.to_string())
        )),
    }
}

/// Tell whoever asked to be told, by every means declared, and report how each
/// went. Never fails, and never decides the run.
pub async fn deliver(
    notify: &Notify,
    note: &Notification,
    project_root: &Path,
    moment: Moment,
) -> Vec<Delivered> {
    if !wants(notify, moment) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !notify.command.is_empty() {
        let (n, note_copy, root) = (notify.clone(), note.clone(), project_root.to_path_buf());
        let ran = tokio::task::spawn_blocking(move || run_command(&n, &note_copy, &root))
            .await
            .unwrap_or_else(|e| Delivered::Failed(format!("the command could not be run: {e}")));
        out.push(ran);
    }
    if notify.webhook.is_some() {
        out.push(post_webhook(notify, note).await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(command: &[&str], webhook: Option<&str>, events: &[&str]) -> NotifySection {
        NotifySection {
            command: command.iter().map(|s| s.to_string()).collect(),
            webhook: webhook.map(|s| s.to_string()),
            events: events.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Nothing declared is nothing to do, and is not an error.
    #[test]
    fn a_project_that_asks_for_nothing_is_told_nothing() {
        assert_eq!(check(&NotifySection::default()).expect("fine"), None);
    }

    /// What a project asks for is checked at startup, not discovered when a
    /// run ends and nobody is told.
    #[test]
    fn a_configuration_that_cannot_work_is_refused_at_startup() {
        use tauri_plugin_agent_tools::harness_error::ErrorKind;
        let err = check(&section(&[], Some("ftp://example.invalid"), &[])).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(err.message().contains("http or https"), "{err}");

        let err = check(&section(&["notify-send", "  "], None, &[])).unwrap_err();
        assert!(err.message().contains("empty argument"), "{err}");

        let err = check(&section(&["x"], None, &["run.finished"])).unwrap_err();
        assert!(err.message().contains("not a moment this knows"), "{err}");
    }

    /// Asking for no particular moment asks for both.
    #[test]
    fn the_default_is_the_two_moments_worth_knowing_about() {
        let notify = check(&section(&["x"], None, &[])).expect("fine").expect("declared");
        assert!(wants(&notify, Moment::RunEnded));
        assert!(wants(&notify, Moment::NeedsAttention));

        let only_end = check(&section(&["x"], None, &["run.ended"]))
            .expect("fine")
            .expect("declared");
        assert!(wants(&only_end, Moment::RunEnded));
        assert!(!wants(&only_end, Moment::NeedsAttention));
    }

    /// A notification says which run, what happened and when -- and carries
    /// nothing of what the run was doing.
    #[test]
    fn a_notification_carries_no_content_of_the_run() {
        let note = Notification::new(
            Moment::RunEnded,
            "s1",
            Some("s1#run-1"),
            "the run ended: completed",
        );
        let json = serde_json::to_string(&note).unwrap();
        assert!(json.contains("\"kind\":\"run.ended\""), "{json}");
        assert!(json.contains("s1#run-1"), "{json}");
        assert!(note.at.ends_with('Z'), "{}", note.at);
        assert!(!json.contains("prompt") && !json.contains("content"), "{json}");
    }

    /// A command that cannot be started, or that fails, is reported -- and is
    /// still not an error anybody's run depends on.
    #[test]
    fn a_command_that_fails_is_reported_and_nothing_more() {
        let notify = Notify {
            command: vec!["this-program-does-not-exist-anywhere".to_string()],
            webhook: None,
            moments: vec![Moment::RunEnded],
        };
        let note = Notification::new(Moment::RunEnded, "s1", Some("s1#run-1"), "ended");
        match run_command(&notify, &note, std::path::Path::new(".")) {
            Delivered::Failed(why) => assert!(why.contains("could not be started"), "{why}"),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    /// The command actually runs, with the notification as one argument.
    #[tokio::test]
    async fn the_declared_command_runs_and_receives_the_notification() {
        let dir = std::env::temp_dir().join(format!(
            "jan_notify_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // `cmd /c` on Windows, `sh -c` elsewhere: write the argument to a file
        // so the test can read what the command was actually handed.
        let out = dir.join("got.json");
        let notify = if cfg!(windows) {
            // Python is what this repository's own fixtures run on Windows;
            // `cmd /c` does not substitute arguments into its command string,
            // which is the point being tested here.
            Notify {
                command: vec![
                    "python".to_string(),
                    "-c".to_string(),
                    "import sys; open(sys.argv[1], 'w').write(sys.argv[2])".to_string(),
                    out.display().to_string(),
                ],
                webhook: None,
                moments: vec![Moment::RunEnded],
            }
        } else {
            Notify {
                command: vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    format!("printf '%s' \"$1\" > '{}'", out.display()),
                    "sh".to_string(),
                ],
                webhook: None,
                moments: vec![Moment::RunEnded],
            }
        };
        let note = Notification::new(Moment::RunEnded, "s1", Some("s1#run-1"), "the run ended: completed");
        let delivered = deliver(&notify, &note, &dir, Moment::RunEnded).await;
        assert!(
            matches!(delivered.as_slice(), [Delivered::Sent(_)]),
            "{delivered:?}"
        );
        let got = std::fs::read_to_string(&out).unwrap_or_default();
        assert!(got.contains("s1#run-1"), "the command was handed: {got:?}");

        // A moment nobody asked about delivers nothing at all.
        assert!(deliver(&notify, &note, &dir, Moment::NeedsAttention).await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
