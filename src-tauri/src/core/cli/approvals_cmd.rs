//! `flint cli approvals ...`: answer the permission prompts that were put off,
//! and see or revoke the scoped rules saved with "allow always".
//!
//! A run with `[approvals] defer = true` that reaches a prompt nobody can
//! answer records it and ends. `list` shows what is waiting, `allow` and `deny`
//! answer it, and resuming the session lets the model propose the call again --
//! the answer is applied to exactly that call, once, if it is given in time.

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri_plugin_agent_tools::deferred_approvals::{self as deferred, DeferStatus, Deferred};
use tauri_plugin_agent_tools::scoped_rules::{self, ApprovalScope, ScopedRule};

fn data_folder() -> PathBuf {
    crate::core::app::commands::resolve_jan_data_folder()
}

fn stamp(secs: u64) -> String {
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "-".to_string())
}

fn status_word(status: DeferStatus) -> &'static str {
    match status {
        DeferStatus::Pending => "pending",
        DeferStatus::Allowed => "allowed",
        DeferStatus::Denied => "denied",
        DeferStatus::Expired => "expired",
        DeferStatus::Void => "void",
        DeferStatus::Consumed => "applied",
        DeferStatus::Stale => "stale (file changed)",
    }
}

fn scope_text(scope: &ApprovalScope) -> String {
    match scope {
        ApprovalScope::Once => "once".to_string(),
        ApprovalScope::Run => "this run".to_string(),
        ApprovalScope::Folder { dir } => format!("folder {dir}"),
        ApprovalScope::CommandPrefix { prefix } => format!("commands starting `{prefix}`"),
    }
}

/// `flint cli approvals list`: the questions waiting for an answer, or with
/// `all` every one on file.
pub fn list(project: Option<&Path>, all: bool, as_json: bool) -> Result<(), String> {
    let items = deferred::list(&data_folder(), project, all);
    if as_json {
        println!("{}", serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if items.is_empty() {
        println!("No approvals are waiting.");
        return Ok(());
    }
    for d in &items {
        print_one(d);
    }
    Ok(())
}

fn print_one(d: &Deferred) {
    println!(
        "{}  {}  {}  session {}\n    {}\n    asked {}, answer by {}",
        d.id,
        status_word(d.status),
        super::display_safe::display_safe(&d.tool),
        if d.session.is_empty() { "-" } else { &d.session },
        super::display_safe::display_safe(&d.summary),
        stamp(d.created_at),
        stamp(d.expires_at),
    );
    // What is being approved in full: the digest binds these arguments.
    if !d.detail.is_empty() {
        for line in d.detail.lines() {
            println!("      | {}", super::display_safe::display_safe(line));
        }
    }
}

/// `flint cli approvals allow|deny <id>`. Refused, never granted, when the
/// question already expired, was voided by a restore, or was answered.
pub fn answer(id: &str, allow: bool) -> Result<(), String> {
    let record = deferred::answer(&data_folder(), id, allow)?;
    println!(
        "{} {}. Resume session {} and the run will propose the call again; the answer applies to that exact call, once, until {}.",
        record.id,
        status_word(record.status),
        if record.session.is_empty() { "(none)" } else { &record.session },
        stamp(record.expires_at),
    );
    Ok(())
}

/// `flint cli approvals discard <id>`: drop a record from the list.
pub fn discard(id: &str) -> Result<(), String> {
    if deferred::discard(&data_folder(), id)? {
        println!("{id} removed.");
        Ok(())
    } else {
        Err(format!("no deferred approval {id}"))
    }
}

/// `flint cli approvals rules`: the scoped rules saved with "allow always".
pub fn rules(project: Option<&Path>, as_json: bool) -> Result<(), String> {
    let items: Vec<ScopedRule> = scoped_rules::list(&data_folder(), project);
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "rules": items })).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if items.is_empty() {
        println!("No approval rules are saved.");
        return Ok(());
    }
    for r in &items {
        println!(
            "{}  {}  {}\n    {}\n    in {}, saved {}",
            r.id,
            r.tool,
            r.kind,
            scope_text(&r.scope),
            r.project,
            stamp(r.created_at),
        );
    }
    Ok(())
}

/// `flint cli approvals revoke <rule id>`.
pub fn revoke(id: &str) -> Result<(), String> {
    if scoped_rules::revoke(&data_folder(), id)? {
        println!("{id} revoked.");
        Ok(())
    } else {
        Err(format!("no approval rule {id}"))
    }
}
