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
        AgentCommands::Tree { session, json } => inspect::tree(session, json),
        AgentCommands::TestTriage {
            project,
            command,
            no_retry,
            json,
        } => inspect::test_triage(project, command, no_retry, json),
        AgentCommands::Health {
            project,
            only,
            dry_run,
            json,
        } => inspect::health(project, only, dry_run, json),
        AgentCommands::Licenses {
            project,
            allow,
            record,
            json,
        } => inspect::licenses(project, allow, record, json),
        AgentCommands::Search {
            query,
            project,
            regex,
            session,
            role,
            limit,
            json,
        } => inspect::search(query, project, regex, session, role, limit, json),
        AgentCommands::Transcript {
            session,
            project,
            format,
            out,
        } => inspect::transcript(session, project, format, out),
        AgentCommands::Quota { json } => inspect::quota(json),
        AgentCommands::Compaction { project } => inspect::compaction(project),
        AgentCommands::BundleExport { project, out } => bundle_policy::bundle_export(project, out),
        AgentCommands::BundleImport { project, file, overwrite, accept_widening, dry_run } => bundle_policy::bundle_import(project, file, overwrite, accept_widening, dry_run),
        AgentCommands::ImportAgents {
            path,
            scope,
            project,
            overwrite,
            dry_run,
        } => bundle_policy::import_agents(path, scope, project, overwrite, dry_run),
        AgentCommands::PolicyExport { project, out } => bundle_policy::policy_export(project, out),
        AgentCommands::PolicyImport {
            file,
            project,
            accept_widening,
        } => bundle_policy::policy_import(file, project, accept_widening),
        AgentCommands::Context {
            session,
            snapshot,
            window,
            json,
        } => inspect::context(session, snapshot, window, json),
        AgentCommands::Index {
            project,
            symbol,
            limit,
            json,
        } => inspect::index(project, symbol, limit, json),
        AgentCommands::Spend {
            since,
            session,
            json,
            by_item,
        } => inspect::spend(since, session, json, by_item),
        AgentCommands::State { json } => inspect::state(json),
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
        AgentCommands::Vcs { project, json } => inspect::vcs(project, json),
        AgentCommands::Impact {
            changed,
            project,
            json,
        } => inspect::impact(changed, project, json),
        AgentCommands::EventsExport { session, run, include_content } => data::events_export(session, run, include_content),
        AgentCommands::EventsInspect { file } => data::events_inspect(file),
        AgentCommands::Replays { session } => data::replays(session),
        AgentCommands::Replay { session, run } => data::replay(session, run),
        AgentCommands::Audit { session, run, agent, tool, decision, limit } => data::audit(session, run, agent, tool, decision, limit),
        AgentCommands::Prompts { session, show } => data::prompts(session, show),
        AgentCommands::Ledger { run, json } => data::ledger(run, json),
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
