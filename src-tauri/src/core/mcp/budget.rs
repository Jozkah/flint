//! What one MCP server may put into a conversation (AH-144).
//!
//! The existing cap bounded every tool result by the same number, whichever
//! server produced it. A search server that returns a page of results and a
//! database server that can return a table are not the same risk, and one
//! noisy server could spend a whole context window a dozen small calls at a
//! time without any single result tripping the cap.
//!
//! A server entry in `mcp_config.json` may now carry:
//!
//! ```json
//! "budget": { "maxResultChars": 8000, "maxSessionChars": 60000 }
//! ```
//!
//! * `maxResultChars` narrows the global per-result cap for this server. It
//!   can never widen it: the tighter of the two wins.
//! * `maxSessionChars` bounds the total a server may return in this process's
//!   session. Once spent, calls to that server are refused with a typed
//!   `budget_exhausted` naming the server, and other servers are unaffected.
//!
//! Token cost is reported as an estimate (four characters per token) and said
//! to be one: the provider's tokenizer is not available here, and a figure
//! presented as exact would be wrong in a way that looks authoritative.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

/// A server's declared budget. `None` in either field is "not narrowed".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerBudget {
    pub max_result_chars: Option<u64>,
    pub max_session_chars: Option<u64>,
}

impl ServerBudget {
    /// Read `budget` from a server's config object. Zero, negative or
    /// non-numeric values are "not narrowed" -- never "unlimited beyond the
    /// global cap", which a budget cannot express.
    pub fn from_config(config: &serde_json::Value) -> Self {
        let read = |key: &str| {
            config
                .get("budget")
                .and_then(|b| b.get(key))
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0)
        };
        Self {
            max_result_chars: read("maxResultChars"),
            max_session_chars: read("maxSessionChars"),
        }
    }

    /// Read a named server's budget from `<data>/mcp_config.json`.
    pub fn for_server(data_folder: &Path, server: &str) -> Self {
        std::fs::read_to_string(data_folder.join("mcp_config.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|cfg| cfg.get("mcpServers").and_then(|s| s.get(server)).cloned())
            .map(|c| Self::from_config(&c))
            .unwrap_or_default()
    }

    /// The cap for one result: the tighter of the global cap and this
    /// server's. A global cap of 0 (disabled) still yields to a server's own.
    pub fn result_cap(&self, global: u64) -> u64 {
        match (global, self.max_result_chars) {
            (0, Some(own)) => own,
            (g, Some(own)) => g.min(own),
            (g, None) => g,
        }
    }
}

/// What a server has spent this session.
static SPENT: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

/// Characters per estimated token.
pub const CHARS_PER_TOKEN: u64 = 4;

/// Refuse a call to a server whose session budget is spent.
pub fn check(server: &str, budget: &ServerBudget) -> Result<(), String> {
    let Some(limit) = budget.max_session_chars else {
        return Ok(());
    };
    let spent = SPENT.lock().map(|m| *m.get(server).unwrap_or(&0)).unwrap_or(0);
    if spent >= limit {
        return Err(format!(
            "[budget_exhausted] MCP server '{server}' has returned {spent} characters \
             (~{} tokens, estimated) this session, and its budget is {limit}. Its tools are \
             not called again until the session restarts or the budget is raised in \
             mcp_config.json.",
            spent / CHARS_PER_TOKEN
        ));
    }
    Ok(())
}

/// Record what a result cost. Returns the running total.
pub fn charge(server: &str, chars: u64) -> u64 {
    let Ok(mut map) = SPENT.lock() else { return 0 };
    let total = map.entry(server.to_string()).or_insert(0);
    *total = total.saturating_add(chars);
    *total
}

/// What every server has spent, with estimated tokens.
pub fn spent() -> Vec<(String, u64, u64)> {
    let mut out: Vec<(String, u64, u64)> = SPENT
        .lock()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), *v, v / CHARS_PER_TOKEN)).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// The characters of text a tool result carries.
pub fn result_chars(result: &rmcp::model::CallToolResult) -> u64 {
    result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.chars().count() as u64))
        .sum()
}

#[cfg(test)]
pub(crate) fn reset(server: &str) {
    if let Ok(mut m) = SPENT.lock() {
        m.remove(server);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_budget_narrows_the_global_cap_and_never_widens_it() {
        let b = ServerBudget::from_config(&serde_json::json!({"budget": {"maxResultChars": 100}}));
        assert_eq!(b.result_cap(40_000), 100);
        assert_eq!(b.result_cap(50), 50, "the tighter wins");
        assert_eq!(b.result_cap(0), 100, "a disabled global cap yields to the server's");
        let none = ServerBudget::from_config(&serde_json::json!({}));
        assert_eq!(none.result_cap(40_000), 40_000);
        let junk = ServerBudget::from_config(
            &serde_json::json!({"budget": {"maxResultChars": -1, "maxSessionChars": "lots"}}),
        );
        assert_eq!(junk, ServerBudget::default());
    }

    #[test]
    fn a_spent_server_is_refused_and_others_are_not() {
        let budget = ServerBudget { max_result_chars: None, max_session_chars: Some(10) };
        reset("noisy-test");
        reset("quiet-test");
        assert!(check("noisy-test", &budget).is_ok());
        charge("noisy-test", 6);
        assert!(check("noisy-test", &budget).is_ok());
        charge("noisy-test", 6);
        let err = check("noisy-test", &budget).unwrap_err();
        assert!(err.starts_with("[budget_exhausted]"), "{err}");
        assert!(err.contains("'noisy-test'") && err.contains("estimated"), "{err}");
        assert!(check("quiet-test", &budget).is_ok(), "other servers are unaffected");
        assert!(check("noisy-test", &ServerBudget::default()).is_ok(), "no budget, no refusal");
    }

    #[test]
    fn a_budget_is_read_by_server_name_from_the_config_file() {
        let d = std::env::temp_dir().join(format!("jan_budget_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("mcp_config.json"),
            r#"{"mcpServers":{"a":{"command":"x","budget":{"maxSessionChars":5}},"b":{"command":"y"}}}"#,
        )
        .unwrap();
        assert_eq!(ServerBudget::for_server(&d, "a").max_session_chars, Some(5));
        assert_eq!(ServerBudget::for_server(&d, "b"), ServerBudget::default());
        assert_eq!(ServerBudget::for_server(&d, "missing"), ServerBudget::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
