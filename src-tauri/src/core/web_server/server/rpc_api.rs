//! RPC command routes and their helpers (split from `server`).

use super::*;

/// A model file a browser names for inspection. Imported models can live
/// anywhere the operator put them, so a `.gguf` file is read where it is; every
/// other path has to be inside the data folder, and a URL is never fetched.
fn gguf_path(data_folder: &std::path::Path, args: &serde_json::Value) -> Result<String, String> {
    let raw = str_field(args, "path").ok_or("path is required")?;
    if raw.contains("://") && !raw.starts_with("file:") {
        return Err("remote model paths are not read by the server".into());
    }
    if let Ok(inside) = files::confine(data_folder, raw) {
        return Ok(inside.to_string_lossy().into_owned());
    }
    let path = std::path::Path::new(raw);
    let is_gguf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    if is_gguf && path.is_absolute() && path.is_file() {
        Ok(raw.to_owned())
    } else {
        Err("path must be a .gguf file or inside the data folder".into())
    }
}

/// The plugin's own error type, serialized the way the desktop app sends it so
/// the extension's error handling sees the same shape.
fn plugin_error(error: &tauri_plugin_llamacpp::error::ServerError) -> Resp {
    let body = serde_json::to_vec(error).unwrap_or_else(|_| b"{}".to_vec());
    reply(StatusCode::BAD_GATEWAY, "application/json", body)
}

/// The Tauri commands the app's extensions call, answered for a browser.
/// Anything not listed is refused, so a command added to the desktop app does
/// not become reachable from a browser by accident.
pub(super) async fn rpc_route(
    state: &State,
    command: &str,
    args: serde_json::Value,
    caller: &super::super::runner::Caller,
) -> Resp {
    if command.starts_with("remote_") {
        // Remote access (phone pairing) is the desktop app's; see `phone_client_page`.
        return text(
            StatusCode::NOT_FOUND,
            "Phone pairing needs the Flint desktop app; a headless server does not offer remote access.",
        );
    }
    if super::super::campaign_driver::handles(command) {
        let Some(agent) = &state.agent else {
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        return match agent.call_campaign(command, &args, caller).await {
            Ok(value) => json(&value),
            Err(failure) => failure_reply(failure),
        };
    }
    if super::super::runner::handles(command) {
        let Some(agent) = &state.agent else {
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        return match agent.call_run(command, &args, caller).await {
            Ok(value) => json(&value),
            Err(failure) => failure_reply(failure),
        };
    }
    if files::handles(command) {
        let (root, command) = (state.data_folder.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || files::call(&root, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if rooms::handles(command) {
        let (root, command) = (state.data_folder.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || rooms::call(&root, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if settings::handles(command) {
        let (store, command) = (state.settings.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || settings::call(&store, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if agent::handles(command) {
        let Some(agent) = &state.agent else {
            // Said once, plainly, so a client can show it rather than guess.
            if command == "agent_server_info" {
                return json(&serde_json::json!({ "agent": false, "folders": [] }));
            }
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        let (agent, command) = (agent.clone(), command.to_owned());
        // Reads and writes files for a proposal, so not on the async threads.
        let outcome = match tokio::task::spawn_blocking(move || agent.call(&command, &args)).await {
            Ok(outcome) => outcome,
            Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
        return match outcome {
            Ok(value) => json(&value),
            Err(failure) => failure_reply(failure),
        };
    }
    match command {
        // The skills and slash-command catalogue are the desktop agent's. A
        // browser session has none, which is an answer the pages handle (an
        // empty list), where an unknown command stopped a room before it began.
        "agent_resolve_extensions" | "agent_slash_catalog" => json(&serde_json::json!([])),
        "search_messages" => {
            let query = str_field(&args, "query").unwrap_or_default().to_owned();
            let limit = args.get("limit").and_then(serde_json::Value::as_u64).unwrap_or(30) as usize;
            let root = state.data_folder.clone();
            blocking(move || crate::core::threads::search::search_messages_in(&root, &query, limit)).await
        }
        "get_secret" => {
            let key = str_field(&args, "key").unwrap_or_default().to_owned();
            match tokio::task::spawn_blocking(move || resources::get_secret(&key)).await {
                Ok(Ok(value)) => json(&value),
                Ok(Err(message)) => reply(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", message),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
            }
        }
        "set_secret" => {
            let (Some(key), Some(value)) = (str_field(&args, "key"), str_field(&args, "value")) else {
                return text(StatusCode::BAD_REQUEST, "key and value are required");
            };
            let (key, value) = (key.to_owned(), value.to_owned());
            match tokio::task::spawn_blocking(move || resources::set_secret(&key, &value)).await {
                Ok(Ok(())) => json(&serde_json::Value::Null),
                Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
            }
        }
        "archive_get_settings" => json(&serde_json::json!(crate::core::archive::store::read_settings(&state.data_folder))),
        "plugin:hardware|get_system_info" => {
            blocking(|| Ok(tauri_plugin_hardware::get_system_info())).await
        }
        "plugin:hardware|get_system_usage" => {
            blocking(|| Ok(tauri_plugin_hardware::sample_system_usage())).await
        }
        "plugin:llamacpp|load_llama_model" | "plugin:llamacpp|ensure_session_ready" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            let embedding = args.get("isEmbedding").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let sink = state.events.clone();
            // The plugin's own error type, serialized as the desktop app sends it.
            match tauri_plugin_llamacpp::commands::load_model(&sink, &state.engine.state, model.to_owned(), embedding).await {
                Ok(session) => json(&session),
                Err(error) => plugin_error(&error),
            }
        }
        "plugin:llamacpp|unload_llama_model" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            match tauri_plugin_llamacpp::commands::unload_model(&state.engine.state, model.to_owned()).await {
                Ok(result) => json(&result),
                Err(error) => plugin_error(&error),
            }
        }
        "plugin:llamacpp|find_session_by_model" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            match tauri_plugin_llamacpp::commands::find_session(&state.engine.state, model.to_owned()).await {
                Ok(session) => json(&session),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|get_loaded_models" => {
            match tauri_plugin_llamacpp::commands::loaded_models(&state.engine.state).await {
                Ok(ids) => json(&ids),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|reload_engine_models" => {
            let preset = match engine::confine_preset(&state.data_folder, str_field(&args, "presetPath").unwrap_or_default()) {
                Ok(path) => path.to_string_lossy().into_owned(),
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let models_max = args.get("modelsMax").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            let slot_cache = args.get("slotCacheMib").and_then(serde_json::Value::as_u64);
            let idle_unload = args.get("idleUnloadMinutes").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            match tauri_plugin_llamacpp::engine::commands::reload_models(&state.engine.state, preset, models_max, slot_cache, idle_unload).await {
                Ok(report) => json(&report),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|engine_slots_idle" => {
            let model = str_field(&args, "modelId").map(str::to_owned);
            match tauri_plugin_llamacpp::engine::commands::slots_idle(&state.engine.state, model).await {
                Ok(idle) => json(&idle),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|erase_thread_slot_state" => {
            let cache_dir = match str_field(&args, "cacheDir") {
                Some(dir) => match files::confine(&state.data_folder, dir) {
                    Ok(path) => Some(path.to_string_lossy().into_owned()),
                    Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
                },
                None => None,
            };
            let thread = str_field(&args, "threadId").map(str::to_owned);
            let model = str_field(&args, "modelId").map(str::to_owned);
            match tauri_plugin_llamacpp::engine::commands::erase_slot_state(&state.engine.state, thread, model, cache_dir).await {
                Ok(count) => json(&count),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|read_gguf_metadata" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            match tauri_plugin_llamacpp::gguf::commands::read_gguf_metadata(path).await {
                Ok(metadata) => json(&metadata),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|find_gguf_tensors" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let names: Vec<String> = args
                .get("names")
                .and_then(serde_json::Value::as_array)
                .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            match tauri_plugin_llamacpp::gguf::commands::find_gguf_tensors(path, names).await {
                Ok(found) => json(&found),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|is_model_supported" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let ctx = args.get("ctxSize").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            let key = str_field(&args, "cacheTypeK").map(str::to_owned);
            let value = str_field(&args, "cacheTypeV").map(str::to_owned);
            let no_kv_offload = args.get("noKvOffload").and_then(serde_json::Value::as_bool);
            match tauri_plugin_llamacpp::gguf::commands::is_model_supported(path, ctx, key, value, no_kv_offload).await {
                Ok(status) => json(&status),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|get_engine_info" => json(&engine::info(&state.engine).await),
        "plugin:llamacpp|get_engine_version" => json(&engine::version()),
        "plugin:llamacpp|stop_engine" => {
            engine::stop(&state.engine, false).await;
            json(&serde_json::Value::Null)
        }
        "plugin:llamacpp|force_stop_engine" => {
            engine::stop(&state.engine, true).await;
            json(&serde_json::Value::Null)
        }
        "plugin:llamacpp|engine_devices" => match engine::devices(&state.engine).await {
            Ok(devices) => json(&devices),
            Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
        },
        "plugin:llamacpp|start_engine" => {
            // The plugin's own argument names, so its guest API works unchanged.
            let request = engine::StartRequest {
                preset_path: str_field(&args, "presetPath").unwrap_or_default().to_owned(),
                models_max: args.get("modelsMax").and_then(serde_json::Value::as_u64).unwrap_or(1) as u32,
                slot_cache_mib: args.get("slotCacheMib").and_then(serde_json::Value::as_u64).unwrap_or(0),
                envs: args
                    .get("envs")
                    .and_then(serde_json::Value::as_object)
                    .map(|map| {
                        map.iter()
                            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            match engine::start(&state.engine, &state.data_folder, request).await {
                Ok(info) => json(&serde_json::json!({
                    "port": info.port,
                    "api_key": info.api_key,
                    "pid": info.pid,
                    "models": info.models,
                })),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        _ => text(StatusCode::NOT_FOUND, "Unknown command"),
    }
}
