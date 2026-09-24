use crate::provider::{clamp_count, create_provider, FetchedPage, SearchResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("WebSearchError: {message}")]
pub struct WebSearchError {
    pub message: String,
}

impl WebSearchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<String> for WebSearchError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

/// Search the web and return normalized results. `provider` selects the backend
/// (defaults to Exa); `api_key` (keyed backends) and `endpoint` (self-hosted
/// backends) are forwarded to the chosen backend.
#[tauri::command]
pub async fn web_search(
    query: String,
    count: Option<u64>,
    provider: Option<String>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> Result<Vec<SearchResult>, WebSearchError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(WebSearchError::new("web_search 'query' must not be empty."));
    }
    let backend = create_provider(provider.as_deref(), api_key, endpoint)?;
    let results = backend.search(query, clamp_count(count)).await?;
    Ok(results)
}

/// Fetch a web page by URL and return normalized, bounded readable content.
#[tauri::command]
pub async fn web_fetch(
    url: String,
    provider: Option<String>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> Result<FetchedPage, WebSearchError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(WebSearchError::new("web_fetch 'url' must not be empty."));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(WebSearchError::new(format!(
            "web_fetch 'url' must be an http(s) URL, got: {url}"
        )));
    }
    let backend = create_provider(provider.as_deref(), api_key, endpoint)?;
    let page = backend
        .fetch(url)
        .await
        .map_err(|e| WebSearchError::new(augment_code_host_error(url, &e)))?;
    Ok(strip_front_matter(page))
}

/// Drop a leading YAML front matter block (`---` ... `---`) from fetched text.
///
/// Docs sites built from Markdown (learn.microsoft.com among them) can hand a
/// crawler the source file, so the page opened with dozens of metadata lines
/// and no title. The block is removed, and its `title:` fills in a missing
/// title. Content without such a block is returned unchanged.
fn strip_front_matter(mut page: FetchedPage) -> FetchedPage {
    let text = page.content.trim_start();
    let mut lines = text.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return page,
    }
    let mut consumed = text.len() - lines.clone().map(str::len).sum::<usize>();
    let mut title: Option<String> = None;
    let mut closed = false;
    for line in lines {
        consumed += line.len();
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            closed = true;
            break;
        }
        if let Some(v) = trimmed.strip_prefix("title:") {
            let v = v.trim().trim_matches(|c: char| c == '"' || c == '\'');
            if !v.is_empty() && title.is_none() {
                title = Some(v.to_string());
            }
        }
    }
    if !closed {
        return page;
    }
    page.content = text[consumed..].trim_start().to_string();
    let untitled = page.title.trim().is_empty() || page.title.trim() == "(no title)";
    if untitled {
        if let Some(t) = title {
            page.title = t;
        }
    }
    page
}

/// Turn a bare fetch failure on a code-hosting URL into an actionable one.
///
/// `web_fetch` is an anonymous crawler with no GitHub/GitLab credentials, so a
/// **private** repository answers it with a not-found error (Exa surfaces this
/// as `CRAWL_NOT_FOUND`). Retrying, or switching web-search providers, cannot
/// fix that -- the barrier is authentication, not the provider. When the URL
/// points at a known code host, append a note steering the caller to the
/// authenticated local path (`gh`/`git` in the attached workspace) instead of
/// leaving them to loop on the crawl error.
fn augment_code_host_error(url: &str, err: &str) -> String {
    const HOSTS: &[&str] = &[
        "github.com",
        "api.github.com",
        "raw.githubusercontent.com",
        "gitlab.com",
        "bitbucket.org",
    ];
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    // Strip any user-info and port so `user@github.com:443` still matches.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if HOSTS.contains(&host.as_str()) {
        format!(
            "{err}\n\nNote: web_fetch is an anonymous web crawler with no GitHub credentials, so \
             it cannot read a private repository -- a private repo returns a not-found error \
             regardless of which web-search provider is selected. Do not retry web_fetch or \
             switch providers for this. If you have the repository attached as a workspace \
             folder, or the `gh` CLI is available, use the authenticated shell instead: e.g. \
             `gh repo view <owner>/<repo>`, `gh api repos/<owner>/<repo>`, `gh pr view <n>`, or \
             plain `git` in the attached folder."
        )
    } else {
        err.to_string()
    }
}

#[cfg(test)]
mod front_matter_tests {
    use super::*;

    fn page(title: &str, content: &str) -> FetchedPage {
        FetchedPage {
            url: "https://learn.microsoft.com/x".into(),
            title: title.into(),
            content: content.into(),
            truncated: false,
        }
    }

    #[test]
    fn front_matter_is_removed_and_supplies_the_title() {
        let got = strip_front_matter(page(
            "(no title)",
            "---\nlayout: Conceptual\ntitle: \"Get-ChildItem (Microsoft.PowerShell.Management)\"\nadobe-target: true\n---\n\n# Get-ChildItem\nBody",
        ));
        assert_eq!(got.title, "Get-ChildItem (Microsoft.PowerShell.Management)");
        assert_eq!(got.content, "# Get-ChildItem\nBody");
    }

    #[test]
    fn an_existing_title_is_kept() {
        let got = strip_front_matter(page("Real", "---\r\ntitle: Other\r\n---\r\nText"));
        assert_eq!(got.title, "Real");
        assert_eq!(got.content, "Text");
    }

    #[test]
    fn content_without_front_matter_is_unchanged() {
        for c in ["Plain text", "--- not yaml", "---\nnever closed\n"] {
            let got = strip_front_matter(page("", c));
            assert_eq!(got.content, c);
            assert_eq!(got.title, "");
        }
        let rule = strip_front_matter(page("T", "Intro\n---\ntitle: x\n---\n"));
        assert_eq!(rule.content, "Intro\n---\ntitle: x\n---\n");
    }
}

#[cfg(test)]
mod code_host_error_tests {
    use super::*;

    #[test]
    fn github_urls_get_the_authenticated_path_hint() {
        for url in [
            "https://github.com/Jozkah/streamer",
            "https://api.github.com/repos/Jozkah/streamer",
            "http://github.com/o/r/pull/7",
            "https://raw.githubusercontent.com/o/r/main/x",
        ] {
            let msg = augment_code_host_error(url, "Error fetching URL(s): CRAWL_NOT_FOUND");
            assert!(msg.contains("CRAWL_NOT_FOUND"), "keeps original: {msg}");
            assert!(msg.contains("private repository"), "{url}: {msg}");
            assert!(msg.contains("gh "), "{url}: {msg}");
            assert!(msg.contains("Do not retry"), "{url}: {msg}");
        }
    }

    #[test]
    fn non_code_hosts_are_left_unchanged() {
        for url in [
            "https://example.com/page",
            "https://docs.rs/tokio",
            "https://mygithub.com.evil.test/x",
        ] {
            assert_eq!(
                augment_code_host_error(url, "boom"),
                "boom",
                "must not augment {url}"
            );
        }
    }
}
