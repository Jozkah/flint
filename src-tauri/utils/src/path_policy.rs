//! One answer to "is this path a secret store?" for every surface that reads
//! user-supplied paths: renderer file reads, `asset:` grants and RAG parsing.
//!
//! This is a deny-list: it closes the obvious credential and browser-profile
//! locations while leaving arbitrary user-picked files readable (model import
//! needs that). An allow-list model would be stricter but is not built.

use std::path::Path;

/// Single path components that are secret stores wherever they appear
/// (compared lowercase).
const SENSITIVE_COMPONENTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".azure",
    ".mozilla",
    ".docker",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".netrc",
    "provider_secrets",
    "login data",
    "cookies",
    "user data",
];

/// Adjacent component runs that are secret stores (compared lowercase). A lone
/// "gh" or "Credentials" folder elsewhere is not matched.
const SENSITIVE_SEQUENCES: &[&[&str]] = &[
    &[".config", "gh"],
    &[".config", "gcloud"],
    &["appdata", "roaming", "microsoft", "credentials"],
    &["appdata", "roaming", "microsoft", "protect"],
];

/// True when `path` passes through a credential or browser-profile location.
/// Case-insensitive; both `/` and `\` separate components. Callers should
/// canonicalise first so 8.3 names and symlinks cannot hide a component.
pub fn is_sensitive_path(path: &Path) -> bool {
    let text = path.to_string_lossy().to_lowercase();
    let parts: Vec<&str> = text
        .split(['/', '\\'])
        .filter(|p| !p.is_empty())
        .collect();
    if parts
        .iter()
        .any(|n| SENSITIVE_COMPONENTS.contains(n) || n.starts_with("provider_secrets"))
    {
        return true;
    }
    SENSITIVE_SEQUENCES
        .iter()
        .any(|seq| parts.windows(seq.len()).any(|w| w == *seq))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &str) -> bool {
        is_sensitive_path(Path::new(p))
    }

    #[test]
    fn flags_each_store() {
        for p in [
            "/home/u/.ssh/id_rsa",
            "/home/u/.GNUPG/x",
            "/home/u/.aws/credentials",
            "/home/u/.kube/config",
            "/home/u/.azure/a",
            "/home/u/.mozilla/firefox/p",
            "/home/u/.docker/config.json",
            "/home/u/.npmrc",
            "/home/u/.pypirc",
            "/home/u/.git-credentials",
            "/home/u/.netrc",
            "/home/u/.config/gh/hosts.yml",
            "/home/u/.config/gcloud/creds.json",
            r"C:\Users\u\AppData\Roaming\Microsoft\Credentials\X",
            r"C:\Users\u\AppData\Roaming\Microsoft\Protect\S-1",
            "C:/Users/u/AppData/Local/Google/Chrome/User Data/Default/Login Data",
            "/d/Flint/provider_secrets.json",
        ] {
            assert!(s(p), "{p} should be sensitive");
        }
    }

    #[test]
    fn leaves_ordinary_paths_alone() {
        for p in [
            "/home/u/models/a.gguf",
            "/home/u/Documents/Credentials/a.txt",
            "/home/u/.config/other/gh",
            "/home/u/gh/readme.md",
            "/home/u/AppData/Roaming/Flint/x.png",
        ] {
            assert!(!s(p), "{p} should be allowed");
        }
    }
}
