//! Pull requests opened from a run, with descriptions kept in step with the
//! change they describe (AH-162, AH-163).
//!
//! The model writes the words; the harness supplies and checks the facts. A
//! pull request's description is the model's text followed by a section the
//! harness owns, between `<!-- jan:change -->` markers: the commits and files
//! the branch changes against its base and the head commit. Syncing rewrites
//! only that section, so anything a person wrote around it survives.
//!
//! ## What it will not do
//!
//! * Push. A branch must already be on its upstream and in step with it; a
//!   description of commits the remote does not have would describe a change
//!   nobody can review.
//! * Comment, request reviewers, label, merge or notify. None of those calls
//!   exist here.
//! * Send a token anywhere but the configured API. The API is named only by the
//!   user (`JAN_FORGE_API`, or for the CLI `forge_api` in `~/.jan/config.toml`;
//!   a project file cannot name one); it must be https, or http to a loopback address;
//!   redirects are never followed; and a generic `GITHUB_TOKEN`/`GH_TOKEN` is
//!   used only for `https://api.github.com` -- any other API needs
//!   `JAN_FORGE_TOKEN`, so a token issued for GitHub never reaches another host.
//!
//! ## Cancellation
//!
//! Every request races the run's cancellation. A record is written only after
//! the forge has answered, atomically. A create abandoned after the request
//! was sent may still have opened the pull request on the forge, so every
//! create first asks the forge for an open pull request from this branch and
//! adopts it rather than opening a second one.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::harness_error::{scrub, ErrorKind, HarnessError};

pub const API_ENV: &str = "JAN_FORGE_API";
pub const TOKEN_ENV: &str = "JAN_FORGE_TOKEN";
pub const DEFAULT_API: &str = "https://api.github.com";
pub const RECORD_VERSION: u32 = 1;
pub const MAX_TITLE: usize = 200;
pub const MAX_BODY: usize = 60_000;
pub const MAX_COMMITS: usize = 100;
pub const MAX_FILES: usize = 300;
const BEGIN: &str = "<!-- jan:change -->";
const END: &str = "<!-- /jan:change -->";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

fn refuse(kind: ErrorKind, message: impl Into<String>) -> HarnessError {
    HarnessError::new(kind, message.into())
}

// ---- where requests go, and with what --------------------------------------

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Check an API base before any request is made to it.
pub fn check_api(raw: &str) -> Result<reqwest::Url, HarnessError> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|e| refuse(ErrorKind::InvalidInput, format!("the forge API {raw:?} is not a URL: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refuse(ErrorKind::InvalidInput, "the forge API URL carries credentials; name the token separately"));
    }
    if url.query().is_some() || url.fragment().is_some() || url.host().is_none() {
        return Err(refuse(ErrorKind::InvalidInput, format!("the forge API {raw:?} must be a plain base URL")));
    }
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => {
            return Err(refuse(
                ErrorKind::PermissionDenied,
                format!("the forge API {raw:?} is plain http to another host; a token sent there travels in the clear"),
            ))
        }
        other => return Err(refuse(ErrorKind::InvalidInput, format!("the forge API scheme {other:?} is not supported"))),
    }
    Ok(url)
}

/// `forge_api` in `~/.jan/config.toml`. That file is the CLI's; the desktop
/// app reads only `JAN_FORGE_API`.
#[cfg(feature = "cli")]
fn user_setting() -> Option<String> {
    crate::core::agent::global_config::forge_api().ok().flatten()
}

#[cfg(not(feature = "cli"))]
fn user_setting() -> Option<String> {
    None
}

/// The API base, from where only the user decides.
pub fn api_base() -> Result<reqwest::Url, HarnessError> {
    let raw = std::env::var(API_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(user_setting)
        .unwrap_or_else(|| DEFAULT_API.to_string());
    check_api(&raw)
}

/// The token for `api`. A generic GitHub token is only ever used for GitHub's
/// own API.
pub fn token_for(api: &reqwest::Url, env: &dyn Fn(&str) -> Option<String>) -> Result<String, HarnessError> {
    let get = |name: &str| env(name).filter(|v| !v.trim().is_empty()).map(|v| v.trim().to_string());
    if let Some(token) = get(TOKEN_ENV) {
        return Ok(token);
    }
    let is_github = api.scheme() == "https" && api.host_str() == Some("api.github.com");
    if is_github {
        if let Some(token) = get("GITHUB_TOKEN").or_else(|| get("GH_TOKEN")) {
            return Ok(token);
        }
    }
    Err(refuse(
        ErrorKind::Authentication,
        if is_github {
            format!("no token: set {TOKEN_ENV} (or GITHUB_TOKEN) to open a pull request")
        } else {
            format!("no token for {api}: set {TOKEN_ENV}; a GITHUB_TOKEN is never sent to an API other than api.github.com")
        },
    ))
}

// ---- the change, from git --------------------------------------------------

fn git(repo: &Path, args: &[&str]) -> Result<String, HarnessError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| refuse(ErrorKind::ToolUnavailable, format!("git would not run: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(refuse(ErrorKind::ToolFailed, scrub(String::from_utf8_lossy(&out.stderr).trim())))
    }
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

/// `owner/name` from a remote URL: `https://host/owner/name(.git)`,
/// `ssh://git@host/owner/name`, or `git@host:owner/name`.
pub fn repo_slug(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/');
    let remote = remote.strip_suffix(".git").unwrap_or(remote);
    let path = if let Some((_, rest)) = remote.split_once("://") {
        rest.split_once('/')?.1.to_string()
    } else if let Some((host, rest)) = remote.split_once(':') {
        if host.contains('/') || host.len() == 1 {
            return None; // a local path, or a Windows drive letter
        }
        rest.to_string()
    } else {
        return None;
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() != 2 {
        return None;
    }
    let ok = |p: &str| p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (ok(parts[0]) && ok(parts[1])).then(|| format!("{}/{}", parts[0], parts[1]))
}

/// What a branch changes against its base, from the remote's point of view.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub repo: String,
    pub branch: String,
    pub base: String,
    pub head: String,
    pub commits: Vec<(String, String)>,
    pub files: Vec<String>,
    pub truncated: bool,
}

pub fn change(repo: &Path, base: &str) -> Result<Change, HarnessError> {
    use crate::core::agent::vcs::{divergence, Standing};
    let base = base.trim();
    if !plain_name(base) {
        return Err(refuse(ErrorKind::InvalidInput, format!("{base:?} is not a base branch name this will use")));
    }
    let state = divergence(repo).map_err(|e| HarnessError::from(&e))?;
    let branch = state
        .branch
        .clone()
        .ok_or_else(|| refuse(ErrorKind::PolicyViolation, "HEAD is detached; a pull request needs a branch"))?;
    match state.standing {
        Standing::InSync => {}
        Standing::NoUpstream | Standing::Ahead => {
            return Err(refuse(
                ErrorKind::PolicyViolation,
                format!("`{branch}` has commits its remote does not have; push it first -- this never pushes, and a description of unpushed commits describes a change nobody can review"),
            ))
        }
        Standing::Behind | Standing::Diverged => {
            return Err(refuse(
                ErrorKind::PolicyViolation,
                format!("`{branch}` and its remote disagree; bring them into step first"),
            ))
        }
        Standing::Detached => return Err(refuse(ErrorKind::PolicyViolation, "HEAD is detached; a pull request needs a branch")),
    }
    if branch == base {
        return Err(refuse(ErrorKind::InvalidInput, format!("`{branch}` cannot be proposed into itself")));
    }
    let remote = git(repo, &["config", "--get", "remote.origin.url"])
        .map_err(|_| refuse(ErrorKind::NotFound, "this repository has no `origin` remote"))?;
    let slug = repo_slug(&remote)
        .ok_or_else(|| refuse(ErrorKind::InvalidInput, "the `origin` remote does not name an owner/repository on a forge"))?;
    let base_ref = format!("refs/remotes/origin/{base}");
    git(repo, &["rev-parse", "--verify", "--quiet", &base_ref])
        .map_err(|_| refuse(ErrorKind::NotFound, format!("the remote has no branch `{base}`")))?;
    let range = format!("{base_ref}..HEAD");
    let log = git(repo, &["log", "--format=%h%x09%s", &range])?;
    let mut commits: Vec<(String, String)> = log
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(h, s)| (h.to_string(), scrub(s)))
        .collect();
    if commits.is_empty() {
        return Err(refuse(ErrorKind::InvalidInput, format!("`{branch}` has no commits that `{base}` does not; there is nothing to propose")));
    }
    let names = git(repo, &["diff", "--name-only", &format!("{base_ref}...HEAD")])?;
    let mut files: Vec<String> = names.lines().map(|l| l.trim().replace('\\', "/")).filter(|l| !l.is_empty()).collect();
    let truncated = commits.len() > MAX_COMMITS || files.len() > MAX_FILES;
    commits.truncate(MAX_COMMITS);
    files.truncate(MAX_FILES);
    Ok(Change {
        repo: slug,
        branch,
        base: base.to_string(),
        head: git(repo, &["rev-parse", "HEAD"])?,
        commits,
        files,
        truncated,
    })
}

// ---- the description -------------------------------------------------------

/// The section the harness owns.
pub fn section(change: &Change) -> String {
    let mut out = format!("{BEGIN}\n### What this changes\n\n");
    for (id, subject) in &change.commits {
        out.push_str(&format!("- {id} {subject}\n"));
    }
    out.push_str(&format!("\nFiles ({}):\n", change.files.len()));
    for file in &change.files {
        out.push_str(&format!("- `{file}`\n"));
    }
    if change.truncated {
        out.push_str("\n(The list is cut; the branch changes more than is shown.)\n");
    }
    out.push_str(&format!(
        "\nHead: {}. This section is kept in step with the branch by Jan; write outside the markers.\n{END}",
        &change.head[..change.head.len().min(12)]
    ));
    out
}

/// A new description: the model's text, checked, then the section.
pub fn compose(title: &str, body: &str, change: &Change) -> Result<(String, String), HarnessError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.contains('\n') {
        return Err(refuse(ErrorKind::InvalidInput, format!("a pull request needs a one-line title of at most {MAX_TITLE} characters")));
    }
    let body = body.trim();
    if body.contains(BEGIN) || body.contains(END) {
        return Err(refuse(ErrorKind::InvalidInput, "the description cannot contain Jan's change markers; that section is written from the branch"));
    }
    if scrub(title) != title || scrub(body) != body {
        return Err(refuse(ErrorKind::InvalidInput, "the title or description carries something that looks like a credential"));
    }
    // A description that names a file path the change does not touch
    // describes work that is not in it.
    // Split on whitespace and brackets only: splitting on ':' would cut a URL
    // into a scheme and a path-shaped remainder.
    for word in body.split(|c: char| c.is_whitespace() || matches!(c, '`' | '(' | ')' | ',' | ';')) {
        let candidate = word.trim_matches(|c: char| matches!(c, '.' | '*' | '"' | '\'' | ':'));
        let looks_like_path = candidate.contains('/') && candidate.contains('.') && !candidate.contains("://");
        if looks_like_path && !change.files.iter().any(|f| f == candidate) {
            return Err(refuse(
                ErrorKind::InvalidInput,
                format!("the description names {candidate:?}, which this branch does not change"),
            ));
        }
    }
    let full = if body.is_empty() { section(change) } else { format!("{body}\n\n{}", section(change)) };
    if full.len() > MAX_BODY {
        return Err(refuse(ErrorKind::InvalidInput, format!("the description is over {MAX_BODY} bytes")));
    }
    Ok((title.to_string(), full))
}

/// The same description with the section brought up to date. Text outside the
/// markers is kept byte for byte; a description whose markers were removed
/// gets the section appended rather than anything deleted.
pub fn resync(current: &str, change: &Change) -> String {
    let fresh = section(change);
    if let (Some(start), Some(end)) = (current.find(BEGIN), current.find(END)) {
        if start < end {
            return format!("{}{}{}", &current[..start], fresh, &current[end + END.len()..]);
        }
    }
    if current.trim().is_empty() {
        fresh
    } else {
        format!("{}\n\n{}", current.trim_end(), fresh)
    }
}

// ---- the record ------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    /// Scheme, host and port of the API; never a token.
    pub api: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub branch: String,
    pub base: String,
    /// The head the description was last written for.
    pub head: String,
}

pub fn dir_for(data_folder: &Path, project: &Path) -> PathBuf {
    let digest = hex::encode(Sha256::digest(project.to_string_lossy().as_bytes()));
    data_folder.join("pull_requests").join(&digest[..24])
}

fn record_path(data_folder: &Path, project: &Path, branch: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(branch.as_bytes()));
    dir_for(data_folder, project).join(format!("{}.json", &digest[..24]))
}

pub fn save(data_folder: &Path, project: &Path, record: &Record) -> Result<(), HarnessError> {
    let path = record_path(data_folder, project, &record.branch);
    let io = |e: std::io::Error| refuse(ErrorKind::Io, format!("the pull request record could not be written: {e}"));
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(io)?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(record).map_err(|e| refuse(ErrorKind::Internal, e.to_string()))?;
    std::fs::write(&tmp, body).map_err(io)?;
    std::fs::rename(&tmp, &path).map_err(io)
}

pub fn load(data_folder: &Path, project: &Path, branch: &str) -> Result<Option<Record>, HarnessError> {
    let path = record_path(data_folder, project, branch);
    let Ok(raw) = std::fs::read_to_string(&path) else { return Ok(None) };
    let record: Record = serde_json::from_str(&raw)
        .map_err(|e| refuse(ErrorKind::MalformedState, format!("the pull request record cannot be read: {e}")))?;
    if record.version != RECORD_VERSION {
        return Err(refuse(ErrorKind::MalformedState, format!("the pull request record is version {}", record.version)));
    }
    Ok(Some(record))
}

// ---- talking to the forge --------------------------------------------------

fn origin(api: &reqwest::Url) -> String {
    api.origin().ascii_serialization()
}

fn client() -> Result<reqwest::Client, HarnessError> {
    crate::core::net::tls::apply12(reqwest::Client::builder())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| refuse(ErrorKind::Transport, format!("no HTTP client: {e}")))
}

async fn until_stopped(token: Option<tauri_plugin_agent_tools::lifecycle::Token>) {
    match token {
        Some(token) => {
            while !token.is_stopped() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// Send one request, racing the run's cancellation, and read a JSON answer.
async fn call(
    request: reqwest::RequestBuilder,
    token: Option<tauri_plugin_agent_tools::lifecycle::Token>,
) -> Result<serde_json::Value, HarnessError> {
    let response = tokio::select! {
        response = request.send() => response,
        _ = until_stopped(token) => {
            return Err(refuse(ErrorKind::Cancelled, "the run was cancelled while the forge was being asked; nothing was recorded"));
        }
    };
    let response = response.map_err(|e| refuse(ErrorKind::Transport, format!("the forge could not be reached: {}", scrub(&e.to_string()))))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_default();
    let message = scrub(&message);
    match status.as_u16() {
        200..=299 => serde_json::from_str(&text)
            .map_err(|e| refuse(ErrorKind::InvalidResponse, format!("the forge answered with something that is not JSON: {e}"))),
        300..=399 => Err(refuse(
            ErrorKind::PermissionDenied,
            format!("the forge redirected (HTTP {status}); redirects are not followed, so the token was not sent onward"),
        )),
        401 => Err(refuse(ErrorKind::Authentication, format!("the forge refused the token: {message}"))),
        403 => Err(refuse(ErrorKind::PermissionDenied, format!("the forge refused this: {message}"))),
        404 => Err(refuse(ErrorKind::NotFound, format!("the forge has no such repository or pull request: {message}"))),
        422 => Err(refuse(ErrorKind::InvalidInput, format!("the forge would not accept it: {message}"))),
        429 => Err(refuse(ErrorKind::RateLimited, format!("the forge is rate limiting: {message}"))),
        _ => Err(refuse(ErrorKind::Upstream, format!("the forge answered HTTP {status}: {message}"))),
    }
}

fn pull_fields(value: &serde_json::Value) -> Result<(u64, String, String), HarnessError> {
    let number = value.get("number").and_then(|v| v.as_u64());
    let url = value.get("html_url").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let body = value.get("body").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    number
        .map(|n| (n, url, body))
        .ok_or_else(|| refuse(ErrorKind::InvalidResponse, "the forge's answer has no pull request number"))
}

pub struct Forge {
    pub api: reqwest::Url,
    pub token: String,
    pub cancel: Option<tauri_plugin_agent_tools::lifecycle::Token>,
}

impl Forge {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.api.as_str().trim_end_matches('/'), path)
    }

    fn with_auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "jan-agent")
    }

    async fn open_pull_for(&self, change: &Change) -> Result<Option<serde_json::Value>, HarnessError> {
        let owner = change.repo.split('/').next().unwrap_or_default();
        let request = client()?
            .get(self.url(&format!("/repos/{}/pulls", change.repo)))
            .query(&[("head", format!("{owner}:{}", change.branch)), ("state", "open".to_string())]);
        let listed = call(self.with_auth(request), self.cancel.clone()).await?;
        Ok(listed.as_array().and_then(|a| a.first()).cloned())
    }

    /// Open a pull request for the branch -- or adopt the one already open for
    /// it -- and record it.
    pub async fn create(
        &self,
        data_folder: &Path,
        project: &Path,
        change: &Change,
        title: &str,
        body: &str,
    ) -> Result<(Record, &'static str), HarnessError> {
        let (title, full) = compose(title, body, change)?;
        if let Some(existing) = self.open_pull_for(change).await? {
            let (number, url, current) = pull_fields(&existing)?;
            let mut record = Record {
                version: RECORD_VERSION,
                api: origin(&self.api),
                repo: change.repo.clone(),
                number,
                url,
                branch: change.branch.clone(),
                base: change.base.clone(),
                head: String::new(),
            };
            let fresh = resync(&current, change);
            if fresh != current {
                let request = client()?
                    .patch(self.url(&format!("/repos/{}/pulls/{number}", change.repo)))
                    .json(&serde_json::json!({ "body": fresh }));
                call(self.with_auth(request), self.cancel.clone()).await?;
            }
            record.head = change.head.clone();
            save(data_folder, project, &record)?;
            return Ok((record, "adopted"));
        }
        let request = client()?.post(self.url(&format!("/repos/{}/pulls", change.repo))).json(&serde_json::json!({
            "title": title,
            "body": full,
            "head": change.branch,
            "base": change.base,
        }));
        let created = call(self.with_auth(request), self.cancel.clone()).await?;
        let (number, url, _) = pull_fields(&created)?;
        let record = Record {
            version: RECORD_VERSION,
            api: origin(&self.api),
            repo: change.repo.clone(),
            number,
            url,
            branch: change.branch.clone(),
            base: change.base.clone(),
            head: change.head.clone(),
        };
        save(data_folder, project, &record)?;
        Ok((record, "opened"))
    }

    /// Bring a recorded pull request's description into step with the branch.
    /// Returns whether it had to change.
    pub async fn sync(
        &self,
        data_folder: &Path,
        project: &Path,
        record: &Record,
        change: &Change,
    ) -> Result<bool, HarnessError> {
        if record.api != origin(&self.api) {
            return Err(refuse(
                ErrorKind::PermissionDenied,
                format!("this pull request was opened through {}, not {}; the token for one is not sent to the other", record.api, origin(&self.api)),
            ));
        }
        if record.repo != change.repo {
            return Err(refuse(ErrorKind::PolicyViolation, "the `origin` remote no longer names the repository this pull request is in"));
        }
        let request = client()?.get(self.url(&format!("/repos/{}/pulls/{}", record.repo, record.number)));
        let current = call(self.with_auth(request), self.cancel.clone()).await?;
        let (_, _, body) = pull_fields(&current)?;
        let fresh = resync(&body, change);
        let changed = fresh != body;
        if changed {
            let request = client()?
                .patch(self.url(&format!("/repos/{}/pulls/{}", record.repo, record.number)))
                .json(&serde_json::json!({ "body": fresh }));
            call(self.with_auth(request), self.cancel.clone()).await?;
        }
        let mut updated = record.clone();
        updated.head = change.head.clone();
        save(data_folder, project, &updated)?;
        Ok(changed)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn git_ok(repo: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(repo).args(args).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn change_of(files: &[&str]) -> Change {
        Change {
            repo: "acme/widgets".into(),
            branch: "retry-limit".into(),
            base: "main".into(),
            head: "0123456789abcdef0123456789abcdef01234567".into(),
            commits: vec![("0123456".into(), "Bound retries".into())],
            files: files.iter().map(|f| f.to_string()).collect(),
            truncated: false,
        }
    }

    #[test]
    fn only_a_user_named_https_or_loopback_api_is_accepted() {
        assert!(check_api("https://api.github.com").is_ok());
        assert!(check_api("https://git.example.com/api/v3").is_ok());
        assert!(check_api("http://127.0.0.1:8123").is_ok());
        assert!(check_api("http://localhost:8123").is_ok());
        assert!(check_api("http://[::1]:8123").is_ok());
        assert_eq!(check_api("http://forge.example.com").unwrap_err().kind(), ErrorKind::PermissionDenied, "plain http elsewhere");
        assert_eq!(check_api("http://127.0.0.1.example.com").unwrap_err().kind(), ErrorKind::PermissionDenied, "a name that only starts like loopback");
        assert_eq!(check_api("https://user:pw@api.github.com").unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(check_api("https://api.github.com/?x=1").unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(check_api("file:///etc/passwd").unwrap_err().kind(), ErrorKind::InvalidInput);
        assert_eq!(check_api("not a url").unwrap_err().kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn a_github_token_is_never_sent_to_another_api() {
        let github = check_api("https://api.github.com").unwrap();
        let other = check_api("https://git.example.com/api/v3").unwrap();
        let only_github_token = |name: &str| (name == "GITHUB_TOKEN").then(|| "ghp_x".to_string());
        assert_eq!(token_for(&github, &only_github_token).unwrap(), "ghp_x");
        let refused = token_for(&other, &only_github_token).unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::Authentication);
        assert!(refused.message().contains("never sent"), "{}", refused.message());
        let both = |name: &str| match name {
            TOKEN_ENV => Some("jan".to_string()),
            "GITHUB_TOKEN" => Some("ghp_x".to_string()),
            _ => None,
        };
        assert_eq!(token_for(&other, &both).unwrap(), "jan");
        assert_eq!(token_for(&github, &|_| None).unwrap_err().kind(), ErrorKind::Authentication);
    }

    #[test]
    fn a_remote_names_its_repository_and_a_local_path_does_not() {
        assert_eq!(repo_slug("https://github.com/acme/widgets.git").as_deref(), Some("acme/widgets"));
        assert_eq!(repo_slug("git@github.com:acme/widgets.git").as_deref(), Some("acme/widgets"));
        assert_eq!(repo_slug("ssh://git@github.com/acme/widgets").as_deref(), Some("acme/widgets"));
        assert_eq!(repo_slug("C:/repos/widgets.git"), None);
        assert_eq!(repo_slug("/srv/git/widgets.git"), None);
        assert_eq!(repo_slug("https://github.com/acme/../widgets"), None);
        assert_eq!(repo_slug("https://github.com/a/b/c"), None);
    }

    #[test]
    fn a_description_is_checked_and_its_section_is_the_only_part_rewritten() {
        let change = change_of(&["src/app.py"]);
        let (title, body) = compose("Bound retries", "Caps retries in src/app.py.", &change).unwrap();
        assert_eq!(title, "Bound retries");
        assert!(body.starts_with("Caps retries in src/app.py.\n\n<!-- jan:change -->"), "{body}");
        let kind = |title: &str, body: &str| compose(title, body, &change).unwrap_err().kind();
        assert_eq!(kind("", "x"), ErrorKind::InvalidInput, "no title");
        assert_eq!(kind("a\nb", "x"), ErrorKind::InvalidInput, "a two-line title");
        assert_eq!(kind("t", "also touches src/other.py"), ErrorKind::InvalidInput, "a file the branch does not change");
        assert_eq!(kind("t", "<!-- jan:change --> forged <!-- /jan:change -->"), ErrorKind::InvalidInput, "forged markers");
        assert_eq!(kind("t", &"x".repeat(MAX_BODY + 1)), ErrorKind::InvalidInput, "too long");
        assert_eq!(kind("t", "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), ErrorKind::InvalidInput, "a credential");
        assert!(compose("t", "see https://example.com/docs/page.html", &change).is_ok(), "a URL is not a file path");
        assert!(compose("t", "Changed: src/app.py.", &change).is_ok(), "punctuation around a real path");
        assert_eq!(kind("t", "Also: src/other.py"), ErrorKind::InvalidInput, "a colon before a wrong path");

        // A person's edit around the section survives a sync.
        let edited = format!("{body}\n\nReviewer: check the rollout.");
        let mut later = change.clone();
        later.commits.push(("89abcde".into(), "Back off".into()));
        later.head = "fedcba9876543210fedcba9876543210fedcba98".into();
        let synced = resync(&edited, &later);
        assert!(synced.starts_with("Caps retries in src/app.py.\n\n<!-- jan:change -->"));
        assert!(synced.contains("89abcde Back off") && synced.contains("Head: fedcba987654"));
        assert!(synced.ends_with("\n\nReviewer: check the rollout."), "{synced}");
        assert_eq!(resync(&synced, &later), synced, "a second sync changes nothing");
        // Markers a person deleted: the section is appended, nothing removed.
        assert_eq!(resync("Only prose.", &later), format!("Only prose.\n\n{}", section(&later)));
    }

    #[test]
    fn only_a_pushed_branch_in_step_with_its_remote_is_described() {
        let base = std::env::temp_dir().join(format!("jan-pr-change-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        git_ok(&origin, &["init", "--bare", "-q", "-b", "main"]);
        git_ok(&work, &["init", "-q", "-b", "main"]);
        git_ok(&work, &["config", "user.email", "t@example.invalid"]);
        git_ok(&work, &["config", "user.name", "Test"]);
        std::fs::write(work.join("a.txt"), "a\n").unwrap();
        git_ok(&work, &["add", "-A"]);
        git_ok(&work, &["commit", "-qm", "first"]);
        git_ok(&work, &["remote", "add", "origin", "https://forge.invalid/acme/widgets.git"]);
        git_ok(&work, &["remote", "set-url", "--push", "origin", &origin.to_string_lossy()]);
        git_ok(&work, &["push", "-q", "-u", "origin", "main"]);
        git_ok(&work, &["switch", "-q", "-c", "topic"]);
        std::fs::create_dir_all(work.join("src")).unwrap();
        std::fs::write(work.join("src/b.txt"), "b\n").unwrap();
        git_ok(&work, &["add", "-A"]);
        git_ok(&work, &["commit", "-qm", "Add b"]);

        let kind = |base: &str| change(&work, base).unwrap_err().kind();
        assert_eq!(kind("main"), ErrorKind::PolicyViolation, "not pushed");
        git_ok(&work, &["push", "-q", "-u", "origin", "topic"]);
        let described = change(&work, "main").unwrap();
        assert_eq!(described.repo, "acme/widgets");
        assert_eq!(described.branch, "topic");
        assert_eq!(described.commits.len(), 1);
        assert_eq!(described.files, vec!["src/b.txt".to_string()]);
        assert_eq!(kind("release"), ErrorKind::NotFound, "a base the remote lacks");
        assert_eq!(kind("--upload-pack=x"), ErrorKind::InvalidInput, "an option as a base");
        assert_eq!(kind("topic"), ErrorKind::InvalidInput, "into itself");
        git_ok(&work, &["switch", "-q", "main"]);
        git_ok(&work, &["switch", "-q", "-c", "empty"]);
        git_ok(&work, &["push", "-q", "-u", "origin", "empty"]);
        assert_eq!(kind("main"), ErrorKind::InvalidInput, "nothing to propose");
        git_ok(&work, &["remote", "set-url", "origin", &origin.to_string_lossy()]);
        assert_eq!(kind("main"), ErrorKind::InvalidInput, "a remote that names no forge repository");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_record_holds_no_token_and_is_kept_per_project_and_branch() {
        let data = std::env::temp_dir().join(format!("jan-pr-record-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let project = Path::new("C:/projects/widgets");
        let record = Record {
            version: RECORD_VERSION,
            api: "http://127.0.0.1:8123".into(),
            repo: "acme/widgets".into(),
            number: 7,
            url: "http://127.0.0.1:8123/acme/widgets/pull/7".into(),
            branch: "topic".into(),
            base: "main".into(),
            head: "abc".into(),
        };
        save(&data, project, &record).unwrap();
        assert_eq!(load(&data, project, "topic").unwrap(), Some(record.clone()));
        assert_eq!(load(&data, project, "other").unwrap(), None);
        assert_eq!(load(&data, Path::new("C:/projects/else"), "topic").unwrap(), None);
        let raw = std::fs::read_to_string(dir_for(&data, project).read_dir().unwrap().next().unwrap().unwrap().path()).unwrap();
        assert!(!raw.to_lowercase().contains("token"), "{raw}");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A create abandoned while the forge is still answering records nothing,
    /// and the stalled request does not outlive the cancellation.
    #[tokio::test]
    async fn a_cancelled_request_records_nothing() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            // Accept and never answer.
            let mut held = Vec::new();
            for stream in listener.incoming().take(4) {
                held.push(stream);
            }
            std::thread::sleep(Duration::from_secs(30));
        });
        let data = std::env::temp_dir().join(format!("jan-pr-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let token = tauri_plugin_agent_tools::lifecycle::Token::detached();
        let forge = Forge {
            api: check_api(&format!("http://127.0.0.1:{port}")).unwrap(),
            token: "t".into(),
            cancel: Some(token.clone()),
        };
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.stop(tauri_plugin_agent_tools::lifecycle::StopReason::Cancelled);
        });
        let started = std::time::Instant::now();
        let project = Path::new("C:/projects/widgets");
        let result = forge.create(&data, project, &change_of(&["src/app.py"]), "t", "b").await;
        assert_eq!(result.unwrap_err().kind(), ErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5), "cancellation waited for the forge");
        assert!(!dir_for(&data, project).exists(), "a cancelled create wrote a record");
        let _ = std::fs::remove_dir_all(&data);
    }
}
