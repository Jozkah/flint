//! A config Jan cannot read must never be silently replaced.
//!
//! `get_mcp_configs` answered an unparseable `mcp_config.json` by starting from
//! `{}`, re-adding the default `Jan Browser MCP` entry, and writing the result
//! back over the original. The user's servers were gone for good, and what was
//! left was exactly the file reported upstream in janhq/jan#8519: `mcpSettings`
//! and a lone `Jan Browser MCP`. The file could become unparseable in the first
//! place because every writer used a truncate-then-write `fs::write`.

use super::commands::get_mcp_configs;
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;
use std::fs;
use tauri::{test::mock_app, Manager};

fn corrupt_copies(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("mcp_config.json.corrupt-"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn an_unreadable_config_is_kept_before_defaults_are_written() {
    let app = mock_app();
    app.manage(AppState::default());
    let data = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&data).unwrap();
    for stale in corrupt_copies(&data) {
        let _ = fs::remove_file(stale);
    }
    let config_path = data.join("mcp_config.json");
    // A torn write: the user's own servers, cut off mid-object.
    let torn =
        "{\"mcpServers\":{\"filesystem\":{\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontext";
    fs::write(&config_path, torn).unwrap();

    let result = get_mcp_configs(app.handle().clone()).await;

    assert!(
        result.is_ok(),
        "Jan still starts with a usable config: {result:?}"
    );
    let kept = corrupt_copies(&data);
    assert_eq!(kept.len(), 1, "the unreadable original must be kept aside");
    assert_eq!(fs::read_to_string(&kept[0]).unwrap(), torn);

    for stale in kept {
        let _ = fs::remove_file(stale);
    }
    let _ = fs::remove_file(&config_path);
}

#[tokio::test]
async fn a_readable_config_is_not_copied_aside() {
    let app = mock_app();
    app.manage(AppState::default());
    let data = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&data).unwrap();
    for stale in corrupt_copies(&data) {
        let _ = fs::remove_file(stale);
    }
    let config_path = data.join("mcp_config.json");
    fs::write(&config_path, "{\"mcpServers\":{}}").unwrap();

    get_mcp_configs(app.handle().clone()).await.unwrap();

    assert!(corrupt_copies(&data).is_empty());
    let _ = fs::remove_file(&config_path);
}
