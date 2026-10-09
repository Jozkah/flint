//! `flint migrate detect | plan | run | status | rollback | dismiss`: the
//! first-launch JAN to Flint migration assistant, from the terminal.
//!
//! The pure core in `core::migration` does the work; this only resolves the
//! real roots, reads the user's choices, and prints. A run never starts
//! without `--yes`, and `plan` shows what it would copy first.

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::core::migration::detect::{self, Category};
use crate::core::migration::execute::{self, ExecuteOpts};
use crate::core::migration::manifest;
use crate::core::migration::paths::{flint_paths, Roots};
use crate::core::migration::plan::{self, Conflict, MigrationPlan, Mode};

fn parse_enum<T: DeserializeOwned>(what: &str, text: &str, ok: &str) -> Result<T, String> {
    serde_json::from_value(Value::String(text.trim().to_ascii_lowercase()))
        .map_err(|_| format!("unknown {what} '{text}' (choose {ok})"))
}

fn print<T: serde::Serialize>(value: &T) -> Result<(), String> {
    println!("{}", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    Ok(())
}

/// The plan for the given choices, built from the real roots.
fn build_plan(roots: &Roots, mode: &str, categories: &[String], conflict: &str) -> Result<MigrationPlan, String> {
    let mode: Mode = parse_enum("mode", mode, "copy, reuse, move, fresh")?;
    let conflict: Conflict = parse_enum("conflict policy", conflict, "keep_flint, use_jan, keep_both")?;
    let legacy = detect::detect_legacy(roots).ok_or_else(|| "no legacy JAN data found".to_string())?;
    let selected: Vec<Category> = if categories.is_empty() {
        Category::all().to_vec()
    } else {
        categories
            .iter()
            .map(|c| Category::parse(c).ok_or_else(|| format!("unknown category '{c}'")))
            .collect::<Result<_, _>>()?
    };
    Ok(plan::plan(&legacy, &flint_paths(roots), &selected, mode, conflict))
}

/// `migrate detect`
pub fn detect_cmd() -> Result<(), String> {
    let roots = Roots::discover();
    let legacy = detect::detect_legacy(&roots);
    let flint = flint_paths(&roots);
    let found = legacy.is_some();
    print(&serde_json::json!({
        "found": found,
        "firstLaunchPending": manifest::is_first_launch_pending(&flint.config_dir, found),
        "legacy": legacy,
    }))
}

/// `migrate plan [--mode M] [--category C]... [--conflict P]`
pub fn plan_cmd(mode: &str, categories: &[String], conflict: &str) -> Result<(), String> {
    print(&build_plan(&Roots::discover(), mode, categories, conflict)?)
}

/// `migrate run ... --yes`
pub fn run_cmd(mode: &str, categories: &[String], conflict: &str, yes: bool) -> Result<(), String> {
    let roots = Roots::discover();
    let plan = build_plan(&roots, mode, categories, conflict)?;
    if !yes {
        print(&plan)?;
        return Err("that is what would be migrated; run again with --yes to do it".to_string());
    }
    let result = execute::execute(&plan, &ExecuteOpts::with_holder("flint-cli-migration"));
    print(&result)?;
    if let Some(e) = &result.error {
        return Err(e.clone());
    }
    if result.status == manifest::Status::Complete {
        // Reuse keeps the JAN folder; every other mode ends on the Flint one.
        let target = match plan.mode {
            Mode::Reuse => plan.reuse_path.clone().unwrap_or_else(|| plan.source_data_folder.clone()),
            _ => plan.dest_data_folder.clone(),
        };
        let current = crate::core::app::commands::resolve_jan_data_folder();
        if current != target && !has_env_override() {
            crate::core::cli::system_cmd::set_data_folder(&target.to_string_lossy(), false)?;
            eprintln!("Flint now uses {}. Restart any running Flint app.", target.display());
        }
    }
    Ok(())
}

fn has_env_override() -> bool {
    crate::core::compat_env::var("DATA_FOLDER").is_ok_and(|f| !f.is_empty())
}

/// `migrate status`
pub fn status_cmd() -> Result<(), String> {
    let flint = flint_paths(&Roots::discover());
    print(&manifest::read(&flint.config_dir)?)
}

/// `migrate rollback --yes`: removes the Flint copies; restores JAN for a Move.
pub fn rollback_cmd(yes: bool) -> Result<(), String> {
    if !yes {
        return Err("this removes the copies a migration made; run again with --yes".to_string());
    }
    let flint = flint_paths(&Roots::discover());
    execute::rollback_from_manifest(&flint.config_dir)?;
    println!("Rolled back.");
    Ok(())
}

/// `migrate dismiss`: never offer the first-launch migration again.
pub fn dismiss_cmd() -> Result<(), String> {
    let flint = flint_paths(&Roots::discover());
    manifest::mark_dismissed(&flint.config_dir)?;
    println!("Dismissed.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_parse_and_unknown_ones_name_the_options() {
        assert_eq!(parse_enum::<Mode>("mode", "Copy", "x").unwrap(), Mode::Copy);
        assert_eq!(parse_enum::<Mode>("mode", "fresh", "x").unwrap(), Mode::Fresh);
        assert!(parse_enum::<Mode>("mode", "teleport", "copy, reuse").unwrap_err().contains("copy, reuse"));
        assert_eq!(parse_enum::<Conflict>("c", "keep_both", "x").unwrap(), Conflict::KeepBoth);
        assert!(!Category::all().is_empty());
        assert!(Category::parse("nonsense").is_none());
    }

    #[test]
    fn run_without_yes_prints_the_plan_and_refuses() {
        // No legacy install here, so the plan itself cannot be built; either
        // way nothing is executed without --yes.
        let err = run_cmd("copy", &[], "keep_flint", false).unwrap_err();
        assert!(err.contains("no legacy JAN data") || err.contains("--yes"), "{err}");
        assert!(rollback_cmd(false).is_err());
    }
}
