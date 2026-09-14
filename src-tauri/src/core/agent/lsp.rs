//! Language servers, spoken to over the Language Server Protocol.
//! AH-057 (the client), AH-058 (the servers' lifecycle).
//!
//! The project index (`index.rs`) locates names by reading text. It does not
//! resolve them: it cannot say which of two `Close` methods `f.Close()` calls,
//! and for a language whose declarations it does not recognise -- Go, until a
//! server answers -- it cannot say anything. A language server can, because it
//! type-checks the code. `lsp` is how the agent asks one.
//!
//! ## What is spoken
//!
//! JSON-RPC 2.0 over the server's stdin and stdout, framed with
//! `Content-Length` headers. The client sends `initialize`/`initialized`, keeps
//! each file it asks about open with its current contents from disk
//! (`didOpen`, then `didChange` with the full text when the file changed), and
//! asks `definition`, `references`, `implementation` and `hover`. Diagnostics
//! arrive as `publishDiagnostics` notifications and are kept per file. Requests
//! the server sends the client (`workspace/configuration`, progress creation)
//! are answered with defaults, so a server that asks is not left waiting.
//!
//! ## Which servers
//!
//! [`SERVERS`] names the ones this build knows how to start, by file extension:
//! Go files go to `gopls`. A server is used only when it is already on PATH.
//! Nothing is installed or downloaded -- a missing server is a refusal that says
//! so -- and a server is started with `GOPROXY=off` and `GOTOOLCHAIN=local`, so
//! starting one never fetches a module or a toolchain behind the user's back.
//! Its environment is the shell's allowlist plus the variables the toolchain
//! needs, never the host's whole environment: the API keys a run holds are not
//! the language server's business.
//!
//! ## Lifecycle
//!
//! A server is started the first time a run asks about a file it covers, and
//! kept for the rest of the run ([`LspPool`], owned by the run's tool invoker).
//!
//! * **Health.** Before each use the process is checked; one that has exited is
//!   noticed then, not after a request hangs. A request that outlives its
//!   deadline marks the server unhealthy and it is replaced on the next use: a
//!   wedged server is not asked again.
//! * **Restart.** A dead or wedged server is restarted, at most
//!   [`MAX_RESTARTS`] times in a run; after that the refusal says it kept
//!   failing, instead of restarting it forever.
//! * **Shutdown with the run.** When the run ends the pool sends `shutdown` and
//!   `exit`, waits briefly, and then stops the process tree.
//! * **Cancellation.** A cancelled request stops waiting at once (and tells the
//!   server with `$/cancelRequest`). The server's process is adopted by the
//!   run's cancellation token, so stopping the run stops the server; it is
//!   registered for the application's shutdown reaping; and on Windows it runs
//!   in a kill-on-close job, so it cannot outlive Flint even if Flint is killed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

/// One language server this build knows how to start.
#[derive(Debug, Clone, Copy)]
pub struct ServerSpec {
    pub language: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub extensions: &'static [&'static str],
    /// The language id sent with `didOpen`.
    pub language_id: &'static str,
}

/// The servers this build speaks to. Only what has been exercised is listed.
pub const SERVERS: &[ServerSpec] = &[ServerSpec {
    language: "go",
    program: "gopls",
    args: &["serve"],
    extensions: &["go"],
    language_id: "go",
}];

/// How many times one server is restarted in a run before it is refused.
pub const MAX_RESTARTS: u32 = 3;

const INITIALIZE_DEADLINE: Duration = Duration::from_secs(60);
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
const DIAGNOSTICS_WAIT: Duration = Duration::from_secs(8);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// The largest message read from a server. A bigger one is a protocol error,
/// not a reason to allocate whatever the header says.
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
/// The largest file sent to a server.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOCATIONS: usize = 100;
const MAX_HOVER_CHARS: usize = 4000;
const MAX_LINE_CHARS: usize = 200;
const POLL: Duration = Duration::from_millis(25);

/// The variables a server's toolchain needs beyond the shell's allowlist.
const TOOLCHAIN_ENV: &[&str] = &[
    "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE", "GOENV", "GOFLAGS", "GOPRIVATE", "GONOSUMDB",
    "GOWORK", "LOCALAPPDATA", "APPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "ProgramFiles",
    "ProgramData", "SystemDrive", "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERNAME",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LspErrorKind {
    /// `[tools] lsp = false` in the project.
    Disabled,
    /// No server this build knows covers the file.
    UnsupportedFile,
    /// The server is not on PATH. Nothing is installed.
    ServerUnavailable,
    /// The server could not be started or did not finish initializing.
    StartFailed,
    /// The server kept dying and is not restarted again this run.
    ServerFailing,
    /// The server exited while a request was waiting.
    ServerCrashed,
    Timeout,
    Cancelled,
    /// The request was not something a server can be asked.
    InvalidInput,
    /// The server answered with an error or something unreadable.
    Protocol,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspError {
    pub kind: LspErrorKind,
    pub message: String,
}

impl LspError {
    fn new(kind: LspErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for LspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<&LspError> for HarnessError {
    fn from(error: &LspError) -> Self {
        let kind = match error.kind {
            LspErrorKind::Disabled | LspErrorKind::UnsupportedFile => ErrorKind::Unsupported,
            LspErrorKind::ServerUnavailable => ErrorKind::ToolUnavailable,
            LspErrorKind::StartFailed | LspErrorKind::ServerFailing | LspErrorKind::ServerCrashed => {
                ErrorKind::ToolFailed
            }
            LspErrorKind::Timeout => ErrorKind::Timeout,
            LspErrorKind::Cancelled => ErrorKind::Cancelled,
            LspErrorKind::InvalidInput => ErrorKind::InvalidInput,
            LspErrorKind::Protocol => ErrorKind::InvalidResponse,
        };
        HarnessError::new(kind, error.message.clone())
    }
}

/// Whether the project allows language servers: `[tools] lsp = false` in
/// `.jan/agent/agent.toml` turns them off. On unless said otherwise -- nothing
/// is started until a file a server covers is asked about.
pub fn enabled(project_root: &Path) -> bool {
    let path = project_root.join(".jan").join("agent").join("agent.toml");
    let Ok(raw) = std::fs::read_to_string(path) else { return true };
    let Ok(doc) = raw.parse::<toml::Value>() else { return true };
    doc.get("tools").and_then(|t| t.get("lsp")).and_then(toml::Value::as_bool).unwrap_or(true)
}

/// The server that covers `path`, if any.
pub fn server_for(servers: &'static [ServerSpec], path: &Path) -> Option<&'static ServerSpec> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    servers.iter().find(|s| s.extensions.contains(&extension.as_str()))
}

/// The environment a server is started with: the allowlisted variables from
/// `source`, and the two that keep it from fetching anything.
pub fn server_env(source: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let allowed = |key: &str| {
        tauri_plugin_agent_tools::tools::proc::SANDBOX_ENV_ALLOW
            .iter()
            .chain(TOOLCHAIN_ENV.iter())
            .any(|k| k.eq_ignore_ascii_case(key))
    };
    let mut env: Vec<(String, String)> = source
        .into_iter()
        .filter(|(k, _)| allowed(k) && !k.eq_ignore_ascii_case("GOPROXY") && !k.eq_ignore_ascii_case("GOTOOLCHAIN"))
        .collect();
    env.push(("GOPROXY".to_string(), "off".to_string()));
    env.push(("GOTOOLCHAIN".to_string(), "local".to_string()));
    env
}

// ---------------------------------------------------------------------------
// Framing

/// One message, framed for the wire.
pub fn encode(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Read one framed message. `Ok(None)` at a clean end of stream.
pub fn decode(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut length: Option<usize> = None;
    let mut saw_header = false;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|e| format!("reading from the server failed: {e}"))?;
        if read == 0 {
            return if saw_header { Err("the server's stream ended inside a message".to_string()) } else { Ok(None) };
        }
        saw_header = true;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = Some(value.trim().parse().map_err(|_| format!("a bad Content-Length: {value:?}"))?);
            }
        }
    }
    let length = length.ok_or_else(|| "a message without a Content-Length".to_string())?;
    if length > MAX_MESSAGE_BYTES {
        return Err(format!("a {length}-byte message is larger than {MAX_MESSAGE_BYTES} bytes"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|e| format!("the server's message was cut short: {e}"))?;
    serde_json::from_slice(&body).map(Some).map_err(|e| format!("the server sent something that is not JSON: {e}"))
}

// ---------------------------------------------------------------------------
// Positions: the model counts characters from 1; LSP counts UTF-16 units from 0.

/// The UTF-16 offset of the 1-based character `column` in `line`.
pub fn to_lsp_character(line: &str, column: usize) -> u32 {
    line.chars().take(column.saturating_sub(1)).map(|c| c.len_utf16() as u32).sum()
}

/// The 1-based character column of the UTF-16 offset `utf16` in `line`.
pub fn from_lsp_character(line: &str, utf16: u64) -> usize {
    let mut units = 0u64;
    let mut column = 1;
    for c in line.chars() {
        if units >= utf16 {
            break;
        }
        units += c.len_utf16() as u64;
        column += 1;
    }
    column
}

pub fn file_uri(path: &Path) -> Option<String> {
    url::Url::from_file_path(path).ok().map(|u| u.to_string())
}

fn path_of_uri(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

// ---------------------------------------------------------------------------
// One server process

type Reply = Result<Value, String>;

struct Connection {
    child: Child,
    owned: tauri_plugin_agent_tools::tools::owned::OwnedChild,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>,
    diagnostics: Arc<Mutex<HashMap<String, (u64, Vec<Value>)>>>,
    /// Bumped on every `publishDiagnostics`, so a wait can see a new one.
    published: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    healthy: AtomicBool,
    reader: Option<std::thread::JoinHandle<()>>,
    /// uri -> (version, a hash of the text last sent).
    opened: Mutex<HashMap<String, (i64, u64)>>,
    started: Instant,
    token: Option<tauri_plugin_agent_tools::lifecycle::Token>,
}

fn hash_text(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

fn write_message(stdin: &Mutex<ChildStdin>, message: &Value) -> Result<(), String> {
    let bytes = encode(message);
    let mut guard = stdin.lock().unwrap_or_else(|p| p.into_inner());
    guard.write_all(&bytes).and_then(|_| guard.flush()).map_err(|e| format!("writing to the server failed: {e}"))
}

impl Connection {
    fn start(
        spec: &ServerSpec,
        program: &Path,
        project: &Path,
        token: Option<tauri_plugin_agent_tools::lifecycle::Token>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Connection, LspError> {
        let mut cmd = Command::new(program);
        cmd.args(spec.args)
            .current_dir(project)
            .env_clear()
            .envs(server_env(std::env::vars()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        tauri_plugin_agent_tools::tools::owned::configure(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| {
            LspError::new(LspErrorKind::StartFailed, format!("{} could not be started: {e}", spec.program))
        })?;
        let pid = child.id();
        let owned = match tauri_plugin_agent_tools::tools::owned::OwnedChild::own(pid) {
            Ok(owned) => owned,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LspError::new(
                    LspErrorKind::StartFailed,
                    format!("{} was started but could not be tied to this run, so it was stopped: {e}", spec.program),
                ));
            }
        };
        tauri_plugin_agent_tools::tools::proc::register(pid);
        if let Some(token) = &token {
            token.adopt(pid);
        }
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin was piped")));
        let stdout = child.stdout.take().expect("stdout was piped");
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>> = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics = Arc::new(Mutex::new(HashMap::new()));
        let published = Arc::new(AtomicU64::new(0));
        let alive = Arc::new(AtomicBool::new(true));
        let reader = {
            let pending = pending.clone();
            let diagnostics = diagnostics.clone();
            let published = published.clone();
            let alive = alive.clone();
            let stdin = stdin.clone();
            std::thread::spawn(move || read_loop(BufReader::new(stdout), stdin, pending, diagnostics, published, alive))
        };
        let mut connection = Connection {
            child,
            owned,
            stdin,
            next_id: AtomicU64::new(1),
            pending,
            diagnostics,
            published,
            alive,
            healthy: AtomicBool::new(true),
            reader: Some(reader),
            opened: Mutex::new(HashMap::new()),
            started: Instant::now(),
            token,
        };
        let root = file_uri(project).unwrap_or_default();
        let name = project.file_name().and_then(|n| n.to_str()).unwrap_or("project").to_string();
        let initialized = connection.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root,
                "workspaceFolders": [{ "uri": root, "name": name }],
                "capabilities": {
                    "textDocument": {
                        "synchronization": { "didSave": false },
                        "hover": { "contentFormat": ["plaintext", "markdown"] },
                        "definition": {},
                        "references": {},
                        "implementation": {},
                        "publishDiagnostics": { "relatedInformation": false }
                    },
                    "workspace": { "configuration": true, "workspaceFolders": true }
                },
                "clientInfo": { "name": "Flint" }
            }),
            INITIALIZE_DEADLINE,
            cancel,
        );
        if let Err(e) = initialized {
            connection.stop();
            return Err(match e.kind {
                LspErrorKind::Cancelled => e,
                _ => LspError::new(
                    LspErrorKind::StartFailed,
                    format!("{} did not finish starting: {}", spec.program, e.message),
                ),
            });
        }
        if let Err(e) = connection.notify("initialized", json!({})) {
            connection.stop();
            return Err(LspError::new(LspErrorKind::StartFailed, e));
        }
        Ok(connection)
    }

    fn pid(&self) -> u32 {
        self.owned.pid()
    }

    /// Whether the process is still there and has not been caught wedged.
    fn is_usable(&mut self) -> bool {
        if !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        if let Ok(Some(_)) = self.child.try_wait() {
            self.alive.store(false, Ordering::SeqCst);
            return false;
        }
        self.healthy.load(Ordering::SeqCst)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        write_message(&self.stdin, &json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn request(&self, method: &str, params: Value, deadline: Duration, cancel: &dyn Fn() -> bool) -> Result<Value, LspError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, tx);
        let sent = write_message(&self.stdin, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if let Err(e) = sent {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            self.alive.store(false, Ordering::SeqCst);
            return Err(LspError::new(LspErrorKind::ServerCrashed, e));
        }
        let until = Instant::now() + deadline;
        loop {
            match rx.recv_timeout(POLL) {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(message)) => {
                    if !self.alive.load(Ordering::SeqCst) {
                        return Err(LspError::new(LspErrorKind::ServerCrashed, message));
                    }
                    return Err(LspError::new(LspErrorKind::Protocol, format!("the server refused {method}: {message}")));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(LspError::new(LspErrorKind::ServerCrashed, "the language server exited while answering"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let stop = if cancel() {
                Some(LspError::new(LspErrorKind::Cancelled, format!("{method} was cancelled with the run")))
            } else if Instant::now() >= until {
                // A server that does not answer in this long is not asked again.
                self.healthy.store(false, Ordering::SeqCst);
                Some(LspError::new(
                    LspErrorKind::Timeout,
                    format!("the language server did not answer {method} within {}s", deadline.as_secs()),
                ))
            } else if !self.alive.load(Ordering::SeqCst) {
                Some(LspError::new(LspErrorKind::ServerCrashed, "the language server exited while answering"))
            } else {
                None
            };
            if let Some(error) = stop {
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                let _ = self.notify("$/cancelRequest", json!({ "id": id }));
                return Err(error);
            }
        }
    }

    /// Make the server see `path` as it is on disk now.
    fn sync(&self, spec: &ServerSpec, path: &Path) -> Result<(String, String), LspError> {
        let metadata = std::fs::metadata(path)
            .map_err(|e| LspError::new(LspErrorKind::InvalidInput, format!("{} cannot be read: {e}", path.display())))?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(LspError::new(
                LspErrorKind::InvalidInput,
                format!("{} is {} bytes; files over {MAX_FILE_BYTES} bytes are not sent to a language server", path.display(), metadata.len()),
            ));
        }
        let text = std::fs::read_to_string(path)
            .map_err(|e| LspError::new(LspErrorKind::InvalidInput, format!("{} is not readable text: {e}", path.display())))?;
        let uri = file_uri(path)
            .ok_or_else(|| LspError::new(LspErrorKind::InvalidInput, format!("{} has no file URI", path.display())))?;
        let hash = hash_text(&text);
        let mut opened = self.opened.lock().unwrap_or_else(|p| p.into_inner());
        let sent = match opened.get(&uri).copied() {
            None => {
                opened.insert(uri.clone(), (1, hash));
                self.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": spec.language_id, "version": 1, "text": text } }),
                )
            }
            Some((_, previous)) if previous == hash => Ok(()),
            Some((version, _)) => {
                opened.insert(uri.clone(), (version + 1, hash));
                self.notify(
                    "textDocument/didChange",
                    json!({ "textDocument": { "uri": uri, "version": version + 1 }, "contentChanges": [{ "text": text }] }),
                )
            }
        };
        sent.map_err(|e| {
            self.alive.store(false, Ordering::SeqCst);
            LspError::new(LspErrorKind::ServerCrashed, e)
        })?;
        Ok((uri, text))
    }

    /// Ask the server to end, then make sure it has.
    fn stop(&mut self) {
        let pid = self.pid();
        if self.alive.load(Ordering::SeqCst) {
            let _ = self.request("shutdown", Value::Null, SHUTDOWN_GRACE, &|| false);
            let _ = self.notify("exit", Value::Null);
            let until = Instant::now() + SHUTDOWN_GRACE;
            while Instant::now() < until {
                if let Ok(Some(_)) = self.child.try_wait() {
                    break;
                }
                std::thread::sleep(POLL);
            }
        }
        self.owned.stop();
        let _ = self.child.wait();
        self.alive.store(false, Ordering::SeqCst);
        tauri_plugin_agent_tools::tools::proc::unregister(pid);
        if let Some(token) = &self.token {
            token.release(pid);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_loop(
    mut reader: BufReader<std::process::ChildStdout>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>,
    diagnostics: Arc<Mutex<HashMap<String, (u64, Vec<Value>)>>>,
    published: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
) {
    let ending = loop {
        let message = match decode(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break "the language server exited".to_string(),
            Err(e) => break e,
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        match (method, id) {
            // A reply to one of ours.
            (None, Some(id)) => {
                let Some(id) = id.as_u64() else { continue };
                let sender = pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                if let Some(sender) = sender {
                    let reply = match message.get("error") {
                        Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("an error").to_string()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = sender.send(reply);
                }
            }
            // A request from the server: answered with defaults, so it is not
            // left waiting on a client that has nothing to configure.
            (Some(method), Some(id)) => {
                let result = if method == "workspace/configuration" {
                    let items = message
                        .get("params")
                        .and_then(|p| p.get("items"))
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    Value::Array(vec![Value::Null; items])
                } else {
                    Value::Null
                };
                let _ = write_message(&stdin, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            }
            (Some("textDocument/publishDiagnostics"), None) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if let Some(uri) = params.get("uri").and_then(Value::as_str) {
                    let found = params.get("diagnostics").and_then(Value::as_array).cloned().unwrap_or_default();
                    let seq = published.fetch_add(1, Ordering::SeqCst) + 1;
                    diagnostics.lock().unwrap_or_else(|p| p.into_inner()).insert(uri.to_string(), (seq, found));
                }
            }
            _ => {}
        }
    };
    alive.store(false, Ordering::SeqCst);
    // Everyone still waiting learns why, instead of waiting out a deadline.
    let waiting: Vec<mpsc::Sender<Reply>> = pending.lock().unwrap_or_else(|p| p.into_inner()).drain().map(|(_, s)| s).collect();
    for sender in waiting {
        let _ = sender.send(Err(ending.clone()));
    }
}

// ---------------------------------------------------------------------------
// The pool a run owns

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Definition,
    References,
    Implementation,
    Hover,
    Diagnostics,
    Status,
}

impl Action {
    pub fn parse(raw: &str) -> Option<Action> {
        Some(match raw {
            "definition" => Action::Definition,
            "references" => Action::References,
            "implementation" => Action::Implementation,
            "hover" => Action::Hover,
            "diagnostics" => Action::Diagnostics,
            "status" => Action::Status,
            _ => return None,
        })
    }
}

/// One question for a server. `line` and `column` are 1-based characters.
#[derive(Debug, Clone)]
pub struct Query {
    pub action: Action,
    pub path: PathBuf,
    pub line: usize,
    pub column: usize,
}

#[derive(Default)]
struct Slot {
    connection: Option<Connection>,
    restarts: u32,
    starts: u32,
    last_failure: Option<String>,
}

/// The language servers one run has started.
pub struct LspPool {
    project: PathBuf,
    enabled: bool,
    servers: &'static [ServerSpec],
    slots: Mutex<HashMap<&'static str, Slot>>,
}

impl LspPool {
    pub fn new(project: &Path) -> Self {
        Self::with_servers(project, enabled(project), SERVERS)
    }

    pub fn with_servers(project: &Path, enabled: bool, servers: &'static [ServerSpec]) -> Self {
        Self { project: project.to_path_buf(), enabled, servers, slots: Mutex::new(HashMap::new()) }
    }

    /// A pool that starts nothing, for runs and tests with no project.
    pub fn disabled() -> Self {
        Self::with_servers(Path::new(""), false, SERVERS)
    }

    /// The process id of the server for `language`, when one is running.
    pub fn running_pid(&self, language: &str) -> Option<u32> {
        let slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        slots.get(language).and_then(|s| s.connection.as_ref()).map(Connection::pid)
    }

    /// How many times the server for `language` was restarted this run.
    pub fn restarts(&self, language: &str) -> u32 {
        self.slots.lock().unwrap_or_else(|p| p.into_inner()).get(language).map(|s| s.restarts).unwrap_or(0)
    }

    /// Answer one question. `cancel` is polled while waiting.
    pub fn run(
        &self,
        query: &Query,
        token: Option<tauri_plugin_agent_tools::lifecycle::Token>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<String, LspError> {
        if query.action == Action::Status {
            return Ok(self.status());
        }
        if !self.enabled {
            return Err(LspError::new(
                LspErrorKind::Disabled,
                "language servers are turned off for this project ([tools] lsp = false)",
            ));
        }
        let spec = server_for(self.servers, &query.path).ok_or_else(|| {
            LspError::new(
                LspErrorKind::UnsupportedFile,
                format!(
                    "no language server this build knows covers {} (known: {})",
                    query.path.display(),
                    self.servers.iter().map(|s| format!(".{} via {}", s.extensions.join("/."), s.program)).collect::<Vec<_>>().join(", ")
                ),
            )
        })?;
        if query.line == 0 || query.column == 0 {
            if query.action != Action::Diagnostics {
                return Err(LspError::new(LspErrorKind::InvalidInput, "line and column are 1-based and must be given"));
            }
        }
        if cancel() {
            return Err(LspError::new(LspErrorKind::Cancelled, "the run was cancelled before the language server was asked"));
        }
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let slot = slots.entry(spec.language).or_default();
        let connection = self.usable_connection(spec, slot, token, cancel)?;
        let answer = ask(connection, spec, &self.project, query, cancel);
        if let Err(e) = &answer {
            if matches!(e.kind, LspErrorKind::ServerCrashed | LspErrorKind::Timeout) {
                slot.last_failure = Some(e.message.clone());
            }
        }
        settle(answer, cancel())
    }

    fn usable_connection<'a>(
        &self,
        spec: &ServerSpec,
        slot: &'a mut Slot,
        token: Option<tauri_plugin_agent_tools::lifecycle::Token>,
        cancel: &dyn Fn() -> bool,
    ) -> Result<&'a Connection, LspError> {
        let needs_start = match slot.connection.as_mut() {
            Some(connection) => !connection.is_usable(),
            None => true,
        };
        if needs_start {
            if let Some(mut dead) = slot.connection.take() {
                // It was started and is no longer usable: that is a restart.
                dead.stop();
                if slot.restarts >= MAX_RESTARTS {
                    return Err(LspError::new(
                        LspErrorKind::ServerFailing,
                        format!(
                            "{} stopped working {} times in this run and is not started again{}",
                            spec.program,
                            slot.restarts + 1,
                            slot.last_failure.as_ref().map(|f| format!(" (last: {f})")).unwrap_or_default()
                        ),
                    ));
                }
                slot.restarts += 1;
            }
            let program = tauri_plugin_agent_tools::tools::owned::find_on_path(spec.program).ok_or_else(|| {
                LspError::new(
                    LspErrorKind::ServerUnavailable,
                    format!(
                        "{} is not on PATH, so {} files cannot be asked about. Jan does not install language servers.",
                        spec.program, spec.language
                    ),
                )
            })?;
            slot.starts += 1;
            slot.connection = Some(Connection::start(spec, &program, &self.project, token, cancel)?);
        }
        Ok(slot.connection.as_ref().expect("started above"))
    }

    fn status(&self) -> String {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = String::new();
        if !self.enabled {
            out.push_str("Language servers are turned off for this project ([tools] lsp = false).\n");
        }
        for spec in self.servers {
            let slot = slots.entry(spec.language).or_default();
            let on_path = tauri_plugin_agent_tools::tools::owned::find_on_path(spec.program);
            let state = match slot.connection.as_mut() {
                Some(c) => {
                    if c.is_usable() {
                        format!("running (pid {}, up {}s)", c.pid(), c.started.elapsed().as_secs())
                    } else {
                        "not answering; replaced on next use".to_string()
                    }
                }
                None if on_path.is_none() => "not on PATH (not installed by Jan)".to_string(),
                None => "not started (starts on first use)".to_string(),
            };
            out.push_str(&format!(
                "{} ({}): {state}; started {} time(s), restarted {} time(s)\n",
                spec.language, spec.program, slot.starts, slot.restarts
            ));
        }
        out
    }

    /// End every server this run started. Also what dropping the pool does.
    pub fn shutdown(&self) {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        for slot in slots.values_mut() {
            if let Some(mut connection) = slot.connection.take() {
                connection.stop();
            }
        }
    }
}

impl Drop for LspPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn ask(connection: &Connection, spec: &ServerSpec, project: &Path, query: &Query, cancel: &dyn Fn() -> bool) -> Result<String, LspError> {
    let before = connection.published.load(Ordering::SeqCst);
    let (uri, text) = connection.sync(spec, &query.path)?;
    let line_text = text.lines().nth(query.line.saturating_sub(1)).unwrap_or("");
    let position = json!({
        "line": query.line.saturating_sub(1),
        "character": to_lsp_character(line_text, query.column),
    });
    let at = json!({ "textDocument": { "uri": uri }, "position": position });
    let shown = display_path(project, &query.path);
    match query.action {
        Action::Definition | Action::Implementation | Action::References => {
            let (method, params, what) = match query.action {
                Action::Definition => ("textDocument/definition", at, "defined"),
                Action::Implementation => ("textDocument/implementation", at, "implemented"),
                _ => {
                    let mut params = at;
                    params["context"] = json!({ "includeDeclaration": true });
                    ("textDocument/references", params, "used")
                }
            };
            let result = connection.request(method, params, REQUEST_DEADLINE, cancel)?;
            let locations = locations_of(&result);
            if locations.is_empty() {
                return Ok(format!(
                    "The language server found nothing {what} for the symbol at {shown}:{}:{}.",
                    query.line, query.column
                ));
            }
            let mut out = format!("{} location(s) where it is {what} ({}):\n", locations.len().min(MAX_LOCATIONS), spec.program);
            for (path, line0, char0) in locations.iter().take(MAX_LOCATIONS) {
                let source = std::fs::read_to_string(path).unwrap_or_default();
                let target = source.lines().nth(*line0 as usize).unwrap_or("");
                let column = from_lsp_character(target, *char0);
                let snippet: String = target.trim().chars().take(MAX_LINE_CHARS).collect();
                out.push_str(&format!("{}:{}:{}  {snippet}\n", display_path(project, path), line0 + 1, column));
            }
            if locations.len() > MAX_LOCATIONS {
                out.push_str(&format!("... and {} more\n", locations.len() - MAX_LOCATIONS));
            }
            Ok(out)
        }
        Action::Hover => {
            let result = connection.request("textDocument/hover", at, REQUEST_DEADLINE, cancel)?;
            let text = hover_text(&result);
            if text.trim().is_empty() {
                return Ok(format!("The language server has nothing to say about {shown}:{}:{}.", query.line, query.column));
            }
            Ok(text.chars().take(MAX_HOVER_CHARS).collect())
        }
        Action::Diagnostics => {
            // Published asynchronously: wait, bounded, for one about this file
            // that arrived after the file was synced.
            let until = Instant::now() + DIAGNOSTICS_WAIT;
            let found = loop {
                if cancel() {
                    return Err(LspError::new(LspErrorKind::Cancelled, "waiting for diagnostics was cancelled with the run"));
                }
                if let Some((seq, found)) = connection.diagnostics.lock().unwrap_or_else(|p| p.into_inner()).get(&uri).cloned() {
                    if seq > before {
                        break Some(found);
                    }
                }
                if Instant::now() >= until {
                    break connection.diagnostics.lock().unwrap_or_else(|p| p.into_inner()).get(&uri).map(|(_, d)| d.clone());
                }
                std::thread::sleep(POLL);
            };
            let Some(found) = found else {
                return Ok(format!("{} reported no diagnostics for {shown} within {}s.", spec.program, DIAGNOSTICS_WAIT.as_secs()));
            };
            if found.is_empty() {
                return Ok(format!("{} reports no problems in {shown}.", spec.program));
            }
            let mut out = format!("{} problem(s) in {shown} ({}):\n", found.len(), spec.program);
            for d in found.iter().take(MAX_LOCATIONS) {
                let line0 = d.pointer("/range/start/line").and_then(Value::as_u64).unwrap_or(0);
                let char0 = d.pointer("/range/start/character").and_then(Value::as_u64).unwrap_or(0);
                let target = text.lines().nth(line0 as usize).unwrap_or("");
                let severity = match d.get("severity").and_then(Value::as_u64) {
                    Some(1) => "error",
                    Some(2) => "warning",
                    Some(3) => "information",
                    Some(4) => "hint",
                    _ => "problem",
                };
                let message: String = d.get("message").and_then(Value::as_str).unwrap_or("").chars().take(MAX_LINE_CHARS).collect();
                out.push_str(&format!("{shown}:{}:{} {severity}: {message}\n", line0 + 1, from_lsp_character(target, char0)));
            }
            Ok(out)
        }
        Action::Status => unreachable!("answered before a server is started"),
    }
}

/// An answer that arrives while the run is being cancelled is not shown: the
/// run stopped, so what the server said afterwards is not part of it. Mirrors
/// `lifecycle::Token::settle`. Found by review (R10): a diagnostics publish that
/// landed just as a cancelled request began was returned as the answer.
fn settle(answer: Result<String, LspError>, cancelled: bool) -> Result<String, LspError> {
    match answer {
        Ok(_) if cancelled => Err(LspError::new(
            LspErrorKind::Cancelled,
            "the run was cancelled; the language server's answer arrived too late to be used",
        )),
        other => other,
    }
}

/// `path` relative to the project when it is inside it; otherwise as it is,
/// marked, so a definition in the standard library is not mistaken for
/// project code.
fn display_path(project: &Path, path: &Path) -> String {
    match relative_to(project, path) {
        Some(relative) => relative,
        None => format!("{} (outside the project)", path.display()),
    }
}

/// `path` relative to `project`, or `None` when it is not inside it.
///
/// Compared by spelling as well as by components, because the two sides arrive
/// spelled differently: the CLI canonicalizes the project root, which on
/// Windows yields the verbatim `\\?\C:\...` form, while a language server
/// reports plain `C:\...` paths (and may case the drive letter differently).
/// Without this every definition in the project read as outside it.
fn relative_to(project: &Path, path: &Path) -> Option<String> {
    if let Ok(relative) = path.strip_prefix(project) {
        return Some(relative.to_string_lossy().replace('\\', "/"));
    }
    let plain = |p: &Path| -> String {
        let text = p.to_string_lossy().replace('\\', "/");
        let text = text.strip_prefix("//?/UNC/").map(|rest| format!("//{rest}")).unwrap_or(text);
        let text = text.strip_prefix("//?/").map(str::to_string).unwrap_or(text);
        if cfg!(windows) { text.to_lowercase() } else { text }
    };
    let root = plain(project);
    let root = root.trim_end_matches('/');
    let target_original = path.to_string_lossy().replace('\\', "/");
    let target = plain(path);
    let rest = target.strip_prefix(root)?.strip_prefix('/')?;
    // Keep the file's own spelling for the part inside the project.
    let keep = target_original.len().checked_sub(rest.len())?;
    Some(target_original[keep..].to_string())
}

/// Locations from a definition/references/implementation result, whichever of
/// the shapes LSP allows it came in: one Location, a list, or LocationLinks.
fn locations_of(result: &Value) -> Vec<(PathBuf, u64, u64)> {
    let items: Vec<&Value> = match result {
        Value::Array(list) => list.iter().collect(),
        Value::Null => Vec::new(),
        single => vec![single],
    };
    items
        .into_iter()
        .filter_map(|item| {
            let uri = item.get("uri").or_else(|| item.get("targetUri")).and_then(Value::as_str)?;
            let range = item.get("range").or_else(|| item.get("targetSelectionRange"))?;
            let line = range.pointer("/start/line").and_then(Value::as_u64)?;
            let character = range.pointer("/start/character").and_then(Value::as_u64)?;
            Some((path_of_uri(uri)?, line, character))
        })
        .collect()
}

fn hover_text(result: &Value) -> String {
    let contents = match result.get("contents") {
        Some(c) => c,
        None => return String::new(),
    };
    let piece = |v: &Value| -> String {
        match v {
            Value::String(s) => s.clone(),
            other => other.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
        }
    };
    match contents {
        Value::Array(list) => list.iter().map(piece).collect::<Vec<_>>().join("\n\n"),
        other => piece(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_round_trips_and_a_bad_frame_is_refused() {
        let message = json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": "caf\u{e9}" } });
        let bytes = encode(&message);
        let mut reader = std::io::Cursor::new(bytes.clone());
        assert_eq!(decode(&mut reader).unwrap(), Some(message));
        assert_eq!(decode(&mut reader).unwrap(), None, "a clean end of stream");

        let oversized = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1);
        assert!(decode(&mut std::io::Cursor::new(oversized.into_bytes())).unwrap_err().contains("larger than"));
        assert!(decode(&mut std::io::Cursor::new(b"X-Other: 1\r\n\r\n{}".to_vec())).unwrap_err().contains("Content-Length"));
        let cut = b"Content-Length: 50\r\n\r\n{\"a\":1}".to_vec();
        assert!(decode(&mut std::io::Cursor::new(cut)).unwrap_err().contains("cut short"));
    }

    /// R10: an answer that arrives as the run is cancelled is refused, never
    /// returned; an error keeps its own kind; a run that is not cancelled gets
    /// its answer.
    #[test]
    fn an_answer_that_arrives_after_cancellation_is_not_returned() {
        let late = settle(Ok("gopls reports no problems in probe.go.".to_string()), true).unwrap_err();
        assert_eq!(late.kind, LspErrorKind::Cancelled);
        let failed = settle(Err(LspError::new(LspErrorKind::Timeout, "slow")), true).unwrap_err();
        assert_eq!(failed.kind, LspErrorKind::Timeout);
        assert_eq!(settle(Ok("answer".to_string()), false).unwrap(), "answer");

        // And a pool asked with the run already cancelled starts nothing.
        let dir = project_with(&[("a.go", "package a
")], None);
        let pool = LspPool::with_servers(dir.path(), true, SERVERS);
        let refused = pool.run(&query(Action::Hover, dir.path(), "a.go", 1, 1), None, &|| true).unwrap_err();
        assert_eq!(refused.kind, LspErrorKind::Cancelled);
        assert!(pool.running_pid("go").is_none(), "a cancelled run started a server");
    }

    /// A project root canonicalized to Windows' verbatim form is the same
    /// folder as the plain path a language server reports: its files are
    /// inside the project, not outside it.
    #[test]
    fn a_location_in_the_project_is_shown_relative_however_the_root_is_spelled() {
        #[cfg(windows)]
        {
            let project = Path::new(r"\\?\C:\tmp\jan-p6-lsp\project");
            assert_eq!(display_path(project, Path::new(r"C:\tmp\jan-p6-lsp\project\probe.go")), "probe.go");
            assert_eq!(display_path(project, Path::new(r"c:\tmp\jan-p6-lsp\project\sub\Probe.go")), "sub/Probe.go");
            assert_eq!(
                display_path(Path::new(r"C:\tmp\jan-p6-lsp\project"), Path::new(r"\\?\C:\tmp\jan-p6-lsp\project\probe.go")),
                "probe.go"
            );
            assert!(display_path(project, Path::new(r"C:\tmp\jan-p6-lsp\projectile\x.go")).ends_with("(outside the project)"));
            assert!(display_path(project, Path::new(r"C:\Program Files\Go\src\io\io.go")).ends_with("(outside the project)"));
        }
        let project = Path::new("/work/project");
        assert_eq!(display_path(project, Path::new("/work/project/a/b.go")), "a/b.go");
        assert!(display_path(project, Path::new("/work/projects/b.go")).ends_with("(outside the project)"));
    }

    #[test]
    fn columns_are_characters_for_the_model_and_utf16_for_the_server() {
        let line = "s := \"h\u{e9}llo \u{1F600}\"; x";
        // `x` is the 16th character; the emoji is two UTF-16 units.
        let column = line.chars().position(|c| c == 'x').unwrap() + 1;
        let utf16 = to_lsp_character(line, column);
        assert_eq!(utf16 as usize, line.chars().take(column - 1).map(char::len_utf16).sum::<usize>());
        assert_eq!(from_lsp_character(line, utf16 as u64), column);
        assert_eq!(to_lsp_character(line, 1), 0);
    }

    #[test]
    fn the_server_gets_no_secrets_and_cannot_fetch() {
        let env = server_env(vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("GOPATH".to_string(), "/go".to_string()),
            ("JAN_API_KEY".to_string(), "secret-1".to_string()),
            ("OPENAI_API_KEY".to_string(), "secret-2".to_string()),
            ("GOPROXY".to_string(), "https://proxy.golang.org".to_string()),
        ]);
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"PATH") && keys.contains(&"GOPATH"));
        assert!(!env.iter().any(|(_, v)| v.starts_with("secret-")), "{env:?}");
        assert_eq!(env.iter().filter(|(k, _)| k == "GOPROXY").map(|(_, v)| v.as_str()).collect::<Vec<_>>(), vec!["off"]);
        assert!(env.contains(&("GOTOOLCHAIN".to_string(), "local".to_string())));
    }

    fn project_with(files: &[(&str, &str)], toml: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        if let Some(toml) = toml {
            std::fs::create_dir_all(dir.path().join(".jan/agent")).unwrap();
            std::fs::write(dir.path().join(".jan/agent/agent.toml"), toml).unwrap();
        }
        dir
    }

    fn query(action: Action, dir: &Path, file: &str, line: usize, column: usize) -> Query {
        Query { action, path: dir.join(file), line, column }
    }

    static MISSING: &[ServerSpec] = &[ServerSpec {
        language: "go",
        program: "jan-no-such-language-server-7d2",
        args: &[],
        extensions: &["go"],
        language_id: "go",
    }];

    #[test]
    fn what_cannot_be_asked_is_refused_by_kind_and_starts_nothing() {
        let dir = project_with(&[("a.go", "package a\n"), ("notes.txt", "hello\n")], None);
        let pool = LspPool::with_servers(dir.path(), true, MISSING);
        let refused = pool.run(&query(Action::Definition, dir.path(), "a.go", 1, 1), None, &|| false).unwrap_err();
        assert_eq!(refused.kind, LspErrorKind::ServerUnavailable);
        assert!(refused.message.contains("does not install"), "{}", refused.message);
        assert_eq!(HarnessError::from(&refused).kind(), ErrorKind::ToolUnavailable);
        assert!(pool.running_pid("go").is_none());

        let refused = pool.run(&query(Action::Hover, dir.path(), "notes.txt", 1, 1), None, &|| false).unwrap_err();
        assert_eq!(refused.kind, LspErrorKind::UnsupportedFile);

        let off = project_with(&[("a.go", "package a\n")], Some("[tools]\nlsp = false\n"));
        assert!(!enabled(off.path()));
        let pool = LspPool::new(off.path());
        let refused = pool.run(&query(Action::Definition, off.path(), "a.go", 1, 1), None, &|| false).unwrap_err();
        assert_eq!(refused.kind, LspErrorKind::Disabled);
        assert!(pool.running_pid("go").is_none());
    }

    /// The tests below speak to the real gopls. It is a platform requirement
    /// of AH-057/058; a machine without it fails these loudly unless the skip
    /// is asked for by name, never silently.
    fn gopls_or_explicit_skip() -> bool {
        if tauri_plugin_agent_tools::tools::owned::find_on_path("gopls").is_some() {
            return true;
        }
        if crate::core::compat_env::var("SKIP_LSP_TESTS").as_deref() == Ok("1") {
            eprintln!("gopls is not on PATH and JAN_SKIP_LSP_TESTS=1: skipping");
            return false;
        }
        panic!("gopls is required on PATH for the LSP tests (set JAN_SKIP_LSP_TESTS=1 to skip them explicitly)");
    }

    fn go_project() -> tempfile::TempDir {
        project_with(
            &[
                ("go.mod", "module example.com/probe\n\ngo 1.22\n"),
                ("probe.go", crate::core::agent::index::resolve_evidence::GO_FIXTURE),
            ],
            None,
        )
    }

    fn wait_gone(pid: u32) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        while tauri_plugin_agent_tools::tools::owned::process_exists(pid) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        !tauri_plugin_agent_tools::tools::owned::process_exists(pid)
    }

    /// AH-057: the question the index could not answer. `f.Close()` on line 17
    /// reaches `(*File).Close`, line 7 -- one answer, not every `Close`.
    #[test]
    fn a_method_call_resolves_to_the_one_method_it_reaches() {
        if !gopls_or_explicit_skip() {
            return;
        }
        let dir = go_project();
        let pool = LspPool::new(dir.path());
        let line = 17;
        let column = crate::core::agent::index::resolve_evidence::GO_FIXTURE.lines().nth(line - 1).unwrap().find("Close").unwrap() + 1;
        let answer = pool.run(&query(Action::Definition, dir.path(), "probe.go", line, column), None, &|| false).unwrap();
        assert!(answer.starts_with("1 location(s)"), "{answer}");
        assert!(answer.contains("probe.go:7:"), "{answer}");
        assert!(answer.contains("func (f *File) Close()"), "{answer}");

        // The interface method has both implementations; hover knows the type.
        let iface = crate::core::agent::index::resolve_evidence::GO_FIXTURE.lines().nth(2).unwrap().find("Close").unwrap() + 1;
        let implementations = pool.run(&query(Action::Implementation, dir.path(), "probe.go", 3, iface), None, &|| false).unwrap();
        assert!(implementations.contains("probe.go:5:") && implementations.contains("probe.go:9:"), "{implementations}");
        let hover = pool.run(&query(Action::Hover, dir.path(), "probe.go", line, column), None, &|| false).unwrap();
        assert!(hover.contains("func (f *File) Close() error"), "{hover}");
        let references = pool.run(&query(Action::References, dir.path(), "probe.go", 7, 16), None, &|| false).unwrap();
        assert!(references.contains("probe.go:7:") && references.contains("probe.go:17:"), "{references}");
        assert!(!references.contains("probe.go:11:"), "Socket's Close is a different method: {references}");

        // One server for the run, reused.
        let pid = pool.running_pid("go").unwrap();
        assert_eq!(pool.run(&query(Action::Status, dir.path(), "", 0, 0), None, &|| false).unwrap().matches("running (pid").count(), 1);
        drop(pool);
        assert!(wait_gone(pid), "gopls {pid} outlived the run's pool");
    }

    /// AH-064-style diagnostics, from the server, for a file edited on disk
    /// after it was opened: the server is sent the new text.
    #[test]
    fn diagnostics_follow_the_file_on_disk() {
        if !gopls_or_explicit_skip() {
            return;
        }
        let dir = go_project();
        let pool = LspPool::new(dir.path());
        let clean = pool.run(&query(Action::Diagnostics, dir.path(), "probe.go", 0, 0), None, &|| false).unwrap();
        assert!(clean.contains("no problems") || clean.contains("no diagnostics"), "{clean}");
        std::fs::write(dir.path().join("probe.go"), "package probe\n\nfunc Broken() int { return \"not an int\" }\n").unwrap();
        let broken = pool.run(&query(Action::Diagnostics, dir.path(), "probe.go", 0, 0), None, &|| false).unwrap();
        assert!(broken.contains("probe.go:3:") && broken.contains("error"), "{broken}");
    }

    /// AH-058: a server that dies is noticed and replaced; one that keeps
    /// dying is refused after MAX_RESTARTS.
    #[test]
    fn a_dead_server_is_restarted_and_one_that_keeps_dying_is_refused() {
        if !gopls_or_explicit_skip() {
            return;
        }
        let dir = go_project();
        let pool = LspPool::new(dir.path());
        let ask = |pool: &LspPool| pool.run(&query(Action::Hover, dir.path(), "probe.go", 17, 11), None, &|| false);
        ask(&pool).unwrap();
        let mut previous = pool.running_pid("go").unwrap();
        for round in 1..=MAX_RESTARTS {
            let _ = tauri_plugin_agent_tools::tools::proc::kill_tree(previous);
            assert!(wait_gone(previous));
            ask(&pool).unwrap_or_else(|e| panic!("restart {round} failed: {e}"));
            let now = pool.running_pid("go").unwrap();
            assert_ne!(now, previous, "round {round} reused a dead server");
            assert_eq!(pool.restarts("go"), round);
            previous = now;
        }
        let _ = tauri_plugin_agent_tools::tools::proc::kill_tree(previous);
        assert!(wait_gone(previous));
        let refused = ask(&pool).unwrap_err();
        assert_eq!(refused.kind, LspErrorKind::ServerFailing, "{refused}");
        assert!(pool.running_pid("go").is_none());
    }

    /// Cancellation: a waiting request stops at once, and a stopped run token
    /// takes the server's process with it.
    #[test]
    fn a_cancelled_request_stops_waiting_and_a_stopped_run_ends_the_server() {
        if !gopls_or_explicit_skip() {
            return;
        }
        let dir = go_project();
        let token = tauri_plugin_agent_tools::lifecycle::Token::new(tauri_plugin_agent_tools::lifecycle::Scope::default());
        let pool = LspPool::new(dir.path());
        pool.run(&query(Action::Hover, dir.path(), "probe.go", 17, 11), Some(token.clone()), &|| false).unwrap();
        let pid = pool.running_pid("go").unwrap();
        assert_eq!(token.live_children(), 1, "the run's token owns the server");

        let started = Instant::now();
        let cancelled = pool
            .run(&query(Action::Diagnostics, dir.path(), "probe.go", 0, 0), Some(token.clone()), &|| true)
            .unwrap_err();
        assert_eq!(cancelled.kind, LspErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2), "cancellation waited {:?}", started.elapsed());

        token.stop(tauri_plugin_agent_tools::lifecycle::StopReason::Cancelled);
        assert!(wait_gone(pid), "stopping the run left gopls {pid} running");
        drop(pool);
    }
}
