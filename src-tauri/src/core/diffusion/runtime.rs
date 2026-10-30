//! Running `sd-server` and generating with it.
//!
//! One model is resident at a time. Loading starts the server and waits until it
//! answers (it loads the model before it listens, so an answer means ready).
//! A generation is a job: submit, poll until it finishes, save what comes back.
//! Progress is read from the server's log while the job runs.

use super::args::{
    self, build_img_gen_request, build_server_args, build_vid_gen_request, ImageRequest, ModelFiles,
    Offload, Sampling, VideoRequest,
};
use super::catalog::{self, Kind, ModelDef, Role};
use super::engine;
use super::gallery;
use super::progress::{Phase, ProgressTracker, RecordSplitter};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// A model that has not been used for this long is unloaded, to give the
/// memory back to chat.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
const LOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// Bounds of how long a generation may run before the wait gives up.
const JOB_TIMEOUT_FLOOR: Duration = Duration::from_secs(10 * 60);
const JOB_TIMEOUT_CAP: Duration = Duration::from_secs(6 * 60 * 60);

/// How long to wait for a job, scaled by its size so a quick 512px image on a
/// GPU is not held for six hours when the engine hangs, and a long video on a
/// CPU is not cut off. Generous per unit (30 s per step * megapixel * frame
/// covers CPU-only runs), floored at ten minutes and capped at six hours.
fn job_timeout(steps: u32, batch: u32, width: u32, height: u32, frames: u32) -> Duration {
    let megapixels = (f64::from(width) * f64::from(height) / 1_000_000.0).max(0.25);
    let units = f64::from(steps.max(1)) * f64::from(batch.max(1)) * f64::from(frames.max(1)) * megapixels;
    let secs = 600.0 + units * 30.0;
    Duration::from_secs_f64(secs).clamp(JOB_TIMEOUT_FLOOR, JOB_TIMEOUT_CAP)
}

/// The timeout for a request body, read from the fields the builders write.
fn job_timeout_for(body: &Value, steps: u32, batch: u32) -> Duration {
    let dim = |key: &str| body[key].as_u64().unwrap_or(1024).min(u64::from(u32::MAX)) as u32;
    let frames = body["video_frames"].as_u64().unwrap_or(1).min(u64::from(u32::MAX)) as u32;
    job_timeout(steps, batch, dim("width"), dim("height"), frames)
}
const LOG_TAIL_LINES: usize = 60;

/// What the log reader shares with the job that is running.
#[derive(Default)]
struct Live {
    tracker: Option<ProgressTracker>,
    fraction: f64,
    tail: VecDeque<String>,
}

struct Resident {
    model_id: &'static str,
    kind: Kind,
    child: Child,
    port: u16,
    live: Arc<StdMutex<Live>>,
    last_used: Instant,
    busy: bool,
    current_job: Option<String>,
    /// Kills the engine if the app dies without unloading it.
    #[cfg(windows)]
    _job: Option<jan_process::confine::Job>,
}

static RESIDENT: OnceLock<Mutex<Option<Resident>>> = OnceLock::new();

fn resident() -> &'static Mutex<Option<Resident>> {
    RESIDENT.get_or_init(|| Mutex::new(None))
}

/// Set while a load waits for the engine to answer, so `unload` (a shutdown, a
/// user stop) can interrupt the wait instead of letting it run to its timeout.
static LOAD_CANCEL: OnceLock<StdMutex<Option<tokio::sync::watch::Sender<bool>>>> = OnceLock::new();

fn load_cancel() -> &'static StdMutex<Option<tokio::sync::watch::Sender<bool>>> {
    LOAD_CANCEL.get_or_init(|| StdMutex::new(None))
}

/// How the last load was asked for, so a server that was stopped (a cancel, an
/// idle unload) can be started again by the next generation.
static LAST_LOAD: OnceLock<StdMutex<Option<(String, Offload)>>> = OnceLock::new();

fn last_load() -> &'static StdMutex<Option<(String, Offload)>> {
    LAST_LOAD.get_or_init(|| StdMutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
pub struct ResidentInfo {
    pub model_id: String,
    pub kind: Kind,
    pub busy: bool,
}

pub async fn resident_info() -> Option<ResidentInfo> {
    resident().lock().await.as_ref().map(|r| ResidentInfo {
        model_id: r.model_id.to_string(),
        kind: r.kind,
        busy: r.busy,
    })
}

#[derive(Debug, Clone, Serialize)]
struct StateEvent<'a> {
    state: &'a str,
    model_id: Option<&'a str>,
}

fn emit_state<R: Runtime>(app: &tauri::AppHandle<R>, state: &str, model_id: Option<&str>) {
    let _ = app.emit("diffusion-state", StateEvent { state, model_id });
}

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent {
    job_id: String,
    phase: &'static str,
    fraction: f64,
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Queued => "queued",
        Phase::Encoding => "encoding",
        Phase::Sampling => "sampling",
        Phase::Decoding => "decoding",
        Phase::Saving => "saving",
    }
}

/// Where a model file is on disk once the Hugging Face download has put it there.
pub fn model_file_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    file: &catalog::FileDef,
) -> PathBuf {
    crate::core::app::commands::get_jan_data_folder_path(app.clone())
        .join(crate::core::huggingface::relative_download_path(file.repo, file.filename))
}

/// Whether every file of `def` is present at its full size.
pub fn model_installed<R: Runtime>(app: &tauri::AppHandle<R>, def: &ModelDef) -> bool {
    def.files.iter().all(|f| {
        std::fs::metadata(model_file_path(app, f))
            .map(|m| m.len() == f.size)
            .unwrap_or(false)
    })
}

fn files_for<R: Runtime>(app: &tauri::AppHandle<R>, def: &ModelDef) -> Result<ModelFiles, String> {
    if !model_installed(app, def) {
        return Err(format!("{} is not fully downloaded.", def.display_name));
    }
    let find = |role: Role| {
        def.files
            .iter()
            .find(|f| f.role == role)
            .map(|f| model_file_path(app, f))
    };
    Ok(ModelFiles {
        diffusion_model: find(Role::DiffusionModel).ok_or("The model has no weights file.")?,
        vae: find(Role::Vae).ok_or("The model has no VAE file.")?,
        llm: find(Role::Llm),
        t5xxl: find(Role::T5xxl),
        clip_l: find(Role::ClipL),
        llm_vision: find(Role::LlmVision),
    })
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("No free port for the image engine: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Could not create the HTTP client: {e}"))
}

/// Read a child's output to the end, keeping a tail and following the progress bar.
fn watch_output<T: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut stream: T,
    live: Arc<StdMutex<Live>>,
) {
    tokio::spawn(async move {
        let mut splitter = RecordSplitter::default();
        let mut buf = vec![0u8; 8192];
        loop {
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for record in splitter.push(&buf[..n]) {
                if let Ok(mut live) = live.lock() {
                    if let Some(tracker) = live.tracker.as_mut() {
                        if let Some(fraction) = tracker.feed(&record) {
                            live.fraction = fraction;
                        }
                    }
                    if live.tail.len() >= LOG_TAIL_LINES {
                        live.tail.pop_front();
                    }
                    live.tail.push_back(record);
                }
            }
        }
        if let Some(rest) = splitter.finish() {
            if let Ok(mut live) = live.lock() {
                live.tail.push_back(rest);
            }
        }
    });
}

/// The last lines of the log that say why a failure happened.
fn diagnose(live: &Arc<StdMutex<Live>>) -> String {
    let tail: Vec<String> = live
        .lock()
        .map(|l| l.tail.iter().cloned().collect())
        .unwrap_or_default();
    friendly_failure(&tail)
}

/// What a run that ran out of graphics memory reports, so it can be told apart.
const OUT_OF_MEMORY: &str = "The graphics card ran out of memory. Try a smaller size, or close other programs that use the GPU.";

/// Whether a failure message is the out-of-memory one. The engine's own message
/// is appended to it in brackets, so it is matched by its start.
fn is_out_of_memory(message: &str) -> bool {
    message.starts_with(OUT_OF_MEMORY)
}

/// A plain-words reason for a failure, from the engine's log.
pub fn friendly_failure(tail: &[String]) -> String {
    let joined = tail.join("\n").to_ascii_lowercase();
    if joined.contains("out of memory") || joined.contains("failed to allocate") || joined.contains("cudamalloc failed") {
        return OUT_OF_MEMORY.to_string();
    }
    if joined.contains("gpu address fault")
        || joined.contains("backend is in error state")
        || (joined.contains("command buffer") && joined.contains("pagefault"))
    {
        return "The graphics card stopped responding. Try again at a smaller size.".to_string();
    }
    let key: Vec<&String> = tail
        .iter()
        .filter(|l| {
            let l = l.to_ascii_lowercase();
            ["error", "abort", "assert", "unsupported", "failed", "exception"]
                .iter()
                .any(|w| l.contains(w))
        })
        .collect();
    let shown: Vec<&String> = if key.is_empty() {
        tail.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
    } else {
        key.into_iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
    };
    if shown.is_empty() {
        "The image engine failed without saying why.".to_string()
    } else {
        format!(
            "The image engine failed: {}",
            shown.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" | ")
        )
    }
}

/// Serialises `load`, which can take minutes and replaces the resident engine.
static LOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn load_lock() -> &'static Mutex<()> {
    LOAD_LOCK.get_or_init(|| Mutex::new(()))
}

/// Loading `model_id` replaces whatever engine is resident; refuse when that
/// engine is in the middle of a generation, which the swap would kill.
async fn check_can_replace(model_id: &str) -> Result<(), String> {
    match resident().lock().await.as_ref() {
        Some(r) if r.busy && r.model_id != model_id => Err(
            "The image engine is busy with another generation. Wait for it to finish or stop it, then load the other model."
                .to_string(),
        ),
        _ => Ok(()),
    }
}

pub async fn unload<R: Runtime>(app: &tauri::AppHandle<R>) {
    // A load that is still waiting for its engine is stopped first; it kills
    // its own child.
    if let Ok(slot) = load_cancel().lock() {
        if let Some(tx) = slot.as_ref() {
            let _ = tx.send(true);
        }
    }
    let taken = resident().lock().await.take();
    if let Some(mut r) = taken {
        let _ = r.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), r.child.wait()).await;
        emit_state(app, "unloaded", None);
    }
}

/// Start the server for `model_id` and wait until it answers.
pub async fn load<R: Runtime>(
    app: &tauri::AppHandle<R>,
    model_id: &str,
    offload: Offload,
) -> Result<ResidentInfo, String> {
    if !engine::platform_supported() {
        return Err("Local image generation needs Windows x64 or Linux x64.".to_string());
    }
    let def = catalog::model(model_id).ok_or_else(|| format!("Unknown model {model_id}."))?;
    let backend = engine::installed_backend(app)
        .ok_or("The image engine is not installed yet.")?;
    let files = files_for(app, def)?;

    // One load or swap at a time: two callers must not each start an engine,
    // with the first one's child killed when the second replaces it.
    let _serial = load_lock().lock().await;

    // Already there, and still running: nothing to do.
    {
        let mut guard = resident().lock().await;
        if let Some(r) = guard.as_mut() {
            if r.model_id == def.id && r.child.try_wait().ok().flatten().is_none() {
                return Ok(ResidentInfo { model_id: def.id.to_string(), kind: def.kind, busy: r.busy });
            }
        }
    }
    check_can_replace(def.id).await?;
    unload(app).await;
    emit_state(app, "loading", Some(def.id));

    let dir = engine::engine_dir(app, backend);
    let scratch = engine::diffusion_root(app).join("scratch");
    let lora_dir = engine::diffusion_root(app).join("loras");
    std::fs::create_dir_all(&scratch).map_err(|e| format!("Could not create the scratch folder: {e}"))?;
    std::fs::create_dir_all(&lora_dir).map_err(|e| format!("Could not create the LoRA folder: {e}"))?;
    let port = free_port()?;
    let mut extra = vec!["--lora-model-dir".to_string(), lora_dir.to_string_lossy().into_owned()];
    extra.extend(def.extra_args.iter().map(|a| a.to_string()));
    let argv = build_server_args(&files, port, &scratch, offload, None, &extra);

    let mut command = Command::new(dir.join(engine::SERVER_EXE));
    command
        .args(&argv)
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    engine::configure_library_path(&mut command, &dir);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    jan_process::confine::die_with_parent(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start the image engine: {e}"))?;
    #[cfg(windows)]
    let job = child.raw_handle().and_then(jan_process::confine::confine);
    let live = Arc::new(StdMutex::new(Live::default()));
    if let Some(out) = child.stdout.take() {
        watch_output(out, live.clone());
    }
    if let Some(err) = child.stderr.take() {
        watch_output(err, live.clone());
    }

    // Ready when /v1/models answers: the model is loaded before the port opens.
    let client = http()?;
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    if let Ok(mut slot) = load_cancel().lock() {
        *slot = Some(cancel_tx);
    }
    let ready = await_ready(&client, &mut child, port, &live, &mut cancel_rx, LOAD_TIMEOUT).await;
    if let Ok(mut slot) = load_cancel().lock() {
        *slot = None;
    }
    if let Err(e) = ready {
        emit_state(app, "unloaded", None);
        return Err(e.message());
    }

    *resident().lock().await = Some(Resident {
        model_id: def.id,
        kind: def.kind,
        child,
        port,
        live,
        last_used: Instant::now(),
        busy: false,
        current_job: None,
        #[cfg(windows)]
        _job: job,
    });
    if let Ok(mut last) = last_load().lock() {
        *last = Some((def.id.to_string(), offload));
    }
    spawn_idle_watch(app.clone());
    emit_state(app, "loaded", Some(def.id));
    Ok(ResidentInfo { model_id: def.id.to_string(), kind: def.kind, busy: false })
}

/// Why waiting for the engine to come up ended without it answering.
#[derive(Debug, PartialEq, Eq)]
enum ReadyError {
    /// The process ended; carries its status and the reason read from its log.
    Exited(String),
    TimedOut,
    /// `unload` asked the load to stop.
    Cancelled,
}

impl ReadyError {
    fn message(&self) -> String {
        match self {
            Self::Exited(why) => why.clone(),
            Self::TimedOut => "The image engine took too long to load the model.".to_string(),
            Self::Cancelled => "The image engine load was cancelled.".to_string(),
        }
    }
}

/// Resolves once `unload` has asked the load to stop. Written with
/// `borrow_and_update` because the `Ref` that `wait_for` returns is not `Send`
/// and this runs inside a spawned task.
async fn cancelled(rx: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            // The sender is gone without asking: nobody will cancel.
            std::future::pending::<()>().await;
        }
    }
}

/// Polls `/v1/models` until the engine answers. A timeout or a cancel kills
/// `child`, so a caller that gets `Err` never leaves a process behind.
async fn await_ready(
    client: &reqwest::Client,
    child: &mut Child,
    port: u16,
    live: &Arc<StdMutex<Live>>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    limit: Duration,
) -> Result<(), ReadyError> {
    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let why = diagnose(live);
            return Err(ReadyError::Exited(format!(
                "The image engine stopped while loading ({status}). {why}"
            )));
        }
        let probe = client
            .get(format!("http://127.0.0.1:{port}/v1/models"))
            .timeout(Duration::from_secs(2))
            .send();
        let answered = tokio::select! {
            r = probe => r.map(|r| r.status().is_success()).unwrap_or(false),
            _ = cancelled(cancel) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                return Err(ReadyError::Cancelled);
            }
        };
        if answered {
            return Ok(());
        }
        if started.elapsed() > limit {
            let _ = child.start_kill();
            return Err(ReadyError::TimedOut);
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(300)) => {}
            _ = cancelled(cancel) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                return Err(ReadyError::Cancelled);
            }
        }
    }
}

/// Bumped by every load; a watch from an earlier load sees a newer value and
/// ends, so loads do not stack one idle watcher each.
static IDLE_WATCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn spawn_idle_watch<R: Runtime>(app: tauri::AppHandle<R>) {
    use std::sync::atomic::Ordering;
    let generation = IDLE_WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if IDLE_WATCH_GEN.load(Ordering::SeqCst) != generation {
                return;
            }
            let expired = {
                let guard = resident().lock().await;
                match guard.as_ref() {
                    None => return,
                    Some(r) => !r.busy && r.last_used.elapsed() > IDLE_UNLOAD,
                }
            };
            if expired {
                unload(&app).await;
                return;
            }
        }
    });
}

/// The server for `model_id`, started again from the last load if it was stopped.
async fn ensure_loaded<R: Runtime>(app: &tauri::AppHandle<R>, model_id: &str) -> Result<(), String> {
    {
        let mut guard = resident().lock().await;
        if let Some(r) = guard.as_mut() {
            if r.model_id == model_id && r.child.try_wait().ok().flatten().is_none() {
                return Ok(());
            }
        }
    }
    let offload = last_load()
        .lock()
        .ok()
        .and_then(|l| l.as_ref().filter(|(m, _)| m == model_id).map(|(_, o)| *o))
        .unwrap_or_default();
    load(app, model_id, offload).await.map(|_| ())
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageParams {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub seed: Option<u32>,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub lora: Vec<LoraChoice>,
    /// Gallery id of a picture to start from (image-to-image).
    #[serde(default)]
    pub init_image_id: Option<String>,
    /// How far the result may drift from `init_image_id`, 0 to 1.
    #[serde(default)]
    pub strength: Option<f64>,
    /// Gallery ids of pictures an edit model should follow.
    #[serde(default)]
    pub reference_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoraChoice {
    pub name: String,
    pub multiplier: f64,
}

fn resolve_loras<R: Runtime>(app: &tauri::AppHandle<R>, choices: &[LoraChoice]) -> Result<Vec<(String, f64)>, String> {
    let dir = engine::diffusion_root(app).join("loras");
    choices.iter().map(|choice| {
        let name = std::path::Path::new(&choice.name);
        if name.file_name().and_then(|n| n.to_str()) != Some(choice.name.as_str())
            || !choice.name.to_ascii_lowercase().ends_with(".safetensors") {
            return Err("Choose an imported LoRA adapter.".to_string());
        }
        if !choice.multiplier.is_finite() || !(0.0..=2.0).contains(&choice.multiplier) {
            return Err("LoRA strength must be between 0 and 2.".to_string());
        }
        let path = dir.join(&choice.name);
        if !path.is_file() {
            return Err(format!("LoRA adapter {} is missing.", choice.name));
        }
        // sd-server resolves relative LoRA names against --lora-model-dir.
        Ok((choice.name.clone(), choice.multiplier))
    }).collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoParams {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub frames: Option<u32>,
    #[serde(default)]
    pub seed: Option<u32>,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub lora: Vec<LoraChoice>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Generated {
    pub job_id: String,
    pub seed: u32,
    pub ids: Vec<String>,
    pub paths: Vec<String>,
    pub duration_ms: u64,
}

fn sampling_of(def: &ModelDef, steps: Option<u32>) -> Sampling {
    Sampling {
        steps: steps.unwrap_or(def.defaults.steps).clamp(1, 100),
        cfg_scale: def.defaults.cfg_scale,
        sample_method: def.defaults.sample_method.map(String::from),
        flow_shift: def.defaults.flow_shift,
    }
}

/// Submit `body` to `path`, wait for the job, and return its `result` object.
async fn run_job<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
    body: Value,
    steps: u32,
    batch: u32,
    cancel_key: &str,
) -> Result<(String, Value), String> {
    let (port, live) = {
        let mut guard = resident().lock().await;
        let r = guard.as_mut().ok_or("No image model is loaded.")?;
        // `cancel_key` is the model this job was built for. Another request may
        // have swapped the engine between `ensure_loaded` and here; running on
        // that model would produce (and record) the wrong one.
        if r.model_id != cancel_key {
            return Err("The image engine switched to another model. Try again.".to_string());
        }
        if r.busy {
            return Err("The image engine is busy with another generation.".to_string());
        }
        r.busy = true;
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        r.last_used = Instant::now();
        let live = r.live.clone();
        if let Ok(mut l) = live.lock() {
            l.tracker = Some(ProgressTracker::new(steps, batch));
            l.fraction = 0.0;
        }
        (r.port, live)
    };
    // If the caller's future is dropped (an HTTP client that went away) the
    // guard frees the engine and asks it to cancel the job.
    let mut guard = JobGuard { live: live.clone(), armed: true };
    let timeout = job_timeout_for(&body, steps, batch);
    let outcome = poll_job(app, port, &live, path, body, cancel_key, timeout).await;
    guard.armed = false;
    // A job abandoned because the wait gave up, or because its status could not
    // be read, may still be running on the engine: it is told to stop, or it
    // keeps the GPU busy while the next request is refused as "busy".
    release_job(&live, matches!(&outcome, Err(e) if e.cancel_job)).await;
    outcome.map_err(|e| e.message)
}

/// Why waiting on a job ended in failure, and whether the engine may still be
/// running that job.
struct PollError {
    message: String,
    /// The job should be cancelled on the engine: we stopped waiting for it, it
    /// did not stop on its own.
    cancel_job: bool,
}

impl PollError {
    fn abandoned(message: impl Into<String>) -> Self {
        Self { message: message.into(), cancel_job: true }
    }
}

impl From<String> for PollError {
    fn from(message: String) -> Self {
        Self { message, cancel_job: false }
    }
}

impl From<&str> for PollError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

/// Frees the engine when a generation's future is dropped before it finished.
struct JobGuard {
    live: Arc<StdMutex<Live>>,
    armed: bool,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let live = self.live.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move { release_job(&live, true).await });
            }
            Err(_) => {
                if let Ok(mut l) = live.lock() {
                    l.tracker = None;
                }
            }
        }
    }
}

/// Mark the engine idle again, and when `cancel` is set ask it to stop the job
/// that was running.
async fn release_job(live: &Arc<StdMutex<Live>>, cancel: bool) {
    let (port, job) = match resident().lock().await.as_mut() {
        Some(r) => {
            r.busy = false;
            r.last_used = Instant::now();
            (Some(r.port), r.current_job.take())
        }
        None => (None, None),
    };
    if let Ok(mut l) = live.lock() {
        l.tracker = None;
    }
    if let (true, Some(port), Some(job), Ok(client)) = (cancel, port, job, http()) {
        let _ = client
            .post(format!("http://127.0.0.1:{port}/sdcpp/v1/jobs/{job}/cancel"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }
}

async fn poll_job<R: Runtime>(
    app: &tauri::AppHandle<R>,
    port: u16,
    live: &Arc<StdMutex<Live>>,
    path: &str,
    body: Value,
    _cancel_key: &str,
    timeout: Duration,
) -> Result<(String, Value), PollError> {
    let client = http()?;
    let base = format!("http://127.0.0.1:{port}");
    let submit = client
        .post(format!("{base}{path}"))
        .timeout(Duration::from_secs(60))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach the image engine: {e}"))?;
    let status = submit.status();
    let submitted: Value = submit.json().await.unwrap_or(Value::Null);
    if !(status.as_u16() == 200 || status.as_u16() == 202) {
        let message = submitted["error"]["message"].as_str().unwrap_or("The request was refused.");
        return Err(match status.as_u16() {
            400 => format!("The image engine refused the request: {message}"),
            429 => "The image engine is busy. Try again in a moment.".to_string(),
            code => format!("The image engine answered {code}: {message}"),
        }
        .into());
    }
    let job_id = submitted["id"]
        .as_str()
        .ok_or("The image engine did not give a job id.")?
        .to_string();
    if let Some(r) = resident().lock().await.as_mut() {
        r.current_job = Some(job_id.clone());
    }

    let started = Instant::now();
    loop {
        if started.elapsed() > timeout {
            return Err(PollError::abandoned("The generation took too long and was stopped."));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let (fraction, phase) = live
            .lock()
            .map(|l| (l.fraction, l.tracker.as_ref().map(|t| t.phase).unwrap_or(Phase::Queued)))
            .unwrap_or((0.0, Phase::Queued));
        let _ = app.emit(
            "diffusion-progress",
            ProgressEvent { job_id: job_id.clone(), phase: phase_name(phase), fraction },
        );
        let response = client
            .get(format!("{base}/sdcpp/v1/jobs/{job_id}"))
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        let response = match response {
            Ok(r) => r,
            Err(e) => {
                log::info!("diffusion: poll failed ({e}); cancel_requested={}", CANCEL_REQUESTED.load(Ordering::SeqCst));
                // A stop the person asked for ends the engine under us; that is a
                // cancellation, not a failure to report.
                if CANCEL_REQUESTED.load(Ordering::SeqCst) {
                    return Err("Cancelled.".into());
                }
                // Otherwise the engine stopped on its own: a crash, or an unload.
                return Err(format!("{} ({e})", diagnose(live)).into());
            }
        };
        if response.status().as_u16() == 404 || response.status().as_u16() == 410 {
            return Err("The image engine lost the job.".into());
        }
        let job: Value = response
            .json()
            .await
            .map_err(|e| PollError::abandoned(format!("The engine's answer was unreadable: {e}")))?;
        match job["status"].as_str().unwrap_or("") {
            "completed" => return Ok((job_id, job["result"].clone())),
            "cancelled" => return Err("Cancelled.".into()),
            "failed" => {
                let why = diagnose(live);
                let message = job["error"]["message"].as_str().unwrap_or("");
                return Err(if message.is_empty() { why } else { format!("{why} ({message})") }.into());
            }
            _ => {}
        }
    }
}

/// `run_job`, but when the graphics card runs out of memory the model is loaded
/// again with the next lighter offload policy and the job is retried, instead of
/// failing a run that would fit with part of the model in system memory. The
/// policy that worked stays for the next run.
async fn run_job_with_fallback<R: Runtime>(
    app: &tauri::AppHandle<R>,
    model_id: &str,
    path: &str,
    body: Value,
    steps: u32,
    batch: u32,
) -> Result<(String, Value), String> {
    loop {
        let outcome = run_job(app, path, body.clone(), steps, batch, model_id).await;
        let Err(message) = &outcome else { return outcome };
        if !is_out_of_memory(message) {
            return outcome;
        }
        let current = last_load()
            .lock()
            .ok()
            .and_then(|l| l.as_ref().filter(|(m, _)| m == model_id).map(|(_, o)| *o))
            .unwrap_or_default();
        let Some(lighter) = current.lighter() else { return outcome };
        log::info!("Image engine ran out of memory; loading {model_id} again with {lighter:?} offload");
        unload(app).await;
        if load(app, model_id, lighter).await.is_err() {
            return outcome;
        }
    }
}

fn random_seed() -> u32 {
    rand::random::<u32>()
}

/// A gallery picture as a data URL, with its size when it is a PNG.
fn gallery_image<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
) -> Result<(String, Option<(u32, u32)>), String> {
    let url = gallery::media_data_url(app, Kind::Image, id)
        .map_err(|_| format!("Image {id} is not in the gallery."))?;
    let size = url
        .split_once(',')
        .and_then(|(_, data)| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .and_then(|bytes| args::png_dimensions(&bytes));
    Ok((url, size))
}

/// Make `count` images from a prompt and save them to the gallery.
pub async fn generate_image<R: Runtime>(
    app: &tauri::AppHandle<R>,
    params: ImageParams,
) -> Result<Generated, String> {
    let def = catalog::model(&params.model).ok_or_else(|| format!("Unknown model {}.", params.model))?;
    if def.kind != Kind::Image {
        return Err(format!("{} makes video, not images.", def.display_name));
    }
    let prompt = params.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("The prompt is empty.".to_string());
    }
    if !params.reference_ids.is_empty() && !def.edit {
        return Err(format!(
            "{} cannot follow reference pictures. Use image-to-image on one picture instead, or load an instruction-edit model such as Qwen-Image-Edit.",
            def.display_name
        ));
    }
    let init_image = params.init_image_id.as_deref().map(|id| gallery_image(app, id)).transpose()?;
    let ref_images = params.reference_ids.iter().map(|id| gallery_image(app, id)).collect::<Result<Vec<_>, _>>()?;
    // An edit keeps the source's shape unless the caller sized it.
    let source_size = init_image.as_ref().or(ref_images.first()).and_then(|(_, size)| *size);
    let (default_width, default_height) = match source_size {
        Some(size) => args::edit_size(size, (def.defaults.width, def.defaults.height), def.min_side, def.max_side),
        None => (def.defaults.width, def.defaults.height),
    };
    let width = params.width.unwrap_or(default_width);
    let height = params.height.unwrap_or(default_height);
    if let Some(problem) = args::size_problem(width, height, def.min_side, def.max_side) {
        return Err(problem);
    }
    let count = params.count.unwrap_or(1).clamp(1, 4);
    let seed = params.seed.unwrap_or_else(random_seed);
    ensure_loaded(app, def.id).await?;

    let sampling = sampling_of(def, params.steps);
    let steps = sampling.steps;
    let request = ImageRequest {
        prompt: prompt.clone(),
        negative_prompt: params.negative_prompt.clone().unwrap_or_default(),
        width,
        height,
        batch: count,
        seed,
        sampling,
        lora: resolve_loras(app, &params.lora)?,
        init_image: init_image.map(|(url, _)| url),
        strength: params.strength,
        ref_images: ref_images.into_iter().map(|(url, _)| url).collect(),
    };
    let started = Instant::now();
    let (job_id, result) = run_job_with_fallback(
        app,
        def.id,
        "/sdcpp/v1/img_gen",
        build_img_gen_request(&request),
        steps,
        count,
    )
    .await?;
    let _ = app.emit(
        "diffusion-progress",
        ProgressEvent { job_id: job_id.clone(), phase: "saving", fraction: 0.99 },
    );

    let mut images: Vec<(u64, Vec<u8>)> = result["images"]
        .as_array()
        .ok_or("The image engine returned no images.")?
        .iter()
        .filter_map(|img| {
            let index = img["index"].as_u64().unwrap_or(0);
            let data = img["b64_json"].as_str()?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
            Some((index, bytes))
        })
        .collect();
    if images.is_empty() {
        return Err("The image engine returned no images.".to_string());
    }
    images.sort_by_key(|(i, _)| *i);

    let duration_ms = started.elapsed().as_millis() as u64;
    let mut ids = Vec::new();
    let mut paths = Vec::new();
    for (index, bytes) in images {
        let recipe = gallery::Recipe {
            job_id: job_id.clone(),
            kind: Kind::Image,
            prompt: prompt.clone(),
            negative_prompt: request.negative_prompt.clone(),
            width,
            height,
            steps,
            seed: seed.wrapping_add(index as u32),
            batch_seed: seed,
            model_id: def.id.to_string(),
            model_name: def.display_name.to_string(),
            lora: params.lora.iter().map(|l| gallery::LoraRecipe { name: l.name.clone(), multiplier: l.multiplier }).collect(),
            frames: None,
            fps: None,
            created_at_ms: gallery::now_ms(),
            duration_ms,
        };
        let saved = gallery::save_image(app, &recipe, index as u32, &bytes)?;
        ids.push(saved.id);
        paths.push(saved.path.to_string_lossy().into_owned());
    }
    Ok(Generated { job_id, seed, ids, paths, duration_ms })
}

/// Make a video from a prompt and save it to the gallery.
pub async fn generate_video<R: Runtime>(
    app: &tauri::AppHandle<R>,
    params: VideoParams,
) -> Result<Generated, String> {
    let def = catalog::model(&params.model).ok_or_else(|| format!("Unknown model {}.", params.model))?;
    let video = match (def.kind, def.video) {
        (Kind::Video, Some(v)) => v,
        _ => return Err(format!("{} makes images, not video.", def.display_name)),
    };
    let prompt = params.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("The prompt is empty.".to_string());
    }
    let width = params.width.unwrap_or(def.defaults.width);
    let height = params.height.unwrap_or(def.defaults.height);
    if let Some(problem) = args::size_problem(width, height, def.min_side, def.max_side) {
        return Err(problem);
    }
    let frames = args::snap_frames(
        params
            .frames
            .unwrap_or(video.frames)
            .clamp(video.min_frames, video.max_frames),
    );
    let seed = params.seed.unwrap_or_else(random_seed);
    ensure_loaded(app, def.id).await?;

    let sampling = sampling_of(def, params.steps);
    let steps = sampling.steps;
    let request = VideoRequest {
        prompt: prompt.clone(),
        negative_prompt: params.negative_prompt.clone().unwrap_or_default(),
        width,
        height,
        frames,
        fps: video.fps,
        seed,
        sampling,
        lora: resolve_loras(app, &params.lora)?,
    };
    let started = Instant::now();
    let (job_id, result) = run_job_with_fallback(app, def.id, "/sdcpp/v1/vid_gen", build_vid_gen_request(&request), steps, 1).await?;
    let _ = app.emit(
        "diffusion-progress",
        ProgressEvent { job_id: job_id.clone(), phase: "saving", fraction: 0.99 },
    );
    let data = result["b64_json"]
        .as_str()
        .ok_or("The engine returned no video.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("The video could not be decoded: {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let recipe = gallery::Recipe {
        job_id: job_id.clone(),
        kind: Kind::Video,
        prompt,
        negative_prompt: request.negative_prompt.clone(),
        width,
        height,
        steps,
        seed,
        batch_seed: seed,
        model_id: def.id.to_string(),
        model_name: def.display_name.to_string(),
        lora: params.lora.iter().map(|l| gallery::LoraRecipe { name: l.name.clone(), multiplier: l.multiplier }).collect(),
        frames: result["frame_count"].as_u64().map(|n| n as u32).or(Some(frames)),
        fps: result["fps"].as_u64().map(|n| n as u32).or(Some(video.fps)),
        created_at_ms: gallery::now_ms(),
        duration_ms,
    };
    let saved = gallery::save_video(app, &recipe, &bytes)?;
    Ok(Generated {
        job_id,
        seed,
        ids: vec![saved.id],
        paths: vec![saved.path.to_string_lossy().into_owned()],
        duration_ms,
    })
}

/// Stop the generation in progress. The engine can only cancel a queued job,
/// so a running one is stopped by stopping the engine; the next generation
/// starts it again.
/// Set when the person asked to stop the job in flight, so the engine going away
/// afterwards (stopped to make the cancel prompt) is read as that, not as a crash.
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub async fn cancel<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let (port, job) = {
        let guard = resident().lock().await;
        match guard.as_ref() {
            Some(r) if r.busy => (r.port, r.current_job.clone()),
            _ => return Ok(()),
        }
    };
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    log::info!("diffusion: cancel requested for {job:?}");
    if let Some(job) = job {
        let client = http()?;
        let base = format!("http://127.0.0.1:{port}");
        let _ = client
            .post(format!("{base}/sdcpp/v1/jobs/{job}/cancel"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let status = client
                .get(format!("{base}/sdcpp/v1/jobs/{job}"))
                .timeout(Duration::from_secs(5))
                .send()
                .await;
            let done = match status {
                Ok(r) => r
                    .json::<Value>()
                    .await
                    .map(|j| j["status"] != "generating" && j["status"] != "queued")
                    .unwrap_or(true),
                Err(_) => true,
            };
            if done {
                return Ok(());
            }
        }
    }
    unload(app).await;
    Ok(())
}

#[cfg(test)]
mod oom_tests {
    use super::*;

    #[test]
    fn the_out_of_memory_message_is_recognised_with_the_engines_own_words_after_it() {
        assert!(is_out_of_memory(OUT_OF_MEMORY));
        assert!(is_out_of_memory(&format!("{OUT_OF_MEMORY} (generate_image returned no results)")));
        assert!(!is_out_of_memory("Cancelled."));
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    /// The tests share the process-wide resident engine.
    static SERIAL: Mutex<()> = Mutex::const_new(());

    fn idle_child() -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping", "-n", "60", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn a stand-in engine")
    }

    #[tokio::test]
    async fn dropping_a_running_generation_frees_the_engine() {
        let _serial = SERIAL.lock().await;
        let live = Arc::new(StdMutex::new(Live::default()));
        *resident().lock().await = Some(Resident {
            model_id: "test-model",
            kind: Kind::Image,
            child: idle_child(),
            port: 1,
            live: live.clone(),
            last_used: Instant::now(),
            busy: true,
            current_job: Some("job-1".to_string()),
            #[cfg(windows)]
            _job: None,
        });
        {
            let _guard = JobGuard { live: live.clone(), armed: true };
            // the future holding the guard is dropped here
        }
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if resident().lock().await.as_ref().is_some_and(|r| !r.busy) {
                break;
            }
        }
        let guard = resident().lock().await;
        let r = guard.as_ref().expect("still loaded");
        assert!(!r.busy, "the engine must not stay busy");
        assert!(r.current_job.is_none());
        drop(guard);
        *resident().lock().await = None;
    }

    #[tokio::test]
    async fn a_busy_engine_is_not_replaced_by_another_model() {
        let _serial = SERIAL.lock().await;
        *resident().lock().await = Some(Resident {
            model_id: "model-a",
            kind: Kind::Image,
            child: idle_child(),
            port: 1,
            live: Arc::new(StdMutex::new(Live::default())),
            last_used: Instant::now(),
            busy: true,
            current_job: None,
            #[cfg(windows)]
            _job: None,
        });
        let refused = check_can_replace("model-b").await;
        let same = check_can_replace("model-a").await;
        *resident().lock().await = None;
        assert!(refused.unwrap_err().contains("busy"));
        assert!(same.is_ok());
        assert!(check_can_replace("model-b").await.is_ok());
    }
}

#[cfg(test)]
mod poll_error_tests {
    use super::*;

    #[test]
    fn only_an_abandoned_wait_asks_the_engine_to_cancel() {
        // We gave up waiting (timeout, unreadable answer): the job may still run.
        assert!(PollError::abandoned("took too long").cancel_job);
        // The engine said it is done, gone or refused: nothing left to cancel.
        assert!(!PollError::from("The image engine lost the job.").cancel_job);
        assert!(!PollError::from("Cancelled.".to_string()).cancel_job);
    }

    #[test]
    fn the_message_is_kept_as_written() {
        assert_eq!(PollError::abandoned("x").message, "x");
        assert_eq!(PollError::from("y").message, "y");
    }
}

#[cfg(test)]
mod load_and_timeout_tests {
    use super::*;

    #[test]
    fn job_timeout_is_floored_scaled_and_capped() {
        // Tiny job: close to the floor.
        let tiny = job_timeout(4, 1, 256, 256, 1);
        assert!(tiny >= JOB_TIMEOUT_FLOOR && tiny < Duration::from_secs(12 * 60));
        // A normal SDXL-size image sits between the bounds and grows with steps.
        let a = job_timeout(30, 1, 1024, 1024, 1);
        let b = job_timeout(60, 1, 1024, 1024, 1);
        assert!(a > JOB_TIMEOUT_FLOOR && b > a && b < JOB_TIMEOUT_CAP);
        // A huge video is capped, never unbounded.
        assert_eq!(job_timeout(50, 4, 2048, 2048, 120), JOB_TIMEOUT_CAP);
    }

    #[test]
    fn job_timeout_reads_the_request_body() {
        let image = serde_json::json!({ "width": 1024, "height": 1024 });
        let video = serde_json::json!({ "width": 1024, "height": 1024, "video_frames": 33 });
        assert!(job_timeout_for(&video, 20, 1) > job_timeout_for(&image, 20, 1));
        // A body without sizes still gets a bounded timeout.
        let t = job_timeout_for(&serde_json::json!({}), 20, 1);
        assert!(t >= JOB_TIMEOUT_FLOOR && t <= JOB_TIMEOUT_CAP);
    }

    fn sleeper() -> Child {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping -n 60 127.0.0.1 >nul"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        };
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd.spawn().expect("spawn a stub long-running process")
    }

    fn free_tcp_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn unload_during_loading_kills_child() {
        let mut child = sleeper();
        let live = Arc::new(StdMutex::new(Live::default()));
        let client = http().unwrap();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let port = free_tcp_port();
        let waiter = tokio::spawn(async move {
            let out = await_ready(&client, &mut child, port, &live, &mut rx, Duration::from_secs(60)).await;
            (out, child)
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        tx.send(true).unwrap();
        let (out, mut child) = tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .expect("the cancelled load kept waiting")
            .unwrap();
        assert_eq!(out, Err(ReadyError::Cancelled));
        assert!(child.try_wait().unwrap().is_some(), "the stub child is still running");
    }

    #[tokio::test]
    async fn a_load_that_never_answers_times_out_and_kills_the_child() {
        let mut child = sleeper();
        let live = Arc::new(StdMutex::new(Live::default()));
        let client = http().unwrap();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let out = await_ready(&client, &mut child, free_tcp_port(), &live, &mut rx, Duration::from_millis(500)).await;
        assert_eq!(out, Err(ReadyError::TimedOut));
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        assert!(child.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn an_engine_that_exits_early_reports_it() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit 3"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("false");
            c
        };
        let mut child = cmd.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let live = Arc::new(StdMutex::new(Live::default()));
        let client = http().unwrap();
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let out = await_ready(&client, &mut child, free_tcp_port(), &live, &mut rx, Duration::from_secs(5)).await;
        assert!(matches!(out, Err(ReadyError::Exited(m)) if m.contains("stopped while loading")));
    }
}
