//! OAuth 2.1 (PKCE + dynamic client registration) for remote MCP servers.
//!
//! Tauri-free on purpose: the CLI drives this today (`core::cli::mcp` for the
//! transport, `core::cli::tui` for the `/mcp` screen) and the desktop
//! activation stack is expected to adopt it unchanged.
//!
//! `rmcp`'s `auth` feature owns the protocol -- metadata discovery, PKCE, the
//! token exchange and the `AuthClient` wrapper that injects the bearer token
//! into either transport. What lives here is everything around it that rmcp
//! leaves to the caller: a persistent token store keyed by server name, the
//! loopback listener that receives the redirect, and absolute expiry tracking.
//!
//! Absolute expiry is not redundant. `rmcp`'s `get_access_token` tests
//! `expires_in()`, which is the *original* lifetime from the token response and
//! never decreases, so its automatic refresh never fires. `StoredCredentials`
//! stamps `expires_at` at exchange time; `authorized_client` refreshes against
//! the clock when it connects, and a refresher refreshes a live connection's
//! token ahead of its expiry for as long as that connection exists (AH-134).
//!
//! Tokens live in the OS secret store (`provider_secrets`: the keyring, or its
//! encrypted file when the keyring is unavailable), keyed by data folder and
//! server name. Earlier builds kept them in plaintext in `mcp_oauth.json`; a
//! record found there is moved into the store the first time it is read.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rmcp::transport::auth::{AuthClient, AuthorizationManager, OAuthState, OAuthTokenResponse};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};

use crate::core::server::provider_secrets;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where earlier builds kept tokens, in plaintext, next to `mcp_config.json`.
/// Read only to migrate: a record found here is moved into the secret store and
/// removed, and the file is deleted once it holds nothing.
const STORE_FILE: &str = "mcp_oauth.json";

/// How often a waiting refresher checks that its connection still exists, so a
/// dropped connection's refresher ends within this long rather than sleeping
/// until the token's expiry.
const REFRESH_POLL: Duration = Duration::from_secs(2);

/// How long the loopback listener waits for the browser redirect before giving
/// up, so an abandoned sign-in cannot pin a port for the rest of the session.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// Refresh this long before the token actually expires, so a turn that starts
/// just under the wire does not fail mid-request.
const EXPIRY_SKEW: Duration = Duration::from_secs(60);

/// Client name sent during dynamic registration; what the user sees on the
/// provider's consent screen.
const CLIENT_NAME: &str = "Jan";

/// Marker the desktop's `activate_mcp_server` prefixes onto an error the user
/// fixes by signing in, so the settings UI can offer an `Authenticate` button
/// instead of showing a transport error nobody can act on.
///
/// A prefix rather than a typed error because the Tauri command boundary
/// serializes failures as strings; the CLI has `ConnectError::NeedsAuth` for the
/// same distinction and does not need this.
/// Stripped back off on the frontend by `useMcpAuth`'s `needsAuthDetail`; there
/// is deliberately no Rust splitter, since nothing on this side consumes it.
pub const NEEDS_AUTH_PREFIX: &str = "NEEDS_AUTH: ";

/// Tokens for one server, as persisted. `client_id` is part of the record
/// because a dynamically registered client is per-installation: refreshing
/// needs the same id the code was issued to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub client_id: String,
    pub tokens: OAuthTokenResponse,
    /// Unix seconds at which `tokens`' access token stops being valid. `None`
    /// when the provider returned no `expires_in`, which means "until refused".
    pub expires_at: Option<u64>,
    /// The MCP url these tokens were issued for. Editing a server's url points
    /// it at a different resource, so credentials for the old one are stale.
    pub resource: String,
}

impl StoredCredentials {
    fn from_exchange(client_id: String, tokens: OAuthTokenResponse, resource: String) -> Self {
        let expires_at = expires_at_from(&tokens);
        Self {
            client_id,
            tokens,
            expires_at,
            resource,
        }
    }

    /// Whether the access token is past `expires_at` (minus the refresh skew).
    /// A record with no expiry never reports expired.
    pub fn is_expired(&self) -> bool {
        let Some(at) = self.expires_at else {
            return false;
        };
        now_secs() + EXPIRY_SKEW.as_secs() >= at
    }

    fn has_refresh_token(&self) -> bool {
        use oauth2::TokenResponse;
        self.tokens.refresh_token().is_some()
    }
}

fn expires_at_from(tokens: &OAuthTokenResponse) -> Option<u64> {
    use oauth2::TokenResponse;
    tokens.expires_in().map(|d| now_secs() + d.as_secs())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Tokens from a refresh, keeping the refresh token they replaced when the
/// provider did not send a new one. RFC 6749 section 6 lets a provider keep the
/// refresh token it issued; dropping it would make the next refresh impossible
/// and send the user back through the browser for no reason. `true` when the
/// previous one was carried over.
fn keep_refresh_token(mut tokens: OAuthTokenResponse, previous: &OAuthTokenResponse) -> (OAuthTokenResponse, bool) {
    use oauth2::TokenResponse;
    if tokens.refresh_token().is_none() {
        if let Some(old) = previous.refresh_token() {
            tokens.set_refresh_token(Some(old.clone()));
            return (tokens, true);
        }
    }
    (tokens, false)
}

/// An authorization manager holding `tokens`, discovered against `url`.
async fn manager_for(
    name: &str,
    url: &str,
    base: &reqwest::Client,
    client_id: &str,
    tokens: OAuthTokenResponse,
) -> Result<AuthorizationManager, HarnessError> {
    let auth = |message: String| HarnessError::new(ErrorKind::Authentication, message).at(Stage::Startup);
    let mut state = OAuthState::new(url.to_string(), Some(base.clone()))
        .await
        .map_err(|e| {
            HarnessError::new(ErrorKind::Transport, format!("could not prepare OAuth for '{name}': {e}"))
                .at(Stage::Startup)
        })?;
    state
        .set_credentials(client_id, tokens)
        .await
        .map_err(|e| auth(format!("stored credentials for '{name}' are unusable: {e}")))?;
    state
        .into_authorization_manager()
        .ok_or_else(|| auth(format!("OAuth for '{name}' did not reach an authorized state")))
}

/// What the `/mcp` screen reports on its `Auth:` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    /// A stdio server: the transport is a pipe, there is nothing to authorize.
    NotApplicable,
    /// The user configured an `Authorization` header by hand. OAuth would fight
    /// with it, so it is never attempted and never reported as missing.
    StaticHeader,
    /// Tokens on disk, still valid.
    Authenticated { expires_at: Option<u64> },
    /// Tokens on disk but past their expiry. Renewable without the browser when
    /// a refresh token came with them.
    Expired {
        renewable: bool,
        expires_at: Option<u64>,
    },
    /// Tokens on disk, issued for a different url than the server now points at.
    StaleResource,
    /// Nothing stored. Whether that is a problem is up to the server.
    Unauthenticated,
}

/// Read the `Auth:` state for one configured server without touching the
/// network. `config` is the raw `mcp_config.json` entry.
pub fn status(data_folder: &Path, name: &str, config: &Value) -> AuthStatus {
    let transport = config
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    if transport == "stdio" {
        return AuthStatus::NotApplicable;
    }
    if has_static_authorization(config) {
        return AuthStatus::StaticHeader;
    }
    let Some(stored) = load(data_folder, name) else {
        return AuthStatus::Unauthenticated;
    };
    let url = config.get("url").and_then(Value::as_str).unwrap_or("");
    if !url.is_empty() && stored.resource != url {
        return AuthStatus::StaleResource;
    }
    if stored.is_expired() {
        return AuthStatus::Expired {
            renewable: stored.has_refresh_token(),
            expires_at: stored.expires_at,
        };
    }
    AuthStatus::Authenticated {
        expires_at: stored.expires_at,
    }
}

/// `AuthStatus` flattened for the wire, so the settings UI can render a badge
/// and decide which buttons to offer without re-deriving any of it.
///
/// A tagged struct rather than the enum itself: `state` is a stable string the
/// frontend switches on, and adding a variant here cannot silently change the
/// shape of an existing one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusInfo {
    /// One of `notApplicable`, `staticHeader`, `authenticated`, `expired`,
    /// `staleResource`, `unauthenticated`.
    pub state: &'static str,
    /// Whether an interactive sign-in is possible and would mean something.
    pub can_authenticate: bool,
    /// Whether there are stored tokens to forget.
    pub has_credentials: bool,
    /// Whether a stored refresh token can renew this without the browser. Only
    /// meaningful for `expired`; false everywhere else.
    pub renewable: bool,
    /// Unix seconds the access token expires at, when known.
    pub expires_at: Option<u64>,
}

impl From<AuthStatus> for AuthStatusInfo {
    fn from(status: AuthStatus) -> Self {
        let (state, can_authenticate, has_credentials, renewable, expires_at) = match status {
            AuthStatus::NotApplicable => ("notApplicable", false, false, false, None),
            AuthStatus::StaticHeader => ("staticHeader", false, false, false, None),
            AuthStatus::Authenticated { expires_at } => {
                ("authenticated", true, true, false, expires_at)
            }
            AuthStatus::Expired {
                renewable,
                expires_at,
            } => ("expired", true, true, renewable, expires_at),
            AuthStatus::StaleResource => ("staleResource", true, true, false, None),
            AuthStatus::Unauthenticated => ("unauthenticated", true, false, false, None),
        };
        Self {
            state,
            can_authenticate,
            has_credentials,
            renewable,
            expires_at,
        }
    }
}

/// Whether the entry carries a hand-configured `Authorization` header. Matched
/// case-insensitively: header names are case-insensitive on the wire, and a
/// user who typed `authorization` still means the same thing.
pub fn has_static_authorization(config: &Value) -> bool {
    config
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|h| {
            h.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("authorization")
                    && v.as_str().is_some_and(|s| !s.trim().is_empty())
            })
        })
}

fn store_path(data_folder: &Path) -> PathBuf {
    data_folder.join(STORE_FILE)
}

fn read_legacy(data_folder: &Path) -> BTreeMap<String, StoredCredentials> {
    match std::fs::read_to_string(store_path(data_folder)) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or_default(),
        _ => BTreeMap::new(),
    }
}

/// Rewrite the legacy file without the records that have moved (tmp + rename,
/// owner-only on Unix), or delete it once nothing is left in it.
fn write_legacy(
    data_folder: &Path,
    store: &BTreeMap<String, StoredCredentials>,
) -> Result<(), String> {
    let path = store_path(data_folder);
    if store.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let body = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The secret-store record for one server in one data folder. The folder is
/// part of the key because the OS keyring belongs to the user, not to a Jan
/// profile: two profiles that each configure a server called `github` must not
/// read or overwrite each other's tokens.
fn secret_key(data_folder: &Path, name: &str) -> String {
    use sha2::{Digest, Sha256};
    let folder = std::fs::canonicalize(data_folder).unwrap_or_else(|_| data_folder.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(folder.to_string_lossy().as_bytes());
    hasher.update([0u8]);
    hasher.update(name.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("mcp-oauth:{}", &digest[..32])
}

fn store_err(name: &str, detail: impl std::fmt::Display) -> HarnessError {
    HarnessError::new(
        ErrorKind::Io,
        format!("could not keep the tokens for '{name}' in the secret store: {detail}"),
    )
    .at(Stage::Persistence)
}

/// Write one server's record to the secret store. The old record is removed
/// first: the keyring refuses values over its size limit, and the store then
/// writes the encrypted file instead, where a keyring copy left behind would be
/// read first and hand back the tokens this write replaced.
fn store_record(data_folder: &Path, name: &str, creds: &StoredCredentials) -> Result<(), HarnessError> {
    let body = serde_json::to_string(creds).map_err(|e| store_err(name, e))?;
    let key = secret_key(data_folder, name);
    provider_secrets::delete_secret_record(&key).map_err(|e| store_err(name, e))?;
    provider_secrets::store_secret_record(&key, &body).map_err(|e| store_err(name, e))
}

/// Move one server's plaintext record into the secret store. The plaintext
/// copy is removed only once the store holds it, so a store that cannot be
/// written leaves the credential where it was instead of losing it.
fn migrate_legacy(data_folder: &Path, name: &str) -> Option<StoredCredentials> {
    let mut legacy = read_legacy(data_folder);
    let creds = legacy.get(name)?.clone();
    match store_record(data_folder, name, &creds) {
        Ok(()) => {
            legacy.remove(name);
            if let Err(e) = write_legacy(data_folder, &legacy) {
                log::warn!("moved the tokens for '{name}' into the secret store but could not remove them from {STORE_FILE}: {e}");
            } else {
                log::info!("moved the tokens for '{name}' from {STORE_FILE} into the secret store");
            }
        }
        Err(e) => log::warn!("{e}; they stay in {STORE_FILE} until the store can be written"),
    }
    Some(creds)
}

pub fn load(data_folder: &Path, name: &str) -> Option<StoredCredentials> {
    if let Some(raw) = provider_secrets::load_secret_record(&secret_key(data_folder, name)) {
        match serde_json::from_str(&raw) {
            Ok(creds) => return Some(creds),
            Err(e) => log::warn!("the stored tokens for '{name}' could not be read ({e}); treating them as absent"),
        }
    }
    migrate_legacy(data_folder, name)
}

pub fn save(data_folder: &Path, name: &str, creds: &StoredCredentials) -> Result<(), String> {
    store_record(data_folder, name, creds).map_err(|e| e.to_string())?;
    // A plaintext copy from an earlier build must not outlive the one that
    // replaced it.
    let mut legacy = read_legacy(data_folder);
    if legacy.remove(name).is_some() {
        write_legacy(data_folder, &legacy)?;
    }
    Ok(())
}

/// Forget one server's tokens. `Ok(false)` when there were none, so the caller
/// can tell "cleared" from "nothing to clear" without a second read.
pub fn clear(data_folder: &Path, name: &str) -> Result<bool, String> {
    let key = secret_key(data_folder, name);
    let stored = provider_secrets::load_secret_record(&key).is_some();
    provider_secrets::delete_secret_record(&key)?;
    let mut legacy = read_legacy(data_folder);
    let plaintext = legacy.remove(name).is_some();
    if plaintext {
        write_legacy(data_folder, &legacy)?;
    }
    Ok(stored || plaintext)
}

/// Live refreshers, by secret key, so a test can prove one ends with its
/// connection.
static REFRESHERS: std::sync::Mutex<BTreeMap<String, usize>> = std::sync::Mutex::new(BTreeMap::new());

struct RefresherAlive(String);

impl RefresherAlive {
    fn new(key: String) -> Self {
        *REFRESHERS.lock().unwrap_or_else(|p| p.into_inner()).entry(key.clone()).or_default() += 1;
        Self(key)
    }
}

impl Drop for RefresherAlive {
    fn drop(&mut self) {
        let mut live = REFRESHERS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = live.get_mut(&self.0) {
            *n -= 1;
            if *n == 0 {
                live.remove(&self.0);
            }
        }
    }
}

#[cfg(test)]
fn live_refreshers(data_folder: &Path, name: &str) -> usize {
    REFRESHERS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&secret_key(data_folder, name))
        .copied()
        .unwrap_or(0)
}

/// Keep a live connection's access token fresh: refresh it `EXPIRY_SKEW`
/// before it expires, store what the provider returned, and repeat for the
/// new token. Holds the connection's authorization manager only weakly, so the
/// refresher ends once the connection is dropped (checked every
/// `REFRESH_POLL`). A refresh the provider refuses ends it too: the next
/// request is then refused and the server reports that it needs
/// authentication, which is where re-authorizing is offered.
fn spawn_refresher(
    data_folder: PathBuf,
    name: String,
    url: String,
    base: reqwest::Client,
    client_id: String,
    manager: Weak<tokio::sync::Mutex<AuthorizationManager>>,
    mut current: OAuthTokenResponse,
    mut expires_at: Option<u64>,
) {
    let alive = RefresherAlive::new(secret_key(&data_folder, &name));
    tokio::spawn(async move {
        let _alive = alive;
        loop {
            // A token with no expiry is refreshed only when it is refused.
            let Some(at) = expires_at else { return };
            let due = at.saturating_sub(EXPIRY_SKEW.as_secs());
            loop {
                if manager.strong_count() == 0 {
                    return;
                }
                let now = now_secs();
                if now >= due {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(due - now).min(REFRESH_POLL)).await;
            }
            let Some(strong) = manager.upgrade() else { return };
            let mut guard = strong.lock().await;
            let outcome = guard.refresh_token().await;
            match outcome {
                Ok(tokens) => {
                    let (tokens, carried) = keep_refresh_token(tokens, &current);
                    if carried {
                        // The manager holds what the provider sent, without the
                        // refresh token; give it the whole set, or its next
                        // refresh has nothing to send.
                        match manager_for(&name, &url, &base, &client_id, tokens.clone()).await {
                            Ok(replacement) => *guard = replacement,
                            Err(e) => {
                                log::warn!("could not keep the refresh token for '{name}' on the live connection: {e}");
                            }
                        }
                    }
                    drop(guard);
                    drop(strong);
                    let creds = StoredCredentials::from_exchange(client_id.clone(), tokens, url.clone());
                    expires_at = creds.expires_at;
                    current = creds.tokens.clone();
                    match save(&data_folder, &name, &creds) {
                        Ok(()) => log::info!("refreshed the access token for '{name}' ahead of its expiry"),
                        Err(e) => log::warn!("refreshed the access token for '{name}' but could not store it: {e}"),
                    }
                }
                Err(e) => {
                    log::warn!(
                        "could not refresh the access token for '{name}' ahead of its expiry: {e}; the server will ask to re-authenticate"
                    );
                    return;
                }
            }
        }
    });
}

/// Whether the server at `url` advertises OAuth, used to turn a failed connect
/// into `needs authentication` rather than a generic transport error. Metadata
/// discovery is exactly the probe the MCP spec defines for this, so a `true`
/// here is the server saying so rather than us pattern-matching an error
/// string.
pub async fn advertises_oauth(url: &str) -> bool {
    let Ok(state) = OAuthState::new(url.to_string(), None).await else {
        return false;
    };
    let OAuthState::Unauthorized(manager) = state else {
        return false;
    };
    manager.discover_metadata().await.is_ok()
}

/// An authorization in flight: the browser has somewhere to go and the loopback
/// listener is already bound, so the redirect cannot race the port.
pub struct PendingAuth {
    state: OAuthState,
    listener: tokio::net::TcpListener,
    server: String,
    resource: String,
    /// Where to send the user. Always surfaced, never only handed to a browser:
    /// a remote or headless session finishes by pasting it somewhere else.
    pub authorization_url: String,
    pub redirect_uri: String,
}

/// Start an authorization: bind the loopback listener, register (or reuse) a
/// client, and build the consent url. Nothing is persisted and no browser is
/// opened here -- the caller owns both.
///
/// The listener is bound *before* the redirect uri is minted because dynamic
/// registration sends that uri to the provider; picking a port afterwards could
/// hand out one another process just took.
pub async fn begin(server: &str, url: &str) -> Result<PendingAuth, String> {
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|e| format!("could not open a local callback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the callback port: {e}"))?
        .port();
    // `localhost` rather than the IP literal: providers commonly allow only the
    // hostname form in a loopback redirect, and both resolve to this listener.
    let redirect_uri = format!("http://localhost:{port}/callback");

    let mut state = OAuthState::new(url.to_string(), None)
        .await
        .map_err(|e| format!("could not reach '{url}' for OAuth discovery: {e}"))?;
    state
        .start_authorization(&[], &redirect_uri, Some(CLIENT_NAME))
        .await
        .map_err(|e| format!("'{server}' does not offer OAuth we can use: {e}"))?;
    let authorization_url = state
        .get_authorization_url()
        .await
        .map_err(|e| format!("could not build the sign-in url for '{server}': {e}"))?;

    Ok(PendingAuth {
        state,
        listener,
        server: server.to_string(),
        resource: url.to_string(),
        authorization_url,
        redirect_uri,
    })
}

impl PendingAuth {
    /// Wait for the browser redirect, exchange the code, and persist the
    /// tokens. Consumes the flow: the PKCE verifier and CSRF token are
    /// single-use, so a failed exchange means starting over rather than
    /// retrying against spent state.
    pub async fn complete(mut self, data_folder: &Path) -> Result<StoredCredentials, String> {
        let callback = tokio::time::timeout(CALLBACK_TIMEOUT, accept_callback(&self.listener))
            .await
            .map_err(|_| "timed out waiting for the browser to come back".to_string())??;

        self.state
            .handle_callback(&callback.code, &callback.state)
            .await
            .map_err(|e| format!("could not exchange the authorization code: {e}"))?;

        let (client_id, tokens) = self
            .state
            .get_credentials()
            .await
            .map_err(|e| format!("authorization finished without usable tokens: {e}"))?;
        let tokens =
            tokens.ok_or_else(|| "authorization finished without an access token".to_string())?;

        let creds = StoredCredentials::from_exchange(client_id, tokens, self.resource);
        save(data_folder, &self.server, &creds)?;
        Ok(creds)
    }
}

/// The query parameters of a successful redirect.
struct Callback {
    code: String,
    state: String,
}

/// Serve exactly one request on the loopback listener and pull `code`/`state`
/// out of it.
///
/// One connection is not always one *request*: a browser may open a speculative
/// connection, and favicon or `/` probes arrive on their own. So this loops
/// until a request actually carries the parameters, answering anything else
/// with a 404 rather than treating it as the redirect and failing the sign-in.
async fn accept_callback(listener: &tokio::net::TcpListener) -> Result<Callback, String> {
    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("callback connection failed: {e}"))?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let serve = http1::Builder::new().serve_connection(
            TokioIo::new(stream),
            service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let tx = tx.clone();
                async move {
                    let outcome = parse_callback_query(req.uri().query().unwrap_or(""));
                    let body = callback_page(&outcome);
                    let status = match &outcome {
                        Some(_) => 200,
                        None => 404,
                    };
                    if let Some(outcome) = outcome {
                        let _ = tx.send(outcome);
                    }
                    Ok::<_, std::convert::Infallible>(
                        hyper::Response::builder()
                            .status(status)
                            .header("content-type", "text/html; charset=utf-8")
                            .body(Full::new(Bytes::from(body)))
                            .expect("static response builds"),
                    )
                }
            }),
        );
        // A browser keeps the connection alive after the redirect, so the
        // connection future would not resolve until it times out. The response
        // has already been written by the time the result lands in `rx`, so
        // finishing on that instead of on the connection is what keeps the flow
        // from stalling for the whole keep-alive window.
        let outcome = tokio::select! {
            served = serve => {
                served.map_err(|e| format!("callback request failed: {e}"))?;
                rx.try_recv().ok()
            }
            Some(outcome) = rx.recv() => Some(outcome),
        };

        match outcome {
            Some(Ok(callback)) => return Ok(callback),
            Some(Err(e)) => return Err(e),
            // Not the redirect (a favicon probe, say): keep listening.
            None => continue,
        }
    }
}

/// Pull `code`/`state` (or the provider's `error`) out of a redirect query.
/// `None` means this request was not the redirect at all, which is the caller's
/// signal to keep waiting rather than to fail.
fn parse_callback_query(query: &str) -> Option<Result<Callback, String>> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut description = None;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }
    // An error is only believed when it carries the `state` it was issued
    // against: a drive-by request to the open loopback port would otherwise abort
    // a sign-in that is still in flight. Same reasoning that refuses a `code`
    // with no `state` below -- unverifiable either way, so neither is acted on.
    if let (Some(error), Some(_)) = (error, state.as_ref()) {
        let detail = description.map(|d| format!(": {d}")).unwrap_or_default();
        return Some(Err(format!(
            "the provider refused the sign-in ({error}){detail}"
        )));
    }
    match (code, state) {
        (Some(code), Some(state)) => Some(Ok(Callback { code, state })),
        // A `code` with no `state` cannot be CSRF-checked, so it is refused
        // rather than accepted with the check skipped.
        (Some(_), None) => Some(Err(
            "the redirect carried no 'state' parameter, so it cannot be verified".to_string(),
        )),
        _ => None,
    }
}

/// What the browser tab shows once the redirect lands. Plain and self-closing
/// in wording only -- no script, since a page served over loopback should not
/// need any.
fn callback_page(outcome: &Option<Result<Callback, String>>) -> String {
    let (title, detail) = match outcome {
        Some(Ok(_)) => ("Signed in", "You can close this tab and return to Jan."),
        Some(Err(e)) => ("Sign-in failed", e.as_str()),
        None => (
            "Not found",
            "This address is only used for the sign-in redirect.",
        ),
    };
    let detail = escape_html(detail);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Jan - {title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem\">\
         <h1>{title}</h1><p>{detail}</p></body></html>"
    )
}

/// The failure detail embeds `error`/`error_description` straight from the
/// redirect query, so it is provider-controlled text going into markup.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Build a transport client that carries this server's bearer token, refreshing
/// it first when it has expired.
///
/// `Ok(None)` means "no OAuth here": either nothing is stored, or the user
/// configured their own `Authorization` header, in which case the plain client
/// already carries it and wrapping it would put two credentials on one request.
/// The caller connects with its unwrapped client in that case.
pub async fn authorized_client(
    data_folder: &Path,
    name: &str,
    url: &str,
    config: &Value,
    base: reqwest::Client,
) -> Result<Option<AuthClient<reqwest::Client>>, HarnessError> {
    let auth = |message: String| HarnessError::new(ErrorKind::Authentication, message).at(Stage::Startup);
    if has_static_authorization(config) {
        return Ok(None);
    }
    let Some(stored) = load(data_folder, name) else {
        return Ok(None);
    };
    if stored.resource != url {
        return Err(auth(format!(
            "stored credentials for '{name}' were issued for {} - re-authenticate from /mcp",
            stored.resource
        )));
    }

    if stored.is_expired() && !stored.has_refresh_token() {
        return Err(auth(format!(
            "the access token for '{name}' expired and there is no refresh token - re-authenticate from /mcp"
        )));
    }
    let mut manager = manager_for(name, url, &base, &stored.client_id, stored.tokens.clone()).await?;

    let mut current = stored.clone();
    if stored.is_expired() {
        let tokens = manager.refresh_token().await.map_err(|e| {
            auth(format!(
                "could not refresh the access token for '{name}': {e} - re-authenticate from /mcp"
            ))
        })?;
        let (tokens, carried) = keep_refresh_token(tokens, &stored.tokens);
        if carried {
            manager = manager_for(name, url, &base, &stored.client_id, tokens.clone()).await?;
        }
        current = StoredCredentials::from_exchange(stored.client_id.clone(), tokens, url.to_string());
        store_record(data_folder, name, &current)?;
    }

    let client = AuthClient::new(base.clone(), manager);
    if current.has_refresh_token() {
        spawn_refresher(
            data_folder.to_path_buf(),
            name.to_string(),
            url.to_string(),
            base,
            current.client_id.clone(),
            Arc::downgrade(&client.auth_manager),
            current.tokens.clone(),
            current.expires_at,
        );
    }
    Ok(Some(client))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oauth2::{AccessToken, EmptyExtraTokenFields, RefreshToken, TokenResponse};
    use serde_json::json;

    fn tokens(expires_in: Option<u64>, refresh: bool) -> OAuthTokenResponse {
        let mut t = OAuthTokenResponse::new(
            AccessToken::new("at-1".to_string()),
            oauth2::basic::BasicTokenType::Bearer,
            EmptyExtraTokenFields {},
        );
        if let Some(secs) = expires_in {
            t.set_expires_in(Some(&Duration::from_secs(secs)));
        }
        if refresh {
            t.set_refresh_token(Some(RefreshToken::new("rt-1".to_string())));
        }
        t
    }

    /// The message from a `parse_callback_query` outcome that must be an error.
    fn err_of(outcome: Option<Result<Callback, String>>) -> String {
        match outcome {
            Some(Err(e)) => e,
            _ => panic!("expected a rejected callback"),
        }
    }

    fn creds(expires_in: Option<u64>, refresh: bool, resource: &str) -> StoredCredentials {
        StoredCredentials::from_exchange(
            "client-1".to_string(),
            tokens(expires_in, refresh),
            resource.to_string(),
        )
    }

    /// A data folder of its own, with the secret store pointed at it and kept
    /// off the OS keyring, so no test reads or writes the developer's real
    /// credentials. Holds the environment lock for as long as it lives.
    struct Isolated {
        dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        _guard: crate::core::server::provider_secrets::TestEnvGuard,
    }

    impl Isolated {
        fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    impl Drop for Isolated {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(p) => std::env::set_var("JAN_DATA_FOLDER", p),
                None => std::env::remove_var("JAN_DATA_FOLDER"),
            }
        }
    }

    fn isolated() -> Isolated {
        let guard = crate::core::server::provider_secrets::TEST_ENV_LOCK.lock();
        crate::core::server::provider_secrets::force_file_secrets();
        let dir = tempfile::TempDir::new().unwrap();
        let previous = std::env::var_os("JAN_DATA_FOLDER");
        std::env::set_var("JAN_DATA_FOLDER", dir.path());
        Isolated { dir, previous, _guard: guard }
    }

    /// Every file under `dir`, read as bytes.
    fn files_under(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).unwrap().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push((p.clone(), std::fs::read(&p).unwrap()));
                }
            }
        }
        out
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn store_round_trips_and_clears() {
        let dir = isolated();
        let c = creds(Some(3600), true, "https://x/mcp");

        assert!(load(dir.path(), "srv").is_none());
        save(dir.path(), "srv", &c).unwrap();

        let back = load(dir.path(), "srv").expect("stored");
        assert_eq!(back.client_id, "client-1");
        assert_eq!(back.tokens.access_token().secret(), "at-1");
        assert_eq!(back.resource, "https://x/mcp");

        assert!(clear(dir.path(), "srv").unwrap());
        assert!(load(dir.path(), "srv").is_none());
        // Nothing to clear is reported, not an error.
        assert!(!clear(dir.path(), "srv").unwrap());
    }

    #[test]
    fn saving_one_server_leaves_the_others_alone() {
        let dir = isolated();
        save(dir.path(), "a", &creds(Some(60), false, "https://a")).unwrap();
        save(dir.path(), "b", &creds(Some(60), false, "https://b")).unwrap();

        clear(dir.path(), "a").unwrap();
        assert!(load(dir.path(), "a").is_none());
        assert_eq!(load(dir.path(), "b").unwrap().resource, "https://b");
    }

    /// AH-134: a saved token is in the secret store, and no file in the data
    /// folder holds it in plaintext.
    #[test]
    fn saved_tokens_are_in_the_secret_store_and_nowhere_in_plaintext() {
        let dir = isolated();
        let mut c = creds(Some(3600), true, "https://x/mcp");
        c.tokens = {
            let mut t = OAuthTokenResponse::new(
                AccessToken::new("plaintext-canary-access".to_string()),
                oauth2::basic::BasicTokenType::Bearer,
                EmptyExtraTokenFields {},
            );
            t.set_refresh_token(Some(RefreshToken::new("plaintext-canary-refresh".to_string())));
            t
        };
        save(dir.path(), "srv", &c).unwrap();
        assert!(!store_path(dir.path()).exists(), "no plaintext store is written");
        let files = files_under(dir.path());
        assert!(!files.is_empty(), "the secret store wrote nothing, so this proves nothing");
        for (path, bytes) in &files {
            assert!(!contains(bytes, "plaintext-canary"), "{} holds a token in plaintext", path.display());
        }
        let key = secret_key(dir.path(), "srv");
        assert!(crate::core::server::provider_secrets::load_secret_record(&key).is_some());
        assert_eq!(load(dir.path(), "srv").unwrap().tokens.access_token().secret(), "plaintext-canary-access");
    }

    /// AH-134: a plaintext record from an earlier build is moved into the
    /// secret store the first time it is read, and the file goes once empty.
    #[test]
    fn plaintext_records_are_moved_into_the_secret_store_on_first_read() {
        let dir = isolated();
        let mut legacy = BTreeMap::new();
        legacy.insert("a".to_string(), creds(Some(3600), true, "https://a/mcp"));
        legacy.insert("b".to_string(), creds(Some(3600), false, "https://b/mcp"));
        write_legacy(dir.path(), &legacy).unwrap();

        assert_eq!(load(dir.path(), "a").unwrap().resource, "https://a/mcp");
        let left = read_legacy(dir.path());
        assert!(!left.contains_key("a") && left.contains_key("b"), "only the record read moves");
        assert!(crate::core::server::provider_secrets::load_secret_record(&secret_key(dir.path(), "a")).is_some());

        assert!(matches!(
            status(dir.path(), "b", &json!({ "type": "http", "url": "https://b/mcp" })),
            AuthStatus::Authenticated { .. }
        ));
        assert!(!store_path(dir.path()).exists(), "the emptied plaintext file is deleted");
        // What moved is still there on the next read, from the store alone.
        assert_eq!(load(dir.path(), "b").unwrap().resource, "https://b/mcp");
        assert!(clear(dir.path(), "a").unwrap());
        assert!(load(dir.path(), "a").is_none());
    }

    /// AH-134 refusal: a store that cannot be written is a typed error for a
    /// save, and a migration keeps the plaintext record rather than losing it.
    #[test]
    fn a_store_that_cannot_be_written_refuses_and_loses_nothing() {
        let dir = isolated();
        let mut legacy = BTreeMap::new();
        legacy.insert("a".to_string(), creds(Some(3600), true, "https://a/mcp"));
        write_legacy(dir.path(), &legacy).unwrap();
        // The encrypted store's file path is taken by a directory.
        std::fs::create_dir_all(dir.path().join("provider_secrets.enc")).unwrap();

        let err = store_record(dir.path(), "x", &creds(Some(60), true, "https://x")).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::Io);
        assert_eq!(err.stage(), Stage::Persistence);
        assert!(save(dir.path(), "x", &creds(Some(60), true, "https://x")).is_err());

        assert_eq!(load(dir.path(), "a").unwrap().resource, "https://a/mcp");
        assert!(read_legacy(dir.path()).contains_key("a"), "the only copy stays where it was");
    }

    /// AH-134 security: tokens are keyed by data folder and server, so another
    /// profile, or another server name, cannot read or be handed them.
    #[test]
    fn another_profile_or_server_cannot_use_a_servers_tokens() {
        let dir = isolated();
        let other = tempfile::tempdir().unwrap();
        save(dir.path(), "github", &creds(Some(3600), true, "https://gh/mcp")).unwrap();
        assert!(load(other.path(), "github").is_none(), "a second profile reads nothing");
        assert!(load(dir.path(), "github2").is_none());
        assert!(load(dir.path(), "GitHub").is_none());
        assert_ne!(secret_key(dir.path(), "github"), secret_key(other.path(), "github"));
        // Clearing in the other profile does not touch this one.
        assert!(!clear(other.path(), "github").unwrap());
        assert!(load(dir.path(), "github").is_some());
        // And a server re-pointed at another url is refused the stored token.
        assert_eq!(
            status(dir.path(), "github", &json!({ "type": "http", "url": "https://evil/mcp" })),
            AuthStatus::StaleResource
        );
    }

    /// The OAuth fixture: an authorization server and an MCP endpoint that
    /// needs a token it issued. Python is required -- a missing interpreter
    /// fails the test rather than skipping it.
    struct OauthFixture {
        child: std::process::Child,
        port: u16,
        log: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl OauthFixture {
        fn start(extra: &[&str]) -> Self {
            use std::io::BufRead;
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock_oauth_server.py");
            let python = ["python3", "python"]
                .into_iter()
                .find(|p| {
                    std::process::Command::new(p)
                        .arg("--version")
                        .output()
                        .is_ok_and(|o| o.status.success())
                })
                .expect("python is required for the OAuth fixture");
            let dir = tempfile::tempdir().unwrap();
            let log = dir.path().join("oauth.log");
            let mut child = std::process::Command::new(python)
                .arg(&script)
                .arg("--log")
                .arg(&log)
                .args(extra)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("start the OAuth fixture");
            let mut line = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
            let port = line.trim().trim_start_matches("PORT ").parse().expect("fixture port");
            Self { child, port, log, _dir: dir }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}/mcp", self.port)
        }

        fn entries(&self, path: &str) -> Vec<Value> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter(|e| e["path"] == path)
                .collect()
        }
    }

    impl Drop for OauthFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn fixture_creds(fixture: &OauthFixture, access: &str, refresh: &str, expires_in: u64) -> StoredCredentials {
        let mut t = OAuthTokenResponse::new(
            AccessToken::new(access.to_string()),
            oauth2::basic::BasicTokenType::Bearer,
            EmptyExtraTokenFields {},
        );
        t.set_expires_in(Some(&Duration::from_secs(expires_in)));
        t.set_refresh_token(Some(RefreshToken::new(refresh.to_string())));
        StoredCredentials::from_exchange("client-1".to_string(), t, fixture.url())
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    fn http() -> Value {
        json!({ "type": "http" })
    }

    /// AH-134: a token inside the refresh window is refreshed at connect,
    /// against the provider, and the refreshed token is what gets stored and
    /// sent.
    #[test]
    fn an_expiring_token_is_refreshed_at_connect_and_stored() {
        let dir = isolated();
        let fixture = OauthFixture::start(&["--accept", "rt-good"]);
        save(dir.path(), "srv", &fixture_creds(&fixture, "at-old", "rt-good", 30)).unwrap();
        runtime().block_on(async {
            let client = authorized_client(dir.path(), "srv", &fixture.url(), &http(), reqwest::Client::new())
                .await
                .unwrap()
                .expect("an authorized client");
            assert_eq!(client.get_access_token().await.unwrap(), "refreshed-access-1");
            assert_eq!(live_refreshers(dir.path(), "srv"), 1, "the refreshed connection is kept fresh");
        });
        assert!(load(dir.path(), "srv").unwrap().has_refresh_token(), "the refresh token is stored with it");
        let refreshes = fixture.entries("/token");
        assert_eq!(refreshes.len(), 1, "{refreshes:?}");
        assert_eq!(refreshes[0]["refresh_token"], "rt-good");
        assert_eq!(refreshes[0]["outcome"], "issued");
        let stored = load(dir.path(), "srv").unwrap();
        assert_eq!(stored.tokens.access_token().secret(), "refreshed-access-1");
        assert!(stored.expires_at.unwrap() >= now_secs() + 3500);
    }

    /// AH-134: a live connection's token is refreshed ahead of its expiry, more
    /// than once, and the refresher ends when the connection is dropped.
    #[test]
    fn a_live_connection_is_refreshed_ahead_of_expiry_and_the_refresher_ends_with_it() {
        let dir = isolated();
        // Every token lives 62s, so each is due two seconds after it is issued.
        let fixture = OauthFixture::start(&["--accept", "rt-good", "--expires-in", "62"]);
        save(dir.path(), "srv", &fixture_creds(&fixture, "at-first", "rt-good", 62)).unwrap();
        let rt = runtime();
        rt.block_on(async {
            let client = authorized_client(dir.path(), "srv", &fixture.url(), &http(), reqwest::Client::new())
                .await
                .unwrap()
                .expect("an authorized client");
            assert_eq!(client.get_access_token().await.unwrap(), "at-first", "not yet due at connect");
            assert_eq!(live_refreshers(dir.path(), "srv"), 1);
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while fixture.entries("/token").len() < 2 {
                assert!(std::time::Instant::now() < deadline, "no second refresh ahead of expiry");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let token = client.get_access_token().await.unwrap();
            assert!(token.starts_with("refreshed-access-"), "{token}");
            assert!(load(dir.path(), "srv").unwrap().tokens.access_token().secret().starts_with("refreshed-access-"));

            drop(client);
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while live_refreshers(dir.path(), "srv") > 0 {
                assert!(std::time::Instant::now() < deadline, "the refresher outlived its connection");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let after = fixture.entries("/token").len();
            tokio::time::sleep(Duration::from_secs(3)).await;
            assert_eq!(fixture.entries("/token").len(), after, "a refresh after the connection was dropped");
        });
    }

    /// AH-134: a provider that does not resend the refresh token on refresh
    /// (RFC 6749 section 6) keeps the one it issued: it is stored, and the live
    /// connection can refresh again with it.
    #[test]
    fn a_refresh_that_omits_the_refresh_token_keeps_the_previous_one() {
        let dir = isolated();
        let fixture = OauthFixture::start(&["--accept", "rt-kept", "--expires-in", "62", "--omit-refresh"]);
        save(dir.path(), "srv", &fixture_creds(&fixture, "at-old", "rt-kept", 30)).unwrap();
        runtime().block_on(async {
            let client = authorized_client(dir.path(), "srv", &fixture.url(), &http(), reqwest::Client::new())
                .await
                .unwrap()
                .expect("an authorized client");
            let stored = load(dir.path(), "srv").unwrap();
            assert_eq!(stored.tokens.access_token().secret(), "refreshed-access-1");
            assert_eq!(stored.tokens.refresh_token().map(|t| t.secret().as_str()), Some("rt-kept"));
            // The refresher refreshes again through the live connection, which
            // is only possible if the carried token reached it.
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while fixture.entries("/token").iter().filter(|e| e["outcome"] == "issued").count() < 3 {
                assert!(std::time::Instant::now() < deadline, "the connection could not refresh again: {:?}", fixture.entries("/token"));
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            assert!(fixture.entries("/token").iter().all(|e| e["refresh_token"] == "rt-kept"));
            drop(client);
        });
    }

    #[test]
    fn keeping_the_refresh_token_only_fills_a_gap() {
        let with = tokens(Some(60), true);
        let (kept, carried) = keep_refresh_token(tokens(Some(60), false), &with);
        assert!(carried && kept.refresh_token().is_some());
        let mut newer = tokens(Some(60), false);
        newer.set_refresh_token(Some(RefreshToken::new("rt-2".to_string())));
        let (kept, carried) = keep_refresh_token(newer, &with);
        assert!(!carried);
        assert_eq!(kept.refresh_token().unwrap().secret(), "rt-2", "a new refresh token wins");
        let (kept, carried) = keep_refresh_token(tokens(Some(60), false), &tokens(Some(60), false));
        assert!(!carried && kept.refresh_token().is_none());
    }

    /// AH-134 refusal: a refresh the provider refuses is a typed
    /// authentication error, and the stored tokens are left as they were.
    #[test]
    fn a_refused_refresh_is_a_typed_error_and_keeps_the_stored_tokens() {
        let dir = isolated();
        let fixture = OauthFixture::start(&["--accept", "a-different-token"]);
        save(dir.path(), "srv", &fixture_creds(&fixture, "at-old", "rt-revoked", 10)).unwrap();
        let err = runtime()
            .block_on(authorized_client(dir.path(), "srv", &fixture.url(), &http(), reqwest::Client::new()))
            .err()
            .expect("a refused refresh is an error");
        assert_eq!(err.kind(), ErrorKind::Authentication);
        assert!(err.message().contains("re-authenticate"), "{err}");
        assert_eq!(fixture.entries("/token")[0]["outcome"], "refused");
        assert_eq!(load(dir.path(), "srv").unwrap().tokens.access_token().secret(), "at-old");
        assert_eq!(live_refreshers(dir.path(), "srv"), 0, "no refresher for a refused connection");
    }

    #[test]
    fn expiry_uses_the_clock_not_the_original_lifetime() {
        // The window rmcp's own check misses: a token whose `expires_in` still
        // reads 3600s but whose absolute deadline has passed.
        let mut c = creds(Some(3600), true, "https://x");
        assert!(!c.is_expired());
        c.expires_at = Some(now_secs());
        assert!(c.is_expired());
        // Inside the refresh skew counts as expired.
        c.expires_at = Some(now_secs() + EXPIRY_SKEW.as_secs() / 2);
        assert!(c.is_expired());
        // A response with no `expires_in` never expires on its own.
        c.expires_at = None;
        assert!(!c.is_expired());
    }

    #[test]
    fn status_reports_each_case() {
        let dir = isolated();
        let http = json!({ "type": "http", "url": "https://x/mcp" });

        assert_eq!(
            status(dir.path(), "s", &json!({ "command": "npx", "args": [] })),
            AuthStatus::NotApplicable
        );
        assert_eq!(status(dir.path(), "s", &http), AuthStatus::Unauthenticated);

        assert_eq!(
            status(
                dir.path(),
                "s",
                &json!({
                    "type": "http",
                    "url": "https://x/mcp",
                    "headers": { "authorization": "Bearer hand-written" }
                })
            ),
            AuthStatus::StaticHeader
        );

        save(dir.path(), "s", &creds(Some(3600), true, "https://x/mcp")).unwrap();
        assert!(matches!(
            status(dir.path(), "s", &http),
            AuthStatus::Authenticated { .. }
        ));

        // Tokens issued for a url the server no longer points at.
        assert_eq!(
            status(
                dir.path(),
                "s",
                &json!({ "type": "http", "url": "https://moved/mcp" })
            ),
            AuthStatus::StaleResource
        );

        save(dir.path(), "s", &creds(Some(0), true, "https://x/mcp")).unwrap();
        assert!(matches!(
            status(dir.path(), "s", &http),
            AuthStatus::Expired {
                renewable: true,
                expires_at: Some(_)
            }
        ));
        save(dir.path(), "s", &creds(Some(0), false, "https://x/mcp")).unwrap();
        assert!(matches!(
            status(dir.path(), "s", &http),
            AuthStatus::Expired {
                renewable: false,
                expires_at: Some(_)
            }
        ));
    }

    #[test]
    fn an_empty_static_header_is_not_a_credential() {
        // A user who cleared the value out of the form still wants OAuth.
        assert!(!has_static_authorization(
            &json!({ "headers": { "Authorization": "  " } })
        ));
        assert!(has_static_authorization(
            &json!({ "headers": { "Authorization": "Bearer t" } })
        ));
    }

    #[test]
    fn a_static_header_short_circuits_the_authorized_client() {
        let dir = isolated();
        save(dir.path(), "s", &creds(Some(3600), true, "https://x/mcp")).unwrap();
        let config = json!({
            "type": "http",
            "url": "https://x/mcp",
            "headers": { "Authorization": "Bearer hand-written" }
        });
        // No network: a static header is answered before discovery is attempted.
        let got = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(authorized_client(
                dir.path(),
                "s",
                "https://x/mcp",
                &config,
                reqwest::Client::new(),
            ));
        assert!(matches!(got, Ok(None)));
    }

    #[test]
    fn a_url_change_refuses_the_stored_token_instead_of_sending_it() {
        let dir = isolated();
        save(dir.path(), "s", &creds(Some(3600), true, "https://old/mcp")).unwrap();
        let config = json!({ "type": "http", "url": "https://new/mcp" });
        let got = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(authorized_client(
                dir.path(),
                "s",
                "https://new/mcp",
                &config,
                reqwest::Client::new(),
            ));
        let err = got.expect_err("stale resource is an error, not a silent skip");
        assert_eq!(err.kind(), ErrorKind::Authentication);
        assert!(err.message().contains("https://old/mcp"), "{err}");
    }

    #[test]
    fn callback_query_parsing() {
        let ok = parse_callback_query("code=abc&state=xyz").unwrap().unwrap();
        assert_eq!(ok.code, "abc");
        assert_eq!(ok.state, "xyz");

        // Percent-encoding is decoded, not passed through.
        let enc = parse_callback_query("code=a%2Bb&state=s%2F1")
            .unwrap()
            .unwrap();
        assert_eq!(enc.code, "a+b");
        assert_eq!(enc.state, "s/1");

        // An unrelated request is not the redirect: keep waiting.
        assert!(parse_callback_query("").is_none());
        assert!(parse_callback_query("favicon=1").is_none());

        // `Callback` deliberately has no `Debug` (it holds an authorization
        // code), so the error cases are matched rather than `unwrap_err`'d.
        let denied = err_of(parse_callback_query(
            "error=access_denied&error_description=nope&state=xyz",
        ));
        assert!(denied.contains("access_denied"), "{denied}");
        assert!(denied.contains("nope"), "{denied}");

        let no_state = err_of(parse_callback_query("code=abc"));
        assert!(no_state.contains("state"), "{no_state}");

        // An unverifiable error must not kill a sign-in that is still in
        // flight: any request can reach the open loopback port.
        assert!(parse_callback_query("error=access_denied").is_none());
    }

    #[test]
    fn the_callback_page_escapes_provider_text() {
        let outcome = parse_callback_query(
            "error=bad&error_description=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&state=s",
        );
        let page = callback_page(&outcome);
        assert!(!page.contains("<img"), "{page}");
        assert!(page.contains("&lt;img"), "{page}");
    }

    /// The redirect is answered and the code extracted over a real socket, so
    /// the keep-alive select in `accept_callback` is exercised rather than
    /// assumed.
    #[test]
    fn the_loopback_listener_answers_the_redirect_and_yields_the_code() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener =
                tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                    .await
                    .unwrap();
            let port = listener.local_addr().unwrap().port();
            let waiter = tokio::spawn(async move { accept_callback(&listener).await });

            let client = reqwest::Client::new();
            // A probe that is not the redirect must not end the wait.
            let probe = client
                .get(format!("http://127.0.0.1:{port}/favicon.ico"))
                .send()
                .await
                .unwrap();
            assert_eq!(probe.status(), 404);

            let hit = client
                .get(format!("http://127.0.0.1:{port}/callback?code=c1&state=s1"))
                .send()
                .await
                .unwrap();
            assert_eq!(hit.status(), 200);
            assert!(hit.text().await.unwrap().contains("Signed in"));

            let got = waiter.await.unwrap().unwrap();
            assert_eq!(got.code, "c1");
            assert_eq!(got.state, "s1");
        });
    }
}
