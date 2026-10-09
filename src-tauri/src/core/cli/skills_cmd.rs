//! `flint cli skills ...`: the skill management the desktop's Extensions page
//! offers, from the terminal: list, read, write, delete, choose which are
//! enabled, and import from Anthropic's public skill hub.
//!
//! Skills live in `<project>/.jan/agent/skills/<name>/SKILL.md`. Only the hub
//! commands touch the network, and only when asked.

use std::path::{Path, PathBuf};

use tauri_plugin_agent_tools::{skills, workspace};

use crate::core::agent::project::{agent_toml_path, ensure_project, load_agent_config, set_skills_enabled_in_agent_toml};
use crate::core::agent::skill_hub;

fn root(project: &str) -> PathBuf {
    PathBuf::from(project)
}

fn store(project: &str) -> PathBuf {
    workspace::project_store(&root(project))
}

/// `skills list [--project P] [--json]`
pub fn list(project: &str, json: bool) -> Result<(), String> {
    let metas = skills::list_meta(&store(project));
    let enabled = load_agent_config(&root(project)).map(|c| c.skills.enabled).unwrap_or_default();
    if json {
        let rows: Vec<_> = metas
            .iter()
            .map(|m| {
                serde_json::json!({
                    "name": m.name,
                    "description": m.description,
                    "plugin": m.plugin,
                    "userInvocable": m.user_invocable,
                    "modelInvocable": m.model_invocable,
                    "version": m.version,
                    "enabled": enabled.is_empty() || enabled.contains(&m.name),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if metas.is_empty() {
        println!("No skills in this project. Add one with `skills write`, or import from the hub.");
        return Ok(());
    }
    for m in metas {
        let on = enabled.is_empty() || enabled.contains(&m.name);
        println!("{:<28} {}  {}", m.name, if on { "on " } else { "off" }, m.description);
    }
    Ok(())
}

/// `skills show <name>`: the raw SKILL.md.
pub fn show(project: &str, name: &str) -> Result<(), String> {
    print!("{}", skills::read_raw(&store(project), name)?);
    Ok(())
}

/// `skills write <name> (--file F | --stdin)`: create or replace a skill.
pub fn write(project: &str, name: &str, content: &str) -> Result<(), String> {
    ensure_project(&root(project))?;
    skills::write(&store(project), name, content)?;
    println!("Wrote skill {name}.");
    Ok(())
}

/// `skills delete <name>`: idempotent.
pub fn delete(project: &str, name: &str) -> Result<(), String> {
    skills::delete(&store(project), name)?;
    println!("Deleted skill {name}.");
    Ok(())
}

/// `skills enabled [names...] [--all]`: show or set the whitelist. No names
/// with `--all` clears it, which enables every skill.
pub fn enabled(project: &str, names: &[String], all: bool) -> Result<(), String> {
    let r = root(project);
    if all || !names.is_empty() {
        if all && !names.is_empty() {
            return Err("give skill names or --all, not both".to_string());
        }
        ensure_project(&r)?;
        set_skills_enabled_in_agent_toml(&agent_toml_path(&r), names)?;
    }
    let now = load_agent_config(&r).map(|c| c.skills.enabled).unwrap_or_default();
    if now.is_empty() {
        println!("All skills are enabled.");
    } else {
        println!("Enabled: {}", now.join(", "));
    }
    Ok(())
}

/// `skills hub-list`: what Anthropic's public skill hub offers.
pub async fn hub_list(json: bool) -> Result<(), String> {
    let hub = skill_hub::list().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&hub).map_err(|e| e.to_string())?);
    } else {
        for s in hub {
            println!("{:<28} {}", s.name, s.description);
        }
    }
    Ok(())
}

/// `skills hub-import <name>`
pub async fn hub_import(project: &str, name: &str) -> Result<(), String> {
    let r = root(project);
    ensure_project(&r)?;
    skill_hub::import(&r, name).await?;
    println!("Imported {name} into {}.", skills_dir_display(&r));
    Ok(())
}

fn skills_dir_display(project: &Path) -> String {
    skills::skills_dir(&workspace::project_store(project)).display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKILL: &str = "---\nname: Tidy\ndescription: Tidies things\n---\nDo the tidying.\n";

    #[test]
    fn write_list_enable_and_delete_a_skill() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write(&project, "tidy", SKILL).unwrap();
        let metas = skills::list_meta(&store(&project));
        assert!(metas.iter().any(|m| m.name == "tidy"), "{metas:?}");
        assert!(skills::read_raw(&store(&project), "tidy").unwrap().contains("Do the tidying."));

        enabled(&project, &["tidy".to_string()], false).unwrap();
        assert_eq!(load_agent_config(&root(&project)).unwrap().skills.enabled, vec!["tidy".to_string()]);
        assert!(enabled(&project, &["tidy".to_string()], true).is_err());
        enabled(&project, &[], true).unwrap();
        assert!(load_agent_config(&root(&project)).unwrap().skills.enabled.is_empty());

        delete(&project, "tidy").unwrap();
        delete(&project, "tidy").unwrap();
        assert!(skills::list_meta(&store(&project)).iter().all(|m| m.name != "tidy"));
        assert!(write(&project, "../escape", SKILL).is_err());
    }
}
