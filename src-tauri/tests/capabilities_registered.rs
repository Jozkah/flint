//! Every capability file must be registered in a Tauri config.
//!
//! Tauri applies a file under `capabilities/` only when its `identifier`
//! appears in some `app.security.capabilities` array. A file that is not
//! listed is parsed by editor tooling but never granted to the app, which is
//! how `mlx` once silently denied every `plugin:mlx|*` command and how an
//! orphaned `desktop.json` sat unused next to `default.json`. This test fails
//! as soon as a capability file exists that no config registers.

use std::collections::BTreeSet;
use std::path::Path;

fn registered_identifiers(root: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for entry in std::fs::read_dir(root).expect("read src-tauri") {
        let path = entry.expect("dir entry").path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !(name.starts_with("tauri.") && name.ends_with(".conf.json")) {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read config");
        let json: serde_json::Value = serde_json::from_str(&text).expect("parse config");
        if let Some(list) = json
            .pointer("/app/security/capabilities")
            .and_then(|v| v.as_array())
        {
            for item in list {
                // Entries are identifiers, or inline capability objects.
                if let Some(id) = item.as_str() {
                    ids.insert(id.to_string());
                } else if let Some(id) = item.get("identifier").and_then(|v| v.as_str()) {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids
}

#[test]
fn every_capability_file_is_registered_in_a_config() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let registered = registered_identifiers(root);
    let mut orphans = Vec::new();
    for entry in std::fs::read_dir(root.join("capabilities")).expect("read capabilities") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read capability");
        let json: serde_json::Value = serde_json::from_str(&text).expect("parse capability");
        let id = json
            .get("identifier")
            .and_then(|v| v.as_str())
            .expect("capability has an identifier")
            .to_string();
        if !registered.contains(&id) {
            orphans.push(format!("{} ({id})", path.display()));
        }
    }
    assert!(
        orphans.is_empty(),
        "capability files not listed in any tauri*.conf.json: {orphans:?}"
    );
}
