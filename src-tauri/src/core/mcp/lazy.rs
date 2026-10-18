//! On-demand MCP server start (lazy start).
//!
//! Enabled servers are registered at launch but not started. The first thing
//! that needs a server's tools (a send, a tool call, an explicit listing, an
//! @mention) starts it once; concurrent callers wait on the same attempt
//! instead of starting a second one. A server marked `startWithFlint` is still
//! started at launch. A running server with no calls for the configured idle
//! time is stopped again (never while a call is in flight).
//!
//! This module is Tauri-free so the start/dedupe/idle rules are unit tested
//! without an app; `helpers` supplies the real start and stop.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::models::ToolWithServer;

/// Default idle time before a lazily started server is stopped.
pub const DEFAULT_IDLE_SHUTDOWN_MINUTES: u64 = 15;

/// Whether a server definition asks to be started with Flint.
/// Absent means no: existing configs stay lazy.
pub fn starts_with_flint(config: &Value) -> bool {
    config
        .get("startWithFlint")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// What the UI shows for one server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ServerStatus {
    /// Enabled, not running: starts when needed.
    Stopped,
    Starting,
    Running,
    Failed { error: String },
}

#[derive(Debug, Clone)]
enum Transient {
    Starting,
    Failed { error: String, at: Instant },
}

#[derive(Debug, Clone, Copy)]
struct Activity {
    last_used: Instant,
    in_flight: usize,
}

#[derive(Default)]
pub struct LazyMcp {
    gates: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
    transient: StdMutex<HashMap<String, Transient>>,
    activity: Arc<StdMutex<HashMap<String, Activity>>>,
}

impl LazyMcp {
    fn gate(&self, name: &str) -> Arc<Mutex<()>> {
        self.gates
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .clone()
    }

    /// Start `name` unless it is running, once, shared by concurrent callers.
    ///
    /// Callers that queued behind an attempt that failed get that failure
    /// rather than each starting the server again.
    pub async fn ensure<R, RF, S, SF>(&self, name: &str, is_running: R, start: S) -> Result<(), String>
    where
        R: Fn() -> RF,
        RF: Future<Output = bool>,
        S: FnOnce() -> SF,
        SF: Future<Output = Result<(), String>>,
    {
        let asked_at = Instant::now();
        let gate = self.gate(name);
        let _held = gate.lock().await;
        if is_running().await {
            self.transient.lock().unwrap().remove(name);
            self.touch(name);
            return Ok(());
        }
        if let Some(Transient::Failed { error, at }) = self.transient.lock().unwrap().get(name) {
            if *at >= asked_at {
                return Err(error.clone());
            }
        }
        self.transient
            .lock()
            .unwrap()
            .insert(name.to_string(), Transient::Starting);
        let result = start().await;
        let mut transient = self.transient.lock().unwrap();
        match &result {
            Ok(()) => {
                transient.remove(name);
                drop(transient);
                self.touch(name);
            }
            Err(e) => {
                transient.insert(
                    name.to_string(),
                    Transient::Failed {
                        error: e.clone(),
                        at: Instant::now(),
                    },
                );
            }
        }
        result
    }

    pub fn status(&self, name: &str, running: bool) -> ServerStatus {
        match self.transient.lock().unwrap().get(name) {
            Some(Transient::Starting) => ServerStatus::Starting,
            _ if running => ServerStatus::Running,
            Some(Transient::Failed { error, .. }) => ServerStatus::Failed {
                error: error.clone(),
            },
            None => ServerStatus::Stopped,
        }
    }

    /// Forget a failure/activity (server stopped or turned off).
    pub fn forget(&self, name: &str) {
        self.transient.lock().unwrap().remove(name);
        self.activity.lock().unwrap().remove(name);
    }

    pub fn touch(&self, name: &str) {
        let mut activity = self.activity.lock().unwrap();
        let entry = activity.entry(name.to_string()).or_insert(Activity {
            last_used: Instant::now(),
            in_flight: 0,
        });
        entry.last_used = Instant::now();
    }

    /// Mark a call in flight; the guard ends it.
    pub fn begin_call(&self, name: &str) -> CallGuard {
        {
            let mut activity = self.activity.lock().unwrap();
            let entry = activity.entry(name.to_string()).or_insert(Activity {
                last_used: Instant::now(),
                in_flight: 0,
            });
            entry.in_flight += 1;
            entry.last_used = Instant::now();
        }
        CallGuard {
            activity: self.activity.clone(),
            name: name.to_string(),
        }
    }

    /// Running servers idle for at least `idle_after` with nothing in flight.
    /// A server with no recorded activity is left alone.
    pub fn idle_servers(&self, running: &[String], idle_after: Duration, now: Instant) -> Vec<String> {
        let activity = self.activity.lock().unwrap();
        running
            .iter()
            .filter(|name| {
                activity.get(*name).is_some_and(|a| {
                    a.in_flight == 0 && now.saturating_duration_since(a.last_used) >= idle_after
                })
            })
            .cloned()
            .collect()
    }
}

pub struct CallGuard {
    activity: Arc<StdMutex<HashMap<String, Activity>>>,
    name: String,
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.activity.lock() {
            if let Some(a) = activity.get_mut(&self.name) {
                a.in_flight = a.in_flight.saturating_sub(1);
                a.last_used = Instant::now();
            }
        }
    }
}

// ---- Persisted tool cache -------------------------------------------------

pub const TOOL_CACHE_FILE: &str = "mcp_tool_cache.json";

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct CachedServerTools {
    /// `definition_identity` of the config the tools were listed from; a
    /// different definition under the same name does not reuse them.
    pub identity: String,
    pub tools: Vec<ToolWithServer>,
}

impl PartialEq for ToolWithServer {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && self.description == other.description
            && self.input_schema == other.input_schema
            && self.server == other.server
    }
}

pub type ToolCache = HashMap<String, CachedServerTools>;

pub fn read_tool_cache(path: &std::path::Path) -> ToolCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_tool_cache(path: &std::path::Path, cache: &ToolCache) -> Result<(), String> {
    let body = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The cached tools usable for each enabled config (identity must match).
pub fn usable_cached_tools(
    cache: &ToolCache,
    configs: &HashMap<String, Value>,
) -> HashMap<String, Vec<ToolWithServer>> {
    configs
        .iter()
        .filter_map(|(name, config)| {
            let entry = cache.get(name)?;
            (entry.identity == super::models::definition_identity(config))
                .then(|| (name.clone(), entry.tools.clone()))
        })
        .collect()
}

// ---- Process-wide hook ------------------------------------------------------

type EnsureAllFn =
    dyn Fn(Option<Duration>) -> std::pin::Pin<Box<dyn Future<Output = Vec<String>> + Send>>
        + Send
        + Sync;

static ENSURE_ALL_HOOK: OnceLock<Box<EnsureAllFn>> = OnceLock::new();

/// How long an agent turn waits for enabled servers to start before going on
/// without the slow ones. A server that never answers `initialize` would
/// otherwise hold the first turn for the whole [`MCP_INIT_TIMEOUT`]
/// (120 s); the cap leaves it starting in the background instead.
///
/// [`MCP_INIT_TIMEOUT`]: super::helpers::MCP_INIT_TIMEOUT
pub const AGENT_MCP_START_WAIT: Duration = Duration::from_secs(25);

/// Installed by the desktop app at setup: starts every enabled server that is
/// not running. Paths that only hold `SharedMcpServers` (the Cowork agent
/// loop, the local API server's tool execution) call [`ensure_enabled_started`].
/// The hook waits at most the given time (`None` = until all are settled) and
/// returns the servers still starting when it stopped waiting.
pub fn install_ensure_all_hook(hook: Box<EnsureAllFn>) {
    let _ = ENSURE_ALL_HOOK.set(hook);
}

/// Start every enabled server that is not running; no-op without the hook.
pub async fn ensure_enabled_started() {
    if let Some(hook) = ENSURE_ALL_HOOK.get() {
        hook(None).await;
    }
}

/// Like [`ensure_enabled_started`] but gives up waiting after `cap`: servers
/// not settled by then keep starting in the background (they are not
/// cancelled) and their names are returned.
pub async fn ensure_enabled_started_within(cap: Duration) -> Vec<String> {
    match ENSURE_ALL_HOOK.get() {
        Some(hook) => hook(Some(cap)).await,
        None => Vec::new(),
    }
}

/// Run each start to completion on its own task, waiting at most `cap` for
/// all of them together. A start that has not finished by then is left
/// running (dropping a join handle detaches the task) and its name returned.
pub async fn wait_for_starts<F>(starts: Vec<(String, F)>, cap: Duration) -> Vec<String>
where
    F: Future<Output = ()> + Send + 'static,
{
    let deadline = tokio::time::Instant::now() + cap;
    let spawned: Vec<_> = starts
        .into_iter()
        .map(|(name, start)| (name, tokio::spawn(start)))
        .collect();
    let mut slow = Vec::new();
    for (name, mut handle) in spawned {
        if tokio::time::timeout_at(deadline, &mut handle).await.is_err() {
            slow.push(name);
        }
    }
    slow
}

/// The one-line notice for servers an agent turn did not wait for.
pub fn slow_start_notice(names: &[String]) -> Option<String> {
    match names {
        [] => None,
        [one] => Some(format!(
            "MCP server {one} is still starting; its tools will appear when ready"
        )),
        many => Some(format!(
            "MCP servers {} are still starting; their tools will appear when ready",
            many.join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[tokio::test]
    async fn starts_once_for_concurrent_callers() {
        let lazy = Arc::new(LazyMcp::default());
        let running = Arc::new(AtomicBool::new(false));
        let starts = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let (lazy, running, starts) = (lazy.clone(), running.clone(), starts.clone());
            handles.push(tokio::spawn(async move {
                let r = running.clone();
                lazy.ensure(
                    "a",
                    move || {
                        let r = r.clone();
                        async move { r.load(Ordering::SeqCst) }
                    },
                    || async move {
                        starts.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        running.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
            }));
        }
        for h in handles {
            assert!(h.await.unwrap().is_ok());
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(lazy.status("a", true), ServerStatus::Running);
    }

    #[tokio::test]
    async fn waiters_share_a_failure_and_a_later_call_retries() {
        let lazy = Arc::new(LazyMcp::default());
        let starts = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let (lazy, starts) = (lazy.clone(), starts.clone());
            handles.push(tokio::spawn(async move {
                lazy.ensure("a", || async { false }, || async move {
                    starts.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    Err("boom".to_string())
                })
                .await
            }));
        }
        for h in handles {
            assert_eq!(h.await.unwrap(), Err("boom".to_string()));
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(
            lazy.status("a", false),
            ServerStatus::Failed { error: "boom".into() }
        );
        // A fresh request tries again.
        let s = starts.clone();
        let r = lazy
            .ensure("a", || async { false }, || async move {
                s.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(r.is_ok());
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn no_start_when_already_running() {
        let lazy = LazyMcp::default();
        let r = lazy
            .ensure("a", || async { true }, || async { panic!("must not start") })
            .await;
        assert!(r.is_ok());
        assert_eq!(lazy.status("b", false), ServerStatus::Stopped);
    }

    #[test]
    fn start_with_flint_defaults_off() {
        assert!(!starts_with_flint(&serde_json::json!({"command": "x"})));
        assert!(!starts_with_flint(&serde_json::json!({"startWithFlint": false})));
        assert!(starts_with_flint(&serde_json::json!({"startWithFlint": true})));
    }

    #[test]
    fn idle_stop_skips_in_flight_and_unknown() {
        let lazy = LazyMcp::default();
        lazy.touch("idle");
        let _guard = lazy.begin_call("busy");
        let running = vec!["idle".to_string(), "busy".to_string(), "unknown".to_string()];
        let later = Instant::now() + Duration::from_secs(16 * 60);
        assert_eq!(
            lazy.idle_servers(&running, Duration::from_secs(15 * 60), later),
            vec!["idle".to_string()]
        );
        // Recently used: not idle.
        assert!(lazy
            .idle_servers(&running, Duration::from_secs(15 * 60), Instant::now())
            .is_empty());
        drop(_guard);
        assert_eq!(
            lazy.idle_servers(&running, Duration::from_secs(15 * 60), later).len(),
            2
        );
    }

    #[test]
    fn cache_reused_only_for_same_definition() {
        let tool = ToolWithServer {
            name: "t".into(),
            description: None,
            input_schema: serde_json::json!({}),
            server: "a".into(),
        };
        let config = serde_json::json!({"command": "npx", "args": ["x"]});
        let mut cache = ToolCache::new();
        cache.insert(
            "a".into(),
            CachedServerTools {
                identity: super::super::models::definition_identity(&config),
                tools: vec![tool],
            },
        );
        let mut configs = HashMap::new();
        configs.insert("a".to_string(), config);
        assert_eq!(usable_cached_tools(&cache, &configs)["a"].len(), 1);
        configs.insert("a".to_string(), serde_json::json!({"command": "uvx"}));
        assert!(usable_cached_tools(&cache, &configs).is_empty());

        let dir = std::env::temp_dir().join(format!("flint-lazy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(TOOL_CACHE_FILE);
        write_tool_cache(&path, &cache).unwrap();
        assert_eq!(read_tool_cache(&path), cache);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_silent_start_does_not_hold_the_wait_and_keeps_running() {
        let done = Arc::new(AtomicBool::new(false));
        let late = done.clone();
        let started = Instant::now();
        let slow = wait_for_starts(
            vec![
                ("quick".to_string(), Box::pin(async {}) as std::pin::Pin<Box<dyn Future<Output = ()> + Send>>),
                (
                    "silent".to_string(),
                    Box::pin(async move {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        late.store(true, Ordering::SeqCst);
                    }),
                ),
            ],
            Duration::from_millis(50),
        )
        .await;
        assert_eq!(slow, vec!["silent".to_string()]);
        assert!(started.elapsed() < Duration::from_millis(300));
        assert!(!done.load(Ordering::SeqCst));
        // Not killed: it finishes on its own after the wait gave up.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(done.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn nothing_is_slow_when_every_start_settles_in_time() {
        let slow = wait_for_starts(
            vec![("a".to_string(), std::future::ready(())), ("b".to_string(), std::future::ready(()))],
            Duration::from_secs(5),
        )
        .await;
        assert!(slow.is_empty());
    }

    #[test]
    fn the_notice_names_the_slow_servers() {
        assert_eq!(slow_start_notice(&[]), None);
        assert_eq!(
            slow_start_notice(&["fs".to_string()]).unwrap(),
            "MCP server fs is still starting; its tools will appear when ready"
        );
        assert!(slow_start_notice(&["a".to_string(), "b".to_string()])
            .unwrap()
            .starts_with("MCP servers a, b are still starting"));
    }
}
