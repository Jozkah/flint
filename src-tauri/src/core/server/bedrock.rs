//! Amazon Bedrock request signing (AWS Signature Version 4).
//!
//! The AWS secret access key lives in the OS keyring (via
//! [`provider_secrets`]) and is read only here: the webview asks
//! [`bedrock_sign`] for the headers of one request and never sees the secret.
//! Signing is a few HMAC-SHA256 steps, so it is written out with the `hmac` /
//! `sha2` crates already in the tree rather than pulling in the AWS SDK.
//!
//! Only `bedrock-runtime.<region>.amazonaws.com` is signed, so a compromised
//! page cannot use this command to sign requests to another AWS service.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::provider_secrets::{delete_secret_record, store_secret_record, try_load_secret_record};

type HmacSha256 = Hmac<Sha256>;

const SECRET_RECORD: &str = "bedrock-aws";
const SERVICE: &str = "bedrock";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Credentials {
    #[serde(default)]
    access_key_id: String,
    #[serde(default)]
    secret_access_key: String,
    #[serde(default)]
    session_token: String,
}

/// Serializes load -> mutate -> save so concurrent field updates cannot lose
/// each other's write.
static CREDENTIAL_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A missing record is an empty `Credentials`; a keyring read error is an
/// `Err` so callers never overwrite a record they could not read.
fn load_credentials() -> Result<Credentials, String> {
    match try_load_secret_record(SECRET_RECORD)? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(Credentials::default()),
    }
}

/// Apply one field change under the write lock.
#[cfg(any(test, not(feature = "cli")))]
fn update_credential_field(field: &str, value: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_WRITE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut creds = load_credentials()?;
    apply_field(&mut creds, field, value)?;
    save_credentials(&creds)
}

#[cfg(any(test, not(feature = "cli")))]
fn apply_field(creds: &mut Credentials, field: &str, value: &str) -> Result<(), String> {
    let value = value.trim().to_string();
    match field {
        "access_key_id" => creds.access_key_id = value,
        "secret_access_key" => creds.secret_access_key = value,
        "session_token" => creds.session_token = value,
        other => return Err(format!("unknown credential field: {other}")),
    }
    Ok(())
}

fn save_credentials(creds: &Credentials) -> Result<(), String> {
    if creds.access_key_id.is_empty()
        && creds.secret_access_key.is_empty()
        && creds.session_token.is_empty()
    {
        return delete_secret_record(SECRET_RECORD);
    }
    let raw = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    store_secret_record(SECRET_RECORD, &raw)
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// SigV4 percent-encoding: everything but unreserved characters (and `/` when
/// encoding a path) becomes `%XX`.
fn uri_encode(input: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Everything signing needs, so tests can pin the clock and credentials.
struct SignInput<'a> {
    method: &'a str,
    url: &'a url::Url,
    /// Headers to sign besides `host` and `x-amz-date` (lowercase names).
    extra_headers: &'a BTreeMap<String, String>,
    body: &'a [u8],
    region: &'a str,
    service: &'a str,
    access_key_id: &'a str,
    secret_access_key: &'a str,
    session_token: &'a str,
    now: DateTime<Utc>,
}

/// The headers to add to the request: `authorization`, `x-amz-date` and, when
/// a session token is set, `x-amz-security-token`.
fn sign(input: &SignInput) -> BTreeMap<String, String> {
    let amz_date = input.now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = &amz_date[..8];

    let host = match input.url.port() {
        Some(port) => format!("{}:{port}", input.url.host_str().unwrap_or_default()),
        None => input.url.host_str().unwrap_or_default().to_string(),
    };

    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    headers.insert("host".into(), host);
    headers.insert("x-amz-date".into(), amz_date.clone());
    if !input.session_token.is_empty() {
        headers.insert(
            "x-amz-security-token".into(),
            input.session_token.to_string(),
        );
    }
    for (name, value) in input.extra_headers {
        headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
    }

    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");

    // Services other than S3 encode the (already encoded) path once more.
    let path = if input.url.path().is_empty() {
        "/"
    } else {
        input.url.path()
    };
    let canonical_uri = uri_encode(path, true);

    let mut query: Vec<(String, String)> = input
        .url
        .query_pairs()
        .map(|(k, v)| (uri_encode(&k, false), uri_encode(&v, false)))
        .collect();
    query.sort();
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let payload_hash = sha256_hex(input.body);
    let canonical_request = format!(
        "{}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}",
        input.method.to_ascii_uppercase()
    );

    let scope = format!("{date}/{}/{}/aws4_request", input.region, input.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac(
        format!("AWS4{}", input.secret_access_key).as_bytes(),
        date.as_bytes(),
    );
    let k_region = hmac(&k_date, input.region.as_bytes());
    let k_service = hmac(&k_region, input.service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));

    let mut out = BTreeMap::new();
    out.insert(
        "authorization".to_string(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.access_key_id
        ),
    );
    out.insert("x-amz-date".to_string(), amz_date);
    if !input.session_token.is_empty() {
        out.insert(
            "x-amz-security-token".to_string(),
            input.session_token.to_string(),
        );
    }
    out
}

/// `bedrock-runtime.<region>.amazonaws.com` (or `-fips`), nothing else.
fn bedrock_runtime_region(url: &url::Url) -> Option<String> {
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let rest = host
        .strip_prefix("bedrock-runtime.")
        .or_else(|| host.strip_prefix("bedrock-runtime-fips."))?;
    let region = rest
        .strip_suffix(".amazonaws.com")
        .or_else(|| rest.strip_suffix(".amazonaws.com.cn"))?;
    if region.is_empty()
        || !region
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some(region.to_string())
}

/// Headers a Bedrock request needs, signed with the stored credentials.
fn sign_bedrock_request(
    creds: &Credentials,
    method: &str,
    url: &str,
    content_type: Option<&str>,
    body: &str,
    now: DateTime<Utc>,
) -> Result<BTreeMap<String, String>, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    let region = bedrock_runtime_region(&parsed).ok_or_else(|| {
        "only https://bedrock-runtime.<region>.amazonaws.com can be signed".to_string()
    })?;
    if creds.access_key_id.is_empty() || creds.secret_access_key.is_empty() {
        return Err(
            "No AWS credentials saved for Amazon Bedrock. Add them in Settings > Model Providers."
                .into(),
        );
    }
    let mut extra = BTreeMap::new();
    if let Some(ct) = content_type {
        extra.insert("content-type".to_string(), ct.to_string());
    }
    Ok(sign(&SignInput {
        method,
        url: &parsed,
        extra_headers: &extra,
        body: body.as_bytes(),
        region: &region,
        service: SERVICE,
        access_key_id: &creds.access_key_id,
        secret_access_key: &creds.secret_access_key,
        session_token: &creds.session_token,
        now,
    }))
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub async fn bedrock_sign(
    method: String,
    url: String,
    content_type: Option<String>,
    body: String,
) -> Result<BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sign_bedrock_request(
            &load_credentials()?,
            &method,
            &url,
            content_type.as_deref(),
            &body,
            Utc::now(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which of the three credential fields is set. Never returns a value.
#[derive(Debug, Serialize)]
pub struct BedrockCredentialStatus {
    pub access_key_id: bool,
    pub secret_access_key: bool,
    pub session_token: bool,
}

#[cfg(not(feature = "cli"))]
#[tauri::command]
pub async fn bedrock_credential_status() -> BedrockCredentialStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let c = load_credentials().unwrap_or_default();
        BedrockCredentialStatus {
            access_key_id: !c.access_key_id.is_empty(),
            secret_access_key: !c.secret_access_key.is_empty(),
            session_token: !c.session_token.is_empty(),
        }
    })
    .await
    .unwrap_or(BedrockCredentialStatus {
        access_key_id: false,
        secret_access_key: false,
        session_token: false,
    })
}

/// Set one credential field: `access_key_id`, `secret_access_key` or
/// `session_token`. An empty value clears it.
#[cfg(not(feature = "cli"))]
#[tauri::command]
pub async fn bedrock_set_credential(field: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update_credential_field(&field, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

    fn vector_time() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2015, 8, 30, 12, 36, 0).unwrap()
    }

    fn vector_sign(
        method: &str,
        url: &str,
        body: &[u8],
        extra: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let parsed = url::Url::parse(url).unwrap();
        sign(&SignInput {
            method,
            url: &parsed,
            extra_headers: extra,
            body,
            region: "us-east-1",
            service: "service",
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: SECRET,
            session_token: "",
            now: vector_time(),
        })
    }

    /// AWS Signature V4 test suite, `get-vanilla`.
    #[test]
    fn aws_test_vector_get_vanilla() {
        let out = vector_sign(
            "GET",
            "https://example.amazonaws.com/",
            b"",
            &BTreeMap::new(),
        );
        assert_eq!(
            out["authorization"],
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
        assert_eq!(out["x-amz-date"], "20150830T123600Z");
    }

    /// AWS Signature V4 test suite, `post-vanilla`.
    #[test]
    fn aws_test_vector_post_vanilla() {
        let out = vector_sign(
            "POST",
            "https://example.amazonaws.com/",
            b"",
            &BTreeMap::new(),
        );
        assert!(out["authorization"].ends_with(
            "Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
        ));
    }

    /// AWS Signature V4 test suite, `get-vanilla-query-order-key-case`
    /// (query parameters are sorted before signing).
    #[test]
    fn aws_test_vector_query_is_sorted() {
        let out = vector_sign(
            "GET",
            "https://example.amazonaws.com/?Param2=value2&Param1=value1",
            b"",
            &BTreeMap::new(),
        );
        assert!(out["authorization"].ends_with(
            "Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"
        ));
    }

    #[test]
    fn session_token_is_signed_and_returned() {
        let parsed =
            url::Url::parse("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse")
                .unwrap();
        let out = sign(&SignInput {
            method: "POST",
            url: &parsed,
            extra_headers: &BTreeMap::new(),
            body: b"{}",
            region: "us-east-1",
            service: "bedrock",
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: SECRET,
            session_token: "TOKEN",
            now: vector_time(),
        });
        assert_eq!(out["x-amz-security-token"], "TOKEN");
        assert!(out["authorization"].contains("SignedHeaders=host;x-amz-date;x-amz-security-token"));
    }

    #[test]
    fn region_is_taken_from_the_bedrock_runtime_host_only() {
        let region = |u: &str| bedrock_runtime_region(&url::Url::parse(u).unwrap());
        assert_eq!(
            region("https://bedrock-runtime.eu-west-1.amazonaws.com/x").as_deref(),
            Some("eu-west-1")
        );
        assert_eq!(
            region("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/x").as_deref(),
            Some("us-gov-west-1")
        );
        assert!(region("https://s3.us-east-1.amazonaws.com/x").is_none());
        assert!(region("https://bedrock-runtime.us-east-1.amazonaws.com.evil.test/x").is_none());
        assert!(region("http://bedrock-runtime.us-east-1.amazonaws.com/x").is_none());
    }

    #[test]
    fn refuses_to_sign_without_credentials_or_for_another_host() {
        let now = vector_time();
        let none = Credentials::default();
        assert!(sign_bedrock_request(
            &none,
            "POST",
            "https://bedrock-runtime.us-east-1.amazonaws.com/x",
            None,
            "{}",
            now
        )
        .is_err());
        let some = Credentials {
            access_key_id: "AK".into(),
            secret_access_key: "SK".into(),
            session_token: String::new(),
        };
        assert!(
            sign_bedrock_request(&some, "POST", "https://example.com/x", None, "{}", now).is_err()
        );
        assert!(sign_bedrock_request(
            &some,
            "POST",
            "https://bedrock-runtime.us-east-1.amazonaws.com/x",
            Some("application/json"),
            "{}",
            now
        )
        .is_ok());
    }

    #[test]
    fn model_id_colon_is_double_encoded_in_the_canonical_path() {
        // The wire path carries %3A; SigV4 for non-S3 services encodes it again.
        assert_eq!(
            uri_encode("/model/a.b-v1%3A0/converse", true),
            "/model/a.b-v1%253A0/converse"
        );
    }

    #[test]
    fn apply_field_rejects_unknown_and_trims() {
        let mut c = Credentials::default();
        apply_field(&mut c, "session_token", "  tok ").unwrap();
        assert_eq!(c.session_token, "tok");
        assert!(apply_field(&mut c, "bogus", "x").is_err());
    }
}
