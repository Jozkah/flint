//! Resource routes (split from `server`).

use super::*;

pub(super) async fn resource_route(
    state: &State,
    method: &Method,
    path: &str,
    req: Request<Incoming>,
) -> Resp {
    let root = state.data_folder.clone();
    match (method.clone(), path) {
        (Method::GET, "/api/v1/projects") => blocking(move || resources::projects(&root)).await,
        (Method::PUT, "/api/v1/projects") => {
            let value = match read_json_value(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::set_projects(&root, value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid projects"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save projects"),
            }
        }
        (Method::POST, "/api/v1/projects") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::add_project(&root, value)).await {
                Ok(Ok(project)) => json_created(&project),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid project"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save project"),
            }
        }
        (Method::PUT, p) if p.starts_with("/api/v1/projects/") => {
            let id = p["/api/v1/projects/".len()..].to_owned();
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::update_project(&root, &id, value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::NOT_FOUND, "No such project"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save project"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/projects/") => {
            let id = p["/api/v1/projects/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_project(&root, &id)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid project id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete project"),
            }
        }
        (Method::GET, "/api/v1/assistants") => {
            blocking(move || resources::assistants(&root)).await
        }
        (Method::POST, "/api/v1/assistants") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::create_assistant(&root, value))
                .await
            {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid assistant"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save assistant"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/assistants/") => {
            let id = p["/api/v1/assistants/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_assistant(&root, &id))
                .await
            {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid assistant id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete assistant"),
            }
        }
        (Method::GET, p)
            if p.starts_with("/api/v1/provider-keys/") && p.ends_with("/status") =>
        {
            let name = p["/api/v1/provider-keys/".len()..p.len() - "/status".len()].to_owned();
            blocking(move || resources::has_provider_keys(&name).map(|has| serde_json::json!({ "has": has }))).await
        }
        (Method::POST, p)
            if p.starts_with("/api/v1/provider-keys/") && p.ends_with("/backup") =>
        {
            let name = p["/api/v1/provider-keys/".len()..p.len() - "/backup".len()].to_owned();
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            blocking(move || {
                resources::export_provider_keys_for_backup(&name, &value)
                    .map(|keys| serde_json::json!({ "keys": keys }))
            })
            .await
        }
        (Method::GET, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            blocking(move || resources::provider_keys(&name).map(|keys| serde_json::json!({ "keys": keys }))).await
        }
        (Method::PUT, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::set_provider_keys(&name, &value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid keys"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save keys"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_provider_keys(&name)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid provider"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete keys"),
            }
        }
        (Method::POST, "/api/v1/secret-values") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match resources::register_secret_values(&value) {
                Ok(()) => no_content(),
                Err(_) => text(StatusCode::BAD_REQUEST, "Invalid values"),
            }
        }
        (Method::GET, "/api/v1/engine/info") => json(&engine::info(&state.engine).await),
        (Method::GET, "/api/v1/engine/version") => json(&engine::version()),
        (Method::GET, "/api/v1/engine/devices") => match engine::devices(&state.engine).await {
            Ok(devices) => json(&devices),
            Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
        },
        (Method::POST, "/api/v1/engine/start") => {
            let body = match read_json_value(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Ok(request) = serde_json::from_value::<engine::StartRequest>(body) else {
                return text(StatusCode::BAD_REQUEST, "Invalid engine request");
            };
            match engine::start(&state.engine, &state.data_folder, request).await {
                Ok(info) => json(&info),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        (Method::POST, "/api/v1/engine/stop") => {
            engine::stop(&state.engine, false).await;
            no_content()
        }
        (Method::POST, "/api/v1/engine/force-stop") => {
            engine::stop(&state.engine, true).await;
            no_content()
        }
        (Method::GET, "/api/v1/hardware/info") => {
            blocking(|| Ok(tauri_plugin_hardware::get_system_info())).await
        }
        (Method::GET, "/api/v1/hardware/usage") => {
            blocking(|| Ok(tauri_plugin_hardware::sample_system_usage())).await
        }
        (Method::GET, "/api/v1/app/info") => json(&serde_json::json!({
            "dataFolder": state.data_folder.to_string_lossy(),
            "version": env!("CARGO_PKG_VERSION"),
            "headless": true,
        })),
        (Method::GET, "/api/v1/hardware/snapshot") => {
            blocking(|| Ok(tauri_plugin_hardware::snapshot::get_system_snapshot())).await
        }
        (Method::POST, "/api/v1/hardware/refresh") => {
            tauri_plugin_hardware::invalidate_system_info();
            no_content()
        }
        _ => text(StatusCode::NOT_FOUND, "Unknown API route"),
    }
}
