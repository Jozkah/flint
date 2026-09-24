//! Import skills from Anthropic's public skill hub (github.com/anthropics/skills).
//! Skills live at `skills/<name>/SKILL.md` with optional bundled files; import
//! copies the whole folder into the project's `.jan/agent/skills/<name>/`.
//!
//! All network I/O goes through the backend (no CORS/CSP limits) using the git
//! tree API (1 request to enumerate paths) plus raw.githubusercontent.com for
//! file contents (not subject to the API's 60/hr unauthenticated limit).

use std::path::Path;

use futures::future::join_all;

use tauri_plugin_agent_tools::{skills, workspace};

const TREE_URL: &str = "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1";
const RAW_BASE: &str = "https://raw.githubusercontent.com/anthropics/skills/main/";
const SKILLS_PREFIX: &str = "skills/";
const USER_AGENT: &str = "jan-agent-skill-import";

/// A skill available on the hub: folder name + its frontmatter description.
#[derive(serde::Serialize)]
pub struct HubSkill {
    pub name: String,
    pub description: String,
}

fn client() -> Result<reqwest::Client, String> {
    crate::core::net::tls::apply12(reqwest::Client::builder().user_agent(USER_AGENT))
        .build()
        .map_err(|e| format!("ERROR: {e}"))
}

/// All blob paths in the repo, via the recursive git tree API (one request).
async fn tree_paths(client: &reqwest::Client) -> Result<Vec<String>, String> {
    let resp = client
        .get(TREE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("ERROR: fetching skill hub index: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ERROR: skill hub index returned {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("ERROR: parsing skill hub index: {e}"))?;
    let tree = json
        .get("tree")
        .and_then(|t| t.as_array())
        .ok_or("ERROR: unexpected skill hub index shape")?;
    Ok(tree
        .iter()
        .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("blob"))
        .filter_map(|e| e.get("path").and_then(|p| p.as_str()).map(String::from))
        .collect())
}

/// The skill folder name for a `skills/<name>/SKILL.md` path, else None.
fn skill_name_of(path: &str) -> Option<&str> {
    path.strip_prefix(SKILLS_PREFIX)?
        .strip_suffix("/SKILL.md")
        .filter(|n| !n.is_empty() && !n.contains('/'))
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("ERROR: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ERROR: {} returned {}", url, resp.status()));
    }
    resp.text().await.map_err(|e| format!("ERROR: {e}"))
}

/// List the skills available on the hub with their descriptions. Descriptions
/// are read from each skill's SKILL.md frontmatter (fetched concurrently).
pub async fn list() -> Result<Vec<HubSkill>, String> {
    let client = client()?;
    let paths = tree_paths(&client).await?;
    let names: Vec<String> = paths
        .iter()
        .filter_map(|p| skill_name_of(p).map(String::from))
        .collect();

    let fetches = names.into_iter().map(|name| {
        let client = client.clone();
        async move {
            let url = format!("{RAW_BASE}{SKILLS_PREFIX}{name}/SKILL.md");
            let description = match fetch_text(&client, &url).await {
                Ok(raw) => skills::parse(&raw).description.unwrap_or_default(),
                Err(_) => String::new(),
            };
            HubSkill { name, description }
        }
    });
    let mut out = join_all(fetches).await;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Download one hub skill (SKILL.md + every bundled file) into the project's
/// `.jan/agent/skills/<name>/`, replacing any existing skill of the same name.
///
/// Atomic on failure: every file is fetched into memory first, then written to
/// a staging directory that is swapped into place only once complete (see
/// [`install_fetched`]). A download or write error leaves the existing skill
/// untouched, and re-import never leaves stale files from a prior version
/// behind.
pub async fn import(root: &Path, name: &str) -> Result<(), String> {
    // Reuse the shared workspace name guard (rejects separators, `..`, `.`, empty).
    let stem = skills::safe_stem(name)?;
    let client = client()?;
    let prefix = format!("{SKILLS_PREFIX}{stem}/");
    let files: Vec<String> = tree_paths(&client)
        .await?
        .into_iter()
        .filter(|p| p.starts_with(&prefix) && !p.ends_with('/'))
        .collect();
    if files.is_empty() {
        return Err(format!("ERROR: skill '{name}' not found on the hub"));
    }

    // Phase 1: fetch every file into memory (relative path + bytes). No writes yet.
    let downloads = files.into_iter().map(|path| {
        let client = client.clone();
        let prefix = prefix.clone();
        async move {
            // Path came from GitHub and is prefix-checked; guard components anyway.
            let rel = path.strip_prefix(&prefix).unwrap_or(&path).to_string();
            if rel.split('/').any(|seg| seg == "..") {
                return Err(format!("ERROR: unsafe path '{path}'"));
            }
            let resp = client
                .get(format!("{RAW_BASE}{path}"))
                .send()
                .await
                .map_err(|e| format!("ERROR: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("ERROR: downloading {path}: {}", resp.status()));
            }
            let bytes = resp.bytes().await.map_err(|e| format!("ERROR: {e}"))?;
            Ok::<_, String>((rel, bytes))
        }
    });
    let mut fetched = Vec::new();
    for result in join_all(downloads).await {
        fetched.push(result?);
    }

    // Phase 2: replace the destination with the freshly fetched files.
    let skills_dir = skills::skills_dir(&workspace::project_store(root));
    let fetched: Vec<(String, Vec<u8>)> = fetched
        .into_iter()
        .map(|(rel, bytes)| (rel, bytes.to_vec()))
        .collect();
    tokio::task::spawn_blocking(move || install_fetched(&skills_dir, &stem, &fetched))
        .await
        .map_err(|e| format!("ERROR: {e}"))?
}

/// Replace `<skills_dir>/<stem>/` with `files` so that a failure at any point
/// leaves the previous skill in place (Jozkah/jan#40).
///
/// The new version is written into a staging directory beside `skills_dir`
/// (not inside it, so the skill scanner never lists a half-written copy). Only
/// once every file is on disk is the old directory moved aside, the staging
/// directory renamed into place, and the old copy removed. If the swap fails,
/// the old directory is moved back.
fn install_fetched(
    skills_dir: &Path,
    stem: &str,
    files: &[(String, Vec<u8>)],
) -> Result<(), String> {
    let err = |e: std::io::Error| format!("ERROR: {e}");
    std::fs::create_dir_all(skills_dir).map_err(err)?;
    let holding = skills_dir.parent().unwrap_or(skills_dir);
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let staging = holding.join(format!(".skill-import-{stem}-{nonce}"));
    let backup = holding.join(format!(".skill-replaced-{stem}-{nonce}"));
    let dest_root = skills_dir.join(stem);
    let flat = skills_dir.join(format!("{stem}.md"));

    let write_all = || -> std::io::Result<()> {
        for (rel, bytes) in files {
            let target = staging.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, bytes)?;
        }
        Ok(())
    };
    std::fs::create_dir_all(&staging).map_err(err)?;
    if let Err(e) = write_all() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err(e));
    }

    let had_old = dest_root.exists();
    if had_old {
        if let Err(e) = std::fs::rename(&dest_root, &backup) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(err(e));
        }
    }
    if let Err(e) = std::fs::rename(&staging, &dest_root) {
        if had_old {
            let _ = std::fs::rename(&backup, &dest_root);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err(e));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&backup);
    }
    let _ = std::fs::remove_file(&flat); // drop a legacy flat form, if any
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "skill-hub-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Jozkah/jan#40: a write failure partway through the new files must
    /// leave the previously installed skill exactly as it was.
    #[test]
    fn a_failed_write_keeps_the_existing_skill() {
        let store = scratch("fail");
        let skills_dir = store.join("skills");
        let old = skills_dir.join("pdf");
        std::fs::create_dir_all(old.join("scripts")).unwrap();
        std::fs::write(old.join("SKILL.md"), b"old skill").unwrap();
        std::fs::write(old.join("scripts/foo.py"), b"print(1)").unwrap();

        // The second file cannot be written: its parent path runs through a
        // regular file, so create_dir_all fails after SKILL.md was written.
        let files = vec![
            ("SKILL.md".to_string(), b"new skill".to_vec()),
            ("SKILL.md/nested.txt".to_string(), b"x".to_vec()),
        ];
        assert!(install_fetched(&skills_dir, "pdf", &files).is_err());

        assert_eq!(std::fs::read(old.join("SKILL.md")).unwrap(), b"old skill");
        assert_eq!(std::fs::read(old.join("scripts/foo.py")).unwrap(), b"print(1)");
        let leftovers: Vec<_> = std::fs::read_dir(&store)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".skill-"))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn a_successful_install_replaces_without_stale_files() {
        let store = scratch("ok");
        let skills_dir = store.join("skills");
        let old = skills_dir.join("pdf");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("SKILL.md"), b"old").unwrap();
        std::fs::write(old.join("stale.txt"), b"stale").unwrap();
        std::fs::write(skills_dir.join("pdf.md"), b"legacy").unwrap();

        let files = vec![("SKILL.md".to_string(), b"new".to_vec())];
        install_fetched(&skills_dir, "pdf", &files).unwrap();

        assert_eq!(std::fs::read(old.join("SKILL.md")).unwrap(), b"new");
        assert!(!old.join("stale.txt").exists());
        assert!(!skills_dir.join("pdf.md").exists());
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn skill_name_extracted_from_skill_md_path() {
        assert_eq!(skill_name_of("skills/pdf/SKILL.md"), Some("pdf"));
        assert_eq!(skill_name_of("skills/pdf/scripts/x.py"), None);
        assert_eq!(skill_name_of("skills/pdf/reference.md"), None);
        assert_eq!(skill_name_of("README.md"), None);
        assert_eq!(skill_name_of("skills/a/b/SKILL.md"), None);
    }
}
