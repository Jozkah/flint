//! Real-Tauri UI smoke harness.
//!
//! This binary launches the *actual* application produced by
//! [`app_lib::build_app`] -- the same plugins, the same invoke handler, the same
//! managed state, the same generated context and therefore the same bundled
//! frontend -- and drives it through the real WebView. Cowork panels talk to the
//! backend over Tauri IPC, so a browser-only preview cannot exercise them; this
//! harness exists precisely to close that gap.
//!
//! Isolation: the harness sets `CI=e2e` and changes into a throwaway working
//! directory before building the app, which routes `get_jan_data_folder_path`
//! at `<temp>/data` instead of the developer's real Jan data folder. The temp
//! tree is removed on the way out.
//!
//! Fixtures resolve from `CARGO_MANIFEST_DIR` (baked in at compile time) or from
//! an explicit `--fixtures <dir>` argument. The session working directory is
//! never consulted.
//!
//! Exit code is non-zero if any scenario fails.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow};

// The harness was one 21,000-line file. It is split into files that are pulled
// in with `include!`, so they share this module's imports and every helper
// keeps the visibility it had: `harness.rs` is the mock provider, seeding and
// the scenario tables; `runner.rs` is `main` and the driver; the rest hold the
// `scenario_*` functions with the helpers they use, grouped by what they cover.

include!("harness.rs");
include!("basics.rs");
include!("team_review.rs");
include!("bundle_events.rs");
include!("agents_timeline.rs");
include!("sessions_messaging.rs");
include!("restart_handoff_replay.rs");
include!("usage_memory.rs");
include!("runner.rs");
include!("memory_jobs_provenance.rs");
include!("durability_mcp.rs");
include!("lane_branchcraft.rs");
include!("rooms.rs");
include!("window_chrome_records.rs");
