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
fn a_system_note_keeps_its_key_and_values_through_the_journal() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 5000).unwrap();
    let mut with_note = message_json("r1", "m1", "Bob is available again.");
    with_note["message"]["kind"] = json!("system");
    with_note["message"]["author"] = json!({ "kind": "system" });
    with_note["message"]["note"] = json!({ "key": "availableAgain", "values": { "name": "Bob" } });
    store.append("r1", parse_record(with_note).unwrap()).unwrap();
    store.append("r1", message("r1", "m2", "an old note")).unwrap();
    let loaded = store.get("r1").unwrap();
    let raw = serde_json::to_value(&loaded.journal).unwrap();
    assert_eq!(raw[0]["message"]["note"], json!({ "key": "availableAgain", "values": { "name": "Bob" } }));
    assert_eq!(raw[0]["message"]["text"], json!("Bob is available again."));
    // A message written before notes existed has none, and none is written.
    assert!(raw[1]["message"].get("note").is_none());
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
fn appends_reuse_the_journal_index_and_an_outside_edit_rescans() {
    let (_dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    let scans = || FULL_SCANS.with(|n| n.get());
    store.append("r1", message("r1", "m0", "first")).unwrap();
    let before = scans();
    for i in 1..200 {
        let rec = store.append("r1", message("r1", &format!("m{i}"), "x")).unwrap();
        assert_eq!(seq_of(&rec), i + 1);
    }
    // A duplicate is still answered with the stored record.
    let again = store.append("r1", message("r1", "m7", "changed")).unwrap();
    assert_eq!(seq_of(&again), 8);
    store.append("r1", turn_start("t1")).unwrap();
    store.append("r1", turn_start("t1")).unwrap();
    assert_eq!(scans(), before, "appends must not re-read the journal");

    // Someone else edits the journal: the next append reads it again.
    let journal_path = store.root().join("r1").join(JOURNAL_FILE);
    let mut raw = fs::read_to_string(&journal_path).unwrap();
    raw.push_str(&serde_json::to_string(&message_json("r1", "outside", "x")).unwrap().replace("\"seq\":0", "\"seq\":500"));
    raw.push('\n');
    fs::write(&journal_path, raw).unwrap();
    let next = store.append("r1", message("r1", "after", "y")).unwrap();
    assert_eq!(scans(), before + 1);
    assert_eq!(seq_of(&next), 501);
    assert_eq!(store.get("r1").unwrap().journal.len(), 203);

    // Cleared: the index is not trusted and seq starts over.
    store.clear_journal("r1").unwrap();
    assert_eq!(seq_of(&store.append("r1", message("r1", "m0", "again")).unwrap()), 1);
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
fn clear_journal_forgets_what_was_said_and_keeps_the_room() {
    let (_dir, store) = new_store();
    let saved = store.save(room("r1"), 10).unwrap();
    store.append("r1", message("r1", "m1", "hello")).unwrap();
    store.append("r1", turn_start("t2")).unwrap();
    assert_eq!(store.get("r1").unwrap().journal.len(), 2);

    store.clear_journal("r1").unwrap();

    let after = store.get("r1").unwrap();
    assert!(after.journal.is_empty());
    assert_eq!(after.room.id, saved.id);
    // Clearing twice is fine, and the next message starts at seq 1 again.
    store.clear_journal("r1").unwrap();
    let again = store.append("r1", message("r1", "m2", "again")).unwrap();
    assert_eq!(seq_of(&again), 1);
}

#[test]
fn clear_journal_refuses_a_room_that_does_not_exist_or_a_bad_id() {
    let (_dir, store) = new_store();
    assert_eq!(store.clear_journal("nope").unwrap_err().code, RoomErrorCode::NotFound);
    assert_eq!(store.clear_journal("..").unwrap_err().code, RoomErrorCode::InvalidId);
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
fn archive_hides_the_room_and_restore_brings_it_back_intact() {
    use crate::core::archive::store as archive;
    let (dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    store.append("r1", message("r1", "m1", "hi")).unwrap();

    store.archive(dir.path(), "r1").unwrap();
    assert!(store.list().unwrap().is_empty());
    assert_eq!(store.get("r1").unwrap_err().code, RoomErrorCode::NotFound);
    let items = archive::list(dir.path());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].meta.title, "Room r1");
    assert_eq!(items[0].meta.kind, archive::Kind::Room);

    archive::restore(dir.path(), archive::Kind::Room, &items[0].archive_id).unwrap();
    let back = store.get("r1").unwrap();
    assert_eq!(back.room.id, "r1");
    assert_eq!(back.journal.len(), 1, "the journal comes back with the room");

    // Same refusals as delete.
    assert_eq!(
        store.archive(dir.path(), "nope").unwrap_err().code,
        RoomErrorCode::NotFound
    );
    assert_eq!(
        store.archive(dir.path(), "..").unwrap_err().code,
        RoomErrorCode::InvalidId
    );
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

#[test]
fn compare_mode_round_trips_through_save_get_and_list() {
    let (_dir, store) = new_store();
    let mut json = room_json("r1");
    json["mode"] = json!("compare");
    let room = parse_room(json).expect("compare room parses");
    assert_eq!(room.mode, SpeakingMode::Compare);
    store.save(room, 5000).unwrap();

    let loaded = store.get("r1").unwrap().room;
    assert_eq!(loaded.mode, SpeakingMode::Compare);
    let raw: Value =
        serde_json::from_slice(&fs::read(store.root().join("r1").join(ROOM_FILE)).unwrap())
            .unwrap();
    assert_eq!(raw["mode"], json!("compare"));
    let listed = serde_json::to_value(&store.list().unwrap()[0]).unwrap();
    assert_eq!(listed["mode"], json!("compare"));
}

#[test]
fn compare_run_settings_and_answer_metadata_round_trip() {
    let (_dir, store) = new_store();
    let mut json = room_json("r1");
    json["mode"] = json!("compare");
    json["compareRun"] = json!("one-by-one");
    json["participants"][1]["compareSkip"] = json!(true);
    let room = parse_room(json).expect("compare room parses");
    store.save(room, 5000).unwrap();
    let raw: Value =
        serde_json::from_slice(&fs::read(store.root().join("r1").join(ROOM_FILE)).unwrap())
            .unwrap();
    assert_eq!(raw["compareRun"], json!("one-by-one"));
    assert_eq!(raw["participants"][1]["compareSkip"], json!(true));
    assert!(raw["participants"][0].get("compareSkip").is_none());

    let mut record = message_json("r1", "m1", "four");
    record["message"]["compare"] =
        json!({ "provider": "p", "model": "m", "replyTo": "q1", "durationMs": 1200 });
    let parsed = parse_record(record).expect("compare metadata parses");
    let back = serde_json::to_value(&parsed).unwrap();
    assert_eq!(
        back["message"]["compare"],
        json!({ "provider": "p", "model": "m", "replyTo": "q1", "durationMs": 1200 })
    );
    // Older rooms without the fields still load.
    assert!(parse_room(room_json("r2")).unwrap().compare_run.is_none());
}

#[test]
fn room_reasoning_effort_round_trips_and_is_optional() {
    let (_dir, store) = new_store();
    let mut json = room_json("r1");
    json["reasoningEffort"] = json!("high");
    store.save(parse_room(json).expect("room parses"), 5000).unwrap();
    let raw: Value =
        serde_json::from_slice(&fs::read(store.root().join("r1").join(ROOM_FILE)).unwrap())
            .unwrap();
    assert_eq!(raw["reasoningEffort"], json!("high"));
    let older = parse_room(room_json("r2")).unwrap();
    assert!(older.reasoning_effort.is_none());
    assert!(serde_json::to_value(&older).unwrap().get("reasoningEffort").is_none());
}

#[test]
fn tools2_fields_round_trip_and_old_rooms_load_unchanged() {
    let (_dir, store) = new_store();
    // An older room has none of the new fields and loads as before.
    let old = room("r2");
    assert!(old.tool_budget.is_none());
    assert!(old.participants.iter().all(|p| p.disabled_tools.is_none()));
    let plain = serde_json::to_value(&old).unwrap();
    assert!(plain.get("toolBudget").is_none());

    let mut value = room_json("r2");
    value["toolBudget"] = json!({ "maxToolCalls": 12, "maxSteps": 6, "toolTimeoutSec": 30 });
    value["participants"][0]["disabledTools"] = json!(["web_fetch", "bash"]);
    store.save(parse_room(value).unwrap(), 5000).unwrap();
    let loaded = store.get("r2").unwrap().room;
    let budget = loaded.tool_budget.clone().unwrap();
    assert_eq!(
        (
            budget.max_tool_calls,
            budget.max_steps,
            budget.tool_timeout_sec
        ),
        (Some(12), Some(6), Some(30))
    );
    assert_eq!(
        loaded.participants[0].disabled_tools.as_deref(),
        Some(&["web_fetch".to_string(), "bash".to_string()][..])
    );

    let mut msg = message_json("r2", "m9", "hi");
    msg["message"]["changes"] = json!({
        "files": [{ "path": "a.txt", "additions": 2, "deletions": 1, "excerpt": "+x" }],
        "workspace": "C:/ws",
        "cumulative": [{ "path": "b.txt", "additions": 1, "deletions": 0 }]
    });
    msg["message"]["budgetHit"] = json!("tool-calls");
    msg["message"]["finishReason"] = json!("length");
    msg["message"]["reasoning"] = json!("thinking");
    store.append("r2", parse_record(msg).unwrap()).unwrap();
    let journal = store.get("r2").unwrap().journal;
    let RoomJournalRecord::Message { message } = journal.last().unwrap() else {
        panic!("expected message")
    };
    assert_eq!(message.changes.as_ref().unwrap().files[0].additions, 2);
    assert_eq!(
        message.changes.as_ref().unwrap().cumulative.as_ref().unwrap()[0].path,
        "b.txt"
    );
    assert_eq!(message.budget_hit.as_deref(), Some("tool-calls"));
    assert_eq!(message.finish_reason.as_deref(), Some("length"));
    assert_eq!(message.reasoning.as_deref(), Some("thinking"));
}

#[test]
fn change_decisions_round_trip_and_old_rooms_load_unchanged() {
    let (_dir, store) = new_store();
    let old = room("r3");
    assert!(old.change_decisions.is_none());
    assert!(serde_json::to_value(&old)
        .unwrap()
        .get("changeDecisions")
        .is_none());
    let mut value = room_json("r3");
    value["changeDecisions"] = json!({ "m1": "kept", "m2": "discarded" });
    store.save(parse_room(value).unwrap(), 5000).unwrap();
    let loaded = store.get("r3").unwrap().room;
    let d = loaded.change_decisions.clone().unwrap();
    assert_eq!(d.get("m1").map(String::as_str), Some("kept"));
    assert_eq!(d.get("m2").map(String::as_str), Some("discarded"));
    // Saved again unchanged, the decisions survive.
    store.save(loaded, 6000).unwrap();
    assert_eq!(
        store.get("r3").unwrap().room.change_decisions.unwrap().len(),
        2
    );
}

#[test]
fn clearing_the_journal_keeps_workspaces_and_delete_removes_them() {
    let (dir, store) = new_store();
    store.save(room("r1"), 10).unwrap();
    let folder = dir.path().join("project");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.txt"), "one\n").unwrap();
    let ws = super::workspace::ensure(store.root(), "r1", "p1", &folder, true).unwrap();
    fs::write(std::path::Path::new(&ws.path).join("a.txt"), "pending\n").unwrap();
    store.append("r1", message("r1", "m1", "hello")).unwrap();

    store.clear_journal("r1").unwrap();
    assert!(store.get("r1").unwrap().journal.is_empty());
    // The workspace and the change waiting in it are still there.
    assert_eq!(
        fs::read_to_string(std::path::Path::new(&ws.path).join("a.txt")).unwrap(),
        "pending\n"
    );
    let changes = super::workspace::changes(
        store.root(),
        "r1",
        "p1",
        super::workspace::ChangeScope::All,
    )
    .unwrap();
    assert_eq!(changes.files.len(), 1);

    store.delete("r1").unwrap();
    assert!(!std::path::Path::new(&ws.path).exists());
}

fn failing_remover(_: &std::path::Path, _: &str) -> Result<(), RoomError> {
    Err(RoomError::new(RoomErrorCode::Io, "remove workspaces: file in use".to_string()))
}

#[test]
fn a_workspace_that_cannot_be_removed_does_not_block_delete_or_archive() {
    let (dir, store) = new_store();
    store.save(room("r1"), 1).unwrap();
    store.delete_with("r1", failing_remover).unwrap();
    assert_eq!(store.get("r1").unwrap_err().code, RoomErrorCode::NotFound);

    store.save(room("r2"), 1).unwrap();
    store.archive_with(dir.path(), "r2", failing_remover).unwrap();
    assert!(store.list().unwrap().is_empty());

    // A missing room is still refused, whatever the remover would do.
    assert_eq!(store.delete_with("nope", failing_remover).unwrap_err().code, RoomErrorCode::NotFound);
}
