//! Versioned wire format for the event stream (AHD-002, AHD-010).
//!
//! Events outlive the build that wrote them: a run recorded today is replayed,
//! audited and exported by later builds, and a downgraded install must not
//! destroy a log it only partly understands. The envelope therefore carries an
//! explicit version, and the reader is deliberately asymmetric:
//!
//! - An event whose *payload* is unknown decodes to [`EventPayload::Unknown`]
//!   with its body preserved verbatim.
//! - An envelope whose *version* is newer than this build fails loudly, because
//!   the framing itself may have changed and guessing would corrupt the log.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{ErrorKind, HarnessError};
use crate::event::{EventPayload, HarnessEvent};
use crate::identity::RunIdentity;

/// The envelope version this build writes and can read.
pub const ENVELOPE_VERSION: u16 = 1;

/// One line of an event log.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    /// Envelope version. Named `v` because it is on every line of every log.
    pub v: u16,
    /// The payload discriminant, duplicated onto the envelope so a reader can
    /// filter a large log without deserializing every body.
    pub kind: String,
    pub seq: u64,
    pub at_ms: u64,
    pub identity: RunIdentity,
    pub payload: serde_json::Value,
}

/// Encodes an event as a single JSON line, newline included.
pub fn encode(event: &HarnessEvent) -> Result<String, HarnessError> {
    let payload = match &event.payload {
        // An unknown payload round-trips as the body that was read, so a build
        // that cannot interpret an event still rewrites it faithfully.
        EventPayload::Unknown { raw, .. } => raw.clone(),
        known => serde_json::to_value(known)?,
    };
    let envelope = Envelope {
        v: ENVELOPE_VERSION,
        kind: event.kind(),
        seq: event.seq,
        at_ms: event.at_ms,
        identity: event.identity.clone(),
        payload,
    };
    Ok(format!("{}\n", serde_json::to_string(&envelope)?))
}

/// Decodes one line, tolerating an unknown payload but not an unknown framing.
pub fn decode(line: &str) -> Result<HarnessEvent, HarnessError> {
    let envelope: Envelope = serde_json::from_str(line.trim())?;
    if envelope.v > ENVELOPE_VERSION {
        return Err(HarnessError::new(
            ErrorKind::Unsupported,
            format!(
                "event envelope version {} was written by a newer build (this build reads {})",
                envelope.v, ENVELOPE_VERSION
            ),
        ));
    }

    let payload = serde_json::from_value::<EventPayload>(envelope.payload.clone())
        .unwrap_or(EventPayload::Unknown { kind: envelope.kind, raw: envelope.payload });

    Ok(HarnessEvent { seq: envelope.seq, at_ms: envelope.at_ms, identity: envelope.identity, payload })
}

/// An append-only event log on disk, one envelope per line.
///
/// JSON Lines rather than a single document so a crashed run leaves a readable
/// log: every complete line before the crash is still valid.
pub struct EventLog {
    file: File,
}

impl EventLog {
    /// Opens the log at `path`, creating it and its parent if needed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, HarnessError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self { file })
    }

    /// Appends one event and flushes it.
    ///
    /// Flushing per event costs throughput and buys the property the log exists
    /// for: an event that has been observed is on disk before the next one runs.
    pub fn append(&mut self, event: &HarnessEvent) -> Result<(), HarnessError> {
        self.file.write_all(encode(event)?.as_bytes())?;
        self.file.flush()?;
        Ok(())
    }

    /// Reads every complete event from a log.
    ///
    /// A torn final line -- a crash mid-write -- is dropped rather than failing
    /// the read, because refusing to open a log is a worse outcome than losing
    /// the event that was still being written. Any *earlier* malformed line is
    /// an error: that is corruption, not an interrupted write.
    pub fn read(path: impl AsRef<Path>) -> Result<Vec<HarnessEvent>, HarnessError> {
        let file = match File::open(path.as_ref()) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let lines: Vec<String> = BufReader::new(file)
            .lines()
            .collect::<Result<_, _>>()
            .map_err(HarnessError::from)?;

        let mut events = Vec::with_capacity(lines.len());
        let last = lines.len().saturating_sub(1);
        for (index, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match decode(line) {
                Ok(event) => events.push(event),
                Err(_) if index == last => break,
                Err(error) => {
                    return Err(HarnessError::new(
                        ErrorKind::Serialization,
                        format!("event log corrupt at line {}: {error}", index + 1),
                    ))
                }
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{ToolOutcome, Usage};
    use crate::fixtures::TempDir;
    use crate::identity::{SessionId, ThreadId};
    use serde_json::json;

    fn identity() -> RunIdentity {
        RunIdentity::root(ThreadId::new(), SessionId::new())
    }

    fn event(seq: u64, payload: EventPayload) -> HarnessEvent {
        HarnessEvent::at(seq, 1_700_000_000_000, identity(), payload)
    }

    #[test]
    fn an_event_round_trips() {
        let original = event(3, EventPayload::TurnFinished { turn: 1, usage: Usage { prompt_tokens: 10, completion_tokens: 4 } });
        let decoded = decode(&encode(&original).unwrap()).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn the_encoded_form_is_exactly_one_line() {
        let encoded = encode(&event(0, EventPayload::TurnStarted { turn: 1 })).unwrap();
        assert!(encoded.ends_with('\n'));
        assert_eq!(encoded.trim_end().lines().count(), 1);
    }

    #[test]
    fn the_envelope_carries_the_version_and_kind() {
        let encoded = encode(&event(0, EventPayload::TurnStarted { turn: 1 })).unwrap();
        let raw: serde_json::Value = serde_json::from_str(encoded.trim()).unwrap();
        assert_eq!(raw["v"], ENVELOPE_VERSION);
        assert_eq!(raw["kind"], "turn_started");
    }

    #[test]
    fn an_unknown_payload_is_preserved_rather_than_dropped() {
        let line = json!({
            "v": 1,
            "kind": "quantum_entanglement_detected",
            "seq": 4,
            "at_ms": 1,
            "identity": identity(),
            "payload": { "type": "quantum_entanglement_detected", "spooky": true },
        })
        .to_string();

        let decoded = decode(&line).unwrap();
        assert_eq!(decoded.seq, 4);
        match &decoded.payload {
            EventPayload::Unknown { kind, raw } => {
                assert_eq!(kind, "quantum_entanglement_detected");
                assert_eq!(raw["spooky"], true);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
        assert!(decoded.payload.is_audit_relevant());
    }

    #[test]
    fn an_unknown_payload_re_encodes_verbatim() {
        let body = json!({ "type": "future", "detail": [1, 2, 3] });
        let original = HarnessEvent::at(
            1,
            2,
            identity(),
            EventPayload::Unknown { kind: "future".into(), raw: body.clone() },
        );
        let re_decoded = decode(&encode(&original).unwrap()).unwrap();
        match re_decoded.payload {
            EventPayload::Unknown { raw, .. } => assert_eq!(raw, body),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn a_newer_envelope_version_is_refused_loudly() {
        let line = json!({
            "v": ENVELOPE_VERSION + 1,
            "kind": "turn_started",
            "seq": 0,
            "at_ms": 0,
            "identity": identity(),
            "payload": { "type": "turn_started", "turn": 1 },
        })
        .to_string();

        let error = decode(&line).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Unsupported);
        assert!(error.message().contains("newer build"), "{}", error.message());
    }

    #[test]
    fn malformed_json_is_a_serialization_error() {
        assert_eq!(decode("{not json").unwrap_err().kind(), ErrorKind::Serialization);
    }

    #[test]
    fn a_log_round_trips_through_disk() {
        let dir = TempDir::new("event-log");
        let path = dir.path().join("run").join("events.jsonl");

        let mut log = EventLog::open(&path).unwrap();
        let written: Vec<_> = (0..5)
            .map(|seq| event(seq, EventPayload::TurnStarted { turn: seq as u32 }))
            .collect();
        for e in &written {
            log.append(e).unwrap();
        }

        assert_eq!(EventLog::read(&path).unwrap(), written);
    }

    #[test]
    fn reading_an_absent_log_yields_nothing_rather_than_failing() {
        let dir = TempDir::new("event-log-missing");
        assert!(EventLog::read(dir.path().join("nope.jsonl")).unwrap().is_empty());
    }

    #[test]
    fn a_torn_final_line_is_dropped_not_fatal() {
        let dir = TempDir::new("event-log-torn");
        let path = dir.path().join("events.jsonl");

        let mut log = EventLog::open(&path).unwrap();
        log.append(&event(0, EventPayload::RunStarted { model: "m".into(), plan_mode: false }))
            .unwrap();
        log.append(&event(1, EventPayload::RunFinished { outcome: ToolOutcome::Ok })).unwrap();
        // Simulate a crash part-way through writing the third event.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"v\":1,\"kind\":\"turn_st")
            .unwrap();

        let recovered = EventLog::read(&path).unwrap();
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[1].kind(), "run_finished");
    }

    #[test]
    fn corruption_before_the_end_is_reported() {
        let dir = TempDir::new("event-log-corrupt");
        let path = dir.path().join("events.jsonl");
        std::fs::write(&path, "garbage\n{\"v\":1}\n").unwrap();

        let error = EventLog::read(&path).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Serialization);
        assert!(error.message().contains("line 1"), "{}", error.message());
    }

    #[test]
    fn appending_reopens_rather_than_truncates() {
        let dir = TempDir::new("event-log-append");
        let path = dir.path().join("events.jsonl");

        EventLog::open(&path).unwrap().append(&event(0, EventPayload::TurnStarted { turn: 0 })).unwrap();
        EventLog::open(&path).unwrap().append(&event(1, EventPayload::TurnStarted { turn: 1 })).unwrap();

        assert_eq!(EventLog::read(&path).unwrap().len(), 2);
    }
}
