use super::*;

pub(super) async fn handle_agent(cmd: AgentCommands) {
    let result = match cmd {
        AgentCommands::Run {
            project,
            task,
            model,
            safe,
            mode,
            providers,
            sandbox,
            budget,
            worktree,
            resume,
            output_format,
            input_format,
            host_tools,
            host_gate,
            events,
            profile,
            output_density,
            append_system_prompt,
            append_system_prompt_file,
            allow_tools,
            deny_tools,
            effort,
            ephemeral,
            json_schema,
            json_schema_attempts,
        } => run_cmd::run(project, task, model, safe, mode, providers, sandbox, budget, worktree, resume, output_format, input_format, host_tools, host_gate, events, profile, output_density, append_system_prompt, append_system_prompt_file, allow_tools, deny_tools, effort, ephemeral, json_schema, json_schema_attempts).await,
        AgentCommands::RunSubagent { spec } => run_cmd::run_subagent(spec).await,
        AgentCommands::Serve => run_cmd::serve().await,
        AgentCommands::Step {
            project,
            task,
            model,
            safe,
            mode,
            providers,
            sandbox,
            profile,
        } => run_cmd::step(project, task, model, safe, mode, providers, sandbox, profile).await,
        AgentCommands::Tree { session, json } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            tauri_plugin_agent_tools::run_tree::of_session(&data, &session).map(|tree| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&tree).unwrap_or_default());
                } else {
                    print!("{}", tauri_plugin_agent_tools::run_tree::render(&tree));
                }
            })
        }
        AgentCommands::TestTriage {
            project,
            command,
            no_retry,
            json,
        } => {
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
        AgentCommands::Health {
            project,
            only,
            dry_run,
            json,
        } => {
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
        AgentCommands::Licenses {
            project,
            allow,
            record,
            json,
        } => {
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
        AgentCommands::Search {
            query,
            project,
            regex,
            session,
            role,
            limit,
            json,
        } => {
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
        AgentCommands::Transcript {
            session,
            project,
            format,
            out,
        } => {
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
        AgentCommands::Quota { json } => {
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
        AgentCommands::Compaction { project } => {
            tauri_plugin_agent_tools::compaction_policy::Policy::resolve(
                Some(&app_lib::core::app::commands::resolve_jan_data_folder()),
                Some(std::path::Path::new(&project)),
                None,
            )
            .map(|p| println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default()))
        }
        AgentCommands::BundleExport { project, out } => {
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
        AgentCommands::BundleImport { project, file, overwrite, accept_widening, dry_run } => {
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
        AgentCommands::ImportAgents {
            path,
            scope,
            project,
            overwrite,
            dry_run,
        } => {
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
        AgentCommands::PolicyExport { project, out } => {
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
        AgentCommands::PolicyImport {
            file,
            project,
            accept_widening,
        } => {
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
        AgentCommands::Context {
            session,
            snapshot,
            window,
            json,
        } => {
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
        AgentCommands::Index {
            project,
            symbol,
            limit,
            json,
        } => {
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
        AgentCommands::Spend {
            since,
            session,
            json,
            by_item,
        } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
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
        AgentCommands::State { json } => {
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
        AgentCommands::Mail {
            run,
            session,
            from,
            body,
            subject,
            peek,
        } => {
            use tauri_plugin_agent_tools::identity::{RunId, SessionId};
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            let to = RunId::parse(run);
            match (to, from, body) {
                (Err(e), _, _) => Err(e),
                (Ok(to), Some(from), Some(body)) => session
                    .ok_or_else(|| {
                        HarnessError::new(
                            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput,
                            "sending needs --session: a message belongs to one conversation",
                        )
                    })
                    .and_then(SessionId::parse)
                    .and_then(|session| RunId::parse(from).map(|from| (session, from)))
                    .and_then(|(session, from)| {
                        tauri_plugin_agent_tools::mailbox::send(
                            &data, &session, &from, &to, &subject, &body,
                        )
                        .map_err(|e| HarnessError::from(&e))
                    })
                    .map(|message| {
                        println!("delivered to {} as message {}", message.to, message.seq);
                    }),
                (Ok(to), _, _) => {
                    tauri_plugin_agent_tools::mailbox::read(&data, &to, !peek)
                        .map_err(|e| HarnessError::from(&e))
                        .map(|messages| {
                            if messages.is_empty() {
                                println!("no messages");
                            }
                            for message in messages {
                                println!(
                                    "{} from {}{} [{}]",
                                    message.at,
                                    message.from,
                                    if message.subject.is_empty() {
                                        String::new()
                                    } else {
                                        format!(" -- {}", message.subject)
                                    },
                                    if message.delivered_at.is_some() { "read" } else { "unread" }
                                );
                                println!("  {}", message.body);
                            }
                        })
                }
            }
        }
        AgentCommands::Vcs { project, json } => {
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
        AgentCommands::Impact {
            changed,
            project,
            json,
        } => {
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
        AgentCommands::EventsExport { session, run, include_content } => {
            app_lib::core::cli::run_data_cmd::events_export(
                &app_lib::core::app::commands::resolve_jan_data_folder(),
                &session,
                run.as_deref(),
                include_content,
            )
            .map_err(HarnessError::legacy)
        }
        AgentCommands::EventsInspect { file } => {
            app_lib::core::cli::run_data_cmd::events_inspect(&file).map_err(HarnessError::legacy)
        }
        AgentCommands::Replays { session } => app_lib::core::cli::run_data_cmd::replays(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
            &session,
        )
        .map_err(HarnessError::legacy),
        AgentCommands::Replay { session, run } => app_lib::core::cli::run_data_cmd::replay(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
            &session,
            &run,
        )
        .map_err(HarnessError::legacy),
        AgentCommands::Audit { session, run, agent, tool, decision, limit } => {
            app_lib::core::cli::run_data_cmd::audit_cmd(
                &app_lib::core::app::commands::resolve_jan_data_folder(),
                session,
                run,
                agent,
                tool,
                decision,
                limit,
            )
            .map_err(HarnessError::legacy)
        }
        AgentCommands::Prompts { session, show } => agent_prompts_text(
            &app_lib::core::app::commands::resolve_jan_data_folder(),
            &session,
            show.as_deref(),
        )
        .map(|text| print!("{text}"))
        .map_err(HarnessError::legacy),
        AgentCommands::Ledger { run, json } => {
            let data = app_lib::core::app::commands::resolve_jan_data_folder();
            match app_lib::core::agent::ledger::read(&data, &run) {
                Ok(entries) if json => {
                    println!("{}", serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string()));
                    Ok(())
                }
                Ok(entries) => {
                    print!("{}", app_lib::core::agent::ledger::render_text(&entries));
                    Ok(())
                }
                Err(e) => Err(HarnessError::legacy(e)),
            }
        }
        AgentCommands::Status { project, providers } => run_cmd::status(project, providers),
        AgentCommands::Schema { out } => run_cmd::schema(out),
        AgentCommands::Rpc => run_cmd::rpc().await,
        AgentCommands::RpcSchema { out } => run_cmd::rpc_schema(out),
    };
    if let Err(e) = result {
        // AH-009: what ended the run decides how it is reported and what the
        // process exits with. A run the user stopped is not a failure, and a
        // rejected credential is not an outage -- a script reading the status
        // can tell them apart without parsing this line.
        if e.is_cancellation() {
            eprintln!("Stopped: {}", e.message());
        } else {
            eprintln!("Error [{}]: {}", e.kind().tag(), e.message());
            for cause in e.chain().into_iter().skip(1) {
                eprintln!("  caused by [{}]: {}", cause.kind().tag(), cause.message());
            }
        }
        std::process::exit(run_exit_code(&e));
    }
}
