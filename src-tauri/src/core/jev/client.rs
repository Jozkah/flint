//! The one TypeSafe HTTP call: `POST /v1/systemone`, bounded in time and in
//! the size of what is read back.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

/// A response larger than this is not a decision; it is not read.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Answer {
    Choice {
        choice: String,
        #[serde(default)]
        confidence: Option<f64>,
        #[serde(default)]
        probabilities: HashMap<String, f64>,
    },
    Noul {
        noul: f64,
    },
    Score {
        #[serde(default)]
        score: Value,
    },
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SystemOneResponse {
    /// The version that answered, e.g. `jev-1.13.0`.
    pub model: String,
    pub answers: HashMap<String, Answer>,
    #[serde(default)]
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    Timeout,
    /// Status and a short, key-free reason.
    Http(String),
    Decode(String),
}

pub fn parse(bytes: &[u8]) -> Result<SystemOneResponse, CallError> {
    serde_json::from_slice(bytes).map_err(|e| CallError::Decode(e.to_string()))
}

/// POST `body` to `endpoint` with the key as a bearer token.
///
/// Redirects are refused: the key must only ever go to the endpoint named.
pub async fn post(endpoint: &str, key: &str, body: &Value, timeout: Duration) -> Result<SystemOneResponse, CallError> {
    let client = crate::core::net::tls::apply12(reqwest::Client::builder())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .map_err(|e| CallError::Http(format!("client: {e}")))?;
    let work = async {
        let resp = client
            .post(endpoint)
            .bearer_auth(key)
            .json(body)
            .send()
            .await
            .map_err(|e| if e.is_timeout() { CallError::Timeout } else { CallError::Http(e.without_url().to_string()) })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(CallError::Http(format!("HTTP {}", status.as_u16())));
        }
        if resp.content_length().is_some_and(|n| n as usize > MAX_RESPONSE_BYTES) {
            return Err(CallError::Decode("response too large".into()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| if e.is_timeout() { CallError::Timeout } else { CallError::Http(e.without_url().to_string()) })?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CallError::Decode("response too large".into()));
        }
        parse(&bytes)
    };
    // The client's own timeout covers the request; this covers everything.
    tokio::time::timeout(timeout, work).await.unwrap_or(Err(CallError::Timeout))
}
