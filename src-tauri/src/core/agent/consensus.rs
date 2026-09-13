//! Consensus gates: a decision that needs agreement from several independent
//! agents (AH-112).
//!
//! One model deciding that its own change is safe to ship is one opinion. A
//! consensus gate asks the same question of several reviewers that do not see
//! each other's answers, and the decision is taken by a stated quorum -- all of
//! them, a majority, or at least N -- not by whoever answered last.
//!
//! ## What makes the reviewers independent
//!
//! * Each is a separate subagent with a clean brief: the question and the
//!   context given, never the other reviewers' answers.
//! * No reviewer is asked twice: a gate with the same role listed twice would
//!   count one opinion as two, and is refused.
//! * Only read-only roles may sit on a gate (explorer, planner, reviewer,
//!   security, or a saved subagent whose tools are all read-only). A reviewer
//!   that could change the thing it is judging is not a reviewer.
//!
//! ## How an answer is read
//!
//! A reviewer must open its answer with `VERDICT: approve` or `VERDICT: reject`
//! and give its reason after. Anything else -- no verdict line, both words, a
//! reviewer that failed or was cancelled -- is an abstention, recorded with what
//! it said, and an abstention is never counted as approval. A quorum that the
//! approvals do not reach is a rejection when the rejections make it
//! unreachable, and undecided otherwise; only an approval quorum approves.
//!
//! ## What is kept
//!
//! Every gate is written, atomically, to `<data>/consensus/<project>/<id>.json`
//! before its outcome is returned: the question, the quorum, each reviewer's
//! verdict and reason, and the outcome. A later run -- after a restart -- reads
//! it back by id. A gate stopped part-way is written as cancelled with whatever
//! verdicts it had, and a cancelled gate never approves.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

pub const RECORD_VERSION: u32 = 1;
pub const MIN_REVIEWERS: usize = 2;
pub const MAX_REVIEWERS: usize = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "count", rename_all = "snake_case")]
pub enum Quorum {
    /// Every reviewer approves.
    All,
    /// More than half approve.
    Majority,
    /// At least this many approve.
    AtLeast(usize),
}

impl Quorum {
    pub fn parse(raw: &str, reviewers: usize) -> Result<Quorum, HarnessError> {
        let raw = raw.trim().to_ascii_lowercase();
        let quorum = match raw.as_str() {
            "" | "all" | "unanimous" => Quorum::All,
            "majority" => Quorum::Majority,
            other => match other.parse::<usize>() {
                Ok(n) => Quorum::AtLeast(n),
                Err(_) => {
                    return Err(refuse(format!(
                        "the quorum {other:?} is not one Jan understands: all, majority, or a number of approvals"
                    )))
                }
            },
        };
        let needed = quorum.required(reviewers);
        if needed == 0 || needed > reviewers {
            return Err(refuse(format!("a quorum of {needed} approvals cannot be met by {reviewers} reviewers")));
        }
        Ok(quorum)
    }

    /// How many approvals it takes, out of `reviewers`.
    pub fn required(self, reviewers: usize) -> usize {
        match self {
            Quorum::All => reviewers,
            Quorum::Majority => reviewers / 2 + 1,
            Quorum::AtLeast(n) => n,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Vote {
    Approve,
    Reject,
    Abstain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub reviewer: String,
    pub vote: Vote,
    /// The reviewer's reason, or why its answer was not counted.
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Approved,
    Rejected,
    Undecided,
    Cancelled,
}

impl Outcome {
    pub fn tag(self) -> &'static str {
        match self {
            Outcome::Approved => "approved",
            Outcome::Rejected => "rejected",
            Outcome::Undecided => "undecided",
            Outcome::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub id: String,
    pub question: String,
    pub quorum: Quorum,
    pub reviewers: Vec<String>,
    pub verdicts: Vec<Verdict>,
    pub outcome: Outcome,
    pub session: String,
    pub run: String,
    pub decided_at: String,
}

fn refuse(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message.into())
}

/// Check a gate before any reviewer is asked.
///
/// `is_read_only` answers for a saved subagent name: whether every tool it may
/// use is read-only. Every reviewer, built-in role or not, is judged by its resolved definition.
pub fn check_request(
    question: &str,
    reviewers: &[String],
    quorum: &str,
    is_read_only: &dyn Fn(&str) -> Option<bool>,
) -> Result<Quorum, HarnessError> {
    if question.trim().is_empty() {
        return Err(refuse("a consensus gate needs a question to decide"));
    }
    if reviewers.len() < MIN_REVIEWERS {
        return Err(refuse(format!(
            "a consensus gate needs at least {MIN_REVIEWERS} reviewers; one reviewer is one opinion, not agreement"
        )));
    }
    if reviewers.len() > MAX_REVIEWERS {
        return Err(refuse(format!("a consensus gate takes at most {MAX_REVIEWERS} reviewers")));
    }
    let mut seen = BTreeSet::new();
    for reviewer in reviewers {
        if !seen.insert(reviewer.as_str()) {
            return Err(refuse(format!(
                "{reviewer:?} is listed twice; the same reviewer twice is one opinion counted twice"
            )));
        }
        // The resolved definition decides, never the name: a project or user
        // definition of `reviewer` replaces the built-in one and may be given
        // tools that write.
        let read_only = is_read_only(reviewer);
        if read_only != Some(true) {
            return Err(HarnessError::new(
                ErrorKind::PermissionDenied,
                match read_only {
                    None => format!("{reviewer:?} is not a subagent Jan knows"),
                    Some(_) => format!(
                        "{reviewer:?} can change files or run commands; only read-only reviewers may sit on a consensus gate"
                    ),
                },
            ));
        }
    }
    Quorum::parse(quorum, reviewers.len())
}

/// The brief each reviewer gets: which reviewer it is, the question, the
/// context, and the answer format. Nothing about the other reviewers' answers.
pub fn brief(reviewer: &str, question: &str, context: &str) -> String {
    let mut out = format!(
        "You are the {reviewer} on a consensus gate: one of several independent reviewers deciding a question. You will not see the other reviewers' answers, and they will not see yours.\n\n"
    );
    out.push_str("Question:\n");
    out.push_str(question.trim());
    out.push('\n');
    if !context.trim().is_empty() {
        out.push_str("\nContext:\n");
        out.push_str(context.trim());
        out.push('\n');
    }
    out.push_str(
        "\nInvestigate as you need to, then answer. The first line of your answer must be exactly `VERDICT: approve` or `VERDICT: reject`; give your reason after it. An answer without that line is not counted.",
    );
    out
}

/// Read a reviewer's answer into a verdict.
pub fn read_verdict(reviewer: &str, answer: Result<&str, &str>) -> Verdict {
    let text = match answer {
        Ok(text) => text,
        Err(why) => {
            return Verdict { reviewer: reviewer.to_string(), vote: Vote::Abstain, reason: format!("did not answer: {why}") };
        }
    };
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let lower = first.to_ascii_lowercase();
    let rest: String = text.trim().lines().skip(1).collect::<Vec<_>>().join("\n").trim().chars().take(1000).collect();
    let vote = match lower.strip_prefix("verdict:").map(str::trim) {
        Some("approve") => Vote::Approve,
        Some("reject") => Vote::Reject,
        _ => Vote::Abstain,
    };
    let reason = match vote {
        Vote::Abstain => format!("no verdict line; answered: {}", text.trim().chars().take(300).collect::<String>()),
        _ if rest.is_empty() => "(no reason given)".to_string(),
        _ => rest,
    };
    Verdict { reviewer: reviewer.to_string(), vote, reason }
}

/// The outcome of a set of verdicts under a quorum.
pub fn decide(quorum: Quorum, reviewers: usize, verdicts: &[Verdict], cancelled: bool) -> Outcome {
    let approvals = verdicts.iter().filter(|v| v.vote == Vote::Approve).count();
    let rejections = verdicts.iter().filter(|v| v.vote == Vote::Reject).count();
    let needed = quorum.required(reviewers);
    if cancelled {
        return Outcome::Cancelled;
    }
    if approvals >= needed {
        return Outcome::Approved;
    }
    // Approval is out of reach once too few reviewers are left who could still
    // approve.
    if reviewers - rejections < needed {
        return Outcome::Rejected;
    }
    Outcome::Undecided
}

/// Where a project's gates are kept.
pub fn dir_for(data_folder: &Path, project: &Path) -> PathBuf {
    let digest = hex::encode(Sha256::digest(project.to_string_lossy().as_bytes()));
    data_folder.join("consensus").join(&digest[..24])
}

pub fn new_id() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let salt = hex::encode(Sha256::digest(format!("{now}-{:?}-{}", std::thread::current().id(), std::process::id()).as_bytes()));
    format!("gate-{now}-{}", &salt[..8])
}

fn valid_id(id: &str) -> bool {
    id.starts_with("gate-") && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Write a record atomically: a gate is either fully recorded or not at all.
pub fn save(data_folder: &Path, project: &Path, record: &Record) -> Result<PathBuf, HarnessError> {
    if !valid_id(&record.id) {
        return Err(refuse(format!("{:?} is not a gate id", record.id)));
    }
    let dir = dir_for(data_folder, project);
    std::fs::create_dir_all(&dir).map_err(|e| HarnessError::new(ErrorKind::Io, format!("the consensus record folder is not usable: {e}")))?;
    let path = dir.join(format!("{}.json", record.id));
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(record).map_err(|e| HarnessError::new(ErrorKind::Internal, e.to_string()))?;
    std::fs::write(&tmp, body).map_err(|e| HarnessError::new(ErrorKind::Io, format!("the consensus record could not be written: {e}")))?;
    std::fs::rename(&tmp, &path).map_err(|e| HarnessError::new(ErrorKind::Io, format!("the consensus record could not be written: {e}")))?;
    Ok(path)
}

/// Read a gate back by id.
pub fn load(data_folder: &Path, project: &Path, id: &str) -> Result<Record, HarnessError> {
    if !valid_id(id) {
        return Err(refuse(format!("{id:?} is not a gate id")));
    }
    let path = dir_for(data_folder, project).join(format!("{id}.json"));
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| HarnessError::new(ErrorKind::NotFound, format!("no consensus gate {id:?} in this project")))?;
    let record: Record = serde_json::from_str(&raw)
        .map_err(|e| HarnessError::new(ErrorKind::MalformedState, format!("the record for {id:?} cannot be read: {e}")))?;
    if record.version != RECORD_VERSION {
        return Err(HarnessError::new(ErrorKind::MalformedState, format!("the record for {id:?} is version {}", record.version)));
    }
    Ok(record)
}

/// What the model is told.
pub fn render(record: &Record) -> String {
    let needed = record.quorum.required(record.reviewers.len());
    let mut out = format!(
        "Consensus gate {} -- {} ({} of {} approvals needed).\nQuestion: {}\n",
        record.id,
        record.outcome.tag().to_uppercase(),
        needed,
        record.reviewers.len(),
        record.question.trim()
    );
    for verdict in &record.verdicts {
        let vote = match verdict.vote {
            Vote::Approve => "approve",
            Vote::Reject => "reject",
            Vote::Abstain => "not counted",
        };
        out.push_str(&format!("- {}: {vote} -- {}\n", verdict.reviewer, verdict.reason.lines().next().unwrap_or("")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn v(reviewer: &str, vote: Vote) -> Verdict {
        Verdict { reviewer: reviewer.into(), vote, reason: "because".into() }
    }

    #[test]
    fn a_gate_that_could_not_mean_agreement_is_refused_by_kind() {
        let saved = |name: &str| match name {
            "reviewer" | "security" | "planner" | "docs-reader" => Some(true),
            "implementer" | "fixer" => Some(false),
            _ => None,
        };
        let check = |q: &str, r: &[&str], quorum: &str| check_request(q, &names(r), quorum, &saved);
        assert_eq!(check("ship?", &["reviewer", "security"], "all").unwrap(), Quorum::All);
        assert_eq!(check("ship?", &["reviewer", "security", "docs-reader"], "majority").unwrap(), Quorum::Majority);
        assert_eq!(check("ship?", &["reviewer", "security", "planner"], "2").unwrap(), Quorum::AtLeast(2));

        let kind = |q: &str, r: &[&str], quorum: &str| check(q, r, quorum).unwrap_err().kind();
        assert_eq!(kind(" ", &["reviewer", "security"], "all"), ErrorKind::InvalidInput);
        assert_eq!(kind("ship?", &["reviewer"], "all"), ErrorKind::InvalidInput, "one reviewer");
        assert_eq!(kind("ship?", &["reviewer", "reviewer"], "all"), ErrorKind::InvalidInput, "the same reviewer twice");
        assert_eq!(kind("ship?", &["reviewer", "implementer"], "all"), ErrorKind::PermissionDenied, "a writing role");
        assert_eq!(kind("ship?", &["reviewer", "fixer"], "all"), ErrorKind::PermissionDenied, "a saved subagent that can write");
        assert_eq!(kind("ship?", &["reviewer", "nobody"], "all"), ErrorKind::PermissionDenied, "an unknown subagent");
        assert_eq!(kind("ship?", &["reviewer", "security"], "3"), ErrorKind::InvalidInput, "a quorum no one can meet");
        assert_eq!(kind("ship?", &["reviewer", "security"], "0"), ErrorKind::InvalidInput);
        assert_eq!(kind("ship?", &["reviewer", "security"], "most"), ErrorKind::InvalidInput);
        // R15: a built-in role's name is not trusted -- a project definition of
        // `reviewer` that can write replaces the built-in and is refused.
        let overridden = |name: &str| match name {
            "reviewer" => Some(false),
            _ => Some(true),
        };
        assert_eq!(
            check_request("ship?", &names(&["reviewer", "security"]), "all", &overridden).unwrap_err().kind(),
            ErrorKind::PermissionDenied,
            "a project override of a built-in role that can write"
        );
        let many: Vec<String> = (0..8).map(|i| format!("r{i}")).collect();
        assert_eq!(check_request("ship?", &many, "all", &|_| Some(true)).unwrap_err().kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn only_a_verdict_line_counts_and_silence_is_never_approval() {
        assert_eq!(read_verdict("r", Ok("VERDICT: approve\nThe change is covered.")).vote, Vote::Approve);
        assert_eq!(read_verdict("r", Ok("  \nverdict: REJECT\nIt drops a check.")).vote, Vote::Reject);
        assert_eq!(read_verdict("r", Ok("VERDICT: approve")).reason, "(no reason given)");
        for unclear in ["Looks good to me.", "VERDICT: approve or reject", "I approve.\nVERDICT: approve", "", "VERDICT:"] {
            assert_eq!(read_verdict("r", Ok(unclear)).vote, Vote::Abstain, "{unclear:?}");
        }
        let failed = read_verdict("r", Err("cancelled"));
        assert_eq!(failed.vote, Vote::Abstain);
        assert!(failed.reason.contains("cancelled"));
        // The brief names the format and says nothing of the other reviewers' answers.
        let b = brief("security", "Ship the migration?", "diff attached");
        assert!(b.contains("VERDICT: approve") && b.contains("Ship the migration?") && b.contains("diff attached"));
        assert!(b.contains("You are the security on a consensus gate"));
        assert_ne!(b, brief("reviewer", "Ship the migration?", "diff attached"), "each reviewer knows which one it is");
    }

    #[test]
    fn the_quorum_decides_and_abstentions_do_not_approve() {
        use Vote::*;
        let all = |verdicts: &[Verdict]| decide(Quorum::All, 3, verdicts, false);
        assert_eq!(all(&[v("a", Approve), v("b", Approve), v("c", Approve)]), Outcome::Approved);
        assert_eq!(all(&[v("a", Approve), v("b", Approve), v("c", Abstain)]), Outcome::Undecided);
        assert_eq!(all(&[v("a", Approve), v("b", Approve), v("c", Reject)]), Outcome::Rejected);

        let majority = |verdicts: &[Verdict]| decide(Quorum::Majority, 3, verdicts, false);
        assert_eq!(majority(&[v("a", Approve), v("b", Approve), v("c", Reject)]), Outcome::Approved);
        assert_eq!(majority(&[v("a", Approve), v("b", Reject), v("c", Reject)]), Outcome::Rejected);
        assert_eq!(majority(&[v("a", Approve), v("b", Abstain), v("c", Abstain)]), Outcome::Undecided);
        assert_eq!(majority(&[v("a", Abstain), v("b", Abstain), v("c", Abstain)]), Outcome::Undecided, "abstentions are not approval");

        assert_eq!(decide(Quorum::AtLeast(2), 4, &[v("a", Approve), v("b", Approve)], false), Outcome::Approved);
        assert_eq!(decide(Quorum::AtLeast(2), 4, &[v("a", Reject), v("b", Reject), v("c", Reject)], false), Outcome::Rejected);
        // A cancelled gate never approves, whatever it had gathered.
        assert_eq!(decide(Quorum::Majority, 3, &[v("a", Approve), v("b", Approve)], true), Outcome::Cancelled);
        assert_eq!(Quorum::Majority.required(4), 3);
        assert_eq!(Quorum::Majority.required(5), 3);
    }

    #[test]
    fn a_gate_is_kept_and_read_back_after_a_restart() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let record = Record {
            version: RECORD_VERSION,
            id: new_id(),
            question: "ship?".into(),
            quorum: Quorum::Majority,
            reviewers: names(&["reviewer", "security", "planner"]),
            verdicts: vec![v("reviewer", Vote::Approve), v("security", Vote::Reject), v("planner", Vote::Approve)],
            outcome: Outcome::Approved,
            session: "s".into(),
            run: "r".into(),
            decided_at: tauri_plugin_agent_tools::audit::now(),
        };
        let path = save(data.path(), project.path(), &record).unwrap();
        assert!(path.starts_with(dir_for(data.path(), project.path())));
        assert!(!path.with_extension("json.tmp").exists(), "the temporary file was left behind");
        // "After a restart": nothing in memory, only what was written.
        assert_eq!(load(data.path(), project.path(), &record.id).unwrap(), record);
        assert!(render(&record).contains("APPROVED (2 of 3 approvals needed)"));

        let other = tempfile::tempdir().unwrap();
        assert_eq!(load(data.path(), other.path(), &record.id).unwrap_err().kind(), ErrorKind::NotFound, "another project's gate");
        assert_eq!(load(data.path(), project.path(), "../../etc/passwd").unwrap_err().kind(), ErrorKind::InvalidInput);
        std::fs::write(dir_for(data.path(), project.path()).join("gate-1-broken.json"), "{").unwrap();
        assert_eq!(load(data.path(), project.path(), "gate-1-broken").unwrap_err().kind(), ErrorKind::MalformedState);
    }
}
