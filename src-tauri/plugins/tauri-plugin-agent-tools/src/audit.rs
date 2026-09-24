//! An append-only record of every permission decision the gate makes.
//!
//! Two things depend on this existing. A user asking "what did it do, and who
//! said it could?" has nowhere to look otherwise, and the permission centre
//! that AH-050/AH-198 build on needs a queryable history rather than a log
//! line. So every call through the production gate leaves a record here,
//! whether it was allowed, refused, or is still waiting on someone.
//!
//! Crash tolerance is the same shape `core::cli::journal` settled on: one JSON
//! object per line, appended and flushed, and a reader that drops any line that
//! no longer parses. A process killed mid-write leaves a truncated final line,
//! which costs the last record and nothing before it. (The registry pointed at
//! `harness/src/envelope.rs` for this; that file does not exist, and the only
//! other JSONL writer lives in the main crate, which this plugin cannot depend
//! on without a cycle.)
//!
//! Nothing here decides anything. It is a witness, so a bug in it must never
//! turn an allowed call into a refused one: every write path returns `()` and
//! logs rather than propagating.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Schema version, so a later reader can tell what it is looking at.
pub const SCHEMA_VERSION: u32 = 1;

/// File name under the audit directory.
pub const PERMISSIONS_LOG: &str = "permissions.jsonl";

/// What happened to a permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// The call was permitted.
    Allow,
    /// The call was refused outright.
    Deny,
    /// The user was asked and has not answered yet.
    Prompt,
    /// The user was asked and said yes.
    Granted,
    /// The user was asked and said no.
    Refused,
    /// A grant that existed has lapsed.
    Expired,
    /// A grant was withdrawn while it was still live.
    Revoked,
    /// An answer arrived for a request that is no longer current — a reply to
    /// a prompt from a run that has since ended. Recorded rather than applied.
    Stale,
    /// The request was abandoned because the run was cancelled.
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Allow => "allow",
            Outcome::Deny => "deny",
            Outcome::Prompt => "prompt",
            Outcome::Granted => "granted",
            Outcome::Refused => "refused",
            Outcome::Expired => "expired",
            Outcome::Revoked => "revoked",
            Outcome::Stale => "stale",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// One permission decision.
///
/// The identifiers are all here rather than implied by position, because the
/// permission centre has to group by any of them and a log that can only be
/// read in order cannot answer "what has this agent been allowed to touch?".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionRecord {
    #[serde(rename = "v")]
    pub version: u32,
    /// RFC 3339, UTC.
    pub at: String,
    pub session: String,
    /// The run within the session. Empty when the call is outside a run.
    #[serde(default)]
    pub run: String,
    /// The individual tool call, so a record joins to the activity timeline.
    #[serde(default)]
    pub call: String,
    /// Which agent asked — the main loop, or a named subagent.
    #[serde(default)]
    pub agent: String,
    /// The project the run is bound to.
    #[serde(default)]
    pub project: String,
    pub tool: String,
    /// `read` / `write` / `exec` / `net`, from the tool's capability.
    pub capability: String,
    /// `path` / `command` / `mcp` / `net` / `process` / `unknown`.
    pub kind: String,
    /// The normalized resource, redacted.
    pub resource: String,
    pub decision: Outcome,
    /// Why, in a form a person can read.
    #[serde(default)]
    pub reason: String,
    /// The rule that decided it, when one did.
    #[serde(default)]
    pub rule: String,
}

impl PermissionRecord {
    /// A record with the required identifiers, redacted and stamped.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        at: String,
        session: impl Into<String>,
        tool: impl Into<String>,
        capability: impl Into<String>,
        resource: &crate::resource::Resource,
        decision: Outcome,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            version: SCHEMA_VERSION,
            at,
            session: session.into(),
            run: String::new(),
            call: String::new(),
            agent: String::new(),
            project: String::new(),
            tool: tool.into(),
            capability: capability.into(),
            kind: resource.kind().to_string(),
            resource: redact(&resource.match_text()),
            decision,
            reason: redact(&reason.into()),
            rule: String::new(),
        }
    }

    pub fn with_run(mut self, run: impl Into<String>) -> Self {
        self.run = run.into();
        self
    }

    pub fn with_call(mut self, call: impl Into<String>) -> Self {
        self.call = call.into();
        self
    }

    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agent = agent.into();
        self
    }

    pub fn with_project(mut self, project: impl Into<String>) -> Self {
        self.project = project.into();
        self
    }

    pub fn with_rule(mut self, rule: impl Into<String>) -> Self {
        self.rule = rule.into();
        self
    }
}

/// Current time as RFC 3339 UTC, to whole seconds.
///
/// Taken through a parameter everywhere it matters so tests can pin it; this
/// is only the default.
pub fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_rfc3339(secs)
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Hand-rolled rather than pulling `chrono` in for one line: civil-from-days,
/// the standard algorithm, valid for any date this log will ever hold.
pub fn format_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Patterns that look like a credential rather than a resource.
///
/// The log records what a call touched, and a command line is one of the
/// places a secret most often appears — `curl -H "Authorization: Bearer ..."`,
/// `PGPASSWORD=... psql`. Redaction happens before the record is built, so a
/// secret is never written and then cleaned up.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split_inclusive(char::is_whitespace) {
        let trimmed = word.trim_end();
        let tail: &str = &word[trimmed.len()..];
        out.push_str(&redact_word(trimmed));
        out.push_str(tail);
    }
    out
}

fn redact_word(word: &str) -> String {
    const REDACTED: &str = "[redacted]";
    // KEY=value where the key names a secret.
    if let Some((key, value)) = word.split_once('=') {
        if !value.is_empty() && names_a_secret(key) {
            return format!("{key}={REDACTED}");
        }
    }
    // A bare token that is long and high-entropy enough to be a key.
    if looks_like_a_token(word) {
        return REDACTED.to_string();
    }
    word.to_string()
}

fn names_a_secret(key: &str) -> bool {
    let k = key.trim_start_matches('-').to_ascii_lowercase();
    [
        "password",
        "passwd",
        "pass",
        "secret",
        "token",
        "apikey",
        "api_key",
        "api-key",
        "auth",
        "authorization",
        "credential",
        "private_key",
        "access_key",
        "session_key",
    ]
    .iter()
    .any(|needle| k.contains(needle))
}

fn looks_like_a_token(word: &str) -> bool {
    // Known prefixes first: these are unambiguous even when short.
    const PREFIXES: [&str; 7] = [
        "sk-", "sk_live_", "pk_live_", "ghp_", "gho_", "xoxb-", "AKIA",
    ];
    if PREFIXES.iter().any(|p| word.starts_with(p)) {
        return true;
    }
    // Otherwise require length *and* mixed classes, so a long file path or a
    // commit message is not mistaken for a credential.
    if word.len() < 32 {
        return false;
    }
    if word.contains('/') || word.contains('\\') || word.contains(' ') {
        return false;
    }
    // A key, JWT or base64 blob is made of token characters only. Source code
    // with no spaces in it -- `test('t',()=>assert.equal(calcTotal(...)))` --
    // is long and mixed-case too, and was redacted from the activity log.
    if !word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '=' | '~'))
    {
        return false;
    }
    let has_upper = word.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = word.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = word.chars().any(|c| c.is_ascii_digit());
    has_upper && has_lower && has_digit
}

/// Where the log lives for a given Jan data folder.
pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join(PERMISSIONS_LOG)
}

/// Append one record.
///
/// Never returns an error: this is a witness, and a failure to record must not
/// change what the gate decided. A failure is logged and dropped.
pub fn append(data_folder: &Path, record: &PermissionRecord) {
    if let Err(e) = try_append(data_folder, record) {
        // The plugin has no logging facade; stderr is what the host captures.
        eprintln!("permission audit: could not record a decision: {e}");
    }
}

fn try_append(data_folder: &Path, record: &PermissionRecord) -> Result<(), String> {
    // The lock retention takes to rewrite this log (Jozkah/jan#234), so a
    // decision recorded during a prune is not lost between read and rename.
    let _guard = crate::retention::lock();
    let path = log_path(data_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    // Flushed per record: a decision that is not on disk when the process dies
    // is a decision nobody can audit.
    file.flush().map_err(|e| e.to_string())
}

/// Every record, oldest first.
///
/// A line that no longer parses is skipped — a truncated final record from a
/// killed process, or an entry written by a newer build — so a corrupt tail
/// costs one record instead of the whole history.
pub fn read_all(data_folder: &Path) -> Vec<PermissionRecord> {
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Vec::new();
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// What to select. Every field is optional and they combine with AND, which is
/// what the permission centre needs to ask "this agent, in this run, refused".
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub session: Option<String>,
    pub run: Option<String>,
    pub agent: Option<String>,
    pub tool: Option<String>,
    pub decision: Option<Outcome>,
    /// Substring of the (already redacted) resource.
    pub resource_contains: Option<String>,
}

impl Query {
    fn accepts(&self, r: &PermissionRecord) -> bool {
        let eq = |want: &Option<String>, have: &str| want.as_ref().map_or(true, |w| w == have);
        eq(&self.session, &r.session)
            && eq(&self.run, &r.run)
            && eq(&self.agent, &r.agent)
            && eq(&self.tool, &r.tool)
            && self.decision.map_or(true, |d| d == r.decision)
            && self
                .resource_contains
                .as_ref()
                .map_or(true, |needle| r.resource.contains(needle))
    }
}

/// Records matching `query`, oldest first.
pub fn query(data_folder: &Path, query: &Query) -> Vec<PermissionRecord> {
    read_all(data_folder)
        .into_iter()
        .filter(|r| query.accepts(r))
        .collect()
}

/// Upper bound on [`recent`], whatever the caller asks for.
pub const RECENT_MAX: usize = 200;

/// The last `limit` records, newest first, for the permissions page.
///
/// Streams the log and keeps only a window of `limit` lines, so a long history
/// costs a pass over the file rather than all of it in memory. `limit` is
/// clamped to `1..=RECENT_MAX`. Resource and reason are redacted again on the
/// way out: redaction rules only ever get stricter, and a record written by an
/// older build should not show what a newer one would have removed.
pub fn recent(data_folder: &Path, limit: usize) -> Vec<PermissionRecord> {
    let limit = limit.clamp(1, RECENT_MAX);
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Vec::new();
    };
    let mut window: std::collections::VecDeque<PermissionRecord> =
        std::collections::VecDeque::with_capacity(limit);
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<PermissionRecord>(&line) else {
            continue;
        };
        if window.len() == limit {
            window.pop_front();
        }
        window.push_back(record);
    }
    window
        .into_iter()
        .rev()
        .map(|mut r| {
            r.resource = redact(&r.resource);
            r.reason = redact(&r.reason);
            r
        })
        .collect()
}

/// The matching records as a JSON array, for the audit export AH-200 needs.
pub fn export_json(data_folder: &Path, q: &Query) -> String {
    serde_json::to_string_pretty(&query(data_folder, q)).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource::Resource;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan-audit-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(session: &str, decision: Outcome) -> PermissionRecord {
        PermissionRecord::new(
            "2026-01-01T00:00:00Z".into(),
            session,
            "bash",
            "exec",
            &Resource::command("git status"),
            decision,
            "because",
        )
    }

    #[test]
    fn a_decision_survives_a_restart() {
        let dir = temp_dir("restart");
        append(&dir, &record("s1", Outcome::Allow));
        append(&dir, &record("s1", Outcome::Deny));
        // A fresh reader is exactly what a restarted process does.
        let read_back = read_all(&dir);
        assert_eq!(read_back.len(), 2);
        assert_eq!(read_back[0].decision, Outcome::Allow);
        assert_eq!(read_back[1].decision, Outcome::Deny);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_final_record_costs_only_itself() {
        let dir = temp_dir("truncated");
        append(&dir, &record("s1", Outcome::Allow));
        append(&dir, &record("s1", Outcome::Deny));
        // Simulate a process killed mid-write.
        let path = log_path(&dir);
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("{\"v\":1,\"at\":\"2026-01-01T00:00:0");
        std::fs::write(&path, body).unwrap();

        let read_back = read_all(&dir);
        assert_eq!(read_back.len(), 2, "the two complete records must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_outcome_the_lifecycle_produces_is_recordable() {
        let dir = temp_dir("outcomes");
        for outcome in [
            Outcome::Allow,
            Outcome::Deny,
            Outcome::Prompt,
            Outcome::Granted,
            Outcome::Refused,
            Outcome::Expired,
            Outcome::Revoked,
            Outcome::Stale,
            Outcome::Cancelled,
        ] {
            append(&dir, &record("s1", outcome));
        }
        let read_back = read_all(&dir);
        assert_eq!(read_back.len(), 9);
        // Round-trips through JSON without losing which one it was.
        assert!(read_back.iter().any(|r| r.decision == Outcome::Revoked));
        assert!(read_back.iter().any(|r| r.decision == Outcome::Stale));
        assert!(read_back.iter().any(|r| r.decision == Outcome::Cancelled));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- redaction (feeds AH-045) ---------------------------------------

    #[test]
    fn a_secret_never_reaches_the_log() {
        let dir = temp_dir("redact");
        let leaky = Resource::command(
            "curl -H Authorization=Bearer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://x/y",
        );
        let rec = PermissionRecord::new(
            "2026-01-01T00:00:00Z".into(),
            "s1",
            "bash",
            "exec",
            &leaky,
            Outcome::Allow,
            "",
        );
        assert!(rec.resource.contains("[redacted]"), "{}", rec.resource);
        assert!(!rec.resource.contains("Bearer_aaaa"), "{}", rec.resource);

        append(&dir, &rec);
        let on_disk = std::fs::read_to_string(log_path(&dir)).unwrap();
        assert!(!on_disk.contains("Bearer_aaaa"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn common_secret_shapes_are_caught() {
        for line in [
            "PGPASSWORD=hunter2 psql",
            "export API_KEY=abc123",
            "deploy --token=abcdefabcdef",
            "auth sk-abcdefghijklmnopqrstuvwxyz",
            "aws AKIAIOSFODNN7EXAMPLE",
        ] {
            let out = redact(line);
            assert!(out.contains("[redacted]"), "{line} -> {out}");
        }
    }

    #[test]
    fn long_code_without_spaces_is_not_a_token() {
        for line in [
            "test('t',()=>assert.equal(calcTotal([{price:2,qty:3}]),6))",
            "fmt.Println(strings.Repeat(\"X\",40)+strconv.Itoa(12345))",
        ] {
            assert_eq!(redact(line), line);
        }
        // A bare high-entropy key is still caught.
        let key = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
        assert!(redact(key).contains("[redacted]"));
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        // Over-redaction makes the log useless, which is its own failure.
        for line in [
            "git status",
            "read /home/user/project/src/main.rs",
            "git commit -m 'fix the parser'",
            "cargo test --workspace",
        ] {
            assert_eq!(redact(line), line, "{line} must not be redacted");
        }
    }

    // ---- query and export (the permission centre) ------------------------

    #[test]
    fn the_log_answers_questions_rather_than_only_replaying() {
        let dir = temp_dir("query");
        append(
            &dir,
            &record("s1", Outcome::Allow)
                .with_run("r1")
                .with_agent("main"),
        );
        append(
            &dir,
            &record("s1", Outcome::Deny).with_run("r1").with_agent("sub"),
        );
        append(
            &dir,
            &record("s2", Outcome::Deny)
                .with_run("r2")
                .with_agent("main"),
        );

        let denied_in_s1 = query(
            &dir,
            &Query {
                session: Some("s1".into()),
                decision: Some(Outcome::Deny),
                ..Default::default()
            },
        );
        assert_eq!(denied_in_s1.len(), 1);
        assert_eq!(denied_in_s1[0].agent, "sub");

        let by_agent = query(
            &dir,
            &Query {
                agent: Some("main".into()),
                ..Default::default()
            },
        );
        assert_eq!(by_agent.len(), 2);

        let exported = export_json(&dir, &Query::default());
        assert!(exported.starts_with('['));
        assert_eq!(exported.matches("\"session\"").count(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_is_newest_first_bounded_and_redacted() {
        let dir = temp_dir("recent");
        for i in 0..5 {
            append(&dir, &record(&format!("s{i}"), Outcome::Allow));
        }
        // A line written before a redaction rule existed.
        let path = log_path(&dir);
        let mut body = std::fs::read_to_string(&path).unwrap();
        let mut old = record("old", Outcome::Deny);
        old.resource = "PGPASSWORD=hunter2 psql".to_string();
        body.push_str(&serde_json::to_string(&old).unwrap());
        body.push('\n');
        std::fs::write(&path, body).unwrap();

        let got = recent(&dir, 3);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].session, "old", "newest first");
        assert_eq!(got[1].session, "s4");
        assert_eq!(got[2].session, "s3");
        assert!(!got[0].resource.contains("hunter2"), "{}", got[0].resource);

        // Clamped at both ends.
        assert_eq!(recent(&dir, 0).len(), 1);
        assert_eq!(recent(&dir, usize::MAX).len(), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_log_is_empty_rather_than_an_error() {
        let dir = temp_dir("absent");
        assert!(read_all(&dir).is_empty());
        assert_eq!(export_json(&dir, &Query::default()), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(1_767_225_600), "2026-01-01T00:00:00Z");
        // A real stamp parses to the same shape.
        let stamp = now();
        assert_eq!(stamp.len(), 20, "{stamp}");
        assert!(stamp.ends_with('Z'));
    }
}
