//! `flint agent` subcommands that inspect a project or a session: tree, triage,
//! health, licenses, search, transcript, quota and the like. The arm bodies
//! moved verbatim out of `handle_agent`.

use super::*;

/// `flint agent tree`.
pub(crate) fn tree(session: String, json: bool) -> Result<(), HarnessError> {
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    tauri_plugin_agent_tools::run_tree::of_session(&data, &session).map(|tree| {
        if json {
            println!("{}", serde_json::to_string_pretty(&tree).unwrap_or_default());
        } else {
            print!("{}", tauri_plugin_agent_tools::run_tree::render(&tree));
        }
    })
}

/// `flint agent test-triage`.
pub(crate) fn test_triage(project: String, command: Vec<String>, no_retry: bool, json: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::test_triage;
    let root = std::path::PathBuf::from(&project);
    let command = if command.is_empty() {
        vec!["cargo".to_string(), "test".to_string()]
    } else {
        command
    };
    test_triage::triage(&root, &command, !no_retry).and_then(|triage| {
        if json {
            println!("{}", serde_json::to_string_pretty(&triage).unwrap_or_default());
        } else {
            print!("{}", test_triage::render(&triage));
        }
        // A suite with failures that happened twice is a suite with
        // failures; one whose only failures did not reproduce is not
        // the same thing, and the exit code says which.
        let real = triage.reproduced.values().any(|r| {
            *r == test_triage::Reproduced::Yes || *r == test_triage::Reproduced::NotChecked
        }) && !triage.failures.is_empty();
        if real || triage.unreadable {
            Err(HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::ToolFailed,
                if triage.unreadable {
                    "the test run failed and its output could not be read".to_string()
                } else {
                    format!(
                        "{} failure(s) in {} group(s)",
                        triage.failures.len(),
                        triage.clusters.len()
                    )
                },
            ))
        } else {
            Ok(())
        }
    })
}

/// `flint agent health`.
pub(crate) fn health(project: String, only: Vec<String>, dry_run: bool, json: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::health;
    let root = std::path::PathBuf::from(&project);
    let selected: std::result::Result<Vec<health::Kind>, String> =
        only.iter().map(|o| health::Kind::parse(o)).collect();
    selected
        .map_err(|e| {
            HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                e,
            )
        })
        .and_then(|selected| {
            if dry_run {
                let planned: Vec<health::Check> = health::checks(&root)
                    .into_iter()
                    .filter(|c| selected.is_empty() || selected.contains(&c.kind))
                    .collect();
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&planned).unwrap_or_default()
                    );
                } else {
                    print!("{}", health::render_plan(&planned));
                }
                return Ok(());
            }
            let report = health::scan(&root, &selected)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            } else {
                print!("{}", health::render(&report));
            }
            // A scan that found something broken says so in its exit
            // code: this is the thing somebody runs before starting
            // work, and "it printed a failure and exited 0" is how a
            // broken tree gets worked in anyway.
            if health::healthy(&report) {
                Ok(())
            } else {
                Err(HarnessError::new(
                    tauri_plugin_agent_tools::harness_error::ErrorKind::ToolFailed,
                    "at least one of this project's own checks did not pass",
                ))
            }
        })
}

/// `flint agent licenses`.
pub(crate) fn licenses(project: String, allow: Vec<String>, record: bool, json: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::licenses;
    let root = std::path::PathBuf::from(&project);
    let allow = if allow.is_empty() {
        app_lib::core::agent::project::allowed_licenses(&root)
    } else {
        allow
    };
    licenses::scan(&root, &allow).and_then(|report| {
        if json {
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
        } else {
            print!("{}", licenses::render(&report));
        }
        if record {
            let path = licenses::record(&root, &report.dependencies)?;
            println!("recorded {} dependenc(ies) in {}", report.dependencies.len(), path.display());
        }
        // A dependency the project does not allow is a finding, and a
        // command that finds something says so in its exit code.
        if report.disallowed.is_empty() {
            Ok(())
        } else {
            Err(HarnessError::new(
                tauri_plugin_agent_tools::harness_error::ErrorKind::PolicyViolation,
                format!(
                    "{} dependenc(ies) are not licensed under anything this project allows",
                    report.disallowed.len()
                ),
            ))
        }
    })
}

/// `flint agent search`.
pub(crate) fn search(query: String, project: String, regex: bool, session: Option<String>, role: Option<String>, limit: usize, json: bool) -> Result<(), HarnessError> {
    use app_lib::core::agent::transcript;
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    transcript::search(
        Some(std::path::Path::new(&project)),
        (!data.as_os_str().is_empty()).then_some(data.as_path()),
        &transcript::Query {
            text: query,
            regex,
            session,
            role,
            limit,
        },
    )
    .map(|found| {
        if json {
            println!("{}", serde_json::to_string_pretty(&found).unwrap_or_default());
        } else {
            print!("{}", transcript::render(&found));
        }
    })
}

/// `flint agent transcript`.
pub(crate) fn transcript(session: String, project: String, format: String, out: Option<String>) -> Result<(), HarnessError> {
    use app_lib::core::agent::transcript;
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    let format = match format.as_str() {
        "text" => Ok(transcript::Format::Text),
        "markdown" | "md" => Ok(transcript::Format::Markdown),
        "json" => Ok(transcript::Format::Json),
        other => Err(HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            format!("{other:?} is not a format; use text, markdown or json"),
        )),
    };
    format
        .and_then(|format| {
            transcript::export(
                Some(std::path::Path::new(&project)),
                (!data.as_os_str().is_empty()).then_some(data.as_path()),
                &session,
                format,
            )
        })
        .and_then(|text| match out {
            Some(path) => std::fs::write(&path, &text)
                .map(|()| println!("wrote {path}"))
                .map_err(|e| {
                    HarnessError::new(
                        tauri_plugin_agent_tools::harness_error::ErrorKind::Io,
                        format!("the transcript could not be written to {path}: {e}"),
                    )
                }),
            None => {
                print!("{text}");
                Ok(())
            }
        })
}

/// `flint agent quota`.
pub(crate) fn quota(json: bool) -> Result<(), HarnessError> {
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    use app_lib::core::agent::quota;
    quota::quotas(&data)
        .and_then(|declared| quota::standing(&data, &declared))
        .map_err(|e| HarnessError::from(&e))
        .map(|standings| {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&standings).unwrap_or_default()
                );
            } else {
                print!("{}", quota::render(&standings));
            }
        })
}

/// `flint agent compaction`.
pub(crate) fn compaction(project: String) -> Result<(), HarnessError> {
    tauri_plugin_agent_tools::compaction_policy::Policy::resolve(
        Some(&app_lib::core::app::commands::resolve_jan_data_folder()),
        Some(std::path::Path::new(&project)),
        None,
    )
    .map(|p| println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default()))
}

/// `flint agent context`.
pub(crate) fn context(session: String, snapshot: Option<String>, window: Option<u64>, json: bool) -> Result<(), HarnessError> {
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    tauri_plugin_agent_tools::context_report::of_snapshot(
        &data,
        &session,
        snapshot.as_deref(),
        window,
        0,
    )
    .map(|breakdown| {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&breakdown).unwrap_or_default()
            );
        } else {
            print!(
                "{}",
                tauri_plugin_agent_tools::context_report::render(&breakdown)
            );
        }
    })
}

/// `flint agent index`.
pub(crate) fn index(project: Option<String>, symbol: Option<String>, limit: usize, json: bool) -> Result<(), HarnessError> {
    let root = project
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    // Nothing cancels a one-shot command, but the index takes the flag
    // rather than assuming: the same call is made from a run, where
    // stopping it has to leave no half index behind.
    let cancel = std::sync::atomic::AtomicBool::new(false);
    app_lib::core::agent::index::refresh(&data, &root, &cancel)
        .map_err(|e| HarnessError::from(&e))
        .map(|(index, update)| {
            if let Some(name) = symbol {
                let found = app_lib::core::agent::index::find_symbol(&index, &name, limit);
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&found).unwrap_or_default()
                    );
                    return;
                }
                if found.is_empty() {
                    println!("nothing named {name:?} is defined in {} files", index.files.len());
                }
                for hit in found {
                    println!("{}:{} {:?} {}", hit.path, hit.line, hit.kind, hit.name);
                }
                return;
            }
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "files": index.files.len(),
                        "symbols": index.files.values().map(|f| f.symbols.len()).sum::<usize>(),
                        "commit": index.commit,
                        "truncated": index.truncated,
                        "update": update,
                    }))
                    .unwrap_or_default()
                );
                return;
            }
            println!(
                "{} files, {} symbols{}",
                index.files.len(),
                index.files.values().map(|f| f.symbols.len()).sum::<usize>(),
                if index.truncated { " (a bound stopped the walk)" } else { "" }
            );
            println!(
                "  read {} new, {} changed; reused {} without reading; {} gone{}",
                update.added,
                update.changed,
                update.unchanged,
                update.removed,
                if update.reconciled { "; the checkout moved, so every entry was re-checked" } else { "" }
            );
        })
}

/// `flint agent spend`.
pub(crate) fn spend(since: Option<String>, session: Option<String>, json: bool, by_item: bool) -> Result<(), HarnessError> {
    let data = app_lib::core::app::commands::resolve_jan_data_folder();
    if by_item && session.is_some() {
        // The per-item report covers every conversation; accepting --session
        // and then ignoring it would show numbers for the wrong scope.
        return Err(HarnessError::new(
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
            "--by-item cannot be combined with --session",
        ));
    }
    if by_item {
        let root = std::env::current_dir().ok();
        app_lib::core::agent::attribution::report(&data, since.as_deref(), root.as_deref())
            .map_err(|e| HarnessError::from(&e))
            .map(|a| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&a).unwrap_or_default());
                } else {
                    print!("{}", app_lib::core::agent::attribution::render(&a));
                }
            })
    } else {
    app_lib::core::agent::spend::report(&data, since.as_deref(), session.as_deref())
        .map_err(|e| HarnessError::from(&e))
        .map(|report| {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                print!("{}", app_lib::core::agent::spend::render(&report));
            }
        })
    }
}

/// `flint agent state`.
pub(crate) fn state(json: bool) -> Result<(), HarnessError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&app_lib::core::agent::state_schema::stores())
                .unwrap_or_default()
        );
    } else {
        print!("{}", app_lib::core::agent::state_schema::render());
    }
    Ok(())
}

/// `flint agent vcs`.
pub(crate) fn vcs(project: Option<String>, json: bool) -> Result<(), HarnessError> {
    let root = project
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    app_lib::core::agent::vcs::divergence(&root)
        .and_then(|divergence| {
            app_lib::core::agent::vcs::conflicts(&root).map(|merge| (divergence, merge))
        })
        .map_err(|e| HarnessError::from(&e))
        .map(|(divergence, merge)| {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "divergence": divergence,
                        "merge": merge,
                    }))
                    .unwrap_or_default()
                );
                return;
            }
            match (&divergence.branch, &divergence.upstream) {
                (Some(branch), Some(upstream)) => println!(
                    "{branch} vs {upstream}: {} ahead, {} behind",
                    divergence.ahead, divergence.behind
                ),
                (Some(branch), None) => println!("{branch}: tracks nothing"),
                _ => println!("HEAD is detached"),
            }
            for option in &divergence.options {
                println!("  - {option}");
            }
            if divergence.needs_a_person {
                println!("  this needs a decision, not a command");
            }
            println!();
            match app_lib::core::agent::vcs::branches(&root) {
                Ok(branches) => {
                    for b in &branches {
                        println!(
                            "{}{}{}{}",
                            if b.current { "* " } else { "  " },
                            b.name,
                            b.upstream.as_ref().map(|u| format!(" -> {u}")).unwrap_or_default(),
                            if b.checked_out_elsewhere { " (held by another worktree)" } else { "" }
                        );
                    }
                }
                Err(e) => println!("branches: {}", e.message),
            }
            if merge.in_progress {
                println!(
                    "a merge is stopped, with {} file(s) unresolved:",
                    merge.files.len()
                );
                for file in &merge.files {
                    println!(
                        "  {} ({:?}, {} region(s))",
                        file.path,
                        file.kind,
                        file.hunks.len()
                    );
                }
                println!("  {}", merge.note);
            }
        })
}

/// `flint agent impact`.
pub(crate) fn impact(changed: Vec<String>, project: Option<String>, json: bool) -> Result<(), HarnessError> {
    let root = project
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let runner = app_lib::core::agent::impact::detected_runner(&root);
    app_lib::core::agent::impact::selection(&root, &changed, runner.as_deref())
        .map_err(|e| HarnessError::from(&e))
        .map(|selection| {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&selection).unwrap_or_default()
                );
            } else {
                println!("{}", selection.reason);
                for test in &selection.impact.tests {
                    println!("  test: {test}");
                }
                for unknown in &selection.impact.unknown {
                    println!("  not seen: {unknown}");
                }
                match selection.command.as_deref() {
                    // Printed, never run: what to do about it is the
                    // caller's decision, not this command's.
                    Some(command) => println!("run: {command}"),
                    None => println!("run: (this project does not say)"),
                }
            }
        })
}
