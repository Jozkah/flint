use super::store::*;
use serde_json::{json, Value};
use std::fs;
use std::sync::Arc;

fn participant(id: &str) -> Value {
    json!({
        "id": id,
        "name": format!("Name {id}"),
        "role": "skeptic",
        "model": { "provider": "openai", "id": "gpt-x" },
        "toolAccess": "none",
        "removed": false,
        "order": 0,
        "availability": { "state": "unknown" }
    })
}

fn room_json(id: &str) -> Value {
    json!({
        "v": 1,
        "id": id,
        "title": format!("Room {id}"),
        "objective": "Decide something",
        "status": "draft",
        "mode": "round-robin",
        "moderator": { "enabled": false, "name": "Moderator", "model": null },
        "participants": [participant("p1"), participant("p2")],
        "limits": {
            "maxRounds": 6,
            "maxTurns": 40,
            "maxConsecutivePerParticipant": 1,
            "maxTotalTokens": 200000,
            "maxOutputTokensPerTurn": 1024,
            "maxCostUsd": null,
            "maxDurationMs": 1800000,
            "maxRepetitiveTurns": 2,
            "repetitionSimilarity": 0.9
        },
        "usage": {
            "turns": 0,
            "rounds": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "estimated": false,
            "costUsd": null,
            "activeMs": 0,
            "consecutiveRepetitive": 0
        },
        "round": 0,
        "spokenThisRound": [],
        "nextSpeakerId": null,
        "stopReason": null,
        "rev": 0,
        "createdAt": 1000,
        "updatedAt": 1000
    })
}

fn room(id: &str) -> Room {
    parse_room(room_json(id)).expect("fixture room parses")
}

fn message_json(room_id: &str, id: &str, text: &str) -> Value {
    json!({
        "type": "message",
        "message": {
            "v": 1,
            "id": id,
            "roomId": room_id,
            "seq": 0,
            "turnId": "t1",
            "author": { "kind": "participant", "participantId": "p1", "name": "Name p1" },
            "to": { "kind": "room" },
            "kind": "speech",
            "text": text,
            "round": 1,
            "createdAt": 2000,
            "status": "complete"
        }
    })
}

fn message(room_id: &str, id: &str, text: &str) -> RoomJournalRecord {
    parse_record(message_json(room_id, id, text)).expect("fixture message parses")
}

fn turn_start(turn_id: &str) -> RoomJournalRecord {
    parse_record(json!({
        "type": "turn-start",
        "turnId": turn_id,
        "speaker": { "kind": "moderator", "name": "Mod" },
        "round": 1,
        "at": 1500
    }))
    .expect("fixture turn-start parses")
}

fn seq_of(record: &RoomJournalRecord) -> u64 {
    match record {
        RoomJournalRecord::Message { message } => message.seq,
        other => panic!("expected a message record, got {other:?}"),
    }
}

fn new_store() -> (tempfile::TempDir, RoomStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = RoomStore::for_data_folder(dir.path());
    (dir, store)
}

#[test]
fn save_get_round_trip() {
    let (_dir, store) = new_store();
    let saved = store.save(room("r1"), 5000).unwrap();
    assert_eq!(saved.rev, 1);
    assert_eq!(saved.updated_at, 5000);
    assert_eq!(saved.created_at, 1000);

    let loaded = store.get("r1").unwrap();
    assert_eq!(loaded.room, saved);
    assert!(loaded.journal.is_empty());

    // Stored JSON keeps the camelCase contract.
    let raw: Value =
        serde_json::from_slice(&fs::read(store.root().join("r1").join(ROOM_FILE)).unwrap())
            .unwrap();
    assert_eq!(raw["spokenThisRound"], json!([]));
    assert_eq!(raw["participants"][0]["toolAccess"], json!("none"));
    assert_eq!(raw["rev"], json!(1));

    // Serialised round trip matches the input apart from rev/updatedAt.
    let mut expected = room_json("r1");
    expected["rev"] = json!(1);
    expected["updatedAt"] = json!(5000);
    assert_eq!(serde_json::to_value(&loaded.room).unwrap(), expected);

    // RoomWithJournal serialises with camelCase keys.
    let wire = serde_json::to_value(&loaded).unwrap();
    assert!(wire.get("room").is_some() && wire.get("journal").is_some());
}

#[test]
fn stale_revision_is_refused() {
    let (_dir, store) = new_store();
    let first = store.save(room("r1"), 10).unwrap();
    assert_eq!(first.rev, 1);

    let stale = store.save(room("r1"), 20).unwrap_err();
    assert_eq!(stale.code, RoomErrorCode::StaleRevision);

    let second = store.save(first.clone(), 30).unwrap();
    assert_eq!(second.rev, 2);
    assert_eq!(
        store.save(first, 40).unwrap_err().code,
        RoomErrorCode::StaleRevision
    );

    // A room that does not exist must be saved at rev 0.
    let mut ghost = room("ghost");
    ghost.rev = 3;
    assert_eq!(
        store.save(ghost, 50).unwrap_err().code,
        RoomErrorCode::StaleRevision
    );
    assert!(!store.root().join("ghost").exists());
}

#[test]
fn id_rule_refuses_bad_ids_including_traversal() {
    for bad in [
        "",
        ".",
        "..",
        "../evil",
        "a/b",
        "a\\b",
        "C:evil",
        "sp ace",
        "ünï",
        &"x".repeat(129),
        "a.",
        "...",
        "CON",
        "nul",
        "aux.txt",
        "com1",
        "LPT9.log",
    ] {
        assert_eq!(
            validate_id(bad).unwrap_err().code,
            RoomErrorCode::InvalidId,
            "id {bad:?} should be refused"
        );
    }
    for good in ["a", "room-1", "A.b_c-9", ".a", "console", "com0", "com10", &"x".repeat(128)] {
        assert!(validate_id(good).is_ok(), "id {good:?} should be accepted");
    }

    let (dir, store) = new_store();
    assert_eq!(
        store.get("../evil").unwrap_err().code,
        RoomErrorCode::InvalidId
    );
    assert_eq!(
        store.delete("..").unwrap_err().code,
        RoomErrorCode::InvalidId
    );
    assert_eq!(
        store.append("../x", turn_start("t1")).unwrap_err().code,
        RoomErrorCode::InvalidId
    );
    let mut traversal = room("ok");
    traversal.id = "../escaped".into();
    assert_eq!(
        store.save(traversal, 1).unwrap_err().code,
        RoomErrorCode::InvalidId
    );
    assert!(!dir.path().join("escaped").exists());

    // Ids inside the room and records follow the rule too.
    let mut bad_participant = room_json("ok");
    bad_participant["participants"][0]["id"] = json!("../p");
    let err = store
        .save(parse_room(bad_participant).unwrap(), 1)
        .unwrap_err();
    assert_eq!(err.code, RoomErrorCode::InvalidRoom);

    store.save(room("ok"), 1).unwrap();
    let err = store
        .append("ok", message("ok", "bad/id", "hi"))
        .unwrap_err();
    assert_eq!(err.code, RoomErrorCode::InvalidRoom);
}

#[test]
fn structure_and_size_limits() {
    let (_dir, store) = new_store();

    // Schema version.
    let mut v2 = room("r1");
    v2.v = 2;
    assert_eq!(
        store.save(v2, 1).unwrap_err().code,
        RoomErrorCode::InvalidRoom
    );

    // Enum values.
    let mut bad_status = room_json("r1");
    bad_status["status"] = json!("bogus");
    assert_eq!(
        parse_room(bad_status).unwrap_err().code,
        RoomErrorCode::InvalidRoom
    );
    let mut bad_limit = room_json("r1");
    bad_limit["stopReason"] = json!({ "kind": "limit", "limit": "maxNonsense" });
    assert_eq!(
        store
            .save(parse_room(bad_limit).unwrap(), 1)
            .unwrap_err()
            .code,
        RoomErrorCode::InvalidRoom
    );
    let mut good_limit = room_json("r1");
    good_limit["stopReason"] = json!({ "kind": "limit", "limit": "ceiling" });
    store.save(parse_room(good_limit).unwrap(), 1).unwrap();

    // Participant count.
    let mut crowded = room_json("r2");
    crowded["participants"] = Value::Array((0..9).map(|i| participant(&format!("p{i}"))).collect());
    assert_eq!(
        store
            .save(parse_room(crowded).unwrap(), 1)
            .unwrap_err()
            .code,
        RoomErrorCode::InvalidRoom
    );
    let mut eight = room_json("r2");
    eight["participants"] = Value::Array((0..8).map(|i| participant(&format!("p{i}"))).collect());
    store.save(parse_room(eight).unwrap(), 1).unwrap();

    // room.json size.
    let mut huge = room("r3");
    huge.objective = "x".repeat(MAX_ROOM_BYTES + 1);
    assert_eq!(
        store.save(huge, 1).unwrap_err().code,
        RoomErrorCode::TooLarge
    );
    assert!(!store.root().join("r3").exists());

    // Message text length, counted in UTF-16 units like JS `length`.
    assert_eq!(
        store
            .append("r1", message("r1", "m1", &"a".repeat(MAX_TEXT_LENGTH + 1)))
            .unwrap_err()
            .code,
        RoomErrorCode::TooLarge
    );
    store
        .append("r1", message("r1", "m2", &"é".repeat(MAX_TEXT_LENGTH)))
        .unwrap();
    assert_eq!(
        store
            .append(
                "r1",
                message("r1", "m3", &"😀".repeat(MAX_TEXT_LENGTH / 2 + 1))
            )
            .unwrap_err()
            .code,
        RoomErrorCode::TooLarge
    );

    // Journal line size, with text under the text limit.
    let mut long_error = message_json("r1", "m4", "short");
    long_error["message"]["error"] =
        json!({ "code": "x", "message": "e".repeat(MAX_JOURNAL_LINE_BYTES) });
    assert_eq!(
        store
            .append("r1", parse_record(long_error).unwrap())
            .unwrap_err()
            .code,
        RoomErrorCode::TooLarge
    );

    // Message roomId must match.
    assert_eq!(
        store
            .append("r1", message("other", "m5", "hi"))
            .unwrap_err()
            .code,
        RoomErrorCode::InvalidRoom
    );
    assert_eq!(store.get("r1").unwrap().journal.len(), 1);
}

#[test]
fn append_accepts_large_utf8_lines_up_to_the_limit() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();

    // A synthesis-sized record: full-length non-ASCII text plus a large second
    // field, about 200 KB of UTF-8 in total.
    let mut big = message_json("r1", "m1", &"中".repeat(MAX_TEXT_LENGTH));
    big["message"]["error"] = json!({ "code": "x", "message": "é".repeat(70_000) });
    let line = serde_json::to_vec(&big).unwrap();
    assert!(line.len() > 195 * 1024 && line.len() < MAX_JOURNAL_LINE_BYTES);
    store.append("r1", parse_record(big).unwrap()).unwrap();

    // One byte over the limit is refused.
    let mut over = message_json("r1", "m2", "short");
    let base = serde_json::to_vec(&over).unwrap().len();
    let filler = MAX_JOURNAL_LINE_BYTES + 1 - base - r#","error":{"code":"x","message":""}"#.len();
    over["message"]["error"] = json!({ "code": "x", "message": "e".repeat(filler) });
    let record = parse_record(over).unwrap();
    assert_eq!(
        serde_json::to_vec(&record).unwrap().len(),
        MAX_JOURNAL_LINE_BYTES + 1
    );
    assert_eq!(
        store.append("r1", record).unwrap_err().code,
        RoomErrorCode::TooLarge
    );
    assert_eq!(store.get("r1").unwrap().journal.len(), 1);
}

#[test]
fn append_is_idempotent_by_message_id() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    let first = store.append("r1", message("r1", "m1", "original")).unwrap();
    let again = store.append("r1", message("r1", "m1", "changed")).unwrap();
    assert_eq!(first, again);
    match &again {
        RoomJournalRecord::Message { message } => assert_eq!(message.text, "original"),
        _ => unreachable!(),
    }
    // Turn-starts are idempotent by turn id.
    store.append("r1", turn_start("t9")).unwrap();
    store.append("r1", turn_start("t9")).unwrap();
    assert_eq!(store.get("r1").unwrap().journal.len(), 2);
}

#[test]
fn append_to_missing_room_is_not_found() {
    let (_dir, store) = new_store();
    assert_eq!(
        store.append("nope", turn_start("t1")).unwrap_err().code,
        RoomErrorCode::NotFound
    );
    assert_eq!(store.get("nope").unwrap_err().code, RoomErrorCode::NotFound);
}

#[test]
fn seq_is_monotonic_and_turn_start_has_none() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    let ts = store.append("r1", turn_start("t1")).unwrap();
    let wire = serde_json::to_value(&ts).unwrap();
    assert!(wire.get("seq").is_none());
    assert_eq!(wire["type"], json!("turn-start"));
    assert_eq!(wire["turnId"], json!("t1"));

    assert_eq!(
        seq_of(&store.append("r1", message("r1", "m1", "a")).unwrap()),
        1
    );
    store.append("r1", turn_start("t2")).unwrap();
    let mut forged = message_json("r1", "m2", "b");
    forged["message"]["seq"] = json!(99);
    assert_eq!(
        seq_of(&store.append("r1", parse_record(forged).unwrap()).unwrap()),
        2
    );
    assert_eq!(
        seq_of(&store.append("r1", message("r1", "m3", "c")).unwrap()),
        3
    );

    let journal = store.get("r1").unwrap().journal;
    let seqs: Vec<u64> = journal
        .iter()
        .filter_map(|r| match r {
            RoomJournalRecord::Message { message } => Some(message.seq),
            _ => None,
        })
        .collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    assert_eq!(journal.len(), 5);
}

#[test]
fn torn_trailing_line_is_dropped_and_next_append_starts_fresh() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    store.append("r1", message("r1", "m1", "one")).unwrap();

    let journal_path = store.root().join("r1").join(JOURNAL_FILE);
    let mut bytes = fs::read(&journal_path).unwrap();
    bytes.extend_from_slice(br#"{"type":"message","message":{"v":1,"id":"m-torn","te"#);
    fs::write(&journal_path, &bytes).unwrap();

    assert_eq!(store.get("r1").unwrap().journal.len(), 1);

    let appended = store.append("r1", message("r1", "m2", "two")).unwrap();
    assert_eq!(seq_of(&appended), 2);

    let raw = fs::read_to_string(&journal_path).unwrap();
    assert!(raw.ends_with('\n'));
    assert!(!raw.contains("m-torn"));
    let lines: Vec<&str> = raw.lines().collect();
    assert_eq!(lines.len(), 2);
    for line in lines {
        serde_json::from_str::<RoomJournalRecord>(line).expect("every stored line parses");
    }
    assert_eq!(store.get("r1").unwrap().journal.len(), 2);
}

#[test]
fn complete_trailing_line_without_newline_is_kept() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    store.append("r1", message("r1", "m1", "one")).unwrap();

    let journal_path = store.root().join("r1").join(JOURNAL_FILE);
    let raw = fs::read_to_string(&journal_path).unwrap();
    fs::write(&journal_path, raw.trim_end_matches('\n')).unwrap();

    assert_eq!(
        seq_of(&store.append("r1", message("r1", "m2", "two")).unwrap()),
        2
    );
    let raw = fs::read_to_string(&journal_path).unwrap();
    assert_eq!(raw.lines().count(), 2);
    assert_eq!(store.get("r1").unwrap().journal.len(), 2);
}

#[test]
fn concurrent_appends_get_unique_contiguous_seq() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    let store = Arc::new(store);
    const THREADS: usize = 8;
    const PER_THREAD: usize = 25;

    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                (0..PER_THREAD)
                    .map(|i| {
                        let record = message("r1", &format!("m-{t}-{i}"), "concurrent");
                        seq_of(&store.append("r1", record).unwrap())
                    })
                    .collect::<Vec<u64>>()
            })
        })
        .collect();

    let mut seqs: Vec<u64> = handles
        .into_iter()
        .flat_map(|h| h.join().expect("append thread"))
        .collect();
    seqs.sort_unstable();
    let expected: Vec<u64> = (1..=(THREADS * PER_THREAD) as u64).collect();
    assert_eq!(seqs, expected);
    assert_eq!(store.get("r1").unwrap().journal.len(), THREADS * PER_THREAD);
}

#[test]
fn list_orders_newest_first_and_skips_unreadable_rooms() {
    let (_dir, store) = new_store();
    assert!(
        store.list().unwrap().is_empty(),
        "missing rooms dir lists empty"
    );

    store.save(room("a"), 100).unwrap();
    store.save(room("b"), 300).unwrap();
    let mut c = room("c");
    c.participants[1].removed = true;
    c.usage.turns = 7;
    store.save(c, 200).unwrap();

    let corrupt = store.root().join("corrupt");
    fs::create_dir_all(&corrupt).unwrap();
    fs::write(corrupt.join(ROOM_FILE), "{ not json").unwrap();
    fs::create_dir_all(store.root().join("empty")).unwrap();
    let mismatched = store.root().join("mismatch");
    fs::create_dir_all(&mismatched).unwrap();
    fs::write(
        mismatched.join(ROOM_FILE),
        serde_json::to_vec(&room("someone-else")).unwrap(),
    )
    .unwrap();
    fs::write(store.root().join("stray.txt"), "x").unwrap();

    let list = store.list().unwrap();
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "c", "a"]);
    let c = &list[1];
    assert_eq!(c.participant_count, 1);
    assert_eq!(c.turns, 7);
    assert_eq!(c.updated_at, 200);

    let wire = serde_json::to_value(c).unwrap();
    assert_eq!(wire["participantCount"], json!(1));
    assert_eq!(wire["updatedAt"], json!(200));
    assert_eq!(wire["mode"], json!("round-robin"));

    assert_eq!(
        store.get("corrupt").unwrap_err().code,
        RoomErrorCode::InvalidRoom
    );
}

#[test]
fn delete_removes_the_room_directory() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    store.append("r1", message("r1", "m1", "hi")).unwrap();

    store.delete("r1").unwrap();
    assert!(!store.root().join("r1").exists());
    assert_eq!(store.get("r1").unwrap_err().code, RoomErrorCode::NotFound);
    assert_eq!(
        store.delete("r1").unwrap_err().code,
        RoomErrorCode::NotFound
    );
    assert!(store.list().unwrap().is_empty());

    // A re-created room starts again at rev 0.
    assert_eq!(store.save(room("r1"), 2).unwrap().rev, 1);
}

#[test]
fn errors_serialize_as_code_and_message() {
    let err = RoomError::new(RoomErrorCode::StaleRevision, "rev moved");
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        json!({ "code": "stale_revision", "message": "rev moved" })
    );
    for (code, wire) in [
        (RoomErrorCode::NotFound, "not_found"),
        (RoomErrorCode::InvalidId, "invalid_id"),
        (RoomErrorCode::InvalidRoom, "invalid_room"),
        (RoomErrorCode::TooLarge, "too_large"),
        (RoomErrorCode::Io, "io"),
        (RoomErrorCode::Unknown, "unknown"),
    ] {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(wire));
    }
    assert_eq!(err.to_string(), "stale_revision: rev moved");
}

#[test]
fn full_message_fields_round_trip() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    let record = json!({
        "type": "message",
        "message": {
            "v": 1,
            "id": "syn-1",
            "roomId": "r1",
            "seq": 0,
            "turnId": null,
            "author": { "kind": "moderator", "name": "Mod" },
            "to": { "kind": "participant", "participantId": "p2" },
            "kind": "synthesis",
            "text": "summary",
            "round": 3,
            "createdAt": 9,
            "status": "failed",
            "error": { "code": "rate_limited", "message": "slow down" },
            "usage": { "inputTokens": 10, "outputTokens": 20, "estimated": true },
            "vote": { "callId": "c1", "choice": "abstain", "proposal": "p" },
            "dissent": [{ "participantId": "p1", "name": "Name p1", "position": "no" }],
            "directive": {
                "next": "p2", "request": null, "disagreements": ["x"],
                "converged": false, "stop": true, "reason": "done"
            }
        }
    });
    let stored = store
        .append("r1", parse_record(record.clone()).unwrap())
        .unwrap();
    let mut expected = record;
    expected["message"]["seq"] = json!(1);
    assert_eq!(serde_json::to_value(&stored).unwrap(), expected);
    assert_eq!(
        serde_json::to_value(&store.get("r1").unwrap().journal[0]).unwrap(),
        expected
    );
}

#[test]
fn participant_reasoning_round_trips_and_is_optional() {
    let (_dir, store) = new_store();
    let mut json = room_json("r1");
    json["participants"][0]["reasoning"] = json!({ "mode": "on", "level": "high" });
    let room = parse_room(json).expect("room with reasoning parses");
    store.save(room, 5000).unwrap();

    let loaded = store.get("r1").unwrap().room;
    assert_eq!(
        loaded.participants[0].reasoning,
        Some(ParticipantReasoning {
            mode: Some(ReasoningMode::On),
            level: Some(ReasoningLevel::High),
        })
    );
    let raw: Value =
        serde_json::from_slice(&fs::read(store.root().join("r1").join(ROOM_FILE)).unwrap())
            .unwrap();
    assert_eq!(
        raw["participants"][0]["reasoning"],
        json!({ "mode": "on", "level": "high" })
    );
    // A participant left at the model default stores nothing at all.
    assert!(raw["participants"][1].get("reasoning").is_none());
}
