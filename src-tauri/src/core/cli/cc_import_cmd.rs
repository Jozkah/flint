//! `flint cli import-claude scan | run`: bring Claude Code skills and plugins
//! (from `~/.claude`, and from `.claude` folders one level under a scan root)
//! into Flint's global store, as the Extensions page's import does.
//!
//! An import is a live link: later edits at the source reach Flint on their
//! own. Plugin hooks are not copied; they keep running from the source.

use crate::core::agent::cc_import::{agent_cc_import, agent_cc_scan, CcImportSelection, CcItemKind};

fn print<T: serde::Serialize>(value: &T) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    Ok(())
}

/// `import-claude scan [--root DIR]`
pub async fn scan(root: Option<String>) -> Result<(), String> {
    print(&agent_cc_scan(root).await?)
}

/// `import-claude run [--root DIR] [--name N]... [--all] [--overwrite] [--link-hooks]`
///
/// Imports the named items, or every item found with `--all`.
pub async fn run(root: Option<String>, names: &[String], all: bool, overwrite: bool, link_hooks: bool) -> Result<(), String> {
    if names.is_empty() && !all {
        return Err("name what to import with --name (repeatable), or use --all".to_string());
    }
    let found = agent_cc_scan(root).await?;
    let selected: Vec<CcImportSelection> = found
        .items
        .into_iter()
        .filter(|i| all || names.iter().any(|n| n == &i.name))
        .map(|i| CcImportSelection { kind: i.kind, name: i.name, source_path: i.source_path })
        .collect();
    if selected.is_empty() {
        return Err("nothing matched; run `import-claude scan` to see what is there".to_string());
    }
    let skills = selected.iter().filter(|i| matches!(i.kind, CcItemKind::Skill)).count();
    let result = agent_cc_import(selected.clone(), overwrite, Some(link_hooks)).await?;
    print(&serde_json::json!({
        "skills": skills,
        "plugins": selected.len() - skills,
        "imported": result.imported,
        "skipped": result.skipped,
        "errors": result.errors,
    }))?;
    if result.errors.is_empty() {
        Ok(())
    } else {
        Err(format!("{} item(s) could not be imported", result.errors.len()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_needs_a_selection() {
        assert!(run(None, &[], false, false, false).await.unwrap_err().contains("--name"));
    }
}
