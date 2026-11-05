//! MCP routes (split from `server`).

use super::*;

pub(super) async fn mcp_route(state: &State, method: &Method, rest: &str, req: Request<Incoming>) -> Resp {
    let query = req.uri().query().map(str::to_owned);
    let decoded: Option<Vec<String>> = rest.split('/').map(percent_decode).collect();
    let Some(decoded) = decoded else {
        return text(StatusCode::BAD_REQUEST, "Invalid path");
    };
    let parts: Vec<&str> = decoded.iter().map(String::as_str).collect();
    let host = &state.mcp;
    match (method.clone(), parts.as_slice()) {
        (Method::GET, ["config"]) => reply(StatusCode::OK, "application/json", mcp::config_text()),
        (Method::PUT, ["config"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(configs) = str_field(&body, "configs") else {
                return text(StatusCode::BAD_REQUEST, "Expected a configs string");
            };
            result_response(mcp::save_config(host, configs).await, StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["restart"]) => {
            mcp::restart_all(host).await;
            no_content()
        }
        (Method::GET, ["tools"]) => {
            let names = query_param(query.as_deref(), "servers").map(|list| {
                list.split(',')
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<String>>()
            });
            let start = query_param(query.as_deref(), "start").as_deref() == Some("true");
            json(&mcp::tools(host, names, start).await)
        }
        (Method::GET, ["summaries"]) => json(&mcp::summaries(host).await),
        (Method::GET, ["statuses"]) => json(&mcp::statuses(host).await),
        (Method::GET, ["connected"]) => json(&mcp::connected(host).await),
        (Method::GET, ["log", name]) => {
            let lines = query_param(query.as_deref(), "lines").and_then(|v| v.parse().ok());
            json(&mcp::log(name, lines))
        }
        (Method::POST, ["servers", name, "activate"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(config) = body.get("config").cloned() else {
                return text(StatusCode::BAD_REQUEST, "Expected a config object");
            };
            let start = body
                .get("start")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            result_response(
                mcp::activate(host, name, config, start).await,
                StatusCode::BAD_REQUEST,
            )
        }
        (Method::POST, ["servers", name, "deactivate"]) => {
            result_response(mcp::deactivate(host, name).await, StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["servers", name, "start"]) => {
            result_response(mcp::start(host, name).await, StatusCode::BAD_GATEWAY)
        }
        (Method::POST, ["servers", name, "stop"]) => {
            mcp::stop(host, name).await;
            no_content()
        }
        (Method::POST, ["call"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(tool) = str_field(&body, "toolName") else {
                return text(StatusCode::BAD_REQUEST, "toolName is required");
            };
            let call = mcp::Call {
                tool,
                server: str_field(&body, "serverName").filter(|n| !n.is_empty()),
                arguments: body
                    .get("arguments")
                    .and_then(serde_json::Value::as_object)
                    .cloned(),
                cancellation_token: str_field(&body, "cancellationToken").map(str::to_owned),
                max_output_chars: body
                    .get("maxOutputChars")
                    .and_then(serde_json::Value::as_u64),
                approval_ticket: str_field(&body, "approvalTicket"),
            };
            // A refused or failed call is data for the chat, as on desktop.
            match mcp::call(host, call).await {
                Ok(result) => json(&result),
                Err(message) => json(&serde_json::json!({ "error": message, "content": [] })),
            }
        }
        (Method::POST, ["cancel"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            if let Some(token) = str_field(&body, "token") {
                mcp::cancel(host, token).await;
            }
            no_content()
        }
        (Method::GET, ["trust"]) => json(&mcp::trust_report()),
        (Method::GET, ["trust", "trusted"]) => json(&mcp::trusted()),
        (Method::GET, ["fingerprints"]) => json(&mcp::fingerprints()),
        (Method::POST, ["trust", name]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            // The definition the user was shown is required: trusting
            // whatever the server is now is not what anybody approved.
            let Some(fingerprint) = str_field(&body, "fingerprint") else {
                return text(StatusCode::BAD_REQUEST, "fingerprint is required");
            };
            result_response(mcp::trust(name, fingerprint), StatusCode::CONFLICT)
        }
        (Method::DELETE, ["trust", name]) => {
            result_response(mcp::revoke(name), StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["forget", name]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            result_response(
                mcp::forget(name, str_field(&body, "reason").unwrap_or("")),
                StatusCode::BAD_REQUEST,
            )
        }
        (Method::POST, ["allow-once"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let (Some(server), Some(tool), Some(fingerprint)) = (
                str_field(&body, "serverName"),
                str_field(&body, "toolName"),
                str_field(&body, "fingerprint"),
            ) else {
                return text(StatusCode::BAD_REQUEST, "serverName, toolName and fingerprint are required");
            };
            match mcp::allow_once(server, tool, fingerprint) {
                Ok(ticket) => json(&serde_json::json!({ "ticket": ticket })),
                Err(message) => result_response(Err(message), StatusCode::CONFLICT),
            }
        }
        (Method::GET, ["auth", name]) => json(&mcp::auth_status(name)),
        (Method::DELETE, ["auth", name]) => match mcp::clear_auth(name) {
            Ok(cleared) => json(&serde_json::json!({ "cleared": cleared })),
            Err(message) => result_response(Err(message), StatusCode::BAD_REQUEST),
        },
        _ => text(StatusCode::NOT_FOUND, "Unknown API route"),
    }
}
