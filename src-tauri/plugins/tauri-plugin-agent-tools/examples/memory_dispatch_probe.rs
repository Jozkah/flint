//! Drive the real memory store and the real selection, for an end-to-end proof.
//!
//! The question this exists to answer is narrow and was not answerable before:
//! does a memory saved in one chat actually reach the request a *different*
//! chat sends? Everything else about memory can be true while that is false --
//! and it was, on the desktop, for as long as retrieval was wired only into the
//! CLI agent loop.
//!
//! The selection here is the production one ([`memory::retrieve::select`]), not
//! a reimplementation. What the caller does with the block -- send it to a real
//! server, assert on the serialized body -- happens outside, so this stays a
//! store-and-select probe and nothing in it reaches the network.
//!
//! Every path is under `JAN_TEST_DATA_ROOT`. It refuses to run without one, so
//! it cannot touch a real profile.

use std::path::PathBuf;

use tauri_plugin_agent_tools::memory::{
    create,
    record::{Creator, MemoryId, Origin, Scope},
    retrieve, store,
};

fn root() -> PathBuf {
    let raw = std::env::var("JAN_TEST_DATA_ROOT").unwrap_or_default();
    if raw.trim().is_empty() {
        eprintln!("JAN_TEST_DATA_ROOT must name an isolated directory");
        std::process::exit(2);
    }
    let path = PathBuf::from(raw);
    std::fs::create_dir_all(&path).expect("create the isolated root");
    path
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn scope_of(name: &str) -> Scope {
    match name {
        "user" => Scope::User,
        "session" => Scope::Session,
        "project" => Scope::Project,
        other => {
            eprintln!("unknown scope: {other}");
            std::process::exit(2);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = root();
    match args.first().map(String::as_str) {
        // remember <scope> <session-id|-> <content>
        Some("remember") => {
            let scope = scope_of(&args[1]);
            let session = (args[2] != "-").then(|| args[2].clone());
            let content = &args[3];
            let existing = store::load(&root, scope).records;
            let id = MemoryId::new(format!("mem_{}", now()));
            let proposal = match create::propose(
                id,
                content,
                scope,
                None,
                session.as_deref(),
                Creator::User,
                Origin::Explicit,
                now(),
                &existing,
            ) {
                Ok(p) => p,
                Err(refusal) => {
                    println!("{{\"refused\":\"{refusal:?}\"}}");
                    std::process::exit(3);
                }
            };
            let id = create::commit(&root, &proposal).expect("commit");
            println!("{{\"id\":\"{}\"}}", id.as_str());
        }
        // select <session-id|-> -- what a dispatch from that chat would carry
        Some("select") => {
            let session = (args[1] != "-").then(|| args[1].clone());
            let mut records = store::load(&root, Scope::User).records;
            records.extend(store::load(&root, Scope::Session).records);
            let selection = retrieve::select(
                &records,
                &retrieve::RetrievalContext {
                    session_id: session.as_deref(),
                    project_id: None,
                    now: now(),
                    budget_chars: retrieve::DEFAULT_BUDGET_CHARS,
                    temporary: args.get(2).map(String::as_str) == Some("temporary"),
                    instructions: &[],
                },
            );
            let ids: Vec<String> = selection
                .injected
                .iter()
                .map(|i| format!("\"{}\"", i.id.as_str()))
                .collect();
            let block = selection.render().unwrap_or_default();
            println!(
                "{{\"ids\":[{}],\"chars\":{},\"block\":{}}}",
                ids.join(","),
                selection.chars_used,
                serde_json::to_string(&block).expect("encode")
            );
        }
        // forget <scope> <id>
        Some("forget") => {
            let scope = scope_of(&args[1]);
            let gone = create::forget(&root, scope, &MemoryId::new(args[2].clone()), now())
                .expect("forget");
            println!("{{\"forgotten\":{gone}}}");
        }
        other => {
            eprintln!("usage: remember|select|forget (got {other:?})");
            std::process::exit(2);
        }
    }
}
