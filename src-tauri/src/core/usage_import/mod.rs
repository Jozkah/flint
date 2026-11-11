//! Usage import: token counts from other coding agents' local session logs.
//!
//! Opt-in and read-only. When the person turns it on, Flint reads the session
//! logs Claude Code (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/**/*.jsonl`)
//! and Codex (`<CODEX_HOME or ~/.codex>/sessions/**/*.jsonl`) already keep on
//! this computer, and adds up the token counts they recorded. Nothing is
//! written to those folders and nothing leaves the machine. Only token counts,
//! the model id, a timestamp and the session/project name are kept; message
//! text is never read into a record.
//!
//! * `parse` reads one log, line by line, defensively.
//! * `scan` finds the logs and keeps an on-disk cache keyed by path + mtime +
//!   size so an unchanged log is never parsed twice.
//! * `aggregate` turns records into the numbers the page shows.
//!
//! Cost here is an API-equivalent estimate at prices the person declared
//! (`prices.toml`, or a price set on the page); it is not a bill.

pub mod aggregate;
#[cfg(not(feature = "cli"))]
pub mod commands;
pub mod parse;
pub mod scan;

use serde::{Deserialize, Serialize};

/// Which program wrote the log a record came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Agent {
    ClaudeCode,
    Codex,
    Flint,
}

/// One model reply's token counts. `input` is the part of the prompt that was
/// neither read from nor written to a cache, so the four figures never overlap.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub agent: Agent,
    /// Milliseconds since the epoch.
    pub ts: i64,
    pub model: String,
    pub session: String,
    pub project: String,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    /// What identifies a reply across files, so a log that repeats it (Claude
    /// Code logs each streamed reply more than once) counts once. Empty when
    /// the log gave nothing to go on.
    pub id: String,
}

impl Record {
    pub fn prompt_tokens(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
    pub fn total_tokens(&self) -> u64 {
        self.prompt_tokens() + self.output
    }
}

/// What one log's parse found, besides records.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ParseStats {
    /// Lines that could not be read as the format expects, or were too long.
    pub skipped_lines: u64,
    /// Replies that repeated an id or running total already seen in the log.
    pub duplicates: u64,
}
