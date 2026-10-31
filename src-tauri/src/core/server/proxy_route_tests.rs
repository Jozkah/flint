//! Q1-001: characterization of `proxy_request`, driven over a real loopback
//! server. Pins status, the start of the body, and CORS for every route that
//! answers without an upstream, so splitting the routes cannot change them.

use super::proxy::*;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

struct Server {
    port: u16,
    handle: Arc<Mutex<Option<crate::core::state::ServerHandle>>>,
    _data: tempfile::TempDir,
}

async fn start(api_key: &str) -> Server {
    let data = tempfile::tempdir().unwrap();
    let handle = Arc::new(Mutex::new(None));
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let port = start_server(
        handle.clone(),
        Arc::new(tauri_plugin_llamacpp::state::LlamacppState::default()),
        Arc::new(Mutex::new(HashMap::new())),
        "127.0.0.1".into(),
        port,
        "/v1".into(),
        api_key.into(),
        vec![],
        30,
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(Default::default())),
        data.path().to_string_lossy().into_owned(),
        false,
        true,
    )
    .await
    .expect("server starts");
    Server {
        port,
        handle,
        _data: data,
    }
}

async fn call(
    s: &Server,
    method: reqwest::Method,
    path: &str,
    body: Option<&str>,
    bearer: Option<&str>,
) -> (u16, String, Option<String>) {
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, format!("http://127.0.0.1:{}{path}", s.port))
        .header("Origin", "http://localhost:1420");
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b.to_string());
    }
    if let Some(k) = bearer {
        req = req.bearer_auth(k);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    let cors = res
        .headers()
        .get("access-control-allow-origin")
        .map(|v| v.to_str().unwrap().to_string());
    let text = res.text().await.unwrap();
    (status, text, cors)
}

fn head(text: &str) -> String {
    text.chars().take(60).collect()
}

#[tokio::test]
async fn every_local_route_answers_as_before() {
    use reqwest::Method;
    let s = start("").await;
    let cases: Vec<(Method, &str, Option<&str>, u16, &str)> = vec![
        (Method::GET, "/v1/models", None, 200, "{\"object\":\"list\""),
        (Method::GET, "/v1/openapi.json", None, 200, "{"),
        (Method::GET, "/v1/", None, 200, ""),
        (Method::GET, "/v1/nope", None, 404, "Not Found"),
        (Method::POST, "/v1/messages", Some("not json"), 400, "Invalid JSON body"),
        (Method::POST, "/v1/messages", Some("{}"), 400, "Request body must contain a 'model' field"),
        (
            Method::POST,
            "/v1/messages",
            Some("{\"model\":\"ghost\"}"),
            404,
            "No running session found for model 'ghost'",
        ),
        (Method::POST, "/v1/chat/completions", Some("not json"), 400, ""),
        (Method::POST, "/v1/chat/completions", Some("{}"), 400, ""),
        (Method::POST, "/v1/chat/completions", Some("{\"model\":\"ghost\"}"), 404, ""),
        (Method::POST, "/v1/orchestrations", Some("not json"), 400, ""),
        (Method::POST, "/v1/images/generations", Some("{}"), 400, ""),
        (Method::POST, "/v1/videos", Some("{}"), 400, ""),
        (Method::GET, "/v1/videos/abc", None, 404, ""),
    ];
    let mut seen = Vec::new();
    for (m, path, body, _, _) in &cases {
        let (status, text, cors) = call(&s, m.clone(), path, *body, None).await;
        seen.push(format!("{m} {path} -> {status} cors={cors:?} {:?}", head(&text)));
        let _ = (status, text);
    }
    let report = seen.join("
");
    assert_eq!(report, EXPECTED.trim(), "
{report}");
    stop_server(s.handle.clone()).await.ok();
}

#[tokio::test]
async fn an_api_key_is_required_when_set() {
    let s = start("sekrit").await;
    let (status, _, _) = call(&s, reqwest::Method::GET, "/v1/models", None, None).await;
    assert_eq!(status, 401);
    let (status, _, _) = call(&s, reqwest::Method::GET, "/v1/models", None, Some("wrong")).await;
    assert_eq!(status, 401);
    let (status, _, _) = call(&s, reqwest::Method::GET, "/v1/models", None, Some("sekrit")).await;
    assert_eq!(status, 200);
    stop_server(s.handle.clone()).await.ok();
}

const EXPECTED: &str = r#"
GET /v1/models -> 200 cors=Some("http://localhost:1420") "{\"object\":\"list\",\"data\":[]}"
GET /v1/openapi.json -> 200 cors=None "{\"openapi\":\"3.0.0\",\"info\":{\"title\":\"Jan API Server Endpoints"
GET /v1/ -> 200 cors=Some("http://localhost:1420") "\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UT"
GET /v1/nope -> 404 cors=Some("http://localhost:1420") "Not Found"
POST /v1/messages -> 400 cors=Some("http://localhost:1420") "Invalid JSON body: expected ident at line 1 column 2"
POST /v1/messages -> 400 cors=Some("http://localhost:1420") "Request body must contain a 'model' field"
POST /v1/messages -> 404 cors=Some("http://localhost:1420") "No running session found for model 'ghost'"
POST /v1/chat/completions -> 400 cors=Some("http://localhost:1420") "Invalid JSON body: expected ident at line 1 column 2"
POST /v1/chat/completions -> 400 cors=Some("http://localhost:1420") "Request body must contain a 'model' field"
POST /v1/chat/completions -> 503 cors=Some("http://localhost:1420") "{\"error\":{\"message\":\"No models are available\",\"type\":\"server"
POST /v1/orchestrations -> 400 cors=Some("http://localhost:1420") "Invalid JSON body: expected ident at line 1 column 2"
POST /v1/images/generations -> 400 cors=Some("http://localhost:1420") "{\"error\":{\"message\":\"prompt is required.\",\"type\":\"invalid_re"
POST /v1/videos -> 400 cors=Some("http://localhost:1420") "{\"error\":{\"message\":\"prompt is required.\",\"type\":\"invalid_re"
GET /v1/videos/abc -> 404 cors=Some("http://localhost:1420") "{\"error\":{\"message\":\"No such video.\",\"type\":\"invalid_request"
"#;
