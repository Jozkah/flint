use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    pub model_path: String,
    pub is_embedding: bool,
    pub api_key: String,
}

/// The last lines the server wrote to stderr, kept for as long as it runs so
/// a crash after the load (a Metal out-of-memory on a long prompt, say) can
/// still be explained.
pub type StderrTail = Arc<std::sync::Mutex<std::collections::VecDeque<String>>>;

pub struct MlxBackendSession {
    pub child: Child,
    pub info: SessionInfo,
    pub stderr_tail: StderrTail,
}

/// MLX plugin state
pub struct MlxState {
    pub mlx_server_process: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
}

impl Default for MlxState {
    fn default() -> Self {
        Self {
            mlx_server_process: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl MlxState {
    pub fn new() -> Self {
        Self::default()
    }
}
