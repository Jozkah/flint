use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    pub is_embedding: bool,
    pub api_key: String,
}

pub struct LlamacppState {
    /// The supervised engine worker, when one is running.
    pub engine: Mutex<Option<crate::engine::worker::WorkerHandle>>,
    /// Persistent `/models/sse` subscriber, alive for the worker's lifetime.
    /// It is what turns an eviction Jan did not initiate into a frontend
    /// event, so it is aborted whenever the worker stops.
    pub unload_watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Loads this app is waiting on, so one can be cancelled.
    pub loads: crate::load_cancel::LoadTracker,
    /// Where engine add-ons are installed; set by the app from its data folder.
    pub addon_root: std::sync::OnceLock<std::path::PathBuf>,
    /// The add-on directory the running worker was started with.
    pub addon_in_use: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// An add-on download or install is running.
    pub addon_busy: std::sync::atomic::AtomicBool,
    /// Set to stop the running download.
    pub addon_cancel: std::sync::atomic::AtomicBool,
    /// Native confirmation before a custom llama-server path is spawned.
    pub custom_exe: crate::engine::custom_exe::CustomExeGate,
}

impl Default for LlamacppState {
    fn default() -> Self {
        Self {
            engine: Mutex::new(None),
            unload_watcher: Mutex::new(None),
            loads: crate::load_cancel::LoadTracker::new(),
            addon_root: std::sync::OnceLock::new(),
            addon_in_use: std::sync::Mutex::new(None),
            addon_busy: std::sync::atomic::AtomicBool::new(false),
            addon_cancel: std::sync::atomic::AtomicBool::new(false),
            custom_exe: Default::default(),
        }
    }
}

impl LlamacppState {
    pub fn new() -> Self {
        Self::default()
    }
}
