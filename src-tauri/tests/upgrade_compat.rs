//! Upgrade-path compatibility: data written by past releases must stay readable
//! by current code (adapts jan#8995 to Flint).
//!
//! Everything under `tests/fixtures/upgrade/` is real bytes written by the named
//! release (0.8.3), committed so a schema drift that would silently eat user data
//! fails here instead of on a user machine. Threads are plain per-thread
//! JSON/JSONL files; `store.json` records the MCP schema version the release
//! wrote (3 on 0.8.3), which `core::setup::migrate_mcp_servers` migrates against
//! at launch.
//!
//! When a release intentionally changes one of these schemas, commit the old
//! release's output as a new fixture directory under
//! `tests/fixtures/upgrade/<release>/` and add assertions for it; update an
//! existing fixture only when the current schema itself is being pinned, never to
//! make a test pass.
//!
//! Scope note: Flint's `migrate_mcp_servers` takes a live `tauri::AppHandle`
//! (it calls `add_server_config`/`remove_exa_server` through it), so the MCP
//! migration itself is exercised by the desktop app rather than this headless
//! integration test. What this suite pins is the durable on-disk contract that
//! migration and every read path depend on: the thread files and the store
//! schema marker written by a past release still parse through today's helpers.

// The thread helpers and fixtures are desktop data; `core` gates several of its
// modules out of `--features cli`, which builds this test target too, so the
// suite belongs to the desktop build.
#![cfg(not(feature = "cli"))]

use app_lib::core::threads::helpers::read_messages_from_file;
use app_lib::core::threads::utils::{get_messages_path, get_thread_dir, get_thread_metadata_path};
use serde_json::Value;
use std::path::PathBuf;

/// Root of a committed release data-folder fixture. Mirrors a real data folder:
/// `threads/<id>/{thread.json,messages.jsonl}`, `store.json`, `mcp_config.json`.
fn fixture_root(release: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/upgrade")
        .join(release)
}

/// Every committed release fixture, oldest first. Discovered rather than listed
/// so the tripwire below can demand a new fixture on a schema bump without also
/// demanding an edit here that would get forgotten.
fn fixture_releases() -> Vec<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/upgrade");
    let mut releases: Vec<(Vec<u64>, String)> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("upgrade fixture root {root:?} unreadable: {e}"))
        .map(|entry| entry.expect("fixture directory entry must be readable"))
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Sort on parsed components, not the string: "0.8.10" must come after
            // "0.8.9", which it does not lexicographically.
            let parts = name
                .split('.')
                .map(|part| {
                    part.parse().unwrap_or_else(|_| {
                        panic!("fixture directory {name:?} is not a dotted release version")
                    })
                })
                .collect();
            (parts, name)
        })
        .collect();
    assert!(
        !releases.is_empty(),
        "no release fixtures under {root:?} -- this suite would pass vacuously"
    );
    releases.sort();
    releases.into_iter().map(|(_, name)| name).collect()
}

/// The thread ids present in a release fixture's `threads/` directory.
fn fixture_thread_ids(release: &str) -> Vec<String> {
    let threads = fixture_root(release).join("threads");
    let mut ids: Vec<String> = std::fs::read_dir(&threads)
        .unwrap_or_else(|e| panic!("{release} threads dir unreadable at {threads:?}: {e}"))
        .map(|e| e.expect("thread dir entry readable"))
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

/// `store.json` written by a past release must still parse and carry the two
/// markers current code keys migrations off: the release `version` (which must
/// match the fixture directory) and the integer `mcp_version`.
#[test]
fn past_release_store_json_still_parses_with_its_schema_marker() {
    for release in fixture_releases() {
        let path = fixture_root(&release).join("store.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{release} store.json missing at {path:?}: {e}"));
        let store: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{release} store.json must parse: {e}"));
        assert_eq!(
            store["version"].as_str(),
            Some(release.as_str()),
            "fixture dir {release} holds a store.json written by a different release"
        );
        assert!(
            store["mcp_version"].as_i64().is_some(),
            "{release} store.json must record an integer mcp_version for migration"
        );
    }
}

/// `mcp_config.json` written by a past release must still parse as an MCP config
/// object, so `migrate_mcp_servers` reads a well-formed starting point.
#[test]
fn past_release_mcp_config_still_parses() {
    for release in fixture_releases() {
        let path = fixture_root(&release).join("mcp_config.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{release} mcp_config.json missing at {path:?}: {e}"));
        let cfg: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{release} mcp_config.json must parse: {e}"));
        assert!(
            cfg.get("mcpServers").and_then(|s| s.as_object()).is_some(),
            "{release} mcp_config.json must have an mcpServers object"
        );
    }
}

/// Every thread a past release wrote must still be readable through today's
/// helpers: the metadata parses, and the messages come back through
/// `read_messages_from_file` (the one reader every surface uses) with their
/// roles and text intact -- a schema drift that dropped a field would surface as
/// an empty or unparsable read here.
#[test]
fn past_release_threads_still_read_through_current_helpers() {
    for release in fixture_releases() {
        let root = fixture_root(&release);
        let ids = fixture_thread_ids(&release);
        assert!(
            !ids.is_empty(),
            "{release} fixture has no threads to check"
        );
        for id in ids {
            // Metadata: thread.json parses and self-identifies.
            let meta_path = get_thread_metadata_path(&root, &id);
            assert_eq!(
                meta_path,
                get_thread_dir(&root, &id).join("thread.json"),
                "metadata path layout drifted"
            );
            let meta_raw = std::fs::read_to_string(&meta_path)
                .unwrap_or_else(|e| panic!("{release}/{id} thread.json missing: {e}"));
            let _: Value = serde_json::from_str(&meta_raw)
                .unwrap_or_else(|e| panic!("{release}/{id} thread.json must parse: {e}"));

            // Messages: read through the production reader, not raw JSON.
            assert!(
                get_messages_path(&root, &id).exists(),
                "{release}/{id} messages.jsonl missing"
            );
            let messages = read_messages_from_file(&root, &id)
                .unwrap_or_else(|e| panic!("{release}/{id} messages must read: {e}"));
            assert!(
                !messages.is_empty(),
                "{release}/{id} read back no messages -- a schema drift dropped them"
            );
            for (i, m) in messages.iter().enumerate() {
                assert!(
                    m.get("role").and_then(Value::as_str).is_some(),
                    "{release}/{id} message {i} lost its role: {m}"
                );
                // 0.8.3 stored content as an array of typed parts; the reader
                // must still surface it (as an array or a coalesced string).
                assert!(
                    m.get("content").is_some(),
                    "{release}/{id} message {i} lost its content: {m}"
                );
            }
        }
    }
}

/// The 0.8.3 fixture specifically: it records MCP schema 3, the version whose
/// hosted-Exa entry later migrations supersede. Pinning it here means a change
/// to how 0.8.3 is recognized fails loudly.
#[test]
fn the_0_8_3_fixture_is_schema_3() {
    let store: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_root("0.8.3").join("store.json")).expect("0.8.3 store"),
    )
    .expect("0.8.3 store parses");
    assert_eq!(store["mcp_version"].as_i64(), Some(3));
}
