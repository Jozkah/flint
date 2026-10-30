//! Tauri surface of the engine add-ons (see `addon.rs` for the pack format and
//! the security model). Nothing here downloads on its own: every download
//! starts from a user's click in the frontend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use super::addon::{self, AddonError, Eligibility, Expect, HostFacts, OwnedExpect};
use crate::state::LlamacppState;

/// The error shape the frontend receives: a stable code plus the detail.
#[derive(Debug, Serialize)]
pub struct AddonFailure {
    pub code: &'static str,
    pub message: String,
}

impl From<AddonError> for AddonFailure {
    fn from(e: AddonError) -> Self {
        Self { code: e.code(), message: e.to_string() }
    }
}

fn fail(e: AddonError) -> String {
    serde_json::to_string(&AddonFailure::from(e)).unwrap_or_default()
}

/// Where add-ons live: `<data folder>/engine-addons`, set by the app at
/// startup; the app's local data dir when it was not.
pub fn addon_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &LlamacppState) -> PathBuf {
    if let Some(root) = state.addon_root.get() {
        return root.clone();
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("engine-addons")
}

fn expect_for(release_tag: Option<String>) -> Option<OwnedExpect> {
    Some(OwnedExpect {
        kind: addon::CUDA_KIND.into(),
        platform: addon::platform()?.into(),
        engine_commit: super::PINNED_COMMIT.into(),
        release_tag,
    })
}

/// True when the engine the app runs already has a CUDA module beside it.
fn bundled_cuda(worker_exe: Option<&Path>) -> bool {
    worker_exe
        .and_then(Path::parent)
        .is_some_and(|dir| dir.join(addon::cuda_module_name()).is_file())
}

fn host_facts(worker_exe: Option<&Path>) -> (HostFacts, Option<String>) {
    use tauri_plugin_hardware::vendor::nvidia::{get_nvidia_gpus, nvidia_driver};
    let gpus = get_nvidia_gpus();
    let driver = nvidia_driver();
    let facts = HostFacts {
        platform: addon::platform(),
        nvidia_compute: gpus
            .iter()
            .filter_map(|g| g.nvidia_info.as_ref())
            .filter_map(|n| addon::parse_compute(&n.compute_capability))
            .collect(),
        driver_branch: driver.as_ref().and_then(|d| addon::parse_driver_branch(&d.version)),
        bundled_cuda: bundled_cuda(worker_exe),
    };
    (facts, driver.map(|d| d.version))
}

/// The environment the worker needs to load the installed add-on, if one
/// verifies and the bundle has no CUDA of its own. Records which add-on the
/// started worker uses, so a later install can tell it needs a restart.
pub fn apply_worker_env<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &LlamacppState,
    worker_exe: &Path,
    envs: &mut HashMap<String, String>,
) -> Option<PathBuf> {
    if bundled_cuda(Some(worker_exe)) {
        return None;
    }
    let exp = expect_for(None)?;
    let root = addon_root(app, state);
    addon::sweep_leftovers(&root);
    let dir = addon::active_addon(&root, addon::pubkey().as_deref(), &exp.as_expect())?;
    log::info!("engine add-on in use: {}", dir.display());
    envs.insert(addon::WORKER_ADDON_ENV.into(), dir.to_string_lossy().into_owned());
    Some(dir)
}

#[derive(Debug, Serialize)]
pub struct InstalledDto {
    pub kind: String,
    pub release_tag: String,
    pub engine_tag: String,
    pub size: u64,
    pub dir: String,
    pub compatible: bool,
    pub problem: Option<AddonFailure>,
}

#[derive(Debug, Serialize)]
pub struct AddonStatus {
    /// Whether this build can have add-ons at all (platform + signing key).
    pub supported: bool,
    pub signing_configured: bool,
    pub kind: &'static str,
    pub release_tag: String,
    pub eligibility: Eligibility,
    pub driver_version: Option<String>,
    pub min_driver: u32,
    pub installed: Vec<InstalledDto>,
    /// The installed add-on the running engine was started with.
    pub in_use: Option<String>,
    /// An add-on was installed or removed since the engine started.
    pub restart_pending: bool,
    pub downloading: bool,
}

fn installed_list(root: &Path, exp: &OwnedExpect) -> Vec<InstalledDto> {
    let key = addon::pubkey();
    addon::list_dirs(root, &exp.kind)
        .into_iter()
        .map(|dir| {
            let read = addon::read_installed(&dir, key.as_deref(), &exp.as_expect());
            let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let (release_tag, engine_tag) = match &read {
                Ok(m) => (m.release_tag.clone(), m.engine_tag.clone()),
                Err(_) => (name.trim_start_matches(&format!("{}-", exp.kind)).to_string(), String::new()),
            };
            InstalledDto {
                kind: exp.kind.clone(),
                release_tag,
                engine_tag,
                size: addon::dir_size(&dir),
                dir: dir.to_string_lossy().into_owned(),
                compatible: read.is_ok(),
                problem: read.err().map(AddonFailure::from),
            }
        })
        .collect()
}

async fn running_addon(state: &LlamacppState) -> (bool, Option<PathBuf>) {
    let running = state.engine.lock().await.is_some();
    let in_use = state.addon_in_use.lock().ok().and_then(|g| g.clone());
    (running, in_use)
}

#[tauri::command]
pub async fn engine_addon_status<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
) -> Result<AddonStatus, String> {
    let tag = addon::release_tag(&app_handle.package_info().version.to_string());
    let worker = super::commands::resolve_worker_exe(&app_handle).ok();
    let (facts, driver_version) = tokio::task::spawn_blocking(move || host_facts(worker.as_deref()))
        .await
        .map_err(|e| e.to_string())?;
    let eligibility = addon::eligibility(&facts, addon::CUDA13_MIN_DRIVER, addon::CUDA13_MIN_COMPUTE);
    let root = addon_root(&app_handle, &state);
    let exp = expect_for(Some(tag.clone()));
    let installed = exp.as_ref().map(|e| installed_list(&root, e)).unwrap_or_default();
    let (running, in_use) = running_addon(&state).await;
    let current = exp
        .as_ref()
        .and_then(|e| addon::active_addon(&root, addon::pubkey().as_deref(), &e.as_expect().with_any_tag()));
    let signing = addon::pubkey().is_some();
    Ok(AddonStatus {
        supported: facts.platform.is_some() && signing,
        signing_configured: signing,
        kind: addon::CUDA_KIND,
        release_tag: tag,
        eligibility,
        driver_version,
        min_driver: addon::CUDA13_MIN_DRIVER,
        installed,
        in_use: in_use.as_ref().map(|p| p.to_string_lossy().into_owned()),
        restart_pending: running && in_use != current,
        downloading: state.addon_busy.load(Ordering::SeqCst),
    })
}

/// True when the running engine was started with a different add-on state
/// than what is installed now (installed, removed or replaced since). The
/// extension restarts the idle engine before the next model load, which is
/// how a fresh install takes effect without a click.
#[tauri::command]
pub async fn engine_addon_restart_pending<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
) -> Result<bool, String> {
    let (running, in_use) = running_addon(&state).await;
    if !running {
        return Ok(false);
    }
    let Some(exp) = expect_for(None) else {
        return Ok(false);
    };
    if let Ok(exe) = super::commands::resolve_worker_exe(&app_handle) {
        if bundled_cuda(Some(&exe)) {
            return Ok(false);
        }
    }
    let root = addon_root(&app_handle, &state);
    let current = addon::active_addon(&root, addon::pubkey().as_deref(), &exp.as_expect());
    Ok(in_use != current)
}

#[derive(Debug, Serialize)]
pub struct RemotePack {
    pub release_tag: String,
    pub archive_size: u64,
    pub installed_size: u64,
    pub min_driver: u32,
    pub min_compute: u32,
    pub cuda_toolkit: Option<String>,
}

/// Reads this release's published manifest (small; no pack download).
#[tauri::command]
pub async fn engine_addon_check<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<RemotePack, String> {
    let tag = addon::release_tag(&app_handle.package_info().version.to_string());
    let exp = expect_for(Some(tag.clone())).ok_or_else(|| fail(AddonError::UnsupportedPlatform))?;
    let client = addon::http_client().map_err(fail)?;
    let m = addon::fetch_manifest(&client, &tag, &exp.as_expect())
        .await
        .map_err(fail)?;
    Ok(RemotePack {
        release_tag: m.release_tag.clone(),
        archive_size: m.archive.as_ref().map_or(0, |a| a.size),
        installed_size: m.installed_size(),
        min_driver: m.min_driver,
        min_compute: m.min_compute,
        cuda_toolkit: m.cuda_toolkit,
    })
}

/// Releases the busy flag however the download ends.
struct Busy(Arc<LlamacppState>);
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.addon_busy.store(false, Ordering::SeqCst);
    }
}

fn claim(state: &Arc<LlamacppState>) -> Result<Busy, String> {
    if state.addon_busy.swap(true, Ordering::SeqCst) {
        return Err(fail(AddonError::Io("an add-on download is already running".into())));
    }
    state.addon_cancel.store(false, Ordering::SeqCst);
    Ok(Busy(state.clone()))
}

fn to_dto(dir: &Path, m: &addon::PackManifest) -> InstalledDto {
    InstalledDto {
        kind: m.kind.clone(),
        release_tag: m.release_tag.clone(),
        engine_tag: m.engine_tag.clone(),
        size: addon::dir_size(dir),
        dir: dir.to_string_lossy().into_owned(),
        compatible: true,
        problem: None,
    }
}

/// Downloads, verifies and installs this release's pack. Started only by the
/// user; emits `engine-addon-progress`. The next model load picks it up.
#[tauri::command]
pub async fn engine_addon_download<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
) -> Result<InstalledDto, String> {
    let tag = addon::release_tag(&app_handle.package_info().version.to_string());
    let exp = expect_for(Some(tag.clone())).ok_or_else(|| fail(AddonError::UnsupportedPlatform))?;
    let busy = claim(&state)?;
    let root = addon_root(&app_handle, &state);
    let emitter = app_handle.clone();
    let on_progress = move |p: addon::Progress| {
        let _ = emitter.emit("engine-addon-progress", &p);
    };
    let result = addon::download_and_install(
        &root,
        &tag,
        &exp.as_expect(),
        &busy.0.addon_cancel,
        &on_progress,
    )
    .await;
    match result {
        Ok((dir, m)) => {
            log::info!("engine add-on {} installed in {}", m.kind, dir.display());
            Ok(to_dto(&dir, &m))
        }
        Err(e) => {
            log::warn!("engine add-on download failed: {e}");
            Err(fail(e))
        }
    }
}

#[tauri::command]
pub fn engine_addon_cancel(state: State<'_, Arc<LlamacppState>>) {
    state.addon_cancel.store(true, Ordering::SeqCst);
}

/// Installs a pack the user picked (machines without internet). The zip
/// carries its signed manifest, so the same checks apply; the release tag may
/// differ as long as the engine ABI matches.
#[tauri::command]
pub async fn engine_addon_install_file<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
    path: String,
) -> Result<InstalledDto, String> {
    let exp = expect_for(None).ok_or_else(|| fail(AddonError::UnsupportedPlatform))?;
    let _busy = claim(&state)?;
    let root = addon_root(&app_handle, &state);
    let key = addon::pubkey();
    let zip = PathBuf::from(path);
    let _ = app_handle.emit(
        "engine-addon-progress",
        addon::Progress { phase: "install", received: 0, total: 0 },
    );
    let res = tokio::task::spawn_blocking(move || {
        addon::install_pack(&root, &zip, key.as_deref(), &exp.as_expect())
    })
    .await
    .map_err(|e| e.to_string())?;
    match res {
        Ok((dir, m)) => Ok(to_dto(&dir, &m)),
        Err(e) => {
            log::warn!("engine add-on from file refused: {e}");
            Err(fail(e))
        }
    }
}

/// Removes the add-on. The running engine keeps it until its next start.
#[tauri::command]
pub async fn engine_addon_remove<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
) -> Result<(), String> {
    // Not while a download or verify is writing the same folders.
    let _busy = claim(&state)?;
    let root = addon_root(&app_handle, &state);
    let in_use = state.addon_in_use.lock().ok().and_then(|g| g.clone());
    match addon::remove_all(&root, addon::CUDA_KIND) {
        Ok(()) => Ok(()),
        // Windows will not delete a DLL the running worker holds: rename the
        // directory aside so it is not loaded again and the next start sweeps it.
        Err(_) if in_use.is_some() => {
            for dir in addon::list_dirs(&root, addon::CUDA_KIND) {
                let aside = root.join(format!(".old-{}", rand_suffix()));
                std::fs::rename(&dir, aside).map_err(|e| fail(e.into()))?;
            }
            Ok(())
        }
        Err(e) => Err(fail(e)),
    }
}

fn rand_suffix() -> String {
    use rand::Rng;
    format!("{:016x}", rand::thread_rng().gen::<u64>())
}

/// Rehashes the installed add-on ("Check again"). A corrupt one is removed so
/// the engine stays on Vulkan and the UI offers the download again.
#[tauri::command]
pub async fn engine_addon_verify<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, Arc<LlamacppState>>,
) -> Result<bool, String> {
    let exp = expect_for(None).ok_or_else(|| fail(AddonError::UnsupportedPlatform))?;
    // A verify that removes a pack must not race a download installing one.
    let _busy = claim(&state)?;
    let root = addon_root(&app_handle, &state);
    let key = addon::pubkey();
    tokio::task::spawn_blocking(move || {
        let mut any = false;
        for dir in addon::list_dirs(&root, &exp.kind) {
            let ok = addon::read_installed(&dir, key.as_deref(), &exp.as_expect())
                .and_then(|m| addon::rehash(&dir, &m));
            match ok {
                Ok(()) => any = true,
                Err(e) => {
                    log::warn!("engine add-on {} failed its check ({e}); removing it", dir.display());
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
        }
        Ok(any)
    })
    .await
    .map_err(|e| e.to_string())?
}

impl Expect<'_> {
    /// The same pin without the release tag: an add-on installed from a file
    /// of another release with the same engine is still loaded.
    pub fn with_any_tag(self) -> Self {
        Self { release_tag: None, ..self }
    }
}
