//! Tauri-free persistence for discussion rooms (docs/DISCUSSION_ROOMS.md,
//! "Persistence").
//!
//! Layout: `<jan_data>/rooms/<roomId>/room.json` and
//! `<jan_data>/rooms/<roomId>/journal.jsonl`.
//!
//! The typed structs mirror `web-app/src/lib/rooms/types.ts`. Deserialising
//! into them is how enum values and field shapes are validated; the remaining
//! structural rules (schema version, ids, sizes, participant count) are checked
//! explicitly. Discussion semantics are the engine's business, not this file's.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

pub const ROOM_SCHEMA_VERSION: u32 = 1;
pub const ROOMS_DIR: &str = "rooms";
pub const ROOM_FILE: &str = "room.json";
pub const JOURNAL_FILE: &str = "journal.jsonl";
pub const MAX_ROOM_BYTES: usize = 256 * 1024;
/// A serialised journal line. Message `text` is capped in UTF-16 units, so a
/// record with text plus a same-sized second field (a vote's proposal, a
/// synthesis's capped dissent list) can take 4 x 3 bytes per unit of
/// `MAX_TEXT_LENGTH`; this stays above that. Independent of `MAX_ROOM_BYTES`.
pub const MAX_JOURNAL_LINE_BYTES: usize = 256 * 1024;
/// `ROOM_LIMIT_CEILINGS.maxTextLength`, counted in UTF-16 code units so it
/// agrees with JavaScript's `string.length`.
pub const MAX_TEXT_LENGTH: usize = 20_000;
/// `ROOM_LIMIT_CEILINGS.maxParticipants`.
pub const MAX_PARTICIPANTS: usize = 8;
pub const MAX_ID_LENGTH: usize = 128;

/// Keys a `StopReason` of kind `limit` may name: `keyof RoomLimits | 'ceiling'`.
const LIMIT_KEYS: &[&str] = &[
    "maxRounds",
    "maxTurns",
    "maxConsecutivePerParticipant",
    "maxTotalTokens",
    "maxOutputTokensPerTurn",
    "maxCostUsd",
    "maxDurationMs",
    "maxRepetitiveTurns",
    "repetitionSimilarity",
    "ceiling",
];

/// One process-wide lock for every room write. Poison-tolerant: a panic in one
/// writer must not make every later room write fail.
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_guard() -> MutexGuard<'static, ()> {
    WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomErrorCode {
    NotFound,
    InvalidId,
    InvalidRoom,
    StaleRevision,
    TooLarge,
    Io,
    Unknown,
}

/// Serialises as `{ code, message }`, which is what the renderer receives when
/// a room command rejects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomError {
    pub code: RoomErrorCode,
    pub message: String,
}

impl RoomError {
    pub fn new(code: RoomErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for RoomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = serde_json::to_value(self.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown".into());
        write!(f, "{code}: {}", self.message)
    }
}

impl std::error::Error for RoomError {}

fn io_error(context: &str, err: std::io::Error) -> RoomError {
    if err.kind() == std::io::ErrorKind::NotFound {
        RoomError::new(RoomErrorCode::NotFound, format!("{context}: {err}"))
    } else {
        RoomError::new(RoomErrorCode::Io, format!("{context}: {err}"))
    }
}

fn invalid_room(message: impl Into<String>) -> RoomError {
    RoomError::new(RoomErrorCode::InvalidRoom, message)
}

fn too_large(message: impl Into<String>) -> RoomError {
    RoomError::new(RoomErrorCode::TooLarge, message)
}

// ---------------------------------------------------------------------------
// Types mirroring web-app/src/lib/rooms/types.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomModelRef {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomStatus {
    Draft,
    Running,
    AwaitingUser,
    Paused,
    Stopped,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpeakingMode {
    RoundRobin,
    UserSelected,
    ModeratorSelected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolAccess {
    None,
    Read,
    /// Read plus write/edit, confined to the room's attached folder by a
    /// direct-edit grant. Requires a folder; falls back to read behaviour with
    /// none.
    Edit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParticipantUnavailableReason {
    ProviderMissing,
    ProviderNotConfigured,
    ModelMissing,
    LoadFailed,
    RepeatedErrors,
    ContextTooSmall,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ParticipantAvailability {
    Unknown,
    Available,
    Unavailable {
        reason: ParticipantUnavailableReason,
        message: String,
        at: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantPricing {
    pub input_per_m_tok_usd: f64,
    pub output_per_m_tok_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub role: String,
    pub model: RoomModelRef,
    pub tool_access: ToolAccess,
    pub removed: bool,
    pub order: i64,
    pub availability: ParticipantAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ParticipantPricing>,
    /// How this participant's model reasons on its turns. Absent on rooms
    /// saved before it existed and on participants left at the model default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ParticipantReasoning>,
}

/// A participant's reasoning setting, mirroring `ParticipantReasoning` in
/// web-app/src/lib/rooms/types.ts. Stored, never interpreted here: the turn is
/// built on the frontend, which maps it per provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantReasoning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ReasoningMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<ReasoningLevel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningMode {
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Unlimited,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeratorConfig {
    pub enabled: bool,
    pub name: String,
    pub model: Option<RoomModelRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLimits {
    pub max_rounds: u64,
    pub max_turns: u64,
    pub max_consecutive_per_participant: u64,
    pub max_total_tokens: u64,
    pub max_output_tokens_per_turn: u64,
    pub max_cost_usd: Option<f64>,
    pub max_duration_ms: u64,
    pub max_repetitive_turns: u64,
    pub repetition_similarity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomUsage {
    pub turns: u64,
    pub rounds: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated: bool,
    pub cost_usd: Option<f64>,
    pub active_ms: u64,
    pub consecutive_repetitive: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConvergedBy {
    Moderator,
    Repetition,
    Consensus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StopReason {
    User,
    Limit { limit: String },
    Converged { by: ConvergedBy },
    Synthesized,
    NoParticipants { message: String },
    InterruptedByRestart,
    Error { code: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub v: u32,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: RoomStatus,
    pub mode: SpeakingMode,
    pub moderator: ModeratorConfig,
    pub participants: Vec<Participant>,
    /// An optional working folder the room's tool-capable participants read
    /// from. Absent on rooms created before this existed, and on rooms that
    /// have not attached one (serde default keeps those loading unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub limits: RoomLimits,
    pub usage: RoomUsage,
    pub round: u64,
    pub spoken_this_round: Vec<String>,
    pub next_speaker_id: Option<String>,
    pub stop_reason: Option<StopReason>,
    pub rev: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Address {
    Room,
    Participant {
        #[serde(rename = "participantId")]
        participant_id: String,
    },
    Moderator,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RoomAuthor {
    Participant {
        #[serde(rename = "participantId")]
        participant_id: String,
        name: String,
    },
    Moderator {
        name: String,
    },
    User,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomMessageKind {
    Speech,
    ModeratorNote,
    User,
    VoteCall,
    Vote,
    FinalPosition,
    Synthesis,
    System,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoteChoice {
    Agree,
    Disagree,
    Abstain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomMessageStatus {
    Complete,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessageError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessageUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomVote {
    pub call_id: String,
    pub choice: VoteChoice,
    pub proposal: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDissent {
    pub participant_id: String,
    pub name: String,
    pub position: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeratorDirective {
    pub next: Option<String>,
    pub request: Option<String>,
    pub disagreements: Vec<String>,
    pub converged: bool,
    pub stop: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessage {
    pub v: u32,
    pub id: String,
    pub room_id: String,
    /// Assigned by the backend on append; any caller value is replaced.
    #[serde(default)]
    pub seq: u64,
    pub turn_id: Option<String>,
    pub author: RoomAuthor,
    pub to: Address,
    pub kind: RoomMessageKind,
    pub text: String,
    pub round: u64,
    pub created_at: u64,
    pub status: RoomMessageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RoomMessageError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<RoomMessageUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vote: Option<RoomVote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dissent: Option<Vec<RoomDissent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directive: Option<ModeratorDirective>,
    /// The read-only tools a tool-capable participant used to produce this
    /// reply. Absent on messages from participants without tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<RoomToolCall>>,
    /// For system notes: the discussion was compacted here. Drawn as a
    /// divider that expands to the summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<RoomCompaction>,
}

/// A compaction of the discussion, journaled so its divider survives reloads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCompaction {
    pub summarized_count: u64,
    pub summary: String,
}

/// One tool a participant used in its turn, journaled for the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomToolCall {
    pub name: String,
    pub ok: bool,
    /// The tool's input, kept for the transcript's expandable advanced view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// The tool's output (truncated on the frontend), for the advanced view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// The tool came from an MCP server, for the transcript's colouring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RoomJournalRecord {
    TurnStart {
        #[serde(rename = "turnId")]
        turn_id: String,
        speaker: RoomAuthor,
        round: u64,
        at: u64,
    },
    Message {
        message: Box<RoomMessage>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub status: RoomStatus,
    pub mode: SpeakingMode,
    pub updated_at: u64,
    pub created_at: u64,
    pub participant_count: usize,
    pub turns: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomWithJournal {
    pub room: Room,
    pub journal: Vec<RoomJournalRecord>,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn preview(id: &str) -> String {
    let short: String = id.chars().take(40).collect();
    if short.len() < id.len() {
        format!("{short:?}...")
    } else {
        format!("{short:?}")
    }
}

/// 1-128 chars of `[A-Za-z0-9._-]`, not `.` or `..`. Checked before any id
/// becomes part of a path.
fn is_windows_reserved_name(id: &str) -> bool {
    let base = id.split('.').next().unwrap_or(id).to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

pub fn validate_id(id: &str) -> Result<(), RoomError> {
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_LENGTH
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        // Windows strips a trailing dot and reserves device names (with any
        // extension), so such ids would alias another path or fail to open.
        && !id.ends_with('.')
        && !is_windows_reserved_name(id);
    if ok {
        Ok(())
    } else {
        Err(RoomError::new(
            RoomErrorCode::InvalidId,
            format!(
                "invalid id {}: expected 1-{MAX_ID_LENGTH} chars of [A-Za-z0-9._-], not '.' or '..'",
                preview(id)
            ),
        ))
    }
}

fn validate_field_id(field: &str, id: &str) -> Result<(), RoomError> {
    validate_id(id).map_err(|e| invalid_room(format!("{field}: {}", e.message)))
}

fn text_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Parses a room from untyped JSON; shape and enum errors become `invalid_room`.
pub fn parse_room(value: serde_json::Value) -> Result<Room, RoomError> {
    serde_json::from_value(value).map_err(|e| invalid_room(format!("invalid room: {e}")))
}

/// Parses a journal record from untyped JSON; shape and enum errors become
/// `invalid_room`.
pub fn parse_record(value: serde_json::Value) -> Result<RoomJournalRecord, RoomError> {
    serde_json::from_value(value).map_err(|e| invalid_room(format!("invalid journal record: {e}")))
}

pub fn validate_room(room: &Room) -> Result<(), RoomError> {
    validate_id(&room.id)?;
    if room.v != ROOM_SCHEMA_VERSION {
        return Err(invalid_room(format!(
            "unsupported room schema version {} (expected {ROOM_SCHEMA_VERSION})",
            room.v
        )));
    }
    if room.participants.len() > MAX_PARTICIPANTS {
        return Err(invalid_room(format!(
            "room has {} participants; at most {MAX_PARTICIPANTS} are allowed",
            room.participants.len()
        )));
    }
    for (index, participant) in room.participants.iter().enumerate() {
        validate_field_id(&format!("participants[{index}].id"), &participant.id)?;
        if room.participants[..index]
            .iter()
            .any(|other| other.id == participant.id)
        {
            return Err(invalid_room(format!(
                "duplicate participant id {}",
                preview(&participant.id)
            )));
        }
    }
    if let Some(StopReason::Limit { limit }) = &room.stop_reason {
        if !LIMIT_KEYS.contains(&limit.as_str()) {
            return Err(invalid_room(format!(
                "stopReason.limit {} is not a room limit",
                preview(limit)
            )));
        }
    }
    Ok(())
}

pub fn validate_record(room_id: &str, record: &RoomJournalRecord) -> Result<(), RoomError> {
    match record {
        RoomJournalRecord::TurnStart { turn_id, .. } => validate_field_id("turnId", turn_id),
        RoomJournalRecord::Message { message } => {
            if message.v != ROOM_SCHEMA_VERSION {
                return Err(invalid_room(format!(
                    "unsupported message schema version {} (expected {ROOM_SCHEMA_VERSION})",
                    message.v
                )));
            }
            validate_field_id("message.id", &message.id)?;
            if message.room_id != room_id {
                return Err(invalid_room(format!(
                    "message.roomId {} does not match room {}",
                    preview(&message.room_id),
                    preview(room_id)
                )));
            }
            if let Some(turn_id) = &message.turn_id {
                validate_field_id("message.turnId", turn_id)?;
            }
            let length = text_length(&message.text);
            if length > MAX_TEXT_LENGTH {
                return Err(too_large(format!(
                    "message text is {length} chars; at most {MAX_TEXT_LENGTH} are allowed"
                )));
            }
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/// Temp file in the target's directory, flushed, then renamed over the target.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), RoomError> {
    let dir = path
        .parent()
        .ok_or_else(|| RoomError::new(RoomErrorCode::Io, "room file has no parent directory"))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("room");
    let tmp = dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| RoomError::new(RoomErrorCode::Io, format!("write {file_name}: {e}")))
}

fn read_room_file(path: &Path) -> Result<Room, RoomError> {
    let bytes = fs::read(path).map_err(|e| io_error("read room.json", e))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| invalid_room(format!("stored room.json is unreadable: {e}")))
}

struct JournalScan {
    records: Vec<RoomJournalRecord>,
    /// Byte length of the file worth keeping: everything up to the last
    /// newline, plus a trailing unterminated line only if it parses.
    keep_len: usize,
    /// The kept content ends in a complete record without its newline.
    missing_newline: bool,
}

fn parse_line(line: &[u8]) -> Option<RoomJournalRecord> {
    let text = std::str::from_utf8(line).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// Reads journal bytes. Unparseable terminated lines are skipped; an
/// unterminated trailing line that does not parse is a torn write and is
/// dropped.
fn scan_journal(bytes: &[u8]) -> JournalScan {
    let mut records = Vec::new();
    let mut pos = 0;
    let mut keep_len = 0;
    let mut missing_newline = false;
    while pos < bytes.len() {
        match bytes[pos..].iter().position(|&b| b == b'\n') {
            Some(offset) => {
                if let Some(record) = parse_line(&bytes[pos..pos + offset]) {
                    records.push(record);
                }
                pos += offset + 1;
                keep_len = pos;
            }
            None => {
                if let Some(record) = parse_line(&bytes[pos..]) {
                    records.push(record);
                    keep_len = bytes.len();
                    missing_newline = true;
                }
                pos = bytes.len();
            }
        }
    }
    JournalScan {
        records,
        keep_len,
        missing_newline,
    }
}

fn read_journal_bytes(path: &Path) -> Result<Vec<u8>, RoomError> {
    match fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(RoomError::new(
            RoomErrorCode::Io,
            format!("read journal.jsonl: {e}"),
        )),
    }
}

#[derive(Deserialize)]
struct StoredRev {
    rev: u64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RoomStore {
    root: PathBuf,
}

impl RoomStore {
    /// `root` is the `rooms` directory itself.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn for_data_folder(data_folder: &Path) -> Self {
        Self::new(data_folder.join(ROOMS_DIR))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn room_dir(&self, room_id: &str) -> Result<PathBuf, RoomError> {
        validate_id(room_id)?;
        Ok(self.root.join(room_id))
    }

    /// Newest `updatedAt` first (ties by id). Rooms that cannot be read are
    /// skipped.
    pub fn list(&self) -> Result<Vec<RoomSummary>, RoomError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(RoomError::new(
                    RoomErrorCode::Io,
                    format!("read rooms directory: {e}"),
                ))
            }
        };
        let mut summaries = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_id(&name).is_err()
                || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            {
                continue;
            }
            let Ok(room) = read_room_file(&entry.path().join(ROOM_FILE)) else {
                continue;
            };
            if room.id != name {
                continue;
            }
            summaries.push(RoomSummary {
                participant_count: room.participants.iter().filter(|p| !p.removed).count(),
                turns: room.usage.turns,
                id: room.id,
                title: room.title,
                objective: room.objective,
                status: room.status,
                mode: room.mode,
                updated_at: room.updated_at,
                created_at: room.created_at,
            });
        }
        summaries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(summaries)
    }

    pub fn get(&self, room_id: &str) -> Result<RoomWithJournal, RoomError> {
        let dir = self.room_dir(room_id)?;
        let room = read_room_file(&dir.join(ROOM_FILE)).map_err(|e| match e.code {
            RoomErrorCode::NotFound => {
                RoomError::new(RoomErrorCode::NotFound, format!("room {room_id} not found"))
            }
            _ => e,
        })?;
        if room.id != room_id {
            return Err(invalid_room(format!(
                "stored room id {} does not match directory {room_id}",
                preview(&room.id)
            )));
        }
        let journal = scan_journal(&read_journal_bytes(&dir.join(JOURNAL_FILE))?).records;
        Ok(RoomWithJournal { room, journal })
    }

    /// Optimistic save: `room.rev` must equal the stored rev (0 when no room
    /// file exists). Stores and returns the room with `rev + 1` and
    /// `updatedAt = now_ms`.
    pub fn save(&self, mut room: Room, now_ms: u64) -> Result<Room, RoomError> {
        validate_room(&room)?;
        let dir = self.room_dir(&room.id)?;
        let path = dir.join(ROOM_FILE);

        let _guard = write_guard();
        let stored_rev = match fs::read(&path) {
            Ok(bytes) => Some(
                serde_json::from_slice::<StoredRev>(&bytes)
                    .map_err(|e| invalid_room(format!("stored room.json is unreadable: {e}")))?
                    .rev,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(RoomError::new(
                    RoomErrorCode::Io,
                    format!("read room.json: {e}"),
                ))
            }
        };
        let expected = stored_rev.unwrap_or(0);
        if room.rev != expected {
            let message = match stored_rev {
                Some(stored) => format!(
                    "room {} was saved at rev {}, but the stored rev is {stored}",
                    room.id, room.rev
                ),
                None => format!(
                    "room {} does not exist; a new room must be saved with rev 0 (got {})",
                    room.id, room.rev
                ),
            };
            return Err(RoomError::new(RoomErrorCode::StaleRevision, message));
        }

        room.rev = expected + 1;
        room.updated_at = now_ms;
        let bytes = serde_json::to_vec(&room)
            .map_err(|e| RoomError::new(RoomErrorCode::Unknown, format!("serialize room: {e}")))?;
        if bytes.len() > MAX_ROOM_BYTES {
            return Err(too_large(format!(
                "room.json would be {} bytes; at most {MAX_ROOM_BYTES} are allowed",
                bytes.len()
            )));
        }
        fs::create_dir_all(&dir).map_err(|e| {
            RoomError::new(RoomErrorCode::Io, format!("create room directory: {e}"))
        })?;
        write_atomically(&path, &bytes)?;
        Ok(room)
    }

    /// Appends one journal record. Message records get `seq = max + 1` and are
    /// idempotent by message id; turn-start records are idempotent by turn id.
    /// Returns the stored record.
    pub fn append(
        &self,
        room_id: &str,
        mut record: RoomJournalRecord,
    ) -> Result<RoomJournalRecord, RoomError> {
        let dir = self.room_dir(room_id)?;
        validate_record(room_id, &record)?;

        let _guard = write_guard();
        if !dir.join(ROOM_FILE).is_file() {
            return Err(RoomError::new(
                RoomErrorCode::NotFound,
                format!("room {room_id} not found"),
            ));
        }
        let path = dir.join(JOURNAL_FILE);
        let bytes = read_journal_bytes(&path)?;
        let scan = scan_journal(&bytes);

        match &mut record {
            RoomJournalRecord::Message { message } => {
                let mut max_seq = 0;
                for existing in &scan.records {
                    if let RoomJournalRecord::Message { message: stored } = existing {
                        if stored.id == message.id {
                            return Ok(existing.clone());
                        }
                        max_seq = max_seq.max(stored.seq);
                    }
                }
                message.seq = max_seq + 1;
            }
            RoomJournalRecord::TurnStart { turn_id, .. } => {
                let duplicate = scan.records.iter().find(|existing| {
                    matches!(existing, RoomJournalRecord::TurnStart { turn_id: stored, .. } if stored == turn_id)
                });
                if let Some(existing) = duplicate {
                    return Ok(existing.clone());
                }
            }
        }

        let mut line = serde_json::to_vec(&record).map_err(|e| {
            RoomError::new(
                RoomErrorCode::Unknown,
                format!("serialize journal record: {e}"),
            )
        })?;
        if line.len() > MAX_JOURNAL_LINE_BYTES {
            return Err(too_large(format!(
                "journal record is {} bytes; at most {MAX_JOURNAL_LINE_BYTES} are allowed",
                line.len()
            )));
        }
        if scan.missing_newline {
            line.insert(0, b'\n');
        }
        line.push(b'\n');

        let write = || -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)?;
            if scan.keep_len < bytes.len() {
                // Cut the torn tail so the new record starts on a fresh line.
                file.set_len(scan.keep_len as u64)?;
            }
            file.seek(SeekFrom::Start(scan.keep_len as u64))?;
            file.write_all(&line)?;
            file.sync_data()
        };
        write()
            .map_err(|e| RoomError::new(RoomErrorCode::Io, format!("append journal.jsonl: {e}")))?;
        Ok(record)
    }

    pub fn delete(&self, room_id: &str) -> Result<(), RoomError> {
        let dir = self.room_dir(room_id)?;
        let _guard = write_guard();
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(RoomError::new(
                    RoomErrorCode::NotFound,
                    format!("room {room_id} not found"),
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(RoomError::new(
                    RoomErrorCode::NotFound,
                    format!("room {room_id} not found"),
                ))
            }
            Err(e) => {
                return Err(RoomError::new(
                    RoomErrorCode::Io,
                    format!("inspect room directory: {e}"),
                ))
            }
        }
        fs::remove_dir_all(&dir)
            .map_err(|e| RoomError::new(RoomErrorCode::Io, format!("delete room {room_id}: {e}")))
    }
}
