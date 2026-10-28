//! `flint agent` subcommands that move a project's agent setup around: bundle
//! export/import, agent import and policy export/import. The arm bodies moved
//! verbatim out of `handle_agent`.

use super::*;

/// `flint agent bundle-export`.
pub(crate) fn bundle_export(project: String, out: String) -> Result<(), HarnessError> {
    use app_lib::core::agent::agent_bundle;
    agent_bundle::export(std::path::Path::new(&project)).and_then(|(bundle, report)| {
        let text = serde_json::to_string_pretty(&bundle).unwrap_or_default();
        let tmp = format!("{out}.partial");
        std::fs::write(&tmp, format!("{text}\n"))
            .and_then(|()| std::fs::rename(&tmp, &out))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                    format!("the bundle could not be written to {out}: {e}"),
                )
            })?;
        println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
        Ok(())
    })
}

/// `flint agent bundle-import`.
pub(crate) fn bundle_import(project: String, file: String, overwrite: bool, accept_widening: bool, dry_run: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::agent_bundle;
    std::fs::read_to_string(&file)
        .map_err(|e| {
            HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::NotFound,
                format!("{file} could not be read: {e}"),
            )
        })
        .and_then(|text| agent_bundle::parse(&text))
        .and_then(|bundle| {
            agent_bundle::import(std::path::Path::new(&project), &bundle, overwrite, accept_widening, dry_run)
        })
        .map(|report| println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default()))
}

/// `flint agent import-agents`.
pub(crate) fn import_agents(path: String, scope: String, project: String, overwrite: bool, dry_run: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::subagent::SubagentScope;
    let resolved = match scope.as_str() {
        "user" => app_lib::core::agent::subagent::user_subagents_dir()
            .map(|dir| (SubagentScope::User, dir))
            .ok_or_else(|| {
                HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::NotFound,
                    "the home directory could not be resolved, so there is no user scope to import into",
                )
            }),
        "project" => Ok((
            SubagentScope::Project,
            app_lib::core::agent::subagent::project_subagents_dir(std::path::Path::new(
                &project,
            )),
        )),
        other => Err(HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            format!("'{other}' is not a scope; use 'user' or 'project'"),
        )),
    };
    resolved.and_then(|(scope, dir)| {
        app_lib::core::agent::agent_import::import(
            std::path::Path::new(&path),
            &dir,
            scope,
            overwrite,
            dry_run,
        )
        .map(|report| {
            print!("{}", app_lib::core::agent::agent_import::render(&report));
            if !report.dry_run {
                println!("written to {}", dir.display());
            }
        })
    })
}

/// `flint agent policy-export`.
pub(crate) fn policy_export(project: String, out: Option<String>) -> Result<(), HarnessError> {
    app_lib::core::cli::cli_policy_export(&project).and_then(|document| {
        let text = tauri_plugin_agent_tools::policy_transfer::render(&document);
        match out {
            Some(path) => std::fs::write(&path, format!("{text}\n")).map_err(|e| {
                HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                    format!("the policy could not be written to {path}: {e}"),
                )
            }),
            None => {
                println!("{text}");
                Ok(())
            }
        }
    })
}

/// `flint agent policy-import`.
pub(crate) fn policy_import(file: String, project: String, accept_widening: bool) -> Result<(), HarnessError> {
    let text = if file == "-" {
        use std::io::Read;
        let mut buffer = String::new();
        std::io::stdin().read_to_string(&mut buffer).map(|_| buffer).map_err(|e| {
            HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                format!("the policy could not be read from stdin: {e}"),
            )
        })
    } else {
        std::fs::read_to_string(&file).map_err(|e| {
            HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                format!("{file} could not be read: {e}"),
            )
        })
    };
    text.and_then(|text| {
        app_lib::core::cli::cli_policy_import(&project, &text, accept_widening)
    })
    .map(|change| {
        if change.is_empty() {
            println!("The policy is already what this document says.");
            return;
        }
        println!("Policy updated.");
        for (label, rules) in [
            ("added allow", &change.allow_added),
            ("added deny", &change.deny_added),
            ("added allow_write", &change.allow_write_added),
            ("removed allow", &change.allow_removed),
            ("removed deny", &change.deny_removed),
            ("removed allow_write", &change.allow_write_removed),
        ] {
            for rule in rules {
                println!("  {label}: {rule}");
            }
        }
        if let Some(default) = change.default_changed_to.as_deref() {
            println!("  default is now: {default}");
        }
    })
}
