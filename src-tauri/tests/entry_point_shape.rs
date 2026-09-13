//! Guards on the extracted entry-point construction path.
//!
//! `run()` used to build the Tauri builder and immediately consume it, which
//! made it impossible for the `cowork-smoke` harness to obtain an `App` or an
//! `AppHandle`. The split is now:
//!
//! * `build_app()` owns *all* builder configuration and returns the built `App`.
//! * `run_app()` attaches the lifecycle handler and enters the event loop.
//! * `run()` is a thin composition of the two.
//!
//! Constructing a real `App` needs a window server and the platform main
//! thread, so it cannot run under `cargo test`; it is exercised for real by the
//! smoke binary. What these tests protect is the property that made the split
//! worth doing: production and smoke must not drift apart, which happens the
//! moment configuration is added to `run()` instead of `build_app()`.

use std::path::Path;

fn lib_rs() -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("src/lib.rs must be readable")
}

/// Extract a top-level `pub fn <name>` body by brace matching.
fn fn_body(src: &str, name: &str) -> String {
    let sig = format!("pub fn {name}");
    let start = src
        .find(&sig)
        .unwrap_or_else(|| panic!("`pub fn {name}` not found in src/lib.rs"));
    let open = start
        + src[start..]
            .find('{')
            .unwrap_or_else(|| panic!("no body for `{name}`"));
    let mut depth = 0usize;
    for (offset, ch) in src[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return src[open + 1..open + offset].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces while reading `{name}`");
}

#[test]
fn run_is_a_thin_composition_of_build_and_run() {
    let body = fn_body(&lib_rs(), "run");
    let statements: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .collect();
    assert_eq!(
        statements,
        vec!["run_app(build_app());"],
        "run() must stay a thin wrapper; anything else belongs in build_app() or run_app()"
    );
}

#[test]
fn build_app_owns_every_piece_of_builder_configuration() {
    let body = fn_body(&lib_rs(), "build_app");
    for needle in [
        "tauri::Builder::default()",
        ".invoke_handler(",
        ".manage(AppState {",
        ".setup(",
        ".build(tauri::generate_context!())",
        "tauri_plugin_single_instance::init",
        "tauri_plugin_store::Builder::new",
        "generate_app_token()",
        "setup_mcp(app)",
        "setup::setup_theme_listener(app)",
    ] {
        assert!(
            body.contains(needle),
            "build_app() no longer contains `{needle}`; production and the \
             cowork-smoke harness would stop sharing that configuration"
        );
    }
}

#[test]
fn run_app_owns_the_lifecycle_handler_and_nothing_else() {
    let body = fn_body(&lib_rs(), "run_app");
    assert!(
        body.contains("app.run(|app, event|"),
        "run_app() must attach the lifecycle callback"
    );
    for shutdown in [
        "RunEvent::ExitRequested",
        "RunEvent::Exit",
        "background_cleanup_mcp_servers",
        "cleanup_llama_processes",
        "flush_settings()",
    ] {
        assert!(
            body.contains(shutdown),
            "run_app() lost shutdown behaviour `{shutdown}`"
        );
    }
    assert!(
        !body.contains("tauri::Builder::default()"),
        "run_app() must not construct a builder"
    );
}

/// The whole point of the split: exactly one place configures the application.
#[test]
fn the_builder_is_constructed_in_exactly_one_place() {
    let src = lib_rs();
    assert_eq!(
        src.matches("tauri::Builder::default()").count(),
        1,
        "a second builder appeared; smoke and production must share one \
         configuration path"
    );
    assert_eq!(
        src.matches("tauri::generate_context!()").count(),
        1,
        "a second generated context appeared"
    );
    assert_eq!(
        src.matches(".manage(AppState {").count(),
        1,
        "AppState is now constructed in more than one place"
    );
}

/// The smoke binary must call into the shared path rather than reimplementing it.
#[test]
fn the_smoke_harness_uses_the_shared_construction_path() {
    let smoke = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/cowork_smoke.rs"),
    )
    .expect("examples/cowork_smoke.rs must be readable");
    assert!(
        smoke.contains("app_lib::build_app()"),
        "the harness must build the real application via app_lib::build_app()"
    );
    assert!(
        smoke.contains("app_lib::run_app(app)"),
        "the harness must enter the real event loop via app_lib::run_app()"
    );
    assert!(
        !smoke.contains("tauri::Builder"),
        "the harness must not construct its own builder"
    );
    assert!(
        !smoke.contains("mock_app"),
        "the harness must drive the real runtime, not a mock one"
    );
    assert!(
        smoke.contains("env!(\"CARGO_MANIFEST_DIR\")"),
        "fixtures must resolve from CARGO_MANIFEST_DIR, never the session root"
    );
    assert!(
        !smoke.contains("launch.json"),
        "the harness must never resolve launch.json"
    );
}

// ---------------------------------------------------------------------------
// The test-only dialog seam must not exist in production builds.
// ---------------------------------------------------------------------------

fn manifest(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap_or_else(|e| panic!("{rel} must be readable: {e}"))
}

/// If `cowork-smoke` ever joins the default feature set, the seam ships.
#[test]
fn the_smoke_feature_is_not_a_default_feature() {
    let toml = manifest("Cargo.toml");
    let default_block = toml
        .split("default = [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .expect("Cargo.toml must declare a default feature list");
    assert!(
        !default_block.contains("cowork-smoke"),
        "cowork-smoke became a default feature; the dialog seam would ship in \
         release builds. default = [{default_block}]"
    );
}

/// Every mention of the seam in production source must sit behind the feature.
#[test]
fn the_dialog_seam_is_gated_everywhere_it_is_mentioned() {
    for rel in [
        "src/core/filesystem/mod.rs",
        "src/core/filesystem/commands.rs",
    ] {
        let src = manifest(rel);
        let lines: Vec<&str> = src.lines().collect();
        for (idx, line) in lines.iter().enumerate() {
            // Only real code counts; prose about the seam is not the seam.
            if !line.contains("smoke_dialog") || line.trim().starts_with("//") {
                continue;
            }
            // Walk back over comments to the nearest attribute or code line.
            let guard = lines[..idx]
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty() && !l.trim().starts_with("//"))
                .copied()
                .unwrap_or("");
            assert!(
                guard.contains(r#"#[cfg(feature = "cowork-smoke")]"#),
                "{rel}:{} references smoke_dialog without a \
                 #[cfg(feature = \"cowork-smoke\")] guard directly above it \
                 (found {guard:?})",
                idx + 1
            );
        }
    }
}

/// The seam is driven by the harness's own process environment. It must never
/// become reachable from the WebView, which would hand JavaScript a way to make
/// the picker return an arbitrary path.
#[test]
fn the_dialog_seam_is_not_exposed_to_javascript() {
    let seam = manifest("src/core/filesystem/smoke_dialog.rs");
    assert!(
        !seam.contains("#[tauri::command]"),
        "the dialog seam must not be a Tauri command"
    );
    let lib = lib_rs();
    assert!(
        !lib.contains("smoke_dialog"),
        "the dialog seam must not be registered in the invoke handler"
    );
}
