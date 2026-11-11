//! Tauri commands for the usage import. Nothing here reads a log unless the
//! caller passes `consent: true`, which the page does only after the person
//! switched the import on.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use super::aggregate::{add_flint, aggregate, Query, Report};
use super::scan::{default_roots, scan, ScanSummary};
use super::Record;
use crate::core::agent::spend::{self, Price};
use crate::core::app::commands::get_jan_data_folder_path;

/// The records of the last scan, so changing a filter does not rescan.
static LAST: Mutex<Option<(Vec<Record>, ScanSummary)>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub report: Report,
    pub summary: ScanSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootsInfo {
    pub claude_code: String,
    pub codex: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

fn require(consent: bool) -> Result<(), String> {
    if consent {
        Ok(())
    } else {
        Err("usage import is off".into())
    }
}

fn build<R: Runtime>(
    app: &AppHandle<R>,
    records: &[Record],
    summary: ScanSummary,
    query: &Query,
    custom: BTreeMap<String, Price>,
) -> Response {
    let data = get_jan_data_folder_path(app.clone());
    // Prices someone declared for Flint come first; prices set on the page win.
    let mut prices = spend::prices(&data).unwrap_or_default();
    prices.extend(custom);
    let now = chrono::Local::now();
    let mut report = aggregate(records, query, &prices, now.timestamp_millis(), *now.offset());
    if query.agents.is_empty() || query.agents.contains(&super::Agent::Flint) {
        let period = (query.days > 0).then(|| format!("{}d", query.days));
        if let Ok(flint) = spend::report(&data, period.as_deref(), None) {
            add_flint(&mut report, &flint);
        }
    }
    Response { report, summary }
}

/// The folders a scan reads, for the page to state before anything is read.
#[tauri::command]
pub fn usage_import_roots() -> RootsInfo {
    let r = default_roots();
    RootsInfo {
        claude_code: r.claude_code.to_string_lossy().into_owned(),
        codex: r.codex.to_string_lossy().into_owned(),
    }
}

/// Scan the logs (off the UI thread), then report. Emits
/// `usage-import-progress` as files are handled.
#[tauri::command]
pub async fn usage_import_scan<R: Runtime>(
    app: AppHandle<R>,
    consent: bool,
    query: Query,
    prices: BTreeMap<String, Price>,
) -> Result<Response, String> {
    require(consent)?;
    let cache = get_jan_data_folder_path(app.clone()).join("usage-import-cache.json");
    let emitter = app.clone();
    let (records, summary) = tauri::async_runtime::spawn_blocking(move || {
        let tick = |done: usize, total: usize| {
            if done == total || done % 25 == 0 {
                let _ = emitter.emit("usage-import-progress", Progress { done, total });
            }
        };
        scan(&default_roots(), Some(&cache), &tick)
    })
    .await
    .map_err(|e| e.to_string())?;
    let response = build(&app, &records, summary.clone(), &query, prices);
    *LAST.lock().map_err(|e| e.to_string())? = Some((records, summary));
    Ok(response)
}

/// Re-aggregate the last scan for a new filter, window or price.
#[tauri::command]
pub async fn usage_import_report<R: Runtime>(
    app: AppHandle<R>,
    consent: bool,
    query: Query,
    prices: BTreeMap<String, Price>,
) -> Result<Response, String> {
    require(consent)?;
    let (records, summary) = LAST
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "not scanned yet".to_string())?;
    Ok(build(&app, &records, summary, &query, prices))
}

/// Forget what was read (when the person turns the import off).
#[tauri::command]
pub fn usage_import_forget() {
    if let Ok(mut last) = LAST.lock() {
        *last = None;
    }
}
