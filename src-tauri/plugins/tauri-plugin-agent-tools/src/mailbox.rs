//! Messages between runs, while they are still running. AH-103.
//!
//! A child run can already hand its parent a final answer. What it cannot do
//! is say anything before it finishes -- "the migration you asked about is
//! already applied", "I need the schema you are holding" -- so a parent either
//! waits for a result it could have redirected, or the two agents do not
//! collaborate at all and the work is serialised for no reason.
//!
//! This is the smallest thing that fixes that: a durable per-run mailbox.
//!
//! The rules, each of which is a test:
//!
//! * **The sender is recorded, never claimed.** `from` comes from the run that
//!   is doing the sending, as the harness knows it. A model that would like to
//!   be someone else cannot be: the field is not in the message it writes.
//! * **A message stays inside its session.** A run may write to a run of the
//!   same conversation and to nothing else, so one session cannot reach into
//!   another's work -- the same boundary the event log and the snapshots
//!   already draw.
//! * **Delivery is recorded, and reading does not destroy.** A read marks what
//!   was delivered and leaves the message where it is, because "what did they
//!   tell each other" has to be answerable after the fact.
//! * **Bounded, and the bound is said.** Sixty-four messages per mailbox, 16 KB
//!   each. Past that, sending is refused rather than the oldest message being
//!   dropped: a queue that silently forgets is worse than one that says it is
//!   full, because the sender can react to a refusal.
//! * **A mailbox closes with its run.** Once a run has ended, writing to it is
//!   refused -- a message nobody will ever read is not delivered, and
//!   pretending otherwise makes a sender wait for an answer that cannot come.
//!
//! Secrets are scrubbed on the way in, and a message is data: nothing here
//! executes anything a message contains.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::identity::{RunId, SessionId};

/// The most messages one mailbox holds.
pub const MAX_MESSAGES: usize = 64;
/// The most characters one message body may be.
pub const MAX_BODY: usize = 16 * 1024;
/// The most characters a subject may be.
pub const MAX_SUBJECT: usize = 200;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MailErrorKind {
    /// The sender or the recipient is not an id that can be stored under.
    BadId,
    /// The recipient belongs to another conversation.
    CrossSession,
    /// A run tried to write to itself.
    SelfAddressed,
    /// The message is longer than a message may be.
    TooBig,
    /// The mailbox is full.
    Full,
    /// The run has ended: nobody will read this.
    Closed,
    /// The mailbox could not be read or written.
    Io,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailError {
    pub kind: MailErrorKind,
    pub message: String,
}

impl MailError {
    fn new(kind: MailErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: crate::harness_error::scrub(&message.into()) }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&MailError> for crate::harness_error::HarnessError {
    fn from(error: &MailError) -> Self {
        use crate::harness_error::{ErrorKind, HarnessError, Retry, Stage};
        let kind = match error.kind {
            MailErrorKind::BadId | MailErrorKind::TooBig => ErrorKind::InvalidInput,
            // Not "not found": the recipient may well exist, in someone
            // else's conversation, and saying so would be the leak.
            MailErrorKind::CrossSession | MailErrorKind::SelfAddressed => {
                ErrorKind::PolicyViolation
            }
            // The one failure here that a sender can do something about by
            // waiting: the reader may drain it.
            MailErrorKind::Full => ErrorKind::RateLimited,
            MailErrorKind::Closed => ErrorKind::NotFound,
            MailErrorKind::Io => ErrorKind::Io,
        };
        let harness = HarnessError::new(kind, error.message.clone()).at(Stage::Tool);
        match error.kind {
            MailErrorKind::Closed => harness.with_retry(Retry::Never),
            _ => harness,
        }
    }
}

/// One message, as it is stored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Unique within the mailbox, and the order they arrived in.
    pub seq: u64,
    /// The run that sent it, as the harness knew it -- not as the message
    /// claimed.
    pub from: String,
    pub to: String,
    pub session: String,
    pub at: String,
    pub subject: String,
    pub body: String,
    /// When it was first read, if it has been.
    #[serde(default)]
    pub delivered_at: Option<String>,
}

/// Where a run's mailbox lives.
///
/// Keyed by a hash of the run id rather than by the id itself: a run id is a
/// conversation id with a suffix, and a conversation id is not something to
/// spell out in a path on a shared machine.
pub fn path_for(data_folder: &Path, run: &RunId) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(run.as_str().as_bytes()));
    data_folder.join("mail").join(format!("{}.jsonl", &digest[..24]))
}

/// Hold the mailbox while it is read and rewritten.
///
/// Every write here is read-modify-write over the whole file, and the case
/// this feature exists for is two runs going at once: without a lock, a second
/// send between the first's read and its write silently disappears, and two
/// messages can be given the same seq. The lock is a file created
/// exclusively, so it works across processes -- a run and a `jan cli agent
/// mail` in another terminal are the same race.
struct Held {
    path: PathBuf,
}

impl Held {
    /// Wait briefly for the mailbox, then take it anyway.
    ///
    /// A stale lock (a process killed mid-write) must not wedge a mailbox
    /// forever, and the window it guards is a few milliseconds of file IO, so
    /// a bounded wait followed by taking it is the behaviour that fails least
    /// badly.
    fn take(mailbox: &Path) -> Held {
        let path = mailbox.with_extension("lock");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        for _ in 0..200 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Held { path },
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(&path);
        Held { path }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn read_all(path: &Path) -> Result<Vec<Message>, MailError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(MailError::new(MailErrorKind::Io, format!("mailbox: {e}"))),
    };
    // A line that will not parse was written by an older build or a partial
    // write; it is skipped rather than failing the read, so one bad line does
    // not cost every message.
    Ok(raw.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
}

fn write_all(path: &Path, messages: &[Message]) -> Result<(), MailError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| MailError::new(MailErrorKind::Io, format!("mailbox: {e}")))?;
    }
    let mut out = String::new();
    for message in messages {
        out.push_str(&serde_json::to_string(message).unwrap_or_default());
        out.push('\n');
    }
    std::fs::write(path, out).map_err(|e| MailError::new(MailErrorKind::Io, format!("mailbox: {e}")))
}

/// Where a closed mailbox is recorded.
fn closed_marker(data_folder: &Path, run: &RunId) -> PathBuf {
    path_for(data_folder, run).with_extension("closed")
}

/// Say that a run has ended, so nothing else is queued for it.
///
/// Called when a run ends, however it ended. The messages already there stay
/// readable: what was said is part of the record even when the run that would
/// have read it is gone.
pub fn close(data_folder: &Path, run: &RunId) -> Result<(), MailError> {
    let marker = closed_marker(data_folder, run);
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| MailError::new(MailErrorKind::Io, format!("mailbox: {e}")))?;
    }
    std::fs::write(&marker, crate::audit::now())
        .map_err(|e| MailError::new(MailErrorKind::Io, format!("mailbox: {e}")))
}

pub fn is_closed(data_folder: &Path, run: &RunId) -> bool {
    closed_marker(data_folder, run).is_file()
}

/// Send one message from one run to another in the same session.
///
/// `from` is the run doing the sending, supplied by the harness. Every caller
/// that has a model in it must pass the run it is actually executing, never a
/// value the model produced -- that is the whole of the sender's identity.
pub fn send(
    data_folder: &Path,
    session: &SessionId,
    from: &RunId,
    to: &RunId,
    subject: &str,
    body: &str,
) -> Result<Message, MailError> {
    if from == to {
        return Err(MailError::new(
            MailErrorKind::SelfAddressed,
            "a run cannot post to its own mailbox",
        ));
    }
    // Both ends must be this conversation's. A run that names another
    // session's run is refused without being told whether it exists.
    for (which, run) in [("the sender", from), ("the recipient", to)] {
        if !run.belongs_to(session) {
            return Err(MailError::new(
                MailErrorKind::CrossSession,
                format!("{which} is not a run of this conversation"),
            ));
        }
    }
    if body.chars().count() > MAX_BODY {
        return Err(MailError::new(
            MailErrorKind::TooBig,
            format!("a message may be {MAX_BODY} characters; this one is longer"),
        ));
    }
    if is_closed(data_folder, to) {
        return Err(MailError::new(
            MailErrorKind::Closed,
            "that run has ended, so nothing else will be read from its mailbox",
        ));
    }

    let path = path_for(data_folder, to);
    let _held = Held::take(&path);
    let mut messages = read_all(&path)?;
    if messages.len() >= MAX_MESSAGES {
        // Deliberately a refusal rather than dropping the oldest: a queue that
        // silently forgets leaves the sender believing something was said.
        return Err(MailError::new(
            MailErrorKind::Full,
            format!("that mailbox is holding {MAX_MESSAGES} unread messages"),
        ));
    }
    let subject: String = subject.chars().take(MAX_SUBJECT).collect();
    let message = Message {
        seq: messages.last().map(|m| m.seq + 1).unwrap_or(1),
        from: from.to_string(),
        to: to.to_string(),
        session: session.to_string(),
        at: crate::audit::now(),
        subject: crate::harness_error::scrub(&subject),
        body: crate::harness_error::scrub(body),
        delivered_at: None,
    };
    messages.push(message.clone());
    write_all(&path, &messages)?;
    Ok(message)
}

/// Read a run's mailbox.
///
/// `mark` records delivery; the messages stay where they are either way, so
/// what two agents told each other is answerable after the fact.
pub fn read(data_folder: &Path, run: &RunId, mark: bool) -> Result<Vec<Message>, MailError> {
    let path = path_for(data_folder, run);
    // Held across the read *and* the marking, so a message that arrives
    // between the two is not stamped delivered without ever being shown.
    let _held = mark.then(|| Held::take(&path));
    let mut messages = read_all(&path)?;
    if mark && messages.iter().any(|m| m.delivered_at.is_none()) {
        let now = crate::audit::now();
        for message in messages.iter_mut().filter(|m| m.delivered_at.is_none()) {
            message.delivered_at = Some(now.clone());
        }
        write_all(&path, &messages)?;
    }
    Ok(messages)
}

/// The messages a run has not been shown yet.
pub fn unread(data_folder: &Path, run: &RunId) -> Result<Vec<Message>, MailError> {
    Ok(read(data_folder, run, false)?
        .into_iter()
        .filter(|m| m.delivered_at.is_none())
        .collect())
}

/// Take everything this run has not seen, in one step.
///
/// The two-call version -- ask what is unread, then mark everything unread as
/// delivered -- loses a message that arrives between the two: it is stamped
/// delivered and never shown to anybody. This reads and marks under one lock
/// and returns exactly what it marked.
pub fn collect(data_folder: &Path, run: &RunId) -> Result<Vec<Message>, MailError> {
    let path = path_for(data_folder, run);
    let _held = Held::take(&path);
    let mut messages = read_all(&path)?;
    let now = crate::audit::now();
    let mut fresh = Vec::new();
    for message in messages.iter_mut().filter(|m| m.delivered_at.is_none()) {
        message.delivered_at = Some(now.clone());
        fresh.push(message.clone());
    }
    if !fresh.is_empty() {
        write_all(&path, &messages)?;
    }
    Ok(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-mailbox-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ids(session: &str) -> (SessionId, RunId, RunId) {
        let s = SessionId::parse(session).unwrap();
        let parent = RunId::parse(format!("{session}#run-parent")).unwrap();
        let child = RunId::parse(format!("{session}#run-child")).unwrap();
        (s, parent, child)
    }

    #[test]
    fn a_message_reaches_the_run_it_was_addressed_to_and_says_who_sent_it() {
        let d = data("send");
        let (session, parent, child) = ids("s-mail");
        let sent = send(&d, &session, &child, &parent, "schema", "the migration is applied").unwrap();
        assert_eq!(sent.from, child.as_str());
        assert_eq!(sent.seq, 1);

        let inbox = read(&d, &parent, false).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].body, "the migration is applied");
        // And the sender's own mailbox is untouched: a message goes one way.
        assert!(read(&d, &child, false).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Reading marks delivery and keeps the message: what two agents told each
    /// other has to be answerable afterwards.
    #[test]
    fn reading_records_delivery_and_destroys_nothing() {
        let d = data("read");
        let (session, parent, child) = ids("s-read");
        send(&d, &session, &child, &parent, "one", "first").unwrap();
        send(&d, &session, &child, &parent, "two", "second").unwrap();

        assert_eq!(unread(&d, &parent).unwrap().len(), 2);
        let delivered = read(&d, &parent, true).unwrap();
        assert!(delivered.iter().all(|m| m.delivered_at.is_some()));
        assert!(unread(&d, &parent).unwrap().is_empty(), "nothing is unread twice");
        // Still there, in order, after the read.
        let again = read(&d, &parent, false).unwrap();
        assert_eq!(again.len(), 2);
        assert_eq!(again.iter().map(|m| m.seq).collect::<Vec<_>>(), [1, 2]);

        // A message that arrives after the read is unread again.
        send(&d, &session, &child, &parent, "three", "third").unwrap();
        assert_eq!(unread(&d, &parent).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The boundary: one conversation cannot post into another's runs.
    #[test]
    fn a_message_cannot_leave_its_conversation() {
        let d = data("cross");
        let (session, _, child) = ids("s-mine");
        let (_, elsewhere, _) = ids("s-theirs");
        let refused = send(&d, &session, &child, &elsewhere, "hello", "are you there")
            .expect_err("another conversation's run is not addressable");
        assert_eq!(refused.kind, MailErrorKind::CrossSession);
        // Nothing was written where it was aimed.
        assert!(read(&d, &elsewhere, false).unwrap().is_empty());

        // And a sender claiming to be from another session is refused too.
        let (_, foreign_sender, _) = ids("s-elsewhere");
        let (_, mine, _) = ids("s-mine");
        assert_eq!(
            send(&d, &session, &foreign_sender, &mine, "x", "y").unwrap_err().kind,
            MailErrorKind::CrossSession
        );

        // AH-009: a refusal, not a lookup failure -- the recipient may exist,
        // in a conversation this one is not entitled to know about.
        let harness: crate::harness_error::HarnessError = (&refused).into();
        assert_eq!(harness.kind(), crate::harness_error::ErrorKind::PolicyViolation);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_cannot_post_to_itself() {
        let d = data("self");
        let (session, parent, _) = ids("s-self");
        let refused = send(&d, &session, &parent, &parent, "note", "to me").unwrap_err();
        assert_eq!(refused.kind, MailErrorKind::SelfAddressed);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A full mailbox refuses rather than forgetting the oldest message.
    #[test]
    fn a_full_mailbox_says_so_instead_of_dropping_what_it_holds() {
        let d = data("full");
        let (session, parent, child) = ids("s-full");
        for n in 0..MAX_MESSAGES {
            send(&d, &session, &child, &parent, "n", &format!("message {n}")).unwrap();
        }
        let refused = send(&d, &session, &child, &parent, "one more", "and another").unwrap_err();
        assert_eq!(refused.kind, MailErrorKind::Full);
        // The first message is still the first message.
        let inbox = read(&d, &parent, false).unwrap();
        assert_eq!(inbox.len(), MAX_MESSAGES);
        assert_eq!(inbox[0].body, "message 0");

        // A sender can do something about this one: wait.
        let harness: crate::harness_error::HarnessError = (&refused).into();
        assert_eq!(harness.kind(), crate::harness_error::ErrorKind::RateLimited);
        assert_ne!(harness.retry(), crate::harness_error::Retry::Never);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_message_longer_than_a_message_may_be_is_refused_whole() {
        let d = data("big");
        let (session, parent, child) = ids("s-big");
        let refused = send(&d, &session, &child, &parent, "x", &"y".repeat(MAX_BODY + 1))
            .unwrap_err();
        assert_eq!(refused.kind, MailErrorKind::TooBig);
        assert!(read(&d, &parent, false).unwrap().is_empty(), "nothing half-written");
        // At the bound it is accepted.
        assert!(send(&d, &session, &child, &parent, "x", &"y".repeat(MAX_BODY)).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Once a run is over, a message to it is refused rather than queued for
    /// nobody -- otherwise a sender waits for an answer that cannot come.
    #[test]
    fn a_mailbox_closes_with_its_run_and_what_it_held_stays_readable() {
        let d = data("closed");
        let (session, parent, child) = ids("s-closed");
        send(&d, &session, &child, &parent, "before", "said in time").unwrap();
        close(&d, &parent).unwrap();

        let refused = send(&d, &session, &child, &parent, "after", "too late").unwrap_err();
        assert_eq!(refused.kind, MailErrorKind::Closed);
        let harness: crate::harness_error::HarnessError = (&refused).into();
        assert_eq!(harness.retry(), crate::harness_error::Retry::Never, "the run is not coming back");

        // What was said before it ended is still part of the record.
        let inbox = read(&d, &parent, false).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].body, "said in time");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// What a reader is given is exactly what it marked: a message that lands
    /// mid-read is either shown or still unread, never stamped and skipped.
    #[test]
    fn taking_what_is_unread_and_marking_it_is_one_step() {
        let d = data("collect");
        let (session, parent, child) = ids("s-collect");
        send(&d, &session, &child, &parent, "one", "first").unwrap();
        let taken = collect(&d, &parent).unwrap();
        assert_eq!(taken.len(), 1);
        assert!(taken[0].delivered_at.is_some(), "what is handed back says it was delivered");
        assert!(collect(&d, &parent).unwrap().is_empty(), "nothing is taken twice");

        // Two senders at once: both messages survive, with different seqs.
        let (_, other, _) = ids("s-collect");
        let sender_a = RunId::parse("s-collect#run-a").unwrap();
        let sender_b = RunId::parse("s-collect#run-b").unwrap();
        let _ = other;
        std::thread::scope(|scope| {
            for sender in [&sender_a, &sender_b] {
                let d = d.clone();
                let session = session.clone();
                let parent = parent.clone();
                scope.spawn(move || {
                    for n in 0..10 {
                        send(&d, &session, sender, &parent, "n", &format!("{sender} {n}")).unwrap();
                    }
                });
            }
        });
        let all = read(&d, &parent, false).unwrap();
        let fresh: Vec<_> = all.iter().filter(|m| m.delivered_at.is_none()).collect();
        assert_eq!(fresh.len(), 20, "a concurrent send was lost: {}", fresh.len());
        let seqs: std::collections::BTreeSet<u64> = all.iter().map(|m| m.seq).collect();
        assert_eq!(seqs.len(), all.len(), "two messages share a seq");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_mailbox_survives_the_process_that_wrote_it() {
        let d = data("restart");
        let (session, parent, child) = ids("s-restart");
        send(&d, &session, &child, &parent, "note", "still here").unwrap();
        // Nothing is cached in this module; reading again is reading the disk.
        let after = read(&d, &parent, false).unwrap();
        assert_eq!(after.len(), 1);
        assert!(path_for(&d, &parent).is_file());
        // The path names no conversation.
        let name = path_for(&d, &parent).file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains("s-restart"), "the mailbox path spells out a conversation: {name}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_credential_in_a_message_is_scrubbed_before_it_is_stored() {
        let d = data("scrub");
        let (session, parent, child) = ids("s-scrub");
        send(
            &d,
            &session,
            &child,
            &parent,
            "Authorization: Bearer sk-not-a-real-key-1234567890",
            "the header was Authorization: Bearer sk-not-a-real-key-1234567890",
        )
        .unwrap();
        let inbox = read(&d, &parent, false).unwrap();
        assert!(!inbox[0].body.contains("sk-not-a-real-key-1234567890"), "{}", inbox[0].body);
        assert!(!inbox[0].subject.contains("sk-not-a-real-key-1234567890"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_id_that_could_name_a_place_on_disk_is_never_a_mailbox() {
        for hostile in ["../elsewhere", "a/b", "a\\b", "..", ""] {
            assert!(
                RunId::parse(hostile).is_err(),
                "{hostile:?} must not parse as a run id"
            );
        }
    }
}
