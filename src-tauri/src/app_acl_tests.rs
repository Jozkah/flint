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
#[test]
fn the_runtime_refuses_main_window_only_commands_to_the_logs_windows() {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!(test = true))
        .expect("mock app");
    let call = |label: &str, cmd: &str| -> String {
        let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .expect("window");
        let out = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
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
