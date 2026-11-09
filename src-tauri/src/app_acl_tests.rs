//! The app command ACL that build.rs generates (see build_acl.rs): the
//! command list it reads from this crate's lib.rs, and the capability files
//! that grant it.

#[path = "../build_acl.rs"]
#[allow(dead_code)]
mod build_acl;

use build_acl::{
    allow_permission, permission_sets_toml, registered_commands, ALL_COMMANDS_SET, AUX_WINDOW_SET, MAIN_WINDOW_ONLY,
};

const LIB_RS: &str = include_str!("lib.rs");

fn capability(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn grants(cap: &serde_json::Value, permission: &str) -> bool {
    cap["permissions"].as_array().unwrap().iter().any(|p| p.as_str() == Some(permission))
}

#[test]
fn every_registered_command_is_found() {
    let names = registered_commands(LIB_RS);
    assert!(names.len() > 300, "only {} commands parsed", names.len());
    // First and last of the main list, a bare name, both extras lists.
    for expected in [
        "scan_local_models",
        "confirm_exit",
        "cancel_exit",
        "remote_get_status",
        "browser_agent_resume",
        "thin_client_connect",
    ] {
        assert!(names.iter().any(|n| n == expected), "{expected} missing from the parsed list");
    }
    // The macro's own placeholders are not commands.
    assert!(!names.iter().any(|n| n.contains('$') || n.is_empty()));
}

#[test]
fn main_window_only_names_are_real_commands() {
    let names = registered_commands(LIB_RS);
    for name in MAIN_WINDOW_ONLY {
        assert!(names.iter().any(|n| n == name), "{name} is listed main-window-only but not registered");
    }
}

#[test]
fn the_aux_set_leaves_out_exactly_the_main_window_only_commands() {
    let names = registered_commands(LIB_RS);
    let toml = permission_sets_toml(&names);
    let aux = toml.split(&format!("identifier = \"{AUX_WINDOW_SET}\"")).nth(1).unwrap();
    let all = toml
        .split(&format!("identifier = \"{ALL_COMMANDS_SET}\""))
        .nth(1)
        .unwrap()
        .split("[[set]]")
        .next()
        .unwrap();
    for name in &names {
        let line = format!("\"{}\"", allow_permission(name));
        assert!(all.contains(&line), "{name} is not in the full set");
        assert_eq!(aux.contains(&line), !MAIN_WINDOW_ONLY.contains(&name.as_str()), "{name} in the aux set");
    }
    assert_eq!(allow_permission("get_system_info"), "allow-get-system-info");
}

/// The real ACL (this crate's config and capabilities, compiled by build.rs)
/// on the mock runtime. No command is registered with the mock app, so a call
/// the ACL lets through ends in "not found" and nothing ever runs; a refused
/// one says "not allowed".
///
/// The request must come from the app's own origin, which differs by OS
/// (`http://tauri.localhost` on Windows, `tauri://localhost` on Linux and
/// macOS); any other URL is a remote origin, which no capability here covers,
/// so every command would be refused. (The mock runtime does not give a window
/// a parseable URL, so the origin is spelled here by Tauri's rule.)
#[test]
fn the_runtime_refuses_main_window_only_commands_to_the_logs_windows() {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!(test = true))
        .expect("mock app");
    let call = |label: &str, cmd: &str| -> String {
        let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .expect("window");
        let origin = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost" } else { "tauri://localhost" };
        let url: tauri::Url = origin.parse().expect("the app origin");
        let out = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url,
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        let _ = webview.close();
        match out {
            Ok(_) => "ok".to_string(),
            Err(e) => e.to_string(),
        }
    };
    let refused = |s: &str| s.to_ascii_lowercase().contains("not allowed");

    // Control: the request counts as local, or every check below is vacuous.
    // (Each label once: the mock runtime keeps a closed window's label.)
    let control = call("chat-window-control", "get_app_configurations");
    assert!(!refused(&control), "a chat window is refused an ordinary command: {control}");
    let from_logs = call("logs-window-local-api-server", "factory_reset");
    assert!(refused(&from_logs), "logs window reached factory_reset: {from_logs}");
    let from_monitor = call("system-monitor-window", "remote_start_pairing");
    assert!(refused(&from_monitor), "system monitor reached remote_start_pairing: {from_monitor}");
    // An ordinary command passes the ACL there (and is then simply not found).
    let ordinary = call("logs-app-window", "get_app_configurations");
    assert!(!refused(&ordinary), "logs window lost an ordinary command: {ordinary}");
    // The main window passes the ACL for the main-window-only ones.
    let from_main = call("main", "factory_reset");
    assert!(!refused(&from_main), "main window refused factory_reset: {from_main}");
    // A window no capability names gets no app command at all.
    let stranger = call("some-other-window", "get_app_configurations");
    assert!(refused(&stranger), "an unknown window reached a command: {stranger}");
}

/// With the app manifest in place a window that no capability covers on an
/// OS loses every app command there, so each desktop capability that grants
/// app commands must apply on Windows, macOS and Linux (no `platforms` field
/// means all of them).
#[test]
fn every_desktop_capability_applies_on_all_three_desktop_platforms() {
    // Plugin-only capabilities with a reason to be narrower.
    const NARROWER: &[(&str, &str)] = &[
        ("mlx.json", "the MLX plugin exists on Apple Silicon macOS only and grants no app command"),
        ("mobile.json", "the phone build's capability; it is not enabled on desktop"),
    ];
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let cap = capability(&name);
        if let Some((_, why)) = NARROWER.iter().find(|(n, _)| *n == name) {
            assert!(
                !grants(&cap, ALL_COMMANDS_SET) && !grants(&cap, AUX_WINDOW_SET),
                "{name} is narrower ({why}) but grants app commands"
            );
            continue;
        }
        seen += 1;
        if let Some(platforms) = cap.get("platforms") {
            let platforms: Vec<&str> = platforms.as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
            for want in ["linux", "macOS", "windows"] {
                assert!(platforms.contains(&want), "{name} does not apply on {want}: {platforms:?}");
            }
        }
        assert!(
            grants(&cap, ALL_COMMANDS_SET) || grants(&cap, AUX_WINDOW_SET),
            "{name} names windows but grants them no app command"
        );
    }
    assert_eq!(seen, 4, "a capability file was added or removed; review its app command grant");
}

#[test]
fn only_the_main_and_chat_windows_get_every_command() {
    let main = capability("default.json");
    assert!(grants(&main, ALL_COMMANDS_SET));
    let webviews: Vec<&str> = main["webviews"].as_array().unwrap().iter().filter_map(|w| w.as_str()).collect();
    assert_eq!(webviews, ["main", "chat-window-*"]);
    for aux in ["log-app-window.json", "logs-window.json", "system-monitor-window.json"] {
        let cap = capability(aux);
        assert!(grants(&cap, AUX_WINDOW_SET), "{aux} cannot call app commands at all");
        assert!(!grants(&cap, ALL_COMMANDS_SET), "{aux} gets the main-window-only commands");
    }
}
