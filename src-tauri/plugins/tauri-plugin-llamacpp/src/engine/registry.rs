//! In-process replacement for llama.cpp's router mode.
//!
//! Upstream's router is a process supervisor plus a reverse proxy: it spawns a
//! child `llama-server` per model (`server-models.cpp:1020-1046`). Linking
//! `server_context` directly means there are no children, so what survives is
//! only the bookkeeping -- a model registry with `models_max` and LRU eviction.
//! The two invariants are taken from upstream (`server-models.cpp:92-95` and
//! `:103-210`): never evict a model with requests in flight, and make a caller
//! that arrives while the registry is full wait rather than fail.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::events::{EventBus, Transition};
use super::idle::{self, Candidate, Clock};
use super::{Engine, EngineError};

/// Monotonic tick for LRU ordering. A counter rather than a clock so ordering
/// is exact under rapid use and cannot go backwards on a clock adjustment.
static TICK: AtomicU64 = AtomicU64::new(0);

fn next_tick() -> u64 {
    TICK.fetch_add(1, Ordering::Relaxed)
}

pub struct LoadedModel {
    pub engine: Arc<Engine>,
    /// Requests currently using this model. An evictor must not touch a model
    /// with a non-zero count, or it would cancel a live generation.
    inflight: usize,
    last_used: u64,
    /// Clock reading of the last acquire or release, for idle auto-unload.
    /// Separate from `last_used`: that is an ordering tick, this is time.
    last_active_ms: u64,
}

impl LoadedModel {
    pub fn engine(&self) -> Arc<Engine> {
        Arc::clone(&self.engine)
    }
}

/// Engines the registry has stopped hosting, waiting to be torn down.
///
/// Dropping an `Engine` runs `jan_llama_engine_stop`, which blocks while the
/// server loop winds down and the weights are freed. Doing that inside a
/// registry method would hold the registry's async lock for the whole
/// teardown and stall every request and `/models` poll behind it, so the
/// registry parks victims here and the caller drops them once the lock is
/// released.
///
/// Leak-proof by construction: it is `#[must_use]`, `drain` awaits the
/// teardown on a blocking thread, and merely dropping it (a forgotten value,
/// an early return, no runtime) still tears the engines down on a background
/// thread instead of on the caller's.
#[must_use = "retired engines are torn down by drain(); dropping defers it to a background thread"]
pub struct Retired(Vec<LoadedModel>);

impl Retired {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Tears the engines down off the async executor and waits for it. Use
    /// where the memory must be free before going on (an eviction ahead of a
    /// load).
    pub async fn drain(mut self) {
        let models = std::mem::take(&mut self.0);
        if models.is_empty() {
            return;
        }
        if tokio::task::spawn_blocking(move || drop(models)).await.is_err() {
            log::warn!("an engine teardown panicked");
        }
    }
}

impl Drop for Retired {
    fn drop(&mut self) {
        let models = std::mem::take(&mut self.0);
        if models.is_empty() {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || drop(models));
            }
            Err(_) => {
                std::thread::spawn(move || drop(models));
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegistryError {
    /// Every slot is taken and every resident model is busy, so nothing can be
    /// evicted to make room.
    Full { models_max: usize },
    Engine(EngineError),
}

impl From<EngineError> for RegistryError {
    fn from(e: EngineError) -> Self {
        Self::Engine(e)
    }
}

/// How a model is started, so the registry can reload one it evicted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadSpec {
    /// llama-server's own flag set.
    Args(Vec<String>),
    /// A section of a `router.preset.ini`, the file Jan already generates.
    ///
    /// `body` is the section's settings (plus the shared `[*]` block) and is
    /// compared on reload. It is not passed to the C++ loader, which re-reads
    /// the file itself -- it exists so an unrelated model can stay loaded.
    Preset {
        ini_path: String,
        section: String,
        body: Vec<String>,
    },
}

/// What `GET /models` reports per entry. The names match llama.cpp's router
/// (`server-models.h:29-37`) because the plugin's polling arm
/// (`commands::evaluate_load_poll`) already parses exactly these values, and
/// changing them would silently turn every load into a 600s timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelStatus {
    Loaded,
    Unloaded,
}

impl ModelStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Loaded => "loaded",
            Self::Unloaded => "unloaded",
        }
    }
}

/// What a reload did, for the log line. A reload that reports only `kept` is
/// the case the whole mechanism exists for: nothing was disturbed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReloadOutcome {
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    pub kept: Vec<String>,
}

/// Outcome of `Registry::begin_acquire`.
pub enum AcquireStep {
    /// Resident; already counted busy.
    Ready(Arc<Engine>),
    /// Another request is loading this model; resolves (true) when it settles.
    Wait(tokio::sync::watch::Receiver<bool>),
    /// This caller must start the engine.
    Start(LoadTicket),
}

/// The right to start one model's engine, detached from the registry so the
/// blocking load can run without its lock.
pub struct LoadTicket {
    model_id: String,
    spec: LoadSpec,
    events: EventBus,
    done: tokio::sync::watch::Sender<bool>,
    /// Set by `finish_load`. A ticket dropped without it (a task that died)
    /// would otherwise leave the model in `loading` forever.
    settled: bool,
    abandoned: Arc<std::sync::Mutex<Vec<String>>>,
}

impl Drop for LoadTicket {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // No async lock here: park the id for the registry to collect and
        // wake the waiters so they do not hang.
        if let Ok(mut v) = self.abandoned.lock() {
            v.push(self.model_id.clone());
        }
        self.done.send_replace(true);
    }
}

impl LoadTicket {
    /// Starts the engine. Blocks; call from a blocking context.
    pub fn run(&self) -> Result<Engine, EngineError> {
        let model_id = self.model_id.as_str();
        // Real load progress, straight from server_context. Only the `loading`
        // state carries a fraction; `ready` and `sleeping` arrive here too and
        // are already covered by the lifecycle transitions around the load.
        let progress = {
            let bus = self.events.clone();
            let model = model_id.to_string();
            std::sync::Arc::new(move |state: &str, payload: &str| {
                if state != "loading" {
                    return;
                }
                match serde_json::from_str::<serde_json::Value>(payload) {
                    Ok(v) if v.get("value").is_some() => {
                        bus.emit(&model, Transition::LoadProgress(v));
                    }
                    _ => {}
                }
            }) as crate::engine::sys::StateCallback
        };
        match &self.spec {
            LoadSpec::Args(args) => Engine::start(args, Some(progress)),
            LoadSpec::Preset {
                ini_path, section, ..
            } => {
                let engine = start_preset_with_mmproj_fallback(ini_path, section, |ini| {
                    Engine::start_from_preset(ini, section, Some(progress.clone()))
                })?;
                if !spec_is_embedding(&self.spec) {
                    if let Some(n) = std::fs::read_to_string(ini_path)
                        .ok()
                        .and_then(|ini| warmup_tokens(&ini, section))
                    {
                        warm_up(&engine, model_id, n);
                    }
                }
                Ok(engine)
            }
        }
    }
}

/// Prompt length of the load-time warm-up, or `None` when it is turned off.
///
/// llama.cpp's own warm-up decodes two tokens, which builds only the
/// single-token kernels. The first real prompt then pays for the batched ones:
/// on Vulkan with a cold driver shader cache (first run after an install, an
/// engine update or a driver update) that was a 20 s stall on the first
/// message, prompt speed 300 tok/s instead of 5900 (Qwen3-8B, RTX 5080). One
/// ubatch-sized pass moves that compile into the load, where the user already
/// waits behind a progress bar; with a warm cache it costs 0.15-0.3 s.
/// `no-warmup` (the extra-args opt-out) skips this as well.
fn warmup_tokens(ini: &str, section: &str) -> Option<usize> {
    use super::preset::section_value;
    let value = |k: &str| section_value(ini, section, k);
    if value("no-warmup").is_some_and(|v| !is_falsey(&v))
        || value("warmup").is_some_and(|v| is_falsey(&v))
    {
        return None;
    }
    let num = |k: &str| value(k).and_then(|v| v.parse::<i64>().ok()).filter(|n| *n > 0);
    let mut n = num("ubatch-size").unwrap_or(512);
    if let Some(batch) = num("batch-size") {
        n = n.min(batch);
    }
    if let Some(ctx) = num("ctx-size") {
        // Leaves room for the generated token and BOS in the smallest slot.
        n = n.min(ctx / num("parallel").unwrap_or(1) - 8);
    }
    (n >= 32).then_some(n as usize)
}

/// One prompt of `n` tokens plus one generated token, then the slot is erased
/// so neither the prompt cache nor a thread's saved state ever sees it. A
/// failure only costs the speed-up: the model is loaded either way.
fn warm_up(engine: &Engine, model_id: &str, n: usize) {
    let started = std::time::Instant::now();
    let body = serde_json::json!({
        // " the" is one token in every vocabulary this app ships models for.
        "prompt": " the".repeat(n),
        "n_predict": 1,
        "id_slot": 0,
        "cache_prompt": false,
        "temperature": 0,
    })
    .to_string();
    let status = engine.request("post_completions", &body).status();
    engine.request_with_query("post_slots", "id_slot=0&action=erase", "");
    if status == 200 {
        eprintln!(
            "flint-llama-worker: warmed up '{model_id}' with a {n}-token batch in {} ms",
            started.elapsed().as_millis()
        );
    } else {
        eprintln!("flint-llama-worker: warm-up of '{model_id}' failed with HTTP {status}; continuing");
    }
}

pub struct Registry {
    loaded: HashMap<String, LoadedModel>,
    specs: HashMap<String, LoadSpec>,
    /// Models whose spec changed (or which were removed) while a request was in
    /// flight. They cannot be dropped there without cancelling a live
    /// generation, so `release` drops them once the last request finishes.
    stale: HashSet<String>,
    /// Why a model's last load attempt failed. Kept so `GET /models` can report
    /// `failed: true`: without it a failed load looks merely "unloaded" and the
    /// caller's poll loop waits out its full timeout instead of erroring.
    failures: HashMap<String, String>,
    /// Models whose engine is being started right now, outside the registry
    /// lock. Counted against `models_max` so two concurrent loads cannot both
    /// claim the last slot.
    loading: HashMap<String, tokio::sync::watch::Receiver<bool>>,
    /// Models the registry has stopped hosting since the last drain, whatever
    /// dropped them. Their slots died with the engine, so the occupancy map --
    /// which lives a module over and cannot be reached from these `&mut self`
    /// methods -- has to forget them before it hands one of their slot ids to
    /// another thread. `take_dropped` is drained where occupancy is claimed.
    dropped: Vec<String>,
    /// Engines removed from `loaded` and not yet torn down; see `Retired`.
    retired: Vec<LoadedModel>,
    /// Loads whose ticket was dropped unsettled; drained by `drain_abandoned`.
    abandoned: Arc<std::sync::Mutex<Vec<String>>>,
    /// 0 means unlimited, matching llama.cpp's `--models-max`.
    models_max: usize,
    /// How long a resident model may sit unused before the sweeper unloads it.
    /// `None` keeps models until `models_max` or the user evicts them.
    idle_timeout: Option<Duration>,
    clock: Clock,
    /// Where every transition below is published for `/models/sse`.
    events: EventBus,
}

impl Registry {
    pub fn new(models_max: usize) -> Self {
        Self::with_clock(models_max, idle::system_clock())
    }

    pub fn with_clock(models_max: usize, clock: Clock) -> Self {
        Self {
            loaded: HashMap::new(),
            specs: HashMap::new(),
            stale: HashSet::new(),
            failures: HashMap::new(),
            loading: HashMap::new(),
            dropped: Vec::new(),
            retired: Vec::new(),
            abandoned: Arc::new(std::sync::Mutex::new(Vec::new())),
            models_max,
            idle_timeout: None,
            clock,
            events: EventBus::new(),
        }
    }

    /// The lifecycle feed, for the HTTP layer to subscribe to.
    pub fn events(&self) -> EventBus {
        self.events.clone()
    }

    pub fn models_max(&self) -> usize {
        self.models_max
    }

    /// Records how a model is started without loading it, so `/v1/models` can
    /// list it and a later request can load it on demand.
    pub fn register(&mut self, model_id: impl Into<String>, spec: LoadSpec) {
        self.specs.insert(model_id.into(), spec);
    }

    pub fn known_models(&self) -> Vec<String> {
        let mut v: Vec<String> = self.specs.keys().cloned().collect();
        v.sort();
        v
    }

    pub fn loaded_models(&self) -> Vec<String> {
        let mut v: Vec<String> = self.loaded.keys().cloned().collect();
        v.sort();
        v
    }

    /// Makes `model_id` resident with `inflight` requests, which the default
    /// feature config cannot reach through `acquire`. For tests elsewhere in
    /// the engine that need a busy model.
    #[cfg(all(test, not(feature = "engine")))]
    pub(crate) fn insert_resident_for_test(&mut self, model_id: &str, inflight: usize) {
        self.loaded.insert(
            model_id.to_string(),
            LoadedModel {
                engine: Arc::new(Engine::stub()),
                inflight,
                last_used: next_tick(),
                last_active_ms: (self.clock)(),
            },
        );
    }

    /// Models with at least one request in flight.
    ///
    /// The router could only report "loaded", which conflated a model that is
    /// generating with one merely resident -- so its shutdown gate refused to
    /// exit while any model was in memory. Requests in flight is the question
    /// the gate is actually asking.
    pub fn busy_models(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .loaded
            .iter()
            .filter(|(_, m)| m.inflight > 0)
            .map(|(id, _)| id.clone())
            .collect();
        v.sort();
        v
    }

    /// The identity a saved KV state is checked against: the model's preset
    /// section plus the gguf it names.
    ///
    /// Read from the registry rather than reconstructed, so the comparison is
    /// against what the model was actually loaded with. `None` means the model
    /// is not registered at all, which is not something to guess at.
    pub fn state_identity(&self, model_id: &str) -> Option<super::slots::Identity> {
        let spec = self.specs.get(model_id)?;
        let body = match spec {
            LoadSpec::Preset { body, .. } => body.clone(),
            LoadSpec::Args(args) => args.clone(),
        };
        let path = spec_model_path(&body).map(std::path::PathBuf::from);
        Some(super::slots::Identity::new(
            model_id,
            &body,
            path.as_deref(),
        ))
    }

    pub fn is_loaded(&self, model_id: &str) -> bool {
        self.loaded.contains_key(model_id)
    }

    pub fn status_of(&self, model_id: &str) -> ModelStatus {
        if self.loaded.contains_key(model_id) {
            ModelStatus::Loaded
        } else {
            ModelStatus::Unloaded
        }
    }

    /// The last load failure for a model, if the most recent attempt failed.
    pub fn failure_of(&self, model_id: &str) -> Option<&str> {
        self.failures.get(model_id).map(String::as_str)
    }

    /// True when the registry is at capacity and nothing is evictable, i.e. a
    /// caller must wait. Split out so the HTTP layer can queue instead of
    /// holding the registry lock across a load.
    pub fn is_saturated(&self) -> bool {
        if self.models_max == 0 || self.loaded.len() + self.loading.len() < self.models_max {
            return false;
        }
        self.lru_idle().is_none()
    }

    /// Acquires the engine for a model, loading (and evicting) as needed, and
    /// marks it busy. The caller must pair this with `release`.
    ///
    /// Blocks for the whole load. The HTTP layer uses `begin_acquire` /
    /// `finish_load` instead so the registry lock is not held across it.
    pub fn acquire(&mut self, model_id: &str) -> Result<Arc<Engine>, RegistryError> {
        match self.begin_acquire(model_id)? {
            AcquireStep::Ready(e) => Ok(e),
            // Only reachable when another thread is mid-load, which a caller
            // holding `&mut self` for the whole load cannot be racing.
            AcquireStep::Wait(_) => Err(RegistryError::Full {
                models_max: self.models_max,
            }),
            AcquireStep::Start(ticket) => {
                let result = ticket.run();
                self.finish_load(ticket, result, 1)
            }
        }
    }

    /// First half of an acquire. Either hands back a resident engine (busy),
    /// tells the caller to wait for a load already running, or reserves the
    /// slot and returns a ticket whose `run` the caller executes *without*
    /// holding this registry, then settles with `finish_load`.
    pub fn begin_acquire(&mut self, model_id: &str) -> Result<AcquireStep, RegistryError> {
        self.drain_abandoned();
        // A model awaiting retirement keeps serving until its in-flight
        // requests drain. Loading the new spec alongside it would put two
        // engines under one id and split the inflight count, so a late request
        // on the old spec is the lesser evil -- and is what the router does,
        // which also cannot unload a busy model.
        if let Some(m) = self.loaded.get_mut(model_id) {
            m.inflight += 1;
            m.last_used = next_tick();
            m.last_active_ms = (self.clock)();
            return Ok(AcquireStep::Ready(m.engine()));
        }
        if let Some(rx) = self.loading.get(model_id) {
            return Ok(AcquireStep::Wait(rx.clone()));
        }

        let spec = self
            .specs
            .get(model_id)
            .cloned()
            .ok_or(RegistryError::Engine(EngineError::UnknownRoute(
                model_id.to_string(),
            )))?;

        self.make_room_for(model_id)?;

        self.events.emit(model_id, Transition::Loading);
        let (tx, rx) = tokio::sync::watch::channel(false);
        self.loading.insert(model_id.to_string(), rx);
        Ok(AcquireStep::Start(LoadTicket {
            model_id: model_id.to_string(),
            spec,
            events: self.events.clone(),
            done: tx,
            settled: false,
            abandoned: Arc::clone(&self.abandoned),
        }))
    }

    /// Clears loads whose ticket vanished without settling and records them as
    /// failed, so waiters and later requests get an error instead of a ghost
    /// `loading` entry that holds a `models_max` slot.
    pub fn drain_abandoned(&mut self) {
        let ids: Vec<String> = match self.abandoned.lock() {
            Ok(mut v) => std::mem::take(&mut *v),
            Err(_) => return,
        };
        for id in ids {
            if self.loading.remove(&id).is_some() {
                self.failures
                    .insert(id.clone(), "the load was abandoned".to_string());
                self.events
                    .emit(&id, Transition::Unloaded { exit_code: 1 });
            }
        }
    }

    /// Settles a ticket: records the engine (with `inflight` requests) or the
    /// failure, and wakes everyone waiting on this load.
    pub fn finish_load(
        &mut self,
        mut ticket: LoadTicket,
        result: Result<Engine, EngineError>,
        inflight: usize,
    ) -> Result<Arc<Engine>, RegistryError> {
        ticket.settled = true;
        let model_id = ticket.model_id.clone();
        self.loading.remove(&model_id);
        let out = match result {
            Ok(engine) => {
                self.failures.remove(&model_id);
                let engine = Arc::new(engine);
                self.loaded.insert(
                    model_id.clone(),
                    LoadedModel {
                        engine: Arc::clone(&engine),
                        inflight,
                        last_used: next_tick(),
                        last_active_ms: (self.clock)(),
                    },
                );
                self.events.emit(&model_id, Transition::Loaded);
                // A reload that ran while this load was in flight changed or
                // removed the spec: serve this request, then drop the engine
                // so the next one loads the current settings.
                if self.specs.get(&model_id) != Some(&ticket.spec) {
                    self.retire(&model_id);
                }
                Ok(engine)
            }
            Err(e) => {
                // Recorded so the poll arm sees `failed: true` rather than
                // waiting out its timeout on a bare "unloaded".
                self.failures.insert(model_id.clone(), e.to_string());
                // Nonzero: this is the transition the desktop treats as a
                // definitive load failure.
                self.events
                    .emit(&model_id, Transition::Unloaded { exit_code: 1 });
                Err(e.into())
            }
        };
        let _ = ticket.done.send(true);
        out
    }

    /// Marks a request finished. Only then does the model become evictable.
    ///
    /// A model a reload superseded is dropped here rather than at reload time,
    /// which is the only point where doing so cannot cancel a generation.
    pub fn release(&mut self, model_id: &str) {
        self.release_inner(model_id, true);
    }

    /// Holds a resident model for the KV-state save without counting as use:
    /// the save runs on the idle sweep's own initiative, and if it restarted
    /// the idle timer the model it was saving could never be unloaded. Still
    /// counts as in flight, so nothing evicts the engine mid-save.
    pub fn pin_for_save(&mut self, model_id: &str) -> Option<Arc<Engine>> {
        let m = self.loaded.get_mut(model_id)?;
        m.inflight += 1;
        Some(m.engine())
    }

    pub fn unpin_after_save(&mut self, model_id: &str) {
        self.release_inner(model_id, false);
    }

    fn release_inner(&mut self, model_id: &str, touch: bool) {
        let Some(m) = self.loaded.get_mut(model_id) else {
            return;
        };
        m.inflight = m.inflight.saturating_sub(1);
        if touch {
            m.last_used = next_tick();
            m.last_active_ms = (self.clock)();
        }
        if m.inflight == 0 && self.stale.remove(model_id) {
            self.evict(model_id);
            self.dropped.push(model_id.to_string());
            self.events
                .emit(model_id, Transition::Unloaded { exit_code: 0 });
        }
    }

    /// Applies a regenerated preset without restarting the process.
    ///
    /// A model whose spec is byte-identical stays resident; one whose settings
    /// moved is dropped so the next request reloads it. This is the reason the
    /// engine does not have to be restarted when a model is imported or a
    /// per-model setting is written -- a restart would evict the chat model the
    /// user is talking to.
    pub fn reload(&mut self, specs: HashMap<String, LoadSpec>, models_max: usize) -> ReloadOutcome {
        self.models_max = models_max;
        let mut outcome = ReloadOutcome::default();

        for id in self.specs.keys().cloned().collect::<Vec<_>>() {
            if !specs.contains_key(&id) {
                self.specs.remove(&id);
                self.failures.remove(&id);
                self.retire(&id);
                outcome.removed.push(id);
            }
        }

        for (id, spec) in specs {
            match self.specs.get(&id) {
                Some(existing) if *existing == spec => {
                    if self.loaded.contains_key(&id) {
                        outcome.kept.push(id);
                    }
                }
                existing => {
                    let known = existing.is_some();
                    self.specs.insert(id.clone(), spec);
                    self.failures.remove(&id);
                    self.retire(&id);
                    if known {
                        outcome.changed.push(id);
                    } else {
                        outcome.added.push(id);
                    }
                }
            }
        }

        outcome.added.sort();
        outcome.changed.sort();
        outcome.removed.sort();
        outcome.kept.sort();
        outcome
    }

    /// Drops a resident model, or defers the drop to `release` when it is busy.
    fn retire(&mut self, model_id: &str) {
        match self.loaded.get(model_id) {
            Some(m) if m.inflight == 0 => {
                self.evict(model_id);
                self.dropped.push(model_id.to_string());
                self.events
                    .emit(model_id, Transition::Unloaded { exit_code: 0 });
            }
            Some(_) => {
                self.stale.insert(model_id.to_string());
            }
            None => {}
        }
    }

    /// Sets the idle auto-unload timeout in minutes; 0 turns it off.
    pub fn set_idle_unload_minutes(&mut self, minutes: u64) {
        self.idle_timeout = idle::timeout_from_minutes(minutes);
    }

    pub fn idle_unload_enabled(&self) -> bool {
        self.idle_timeout.is_some()
    }

    /// Resident models that have been idle past the timeout. Embedding models
    /// are skipped (see `idle::Candidate::pinned`).
    pub fn idle_expired(&self) -> Vec<String> {
        idle::expired(
            self.loaded.iter().map(|(id, m)| Candidate {
                id: id.as_str(),
                inflight: m.inflight,
                last_active_ms: m.last_active_ms,
                pinned: self.specs.get(id).is_some_and(spec_is_embedding),
            }),
            (self.clock)(),
            self.idle_timeout,
        )
    }

    /// Unloads `model_id` only if it is still idle past the timeout. The sweep
    /// lists candidates, then saves their KV state without holding this lock;
    /// a request may arrive in that gap, and this re-check is what keeps it
    /// from losing its model.
    pub fn unload_if_idle(&mut self, model_id: &str) -> bool {
        if !self.idle_expired().iter().any(|id| id == model_id) {
            return false;
        }
        self.unload(model_id)
    }

    /// Unloads a model. Refuses while requests are in flight rather than
    /// cancelling them, which is what upstream does.
    pub fn unload(&mut self, model_id: &str) -> bool {
        match self.loaded.get(model_id) {
            Some(m) if m.inflight == 0 => {
                self.evict(model_id);
                self.stale.remove(model_id);
                self.dropped.push(model_id.to_string());
                self.events
                    .emit(model_id, Transition::Unloaded { exit_code: 0 });
                true
            }
            _ => false,
        }
    }

    /// Moves a resident model out of `loaded` into the retire queue. Every
    /// removal goes through here so no engine is ever torn down under the lock.
    fn evict(&mut self, model_id: &str) {
        if let Some(m) = self.loaded.remove(model_id) {
            self.retired.push(m);
        }
    }

    /// The engines removed since the last call. Take it under the lock, then
    /// release the lock and `drain()` it (or drop it) there.
    pub fn take_retired(&mut self) -> Retired {
        Retired(std::mem::take(&mut self.retired))
    }

    /// Ids dropped since the last call, for the caller that owns the slot
    /// occupancy map. Draining is the caller's job precisely because the fix
    /// belongs on the other side of an async lock this struct cannot take.
    pub fn take_dropped(&mut self) -> Vec<String> {
        std::mem::take(&mut self.dropped)
    }

    /// Drops every resident model, ignoring in-flight requests.
    ///
    /// Unconditional where `unload` refuses a busy model: this runs only once
    /// the listener has stopped, and the point is to reach each `Engine`'s Drop
    /// -- and so `jan_llama_engine_stop` -- before the process exits. Returns
    /// the ids it released, for the log.
    pub fn shutdown(&mut self) -> Vec<String> {
        let mut ids: Vec<String> = self.loaded.keys().cloned().collect();
        ids.sort();
        self.retired.extend(self.loaded.drain().map(|(_, m)| m));
        self.stale.clear();
        self.dropped.extend(ids.iter().cloned());
        ids
    }

    /// Evicts LRU-idle models until one more fits under `models_max`.
    ///
    /// Deliberately does *not* persist the victim's KV cache: `save_model_slots`
    /// is called only from `unload_model`, which is the path Jan actually takes
    /// when switching models (`models_max` is 1, so the extension unloads before
    /// it loads). The victim's slot occupancy is still released here via
    /// `dropped`, so the residual is a lost cache and a re-prefill, not a
    /// cross-thread overwrite.
    ///
    /// It becomes reachable as soon as a user raises `models_max` above 1, or
    /// when an embedding model loads alongside a chat model on a tight budget.
    /// Saving here needs the same await-and-persist that `unload_model` does,
    /// which the registry cannot do while holding its own lock -- so it belongs
    /// with the caller, as a follow-up. `retire` has the same omission.
    fn make_room_for(&mut self, model_id: &str) -> Result<(), RegistryError> {
        // The desktop sizes `models_max` as the user's cap plus one slot for an
        // installed embedder (`resolveModelsMax` in the llamacpp extension).
        // That slot is the embedder's: a chat model loaded into it sits beside
        // the resident one, and the two overflow VRAM. The desktop's own load
        // evicts the old chat model first; requests that reach the worker
        // directly (the Local API Server) must get the same, so chat models are
        // capped at `models_max - 1` whenever an embedder is registered.
        if self.models_max > 0
            && self.is_chat(model_id)
            && self.specs.values().any(spec_is_embedding)
        {
            let chat_cap = self.models_max.saturating_sub(1).max(1);
            loop {
                let resident_chat = self
                    .loaded
                    .keys()
                    .chain(self.loading.keys())
                    .filter(|id| self.is_chat(id))
                    .count();
                if resident_chat < chat_cap {
                    break;
                }
                let victim = pick_lru_idle(
                    self.loaded
                        .iter()
                        .filter(|(id, _)| self.is_chat(id))
                        .map(|(id, m)| (id.as_str(), m.inflight, m.last_used)),
                );
                let Some(victim) = victim else {
                    return Err(RegistryError::Full {
                        models_max: self.models_max,
                    });
                };
                self.evict(&victim);
                self.dropped.push(victim.clone());
                self.events
                    .emit(&victim, Transition::Unloaded { exit_code: 0 });
            }
        }
        self.make_room()
    }

    /// A model is a chat model unless its spec starts it as an embedder. An
    /// unregistered id counts as chat, the conservative side for eviction.
    fn is_chat(&self, model_id: &str) -> bool {
        self.specs
            .get(model_id)
            .map_or(true, |s| !spec_is_embedding(s))
    }

    fn make_room(&mut self) -> Result<(), RegistryError> {
        if self.models_max == 0 {
            return Ok(());
        }
        while self.loaded.len() + self.loading.len() >= self.models_max {
            let Some(victim) = self.lru_idle() else {
                return Err(RegistryError::Full {
                    models_max: self.models_max,
                });
            };
            self.evict(&victim);
            self.dropped.push(victim.clone());
            self.events
                .emit(&victim, Transition::Unloaded { exit_code: 0 });
        }
        Ok(())
    }

    /// The least-recently-used model with nothing in flight.
    fn lru_idle(&self) -> Option<String> {
        pick_lru_idle(
            self.loaded
                .iter()
                .map(|(id, m)| (id.as_str(), m.inflight, m.last_used)),
        )
    }
}

/// The eviction policy, over plain data so it can be tested without starting an
/// engine. Busy models are never candidates; among idle ones the oldest tick
/// wins.
fn pick_lru_idle<'a>(
    entries: impl Iterator<Item = (&'a str, usize, u64)>,
) -> Option<String> {
    entries
        .filter(|(_, inflight, _)| *inflight == 0)
        .min_by_key(|(_, _, last_used)| *last_used)
        .map(|(id, _, _)| id.to_string())
}

/// The gguf a spec names, so its size and mtime can join the state guard. The
/// key is `model` in a preset section and `-m`/`--model` in an arg list; a spec
/// with neither (a remote or auto-resolved model) simply has no file to stamp.
fn spec_model_path(body: &[String]) -> Option<String> {
    let mut it = body.iter();
    while let Some(line) = it.next() {
        if line == "-m" || line == "--model" {
            return it.next().cloned();
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == "model" {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// True when the spec starts the model as an embedder: the preset section's
/// `embeddings = true` that `preset.ts` writes, or the llama-server flag.
fn spec_is_embedding(spec: &LoadSpec) -> bool {
    let body = match spec {
        LoadSpec::Preset { body, .. } => body,
        LoadSpec::Args(args) => args,
    };
    body.iter().any(|line| {
        if matches!(line.as_str(), "--embedding" | "--embeddings") {
            return true;
        }
        match line.split_once('=') {
            Some((k, v)) => {
                matches!(k.trim(), "embeddings" | "embedding") && !is_falsey(v)
            }
            None => false,
        }
    })
}

/// Text a failed load carries when the vision projector, not the language
/// model, is what ran out of memory (#148).
///
/// Both halves are needed. The out-of-memory half is `LlamacppError`'s own
/// classification, so the two cannot drift. The projector half exists because
/// llama.cpp loads the language model first and returns early if that fails, so
/// a projector marker means the text model had already loaded: retrying without
/// projector offload is then worth a second load, where for a language-model
/// OOM it would just fail the same way. The markers are llama.cpp's own log
/// text as `capture_log_callback` records it (ERROR level, first lines):
/// `server_context::load_model`'s "failed to load multimodal model, '<path>'"
/// and the function prefixes of mtmd's clip loader. llama.cpp is not vendored
/// in this repository, so they are from upstream's source, not from a test
/// fixture here.
fn is_projector_oom(message: &str) -> bool {
    use crate::error::{ErrorCode, LlamacppError};
    if !matches!(
        LlamacppError::from_load_failure(message).code,
        ErrorCode::OutOfMemory
    ) {
        return false;
    }
    let lower = message.to_lowercase();
    [
        "failed to load multimodal model",
        "clip_model_loader",
        "clip_init",
        "mtmd",
    ]
    .iter()
    .any(|m| lower.contains(m))
}

fn is_falsey(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "false" | "0" | "off" | "no"
    )
}

/// `ini` with `section` told not to offload the projector, or `None` when that
/// would change nothing: the section (or `[*]`) names no projector, or
/// offload is already off. The key is set inside the section, which overrides
/// the shared block, and any existing spelling of it there is replaced.
fn without_mmproj_offload(ini: &str, section: &str) -> Option<String> {
    let mut current: Option<&str> = None;
    let mut has_projector = false;
    let mut offload_off = false;
    for line in ini.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(name);
            continue;
        }
        if !matches!(current, Some(n) if n == "*" || n == section) {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "mmproj" if !value.trim().is_empty() => has_projector = true,
            "mmproj-offload" => offload_off = is_falsey(value),
            "no-mmproj-offload" => offload_off = !is_falsey(value),
            _ => {}
        }
    }
    if !has_projector || offload_off {
        return None;
    }

    let mut out = String::with_capacity(ini.len() + 24);
    let mut inside = false;
    let mut found = false;
    for raw in ini.lines() {
        let line = raw.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            inside = name == section && !found;
            found |= inside;
            out.push_str(raw);
            out.push('\n');
            if inside {
                out.push_str("mmproj-offload = false\n");
            }
            continue;
        }
        let key = line.split_once('=').map(|(k, _)| k.trim());
        if inside && matches!(key, Some("mmproj-offload" | "no-mmproj-offload")) {
            continue;
        }
        out.push_str(raw);
        out.push('\n');
    }
    found.then_some(out)
}

/// Starts a preset section, and if that fails because the vision projector ran
/// out of memory, tries once more with the projector kept off the GPU (#148).
/// Large vision models (Gemma 4 and the like) are where the projector's own
/// compute buffer tips a GPU that fits the language model over the edge, and
/// the projector runs acceptably on the CPU.
///
/// `start` is handed the ini to read, so the retry can point at a patched copy
/// without the real file ever being edited. Only an out-of-memory failure that
/// names the projector retries; anything else, and a retry that also fails,
/// reports the original error.
fn start_preset_with_mmproj_fallback(
    ini_path: &str,
    section: &str,
    mut start: impl FnMut(&str) -> Result<Engine, EngineError>,
) -> Result<Engine, EngineError> {
    let first = start(ini_path);
    let Err(EngineError::Start(message)) = &first else {
        return first;
    };
    if !is_projector_oom(message) {
        return first;
    }
    let Some(patched) = std::fs::read_to_string(ini_path)
        .ok()
        .and_then(|ini| without_mmproj_offload(&ini, section))
    else {
        return first;
    };

    // Beside the original so any relative path in it still resolves.
    let retry_path = format!("{ini_path}.{}.mmproj-cpu.ini", std::process::id());
    if std::fs::write(&retry_path, patched).is_err() {
        return first;
    }
    log::warn!(
        "model '{section}' ran out of memory loading its vision projector; \
         retrying once with the projector on the CPU (mmproj-offload = false)"
    );
    let retried = start(&retry_path);
    let _ = std::fs::remove_file(&retry_path);

    match retried {
        Ok(engine) => {
            log::warn!(
                "model '{section}' loaded with its vision projector on the CPU \
                 because it did not fit on the GPU; image prompts will be slower"
            );
            Ok(engine)
        }
        Err(_) => {
            let Err(EngineError::Start(message)) = first else {
                return first;
            };
            Err(EngineError::Start(format!(
                "{message}; the vision projector was retried on the CPU \
                 (mmproj-offload = false) and the model still did not load"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warmup_is_one_ubatch_and_respects_the_opt_out() {
        let ini = "[*]\nctx-size = 8192\nubatch-size = 512\n\n[a]\nubatch-size = 1024\n\n[b]\n";
        assert_eq!(warmup_tokens(ini, "a"), Some(1024));
        assert_eq!(warmup_tokens(ini, "b"), Some(512));
        assert_eq!(warmup_tokens("[a]\n", "a"), Some(512));
        // Bounded by batch and by the smallest slot's context.
        assert_eq!(warmup_tokens("[a]\nubatch-size = 2048\nbatch-size = 1024\n", "a"), Some(1024));
        assert_eq!(warmup_tokens("[a]\nctx-size = 512\nparallel = 2\n", "a"), Some(248));
        assert_eq!(warmup_tokens("[a]\nctx-size = 32\n", "a"), None);
        assert_eq!(warmup_tokens("[*]\nno-warmup = true\n[a]\n", "a"), None);
        assert_eq!(warmup_tokens("[a]\nwarmup = false\n", "a"), None);
        assert_eq!(warmup_tokens("[a]\nno-warmup = false\n", "a"), Some(512));
    }

    fn spec(n: &str) -> LoadSpec {
        LoadSpec::Args(vec!["llama-server".into(), "-m".into(), n.into()])
    }

    /// Without the `engine` feature every load fails, which still exercises
    /// the bookkeeping: registration, capacity and eviction order are decided
    /// before an engine is ever started.
    fn reg(max: usize, models: &[&str]) -> Registry {
        let mut r = Registry::new(max);
        for m in models {
            r.register(*m, spec(m));
        }
        r
    }

    /// Puts a model in `loaded` without a load, which the default feature
    /// config cannot do: `acquire` always fails there.
    #[cfg(not(feature = "engine"))]
    fn resident(r: &mut Registry, models: &[&str]) {
        for m in models {
            r.register(*m, spec(m));
            r.loaded.insert(
                (*m).to_string(),
                LoadedModel {
                    engine: Arc::new(Engine::stub()),
                    inflight: 0,
                    last_used: next_tick(),
                    last_active_ms: (r.clock)(),
                },
            );
        }
    }

    fn timed(max: usize) -> (Registry, std::sync::Arc<std::sync::atomic::AtomicU64>) {
        let (clock, now) = crate::engine::idle::manual_clock();
        (Registry::with_clock(max, clock), now)
    }

    fn advance(now: &std::sync::atomic::AtomicU64, ms: u64) {
        now.fetch_add(ms, std::sync::atomic::Ordering::Relaxed);
    }

    #[test]
    fn dropping_ticket_unblocks_waiters_with_error() {
        let mut r = reg(1, &["a"]);
        let ticket = match r.begin_acquire("a").unwrap() {
            AcquireStep::Start(t) => t,
            _ => panic!("expected a ticket"),
        };
        let rx = match r.begin_acquire("a").unwrap() {
            AcquireStep::Wait(rx) => rx,
            _ => panic!("expected to wait"),
        };
        drop(ticket);
        assert!(*rx.borrow());
        r.drain_abandoned();
        assert!(!r.loading.contains_key("a"));
        assert_eq!(r.failure_of("a"), Some("the load was abandoned"));
        // The slot is free again: a new request can start a load.
        assert!(matches!(
            r.begin_acquire("a").unwrap(),
            AcquireStep::Start(_)
        ));
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn idle_unload_is_off_by_default() {
        let (mut r, now) = timed(2);
        resident(&mut r, &["a"]);
        advance(&now, 24 * 3_600_000);
        assert!(!r.idle_unload_enabled());
        assert!(r.idle_expired().is_empty());
        assert!(!r.unload_if_idle("a"));
        assert!(r.is_loaded("a"));
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn an_idle_model_is_unloaded_and_recorded() {
        let (mut r, now) = timed(2);
        r.set_idle_unload_minutes(5);
        resident(&mut r, &["a"]);
        advance(&now, 299_000);
        assert!(!r.unload_if_idle("a"), "not idle long enough yet");
        advance(&now, 1_000);
        assert!(r.unload_if_idle("a"));
        assert!(!r.is_loaded("a"));
        assert_eq!(r.take_dropped(), vec!["a".to_string()]);
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_release_restarts_the_idle_timer() {
        let (mut r, now) = timed(2);
        r.set_idle_unload_minutes(5);
        resident(&mut r, &["a"]);
        advance(&now, 240_000);
        r.loaded.get_mut("a").unwrap().inflight = 1;
        advance(&now, 240_000);
        assert!(r.idle_expired().is_empty(), "busy for the whole time");
        r.release("a");
        advance(&now, 240_000);
        assert!(r.idle_expired().is_empty(), "timer restarted at release");
        advance(&now, 60_000);
        assert_eq!(r.idle_expired(), vec!["a".to_string()]);
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_busy_model_is_not_unloaded_however_old() {
        let (mut r, now) = timed(2);
        r.set_idle_unload_minutes(1);
        resident(&mut r, &["a"]);
        r.loaded.get_mut("a").unwrap().inflight = 1;
        advance(&now, 3_600_000);
        assert!(!r.unload_if_idle("a"));
        assert!(r.is_loaded("a"));
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn an_embedding_model_is_never_idle_unloaded() {
        let (mut r, now) = timed(3);
        r.set_idle_unload_minutes(1);
        resident(&mut r, &["chat"]);
        r.register(
            "embed",
            LoadSpec::Preset {
                ini_path: "p.ini".into(),
                section: "embed".into(),
                body: vec!["model = e.gguf".into(), "embeddings = true".into()],
            },
        );
        r.loaded.insert(
            "embed".to_string(),
            LoadedModel {
                engine: Arc::new(Engine::stub()),
                inflight: 0,
                last_used: next_tick(),
                last_active_ms: 0,
            },
        );
        advance(&now, 3_600_000);
        assert_eq!(r.idle_expired(), vec!["chat".to_string()]);
    }

    #[test]
    fn embedding_specs_are_recognised() {
        let preset = |b: &[&str]| LoadSpec::Preset {
            ini_path: "p".into(),
            section: "s".into(),
            body: b.iter().map(|s| s.to_string()).collect(),
        };
        assert!(spec_is_embedding(&preset(&["embeddings = true"])));
        assert!(!spec_is_embedding(&preset(&["embeddings = false"])));
        assert!(!spec_is_embedding(&preset(&["model = m.gguf"])));
        assert!(spec_is_embedding(&LoadSpec::Args(vec!["--embedding".into()])));
    }

    /// The desktop adds one slot to `models_max` when an embedder is installed,
    /// so RAG can load it beside the chat model. That slot is not room for a
    /// second chat model: an API client asking for model B while A is resident
    /// used to load B beside A, and the two overflowed VRAM (one ran at about a
    /// twentieth of its speed). A chat load evicts the idle chat model instead,
    /// which is what the desktop's own load path does.
    #[cfg(not(feature = "engine"))]
    #[test]
    fn the_embedding_slot_is_not_room_for_a_second_chat_model() {
        let embedder = LoadSpec::Args(vec!["-m".into(), "e.gguf".into(), "--embedding".into()]);
        let mut r = Registry::new(2);
        r.register("emb", embedder.clone());
        resident(&mut r, &["a"]);
        r.register("b", spec("b"));
        assert!(r.make_room_for("b").is_ok());
        assert_eq!(r.take_dropped(), vec!["a".to_string()]);

        // The embedder still loads beside the chat model.
        let mut r = Registry::new(2);
        r.register("emb", embedder.clone());
        resident(&mut r, &["a"]);
        assert!(r.make_room_for("emb").is_ok());
        assert!(r.take_dropped().is_empty());

        // A resident embedder is not the chat model's victim either.
        let mut r = Registry::new(2);
        r.register("emb", embedder.clone());
        r.insert_resident_for_test("emb", 0);
        resident(&mut r, &["a"]);
        r.register("b", spec("b"));
        assert!(r.make_room_for("b").is_ok());
        assert_eq!(r.take_dropped(), vec!["a".to_string()]);

        // A busy chat model is never evicted mid-generation: the caller waits.
        let mut r = Registry::new(2);
        r.register("emb", embedder.clone());
        r.register("a", spec("a"));
        r.insert_resident_for_test("a", 1);
        r.register("b", spec("b"));
        assert!(matches!(r.make_room_for("b"), Err(RegistryError::Full { .. })));

        // No embedder installed: models_max is all chat, as before.
        let mut r = Registry::new(2);
        resident(&mut r, &["a"]);
        r.register("b", spec("b"));
        assert!(r.make_room_for("b").is_ok());
        assert!(r.take_dropped().is_empty());

        // A user cap of 2 (+1 embedding slot = 3) keeps two chat models.
        let mut r = Registry::new(3);
        r.register("emb", embedder);
        resident(&mut r, &["a"]);
        r.register("b", spec("b"));
        assert!(r.make_room_for("b").is_ok());
        assert!(r.take_dropped().is_empty());
    }

    /// Every path that stops hosting a model has to say so: the slot occupancy
    /// map lives behind an async lock this struct cannot take, and a model
    /// missing from this list keeps its stale claim on a slot id that another
    /// thread will later be handed.
    #[cfg(not(feature = "engine"))]
    #[test]
    fn each_drop_path_records_the_model_it_dropped() {
        let mut r = Registry::new(2);
        resident(&mut r, &["a"]);
        assert!(r.unload("a"));
        assert_eq!(r.take_dropped(), vec!["a".to_string()]);
        assert!(r.take_dropped().is_empty(), "draining is not repeatable");

        resident(&mut r, &["b"]);
        r.retire("b");
        assert_eq!(r.take_dropped(), vec!["b".to_string()]);

        // Eviction under models_max: the victim is dropped by make_room rather
        // than by a caller, which is the path with no async context at all.
        let mut r = Registry::new(1);
        resident(&mut r, &["c"]);
        assert!(r.make_room().is_ok());
        assert_eq!(r.take_dropped(), vec!["c".to_string()]);

        let mut r = Registry::new(2);
        resident(&mut r, &["d", "e"]);
        let mut ids = r.shutdown();
        ids.sort();
        assert_eq!(ids, vec!["d".to_string(), "e".to_string()]);
        let mut dropped = r.take_dropped();
        dropped.sort();
        assert_eq!(dropped, vec!["d".to_string(), "e".to_string()]);
    }

    /// #281: a model superseded while busy is dropped by `release` once its
    /// last request ends, and that drop path has to record itself like the
    /// others, or its stale slot claims survive the reload.
    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_deferred_retirement_records_the_model_when_released() {
        let mut r = Registry::new(2);
        resident(&mut r, &["a"]);
        r.loaded.get_mut("a").unwrap().inflight = 1;
        r.retire("a");
        assert!(r.take_dropped().is_empty(), "a busy model was recorded before it was dropped");
        r.release("a");
        assert!(!r.loaded.contains_key("a"));
        assert_eq!(r.take_dropped(), vec!["a".to_string()]);
    }

    /// A busy model is not dropped, so it must not be recorded as dropped
    /// either -- releasing its occupancy would discard a live slot's claim.
    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_busy_model_is_neither_dropped_nor_recorded() {
        let mut r = Registry::new(2);
        resident(&mut r, &["a"]);
        r.loaded.get_mut("a").unwrap().inflight = 1;
        assert!(!r.unload("a"), "unload must refuse a busy model");
        r.retire("a");
        assert!(r.take_dropped().is_empty());
    }

    #[test]
    fn registration_does_not_load() {
        let r = reg(2, &["a", "b"]);
        assert_eq!(r.known_models(), vec!["a", "b"]);
        assert!(r.loaded_models().is_empty());
        assert!(!r.is_loaded("a"));
    }

    #[test]
    fn an_unregistered_model_is_rejected_before_any_load() {
        let mut r = reg(2, &["a"]);
        let err = r.acquire("nope").unwrap_err();
        assert!(matches!(err, RegistryError::Engine(_)));
    }

    #[test]
    fn models_max_zero_means_unlimited() {
        let r = reg(0, &["a"]);
        assert_eq!(r.models_max(), 0);
        assert!(!r.is_saturated(), "unlimited must never saturate");
    }

    #[test]
    fn release_is_saturating_and_never_underflows() {
        let mut r = reg(1, &["a"]);
        // release on a model that was never loaded must be a no-op, not a panic
        r.release("a");
        r.release("a");
        assert!(!r.is_loaded("a"));
    }

    fn specs(pairs: &[(&str, &str)]) -> HashMap<String, LoadSpec> {
        pairs
            .iter()
            .map(|(id, path)| ((*id).to_string(), spec(path)))
            .collect()
    }

    #[test]
    fn reload_registers_new_models_and_drops_removed_ones() {
        let mut r = reg(2, &["a", "b"]);
        let outcome = r.reload(specs(&[("b", "b"), ("c", "c")]), 2);
        assert_eq!(outcome.added, vec!["c"]);
        assert_eq!(outcome.removed, vec!["a"]);
        assert!(outcome.changed.is_empty());
        assert_eq!(r.known_models(), vec!["b", "c"]);
    }

    /// The point of reloading rather than restarting: a model whose settings
    /// did not move is left alone.
    #[test]
    fn reload_reports_an_unchanged_spec_as_neither_added_nor_changed() {
        let mut r = reg(2, &["a"]);
        let outcome = r.reload(specs(&[("a", "a")]), 2);
        assert!(outcome.added.is_empty());
        assert!(outcome.changed.is_empty());
        assert!(outcome.removed.is_empty());
    }

    #[test]
    fn reload_reports_a_moved_spec_as_changed() {
        let mut r = reg(2, &["a"]);
        let outcome = r.reload(specs(&[("a", "a-different-gguf")]), 2);
        assert_eq!(outcome.changed, vec!["a"]);
        assert!(outcome.added.is_empty());
    }

    /// The router fixed models_max at spawn, so Jan had to cold-restart the
    /// whole process just to add the embedding slot.
    #[test]
    fn reload_resizes_models_max() {
        let mut r = reg(1, &["a"]);
        r.reload(specs(&[("a", "a")]), 2);
        assert_eq!(r.models_max(), 2);
    }

    #[test]
    fn reload_clears_a_recorded_failure_so_a_fixed_model_is_retried() {
        let mut r = reg(1, &["a"]);
        // A failed load is what populates `failures`; without the engine
        // feature every acquire fails, which is exactly the state needed here.
        let _ = r.acquire("a");
        assert!(r.failure_of("a").is_some());
        r.reload(specs(&[("a", "a-fixed")]), 1);
        assert!(
            r.failure_of("a").is_none(),
            "a changed spec must not inherit the old failure"
        );
    }

    #[test]
    fn make_room_returns_victims_instead_of_dropping() {
        let mut r = Registry::new(1);
        resident(&mut r, &["a"]);
        let probe = Arc::clone(&r.loaded["a"].engine);
        assert_eq!(Arc::strong_count(&probe), 2);
        r.make_room().unwrap();
        // Gone from the registry, but the engine is parked, not dropped.
        assert!(!r.is_loaded("a"));
        assert_eq!(Arc::strong_count(&probe), 2, "engine was dropped under the lock");
        let retired = r.take_retired();
        assert_eq!(retired.len(), 1);
        assert!(r.take_retired().is_empty(), "taking is not repeatable");
        drop(retired);
    }

    #[tokio::test]
    async fn drain_tears_the_engines_down_and_dropping_does_too() {
        let mut r = Registry::new(0);
        resident(&mut r, &["a", "b"]);
        let a = Arc::clone(&r.loaded["a"].engine);
        let b = Arc::clone(&r.loaded["b"].engine);
        assert!(r.unload("a"));
        r.take_retired().drain().await;
        assert_eq!(Arc::strong_count(&a), 1, "drain left the engine alive");
        assert!(r.unload("b"));
        // A forgotten value still tears down, on a background thread.
        drop(r.take_retired());
        for _ in 0..100 {
            if Arc::strong_count(&b) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("a dropped Retired never released its engine");
    }

    #[test]
    fn shutdown_and_retire_park_engines() {
        let mut r = Registry::new(0);
        resident(&mut r, &["a", "b"]);
        assert_eq!(r.shutdown(), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(r.take_retired().len(), 2);
    }

    #[test]
    fn unload_refuses_a_model_that_is_not_loaded() {
        let mut r = reg(1, &["a"]);
        assert!(!r.unload("a"));
    }

    #[test]
    fn lru_picks_the_least_recently_used_idle_model() {
        let entries = [("old", 0usize, 1u64), ("new", 0, 2)];
        assert_eq!(
            pick_lru_idle(entries.iter().copied()).as_deref(),
            Some("old")
        );
    }

    #[test]
    fn a_busy_model_is_never_evicted_even_if_it_is_oldest() {
        // Upstream's rule (server-models.cpp:92-95): evicting a model with a
        // request in flight would cancel a live generation.
        let entries = [("old-but-busy", 3usize, 1u64), ("idle", 0, 9)];
        assert_eq!(
            pick_lru_idle(entries.iter().copied()).as_deref(),
            Some("idle")
        );
    }

    #[test]
    fn nothing_is_evictable_when_every_model_is_busy() {
        let entries = [("a", 1usize, 1u64), ("b", 2, 2)];
        assert_eq!(pick_lru_idle(entries.iter().copied()), None);
    }

    #[test]
    fn a_specs_model_path_is_found_in_either_spelling() {
        assert_eq!(
            spec_model_path(&["ctx-size = 4096".into(), "model = /m/a.gguf".into()]),
            Some("/m/a.gguf".to_string())
        );
        assert_eq!(
            spec_model_path(&["-m".into(), "/m/b.gguf".into()]),
            Some("/m/b.gguf".to_string())
        );
        assert_eq!(spec_model_path(&["ctx-size = 4096".into()]), None);
    }

    // `mmproj` and `model-draft` also end in a path; matching them would stamp
    // the state guard against the wrong file.
    #[test]
    fn a_key_merely_ending_in_model_is_not_the_model_path() {
        assert_eq!(spec_model_path(&["mmproj = /m/mm.gguf".into()]), None);
        assert_eq!(spec_model_path(&["model-draft = /m/d.gguf".into()]), None);
    }

    #[test]
    fn state_identity_follows_the_registered_spec() {
        let mut r = reg(1, &[]);
        r.register("m", spec("/m/a.gguf"));
        let id = r.state_identity("m").expect("registered");
        assert_eq!(id.model, "m");
        r.register("m", spec("/m/b.gguf"));
        assert_ne!(
            r.state_identity("m").unwrap().spec,
            id.spec,
            "a spec change must invalidate saved state"
        );
        assert!(r.state_identity("absent").is_none());
    }

    #[test]
    fn ticks_are_monotonic_so_lru_order_cannot_invert() {
        let a = next_tick();
        let b = next_tick();
        assert!(b > a, "tick went backwards: {a} then {b}");
    }

    const GEMMA: &str = "[*]\nparallel = 1\n\n[gemma]\nmodel = /m/g.gguf\nmmproj = /m/mm.gguf\n\n[plain]\nmodel = /m/p.gguf\n";
    const PROJECTOR_OOM: &str = "failed to load model; alloc_tensor_range: failed to allocate CUDA0 buffer of size 2491323904; srv load_model: failed to load multimodal model, '/m/mm.gguf'";

    #[test]
    fn a_projector_out_of_memory_is_recognised() {
        assert!(is_projector_oom(PROJECTOR_OOM));
        assert!(is_projector_oom(
            "clip_model_loader: ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory"
        ));
    }

    #[test]
    fn a_language_model_out_of_memory_is_not_a_projector_failure() {
        // The text model loads first, so no projector marker ever appears for it.
        assert!(!is_projector_oom(
            "failed to load model; ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory"
        ));
    }

    #[test]
    fn a_non_memory_projector_failure_is_not_retried() {
        assert!(!is_projector_oom(
            "srv load_model: failed to load multimodal model, '/m/mm.gguf'"
        ));
    }

    #[test]
    fn offload_is_turned_off_in_the_named_section_only() {
        let out = without_mmproj_offload(GEMMA, "gemma").unwrap();
        assert_eq!(
            out,
            "[*]\nparallel = 1\n\n[gemma]\nmmproj-offload = false\nmodel = /m/g.gguf\nmmproj = /m/mm.gguf\n\n[plain]\nmodel = /m/p.gguf\n"
        );
    }

    #[test]
    fn nothing_is_patched_without_a_projector_or_when_offload_is_already_off() {
        assert_eq!(without_mmproj_offload(GEMMA, "plain"), None);
        assert_eq!(without_mmproj_offload(GEMMA, "absent"), None);
        let off = GEMMA.replace("mmproj = /m/mm.gguf", "mmproj = /m/mm.gguf\nmmproj-offload = false");
        assert_eq!(without_mmproj_offload(&off, "gemma"), None);
        let shared_off = GEMMA.replace("parallel = 1", "mmproj-offload = false");
        assert_eq!(without_mmproj_offload(&shared_off, "gemma"), None);
    }

    #[test]
    fn an_existing_enabled_offload_key_is_replaced_not_duplicated() {
        let on = GEMMA.replace("mmproj = /m/mm.gguf", "mmproj = /m/mm.gguf\nmmproj-offload = true");
        let out = without_mmproj_offload(&on, "gemma").unwrap();
        assert_eq!(out.matches("mmproj-offload").count(), 1);
        assert!(out.contains("mmproj-offload = false"));
    }

    #[cfg(not(feature = "engine"))]
    fn ini_file(tag: &str) -> String {
        let path = std::env::temp_dir().join(format!("fx148-{tag}-{}.ini", std::process::id()));
        std::fs::write(&path, GEMMA).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_projector_oom_retries_once_on_a_patched_copy_and_cleans_up() {
        let ini = ini_file("retry");
        let mut seen: Vec<String> = Vec::new();
        let mut retry_path = String::new();
        let result = start_preset_with_mmproj_fallback(&ini, "gemma", |p| {
            seen.push(std::fs::read_to_string(p).unwrap());
            if seen.len() == 1 {
                Err(EngineError::Start(PROJECTOR_OOM.into()))
            } else {
                retry_path = p.to_string();
                Ok(Engine::stub())
            }
        });
        assert!(result.is_ok());
        assert_eq!(seen.len(), 2);
        assert!(!seen[0].contains("mmproj-offload"));
        assert!(seen[1].contains("mmproj-offload = false"));
        assert!(!std::path::Path::new(&retry_path).exists(), "temp copy left behind");
        let _ = std::fs::remove_file(&ini);
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn a_failed_retry_reports_the_original_error_with_a_note() {
        let ini = ini_file("fail");
        let mut calls = 0;
        let result = start_preset_with_mmproj_fallback(&ini, "gemma", |_| {
            calls += 1;
            Err(EngineError::Start(PROJECTOR_OOM.into()))
        });
        assert_eq!(calls, 2, "exactly one retry");
        let Err(EngineError::Start(msg)) = result else { panic!("expected a start error") };
        assert!(msg.starts_with(PROJECTOR_OOM));
        assert!(msg.contains("retried on the CPU"));
        let _ = std::fs::remove_file(&ini);
    }

    #[cfg(not(feature = "engine"))]
    #[test]
    fn other_failures_and_projectorless_models_are_not_retried() {
        let ini = ini_file("noretry");
        let mut calls = 0;
        let _ = start_preset_with_mmproj_fallback(&ini, "gemma", |_| {
            calls += 1;
            Err(EngineError::Start("failed to load model; unknown model architecture".into()))
        });
        assert_eq!(calls, 1);
        let mut calls = 0;
        let _ = start_preset_with_mmproj_fallback(&ini, "plain", |_| {
            calls += 1;
            Err(EngineError::Start(PROJECTOR_OOM.into()))
        });
        assert_eq!(calls, 1, "no projector configured, nothing to turn off");
        let _ = std::fs::remove_file(&ini);
    }
}
