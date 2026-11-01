use super::*;

impl CompositeToolInvoker {
    /// A cancellation token for one call, under this run's scope.
    ///
    /// Registered for the caller to hold: dropping the guard deregisters, so a
    /// finished call leaves nothing for a later scope-wide stop to trip over.
    pub(super) fn call_token(&self, call_id: &str) -> tauri_plugin_agent_tools::lifecycle::Registered {
        use tauri_plugin_agent_tools::lifecycle::{register, Scope, Token};
        register(Token::new(Scope::new(
            self.cancel_scope.session.clone(),
            self.cancel_scope.run.clone(),
            call_id.to_string(),
        )))
    }

    /// Report and record a stopped call.
    ///
    /// One place, so the transcript message and the audit record can never
    /// disagree about what happened.
    pub(super) fn cancelled(
        &self,
        out: &mut Vec<ToolOutcome>,
        id: &str,
        name: &str,
        reason: tauri_plugin_agent_tools::lifecycle::StopReason,
    ) {
        return_cancelled_outcome(out, id, name, reason);
        record_cancelled_call(
            &crate::core::app::commands::resolve_jan_data_folder(),
            &self.cancel_scope,
            &self.project_root,
            id,
            name,
            reason,
        );
    }

    pub(super) fn tool_context(&self) -> tauri_plugin_agent_tools::tools::ToolContext<'_> {
        tauri_plugin_agent_tools::tools::ToolContext::new(
            &self.project_root,
            &self.store_root,
            &self.enabled_skills,
        )
        .with_network(self.allow_network)
        .with_home_readonly(self.allow_home_read)
        .with_fs_config(Some(&self.sandbox_fs))
        .with_sandbox(self.sandbox)
        .with_scratch_root(&self.scratch_root)
        .with_user_skills(self.user_skills.as_deref())
        // AH-040: what this run may do, so a skill that declares the tools it
        // needs is withheld where those tools are denied.
        .with_permissions(&self.permissions, &self.subject)
        // AH-124: and what this run has at all, so a skill that names a tool
        // nothing provides is withheld rather than loaded.
        .with_available_tools(&self.available_tools)
        // AH-149: whether an edited file goes through the project's formatter
        // before its diff is shown.
        .with_format_on_edit(self.format_on_edit)
        .with_check_syntax(self.check_syntax)
        .with_nul_programs(&self.nul_programs)
    }

    /// The same context, plus who this run is for the mailbox (AH-103).
    ///
    /// Kept separate because `record_to` is the surface's own answer about
    /// whether it keeps durable state: where it is `None` there is nowhere to
    /// put a message, and the tools say so rather than pretending to send.
    pub(super) fn tool_context_with_run(&self) -> tauri_plugin_agent_tools::tools::ToolContext<'_> {
        let ctx = self.tool_context();
        match self.record_to.as_deref() {
            // Taken from the scope the loop is running under, never from
            // anything the model produced: this is the sender's identity.
            Some(data) => {
                let ctx = ctx.with_run(&self.cancel_scope.run, data);
                if self.session_messaging {
                    ctx.with_mailbox_as(&self.cancel_scope.session, data)
                } else {
                    ctx
                }
            }
            None => ctx,
        }
    }

    /// A tool context whose output streams to the run's event channel as
    /// [`StreamEvent::ToolOutputDelta`], tagged with the call's `id`.
    ///
    /// Only exec-capable tools produce anything here: `bash` tees its child's
    /// combined stdout/stderr through the sink as it reads. A send failure is
    /// ignored -- the receiver is gone only when the run is over, and a dead
    /// display must not stop the command.
    pub(super) fn streaming_tool_context<'s>(&'s self, id: &'s str) -> tauri_plugin_agent_tools::tools::ToolContext<'s> {
        self.tool_context_with_run()
            // The call a command is measured against (AH-174), and the id a
            // backgrounded job reports under.
            .with_call_id(id)
            .with_output_sink(output_sink(&self.events, id))
    }

    /// Whether `name` is a tool the client executes. Always `false` where there
    /// is no client: the desktop build has no peer that could answer one.
    pub(super) fn is_host_tool(&self, name: &str) -> bool {
        #[cfg(feature = "cli")]
        {
            self.host_tools.is_host_tool(name)
        }
        #[cfg(not(feature = "cli"))]
        {
            let _ = name;
            false
        }
    }

    /// How the gate treats a call to host tool `name`. Off the headless build
    /// there are no host tools, so the answer is never consulted there.
    pub(super) fn host_gate(&self, name: &str) -> HostGate {
        #[cfg(feature = "cli")]
        {
            use crate::core::agent::host_tools::HostCapability;
            let capability = self.host_tools.get(name).and_then(|t| t.capability);
            match capability {
                // Plan mode and concurrency follow the capability even when
                // the host owns the gate; only the prompt is the host's.
                Some(HostCapability::Read) => HostGate::Read,
                _ if self.host_owns_gate => HostGate::Host,
                Some(HostCapability::Actuator) => HostGate::Actuator,
                None => HostGate::Opaque,
            }
        }
        #[cfg(not(feature = "cli"))]
        {
            let _ = name;
            HostGate::Opaque
        }
    }

    /// Ask the user about a host tool call, honoring a thread-scoped "allow
    /// always" the user already gave for it.
    ///
    /// `Ok(Err(message))` is a refusal, ready to hand the model.
    pub(super) async fn approve_host_tool(
        &self,
        call_id: &str,
        name: &str,
    ) -> Result<Result<(), String>, tauri_plugin_agent_tools::lifecycle::StopReason> {
        if self.grants.lock().unwrap().covers_mcp("host", name) {
            return Ok(Ok(()));
        }
        let (decision, request_id) = self.prompt_mcp_permission(call_id, name).await?;
        Ok(match decision {
            PermissionDecision::AllowOnce => Ok(()),
            PermissionDecision::AllowAlways => {
                self.grants.lock().unwrap().grant_mcp("host", name);
                Ok(())
            }
            PermissionDecision::Deny => Err(denied_by_user_message(name, &request_id)),
        })
    }

    /// Hand a host tool call to the client and wait for its answer.
    ///
    /// The returned text is what the model sees, in every outcome, unless the
    /// host answered with content parts: a host that fails, or one that goes
    /// away mid-call, still produces a tool message. An unanswered call would
    /// otherwise leave the conversation with an assistant turn whose call is
    /// never resolved, which is not a state the run can be resumed from.
    ///
    /// Upstream brackets this call with the PreToolUse / PostToolUse lifecycle
    /// hooks; this fork has no tool-call hook bracket, so the call goes out as
    /// soon as the gate has approved it and its arguments match the schema.
    #[cfg(feature = "cli")]
    pub(super) async fn call_host_tool(&self, name: &str, args: &serde_json::Value) -> HostCallResult {
        let Some(tool) = self.host_tools.get(name) else {
            return (format!("ERROR: host tool '{name}' is not registered"), None, None);
        };
        // Before the request exists, so the host -- possibly driving hardware --
        // never receives arguments its own schema forbids.
        if let Err(why) = tool.validate(args) {
            return (
                format!(
                    "ERROR: arguments for host tool '{}' do not match its schema: {why}",
                    tool.name
                ),
                None,
                None,
            );
        }
        let (request_id, receiver) =
            crate::core::agent::host_tools::register(&self.host_tool_requests).await;
        // The host declared `observe` and dispatches on `observe`; the `host__`
        // prefix is this layer's business, not the host's. A child's request
        // goes to the root channel unwrapped, so the client answers it exactly
        // as it answers the main run's.
        let (sink, run_id) = match &self.host_tool_route {
            Some((sender, run_id)) => (sender, Some(run_id.clone())),
            None => (&self.events, None),
        };
        let _ = sink.send(StreamEvent::ToolRequest {
            request_id: request_id.clone(),
            tool_name: tool.name.clone(),
            args: args.clone(),
            run_id,
        });
        let (content, parts, details) = match receiver.await {
            Ok(Ok(result)) => {
                if result.is_error {
                    let parts = result.parts.map(mark_parts_as_error);
                    (format!("ERROR: {}", result.content), parts, result.details)
                } else {
                    (result.content, result.parts, result.details)
                }
            }
            Ok(Err(crate::core::agent::host_tools::HostToolError::Cancelled)) => {
                self.host_tool_requests.lock().await.remove(&request_id);
                (
                    format!("ERROR: host tool '{}' was cancelled before it answered", tool.name),
                    None,
                    None,
                )
            }
            // Stranded by a closed pipe, or the sender dropped with the run.
            Ok(Err(crate::core::agent::host_tools::HostToolError::ClientGone)) | Err(_) => {
                self.host_tool_requests.lock().await.remove(&request_id);
                (
                    format!("ERROR: host tool '{}' was not answered: the client is gone", tool.name),
                    None,
                    None,
                )
            }
        };
        (content, parts, details)
    }

    /// Wait for the answer to the open permission request `request_id`, or for
    /// the run (or this call) to be stopped, whichever comes first (AH-049).
    /// `Ok(None)` is a responder that went away. The pending request is always
    /// removed. A stop leaves a `cancelled` audit record under `call_id` and
    /// discards any deny reason recorded for the request, so a stopped run
    /// leaves neither a parked task nor a table entry behind.
    pub(super) async fn await_answer(
        &self,
        call_id: &str,
        name: &str,
        request_id: &str,
        rx: tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) -> Result<Option<PermissionDecision>, tauri_plugin_agent_tools::lifecycle::StopReason> {
        use tauri_plugin_agent_tools::lifecycle::StopReason;
        let registered = self.call_token(call_id);
        let waiting = registered.token().clone();
        let outcome: Result<Option<PermissionDecision>, StopReason> = tokio::select! {
            answer = rx => Ok(answer.ok()),
            _ = async {
                while !waiting.is_stopped() {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            } => Err(waiting.stopped().unwrap_or(StopReason::Cancelled)),
        };
        self.permission_requests.lock().await.remove(request_id);
        if let Err(reason) = outcome {
            let _ = take_deny_reason(request_id);
            record_cancelled_call(
                &crate::core::app::commands::resolve_jan_data_folder(),
                &self.cancel_scope,
                &self.project_root,
                call_id,
                name,
                reason,
            );
        }
        outcome
    }

    /// [`Self::await_answer`] where a responder that went away is a Deny.
    pub(super) async fn await_decision(
        &self,
        call_id: &str,
        name: &str,
        request_id: &str,
        rx: tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) -> Result<PermissionDecision, tauri_plugin_agent_tools::lifecycle::StopReason> {
        Ok(self
            .await_answer(call_id, name, request_id, rx)
            .await?
            .unwrap_or(PermissionDecision::Deny))
    }

    /// Prompt the user to approve an MCP tool call, mirroring the built-in gate.
    /// A dropped responder (client gone) resolves to Deny; a stopped run ends
    /// the wait. Returns the request id with the decision so a refusal can
    /// carry the user's reason (`denied_by_user_message`).
    ///
    /// Plugin and host tools are prompted through here too: `prompt_kind` is
    /// `"mcp"` for all three because it names the *class* a consumer renders --
    /// an opaque third-party capability -- not which subsystem runs the call.
    /// The `tool_name` is the qualified one the model called (`host__move`),
    /// which is what a user needs to see; note that the matching `tool_request`
    /// carries the host's bare name (`move`) instead, since the host dispatches
    /// on the name it declared.
    pub(super) async fn prompt_mcp_permission(
        &self,
        call_id: &str,
        tool_name: &str,
    ) -> Result<(PermissionDecision, String), tauri_plugin_agent_tools::lifecycle::StopReason> {
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.clone(), tx);
        let _ = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: tool_name.to_string(),
            capability: "run".to_string(),
            path: None,
            command: None,
            diff: None,
            patch: None,
            prompt_kind: "mcp".to_string(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        });
        let decision = self.await_decision(call_id, tool_name, &request_id, rx).await?;
        Ok((decision, request_id))
    }

    /// Whether anyone can answer a permission prompt in this run: an attached
    /// interactive UI (the TUI, a duplex client), or a terminal the one-shot
    /// CLI prompts on. Elsewhere a prompt is auto-denied, which would read as
    /// the user saying no when nobody was asked.
    pub(super) fn can_prompt(&self) -> bool {
        use std::io::IsTerminal;
        self.ask_requests.is_some() || std::io::stdin().is_terminal()
    }

    /// A sandboxed `bash` call failed only because Windows' null device
    /// refuses sandboxed programs. Register the one-shot unsandboxed offer,
    /// put it to the user naming the command and why, and run the call again
    /// outside the sandbox only on a yes. Returns what the model gets:
    /// [`tauri_plugin_agent_tools::unsandboxed_retry::model_text`], the same
    /// text the desktop builds. A run where nobody can be asked withdraws the
    /// offer and says so.
    pub(super) async fn settle_null_device_refusal(
        &self,
        id: &str,
        args: &serde_json::Value,
        failure: String,
    ) -> String {
        use tauri_plugin_agent_tools::unsandboxed_retry::{
            model_text, Settled, NULL_DEVICE_RETRY_REASON,
        };
        let offers = null_retry_offers();
        let session = self.cancel_scope.run.clone();
        let offer = offers.offer(&session, args.clone());
        if !self.can_prompt() {
            offers.withdraw(&offer, &session);
            return model_text(&failure, Settled::Unavailable);
        }
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.clone(), tx);
        let sent = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: "bash".to_string(),
            capability: "exec".to_string(),
            path: None,
            command: args.get("command").and_then(|v| v.as_str()).map(String::from),
            diff: None,
            patch: None,
            prompt_kind: "exec".to_string(),
            // Once, for this exact call: an "always" would outlive the offer.
            offers_always: false,
            reason: Some(NULL_DEVICE_RETRY_REASON.to_string()),
            args_digest: None,
            call_id: None,
        });
        if sent.is_err() {
            self.permission_requests.lock().await.remove(&request_id);
            offers.withdraw(&offer, &session);
            return model_text(&failure, Settled::Unavailable);
        }
        let registered = self.call_token(id);
        let waiting = registered.token().clone();
        let decision = tokio::select! {
            answer = rx => answer.unwrap_or(PermissionDecision::Deny),
            _ = async {
                while !waiting.is_stopped() {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            } => PermissionDecision::Deny,
        };
        self.permission_requests.lock().await.remove(&request_id);
        let allowed = matches!(
            decision,
            PermissionDecision::AllowOnce | PermissionDecision::AllowAlways
        ) && !waiting.is_stopped();
        if !allowed {
            offers.withdraw(&offer, &session);
            return model_text(&failure, Settled::Declined);
        }
        // Redeemed, not re-read from `args`: the offer names the call it was
        // made for, and it is spent by this one run.
        let (Some(call), Some(tool)) = (
            offers.redeem(&offer, &session),
            tauri_plugin_agent_tools::tools::lookup("bash"),
        ) else {
            return model_text(&failure, Settled::Unavailable);
        };
        let ctx = self
            .streaming_tool_context(id)
            .with_cancel(registered.token().clone())
            .with_unsandboxed_retry();
        let (output, _, _) =
            tauri_plugin_agent_tools::tools::handlers::execute_builtin_with_diff(tool, &call, &ctx)
                .await;
        model_text(&failure, Settled::Ran(&output))
    }

    /// R18: opening or updating a pull request acts on someone else's
    /// service, so it needs a person or an explicit allow. `default = "allow"`
    /// is not that: a project that allows every tool by default has not decided
    /// that a model may publish to a forge.
    pub(super) async fn approve_forge_mutation(&self, action: &str, api: &str) -> Result<(), String> {
        if self.permissions.is_allowed("pull_request", &self.subject) {
            return Ok(());
        }
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.clone(), tx);
        let _ = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: "pull_request".to_string(),
            capability: "run".to_string(),
            path: None,
            command: Some(format!("{action} a pull request through {api}")),
            diff: None,
            patch: None,
            prompt_kind: "mcp".to_string(),
            offers_always: false,
            reason: None,
            args_digest: None,
            call_id: None,
        });
        let decision = match self.await_decision(&request_id, "pull_request", &request_id, rx).await {
            Ok(decision) => decision,
            Err(reason) => return Err(stopped_message("pull_request", reason)),
        };
        match decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => Ok(()),
            PermissionDecision::Deny => Err(format!(
                "ERROR [approval_refused]: {action} a pull request through {api} was not approved. It changes a service outside this machine, so it needs a person's approval, or `allow = [\"pull_request\"]` in the project's agent.toml; nothing was sent.{}",
                deny_suffix(&request_id)
            )),
        }
    }

    /// `advisor`: one tool-free completion on the configured stronger model,
    /// shown the transcript so far. Counted against the per-run cap; it is a
    /// dispatch like any other, so its tokens appear in the spend report under
    /// the advisor's model.
    #[cfg(feature = "cli")]
    pub(super) async fn handle_advisor(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::advisor;
        let Some(model) = crate::core::agent::global_config::advisor_model() else {
            return "ERROR [invalid_input]: no advisor model is configured".to_string();
        };
        let Some(ctx) = &self.subagents else {
            return "ERROR [invalid_input]: the advisor is not available in this run".to_string();
        };
        let used = self.advisor_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if used >= advisor::MAX_CALLS_PER_RUN {
            return format!(
                "ERROR [budget_exhausted]: the advisor was already consulted {} times this run",
                advisor::MAX_CALLS_PER_RUN
            );
        }
        let messages = self.live_conversation.lock().map(|m| m.clone()).unwrap_or_default();
        let question = args.get("question").and_then(|v| v.as_str()).unwrap_or_default();
        let request = advisor::request(&model, &messages, question);
        match utility_completion(&ctx.parent_args, &model, "advisor", &request).await {
            Ok(completion) => advisor::note(&model, &completion),
            Err(e) => format!("ERROR [upstream]: the advisor call failed: {}", e.message()),
        }
    }

    /// `schedule_task`: plan the call against this session's own limits, then
    /// ask a person before anything is created or deleted. Unlike
    /// `approve_repo_mutation` there is no allow rule, grant, auto-approval or
    /// bypass that answers for the person: unattended work is approved each
    /// time, by someone who has seen the prompt, schedule, folder and mode.
    pub(super) async fn handle_schedule_task(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::schedule_tool as tool;
        use crate::core::schedule::store::Store;
        if self.run_mode == crate::core::agent::plan::RunMode::Plan {
            return plan_mode_read_only_msg("schedule_task");
        }
        if self.permissions.is_denied("schedule_task", &self.subject) {
            return denied_by_policy_msg("schedule_task", &self.project_root);
        }
        let creator = tool::Creator {
            project_root: self.project_root.clone(),
            model: self.subagents.as_ref().map(|c| c.model_id.clone()).unwrap_or_default(),
            plan_mode: false,
            allowed_tools: self.allowed_tools.as_ref().map(|a| a.iter().cloned().collect()),
            denied_tools: tauri_plugin_agent_tools::tools::BUILTIN_TOOLS
                .iter()
                .filter(|t| self.permissions.is_denied(t.name, &self.subject))
                .map(|t| t.name.to_string())
                .collect(),
        };
        let plan = match tool::plan(args, &creator) {
            Ok(plan) => plan,
            Err(e) => return format!("ERROR [invalid_input]: {e}"),
        };
        let store = Store::new(&crate::core::app::commands::resolve_jan_data_folder());
        let tasks = store.load_tasks().unwrap_or_default();
        if let Some(what) = plan.approval_text(&tasks) {
            if let Err(refused) = self.ask_person("schedule_task", &what).await {
                return refused;
            }
        }
        match plan {
            tool::Plan::List => tool::render_list(&tasks),
            tool::Plan::Create(task) => match store.save_task(*task) {
                Ok(saved) => format!("Scheduled task {} created: {}", saved.id, saved.schedule.describe()),
                Err(e) => format!("ERROR [io]: {}", e.message),
            },
            tool::Plan::Delete { id } => match store.delete_task(&id) {
                Ok(true) => format!("Deleted scheduled task {id}"),
                Ok(false) => format!("ERROR [invalid_input]: no scheduled task {id}"),
                Err(e) => format!("ERROR [io]: {}", e.message),
            },
        }
    }

    /// Put `what` to a person and wait. Always asks; offers no "always allow".
    pub(super) async fn ask_person(&self, name: &str, what: &str) -> Result<(), String> {
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests.lock().await.insert(request_id.clone(), tx);
        let _ = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: name.to_string(),
            capability: "run".to_string(),
            path: None,
            command: Some(what.to_string()),
            diff: None,
            patch: None,
            prompt_kind: "exec".to_string(),
            offers_always: false,
            reason: Some("This creates work that runs later with nobody watching, so it is asked every time.".to_string()),
            args_digest: None,
            call_id: None,
        });
        let decision = match self.await_decision(&request_id, name, &request_id, rx).await {
            Ok(decision) => decision,
            Err(reason) => return Err(stopped_message(name, reason)),
        };
        match decision {
            PermissionDecision::Deny => Err(format!(
                "ERROR [approval_refused]: {name} was not approved by a person, so nothing was changed.{}",
                deny_suffix(&request_id)
            )),
            // `offers_always` is false, so a grant is only ever this once.
            _ => Ok(()),
        }
    }

    /// Approve a repository-changing `git_split` / `git_history` /
    /// `git_branch` call. Same rules as a write through the gate: an explicit
    /// allow or a session grant runs it, auto-approval runs it subject to
    /// `[auto_mode]` and the streak check-in, otherwise a person is asked.
    pub(super) async fn approve_repo_mutation(&self, name: &str, what: &str, args: &serde_json::Value) -> Result<(), String> {
        use std::sync::atomic::Ordering as StreakOrdering;
        let refused = || {
            format!(
                "ERROR [approval_refused]: {name} ({what}) was not approved, so the repository was not changed. It needs a person's approval, auto-approval, or `allow = [\"{name}\"]` in the project's agent.toml."
            )
        };
        if self.permissions.is_allowed(name, &self.subject)
            || self.grants.lock().unwrap().covers_mcp("repo", name)
        {
            return Ok(());
        }
        // Headed for a prompt or auto-approval: the `[auto_mode] judge` may
        // refuse it first, never approve it.
        if let crate::core::agent::auto_mode::GateOutcome::Deny(block) = self.consult_judge(name, args).await {
            return Err(judge_refusal_msg(name, &block));
        }
        let mut forced_reason = None;
        if self.auto_approve {
            if let Some(block) = self.auto_mode.block_reason(name, tauri_plugin_agent_tools::tools::Capability::Exec, args) {
                return Err(auto_mode_refusal_msg(name, &block));
            }
            if self.bypass {
                return Ok(());
            }
            let streak = self.auto_approved_streak.fetch_add(1, StreakOrdering::Relaxed) + 1;
            if self.auto_approve_limit == 0 || streak <= self.auto_approve_limit {
                return Ok(());
            }
            forced_reason = Some(format!(
                "Auto-approval paused: {} tool calls ran without asking. Allow this one to continue.",
                self.auto_approve_limit
            ));
        }
        self.auto_approved_streak.store(0, StreakOrdering::Relaxed);
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.clone(), tx);
        let _ = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: name.to_string(),
            capability: "run".to_string(),
            path: None,
            command: Some(what.to_string()),
            diff: None,
            patch: None,
            prompt_kind: "exec".to_string(),
            offers_always: forced_reason.is_none(),
            reason: forced_reason,
            args_digest: None,
            call_id: None,
        });
        let decision = match self.await_decision(&request_id, name, &request_id, rx).await {
            Ok(decision) => decision,
            Err(reason) => return Err(stopped_message(name, reason)),
        };
        match decision {
            PermissionDecision::AllowOnce => Ok(()),
            PermissionDecision::AllowAlways => {
                self.grants.lock().unwrap().grant_mcp("repo", name);
                Ok(())
            }
            PermissionDecision::Deny => Err(format!("{}{}", refused(), deny_suffix(&request_id))),
        }
    }

    /// Prompt the user to approve a `user`-scope subagent write (it persists
    /// outside the current project). Project-scope writes are not prompted.
    pub(super) async fn prompt_subagent_create(
        &self,
        name: &str,
    ) -> Result<(PermissionDecision, String), tauri_plugin_agent_tools::lifecycle::StopReason> {
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.clone(), tx);
        let _ = self.events.send(StreamEvent::PermissionRequest {
            request_id: request_id.clone(),
            tool_name: "create_subagent".to_string(),
            capability: "write".to_string(),
            path: Some(name.to_string()),
            command: None,
            diff: None,
            patch: None,
            prompt_kind: "subagent_create".to_string(),
            offers_always: false,
            reason: None,
            args_digest: None,
            call_id: None,
        });
        let decision = self.await_decision(&request_id, "create_subagent", &request_id, rx).await?;
        Ok((decision, request_id))
    }

    /// Whether a `user`-scope subagent may be written (it persists outside the
    /// project). Under `bypass` the run has already decided, so nobody is
    /// asked; a run nobody can answer is refused with a typed reason instead
    /// of a prompt that would be auto-denied as if the user had said no.
    pub(super) async fn approve_user_subagent(&self, name: &str) -> Result<(), String> {
        if self.bypass {
            return Ok(());
        }
        if !self.can_prompt() {
            return Err(format!(
                "ERROR [approval_refused]: creating the user-scope subagent '{name}' writes outside this project, so it needs a person's approval, and nobody can be asked in this run. Use project scope, or start the run with permission mode bypass."
            ));
        }
        match self.prompt_subagent_create(name).await {
            Ok((PermissionDecision::AllowOnce | PermissionDecision::AllowAlways, _)) => Ok(()),
            Ok((PermissionDecision::Deny, request_id)) => Err(denied_by_user_message("create_subagent", &request_id)),
            Err(reason) => Err(stopped_message("create_subagent", reason)),
        }
    }

    /// `lsp`: one question for the language server that covers a file
    /// (AH-057). The path is resolved inside the project like any other path
    /// the model names; the request runs off the async runtime and is stopped
    /// by the run's own cancellation.
    /// Run a `code` script. The script's inner calls go back through
    /// [`ToolInvoker::invoke`], so nothing here has a gate of its own to get
    /// wrong: a call the gate would deny, prompt for or rule out is denied,
    /// prompted for or ruled out, and the script sees the refusal text.
    pub(super) async fn handle_code_tool(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::code_mode;
        let Some(script) = args.get("script").and_then(|v| v.as_str()) else {
            return "ERROR [invalid_input]: code takes a `script` string.".to_string();
        };
        let next = std::sync::atomic::AtomicU32::new(0);
        let result = code_mode::run(script, code_mode::Limits::default(), |name, call_args| {
            let id = format!("code-{}", next.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
            async move {
                let call = serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": call_args.to_string() }
                });
                let outcomes = ToolInvoker::invoke(self, std::slice::from_ref(&call))
                    .await
                    .map_err(|e| e.to_string())?;
                let outcome = outcomes.into_iter().next().ok_or_else(|| "no result".to_string())?;
                if outcome.refusal.is_some() || tool_outcome_failed(&name, &outcome.content) {
                    Err(outcome.content)
                } else {
                    Ok(outcome.content)
                }
            }
        })
        .await;
        match result {
            Ok(outcome) => code_mode::render(&outcome),
            Err(message) => format!("ERROR [tool_failed]: {message}"),
        }
    }

    pub(super) async fn handle_lsp_tool(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::lsp::{Action, LspError, Query};
        let text = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
        let number = |key: &str| args.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0) as usize;
        let failed = |e: &LspError| {
            let harness: tauri_plugin_agent_tools::harness_error::HarnessError = e.into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        };
        let Some(action) = Action::parse(&text("action")) else {
            return "ERROR [invalid_input]: lsp takes action definition, references, implementation, hover, diagnostics or status.".to_string();
        };
        let project = self.project_root.clone();
        let mut path = std::path::PathBuf::new();
        if action != Action::Status {
            let raw = text("path");
            if raw.is_empty() {
                return "ERROR [invalid_input]: lsp needs the `path` of a file inside the project.".to_string();
            }
            if tauri_plugin_agent_tools::tools::sandbox::escapes_project(&project, None, &raw).unwrap_or(true) {
                return format!("ERROR [sandbox_denied]: {raw:?} is outside this project.");
            }
            path = tauri_plugin_agent_tools::tools::sandbox::resolve_path(&project, None, &raw);
            if !path.is_file() {
                return format!("ERROR [invalid_input]: {raw:?} is not a file in this project.");
            }
        }
        let query = Query { action, path, line: number("line"), column: number("column") };
        let pool = self.lsp.clone();
        let token = tauri_plugin_agent_tools::lifecycle::current();
        let watch = token.clone();
        let answered = tokio::task::spawn_blocking(move || {
            pool.run(&query, token, &|| watch.as_ref().is_some_and(|t| t.is_stopped()))
        })
        .await;
        match answered {
            Ok(Ok(text)) => text,
            Ok(Err(e)) => failed(&e),
            Err(e) => format!("ERROR [internal]: the language server request did not finish: {e}"),
        }
    }

    /// Execute one subagent tool call, returning the model-facing result string
    /// (an `ERROR:`-prefixed message on failure, matching the tool-result
    /// convention). The registry is loaded fresh from disk each call so a
    /// just-created subagent is immediately dispatchable within the same run.
    pub(super) async fn handle_subagent_tool(&self, name: &str, args: &serde_json::Value) -> String {
        let Some(ctx) = &self.subagents else {
            return "ERROR: subagents are not available in this run".to_string();
        };
        match name {
            "list_subagents" => self.subagent_tool_list_subagents().await,
            "consensus" => self.subagent_tool_consensus(ctx, args).await,
            "list_subagent_runs" => self.subagent_tool_list_subagent_runs(ctx).await,
            "cancel_subagent" => self.subagent_tool_cancel_subagent(ctx, args).await,
            "symbol_find" => self.subagent_tool_symbol_find(args).await,
            "mcp_resource_list" => self.subagent_tool_mcp_resource_list().await,
            "mcp_resource_read" => self.subagent_tool_mcp_resource_read(args).await,
            "review_comments" => self.subagent_tool_review_comments(args).await,
            "commit_message" => self.subagent_tool_commit_message(args).await,
            "git_branch" => self.subagent_tool_git_branch(args).await,
            "semantic_search" => self.subagent_tool_semantic_search(args).await,
            "pull_request" => self.subagent_tool_pull_request(name, args).await,
            "git_split" | "git_history" => self.subagent_tool_git_split_git_history(name, args).await,
            "dispatch_subagent" => self.subagent_tool_dispatch_subagent(ctx, args).await,
            "await_subagent" => self.subagent_tool_await_subagent(ctx, args).await,
            "create_subagent" => self.subagent_tool_create_subagent(args).await,
            _ => "ERROR: unknown subagent tool".to_string(),
        }
    }

    /// The `list_subagents` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_list_subagents(&self) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let surface =
            crate::core::agent::subagent::surface_for_project_root(&self.project_root);
        let registry = SubagentRegistry::load_for(&self.project_root, surface);
        format_subagent_list(&registry)
    }

    /// The `consensus` arm of [`Self::handle_subagent_tool`].
    // AH-102: the run's own children, listed and cancelled one at a
    // time. Both are confined to this parent's registry, so a run id
    // from another run names nothing here.
    async fn subagent_tool_consensus(&self, ctx: &SubagentContext, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        use crate::core::agent::consensus;
        let text = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
        let failed = |e: &tauri_plugin_agent_tools::harness_error::HarnessError| {
            format!("ERROR [{}]: {}", e.kind().tag(), e.message())
        };
        let data = crate::core::app::commands::resolve_jan_data_folder();
        let project = self.project_root.clone();
        let id = text("id");
        if !id.is_empty() {
            return match consensus::load(&data, &project, &id) {
                Ok(record) => consensus::render(&record),
                Err(e) => failed(&e),
            };
        }
        let question = text("question");
        let context = text("context");
        let reviewers: Vec<String> = args
            .get("reviewers")
            .and_then(|v| v.as_array())
            .map(|list| list.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();
        let surface =
            crate::core::agent::subagent::surface_for_project_root(&self.project_root);
        let registry = SubagentRegistry::load_for(&self.project_root, surface);
        // A saved subagent may sit on a gate only if every tool it may
        // use reads: one that can write could change what it judges.
        let is_read_only = |name: &str| -> Option<bool> {
            let definition = registry.get(name)?;
            Some(definition.allowed_tools.as_ref().is_some_and(|tools| {
                !tools.is_empty()
                    && tools.iter().all(|tool| {
                        tauri_plugin_agent_tools::tools::lookup(tool).is_some_and(|t| {
                            matches!(
                                t.capability,
                                tauri_plugin_agent_tools::tools::Capability::Read
                                    | tauri_plugin_agent_tools::tools::Capability::Net
                            )
                        })
                    })
            }))
        };
        let quorum = match consensus::check_request(&question, &reviewers, &text("quorum"), &is_read_only) {
            Ok(quorum) => quorum,
            Err(e) => return failed(&e),
        };
        let parent = crate::core::agent::subagent::ParentRun {
            routing: self.routing.clone(),
            conversation: None,
            model: ctx.model_id.clone(),
            budget_remaining: ctx.tokens_remaining(),
            token_rates: ctx.token_rates(),
            usd_remaining: ctx.usd_remaining(),
            send_reasoning: ctx.send_reasoning,
            model_settings: crate::core::agent::subagent::load_model_settings(),
        };
        // Every reviewer is dispatched before any is awaited, so they
        // work at the same time and none waits on another's answer.
        let mut dispatched = Vec::new();
        for reviewer in &reviewers {
            let request = crate::core::agent::subagent::SubagentRequest {
                subagent_name: reviewer.clone(),
                description: consensus::brief(reviewer, &question, &context),
                allowed_tools: None,
                system_prompt: None,
                isolate: None,
                fork_context: false,
                durable: false,
                max_turns: None,
                title: None,
            };
            let run = spawn_subagent(&ctx.bg, &ctx.parent_args, request, &parent, &self.events).map_err(|e| e.to_string());
            dispatched.push((reviewer.clone(), run));
        }
        let mut verdicts = Vec::new();
        let mut cancelled = false;
        for (reviewer, run) in dispatched {
            let answer = match run {
                Ok(run_id) => match await_subagent(&ctx.bg, &run_id).await {
                    Ok(text) => Ok(text),
                    Err(crate::core::agent::subagent::SubagentError::Cancelled) => {
                        cancelled = true;
                        Err("cancelled".to_string())
                    }
                    Err(e) => Err(e.to_string()),
                },
                Err(e) => Err(e),
            };
            verdicts.push(match &answer {
                Ok(text) => consensus::read_verdict(&reviewer, Ok(text)),
                Err(why) => consensus::read_verdict(&reviewer, Err(why)),
            });
        }
        if tauri_plugin_agent_tools::lifecycle::current().is_some_and(|t| t.is_stopped()) {
            cancelled = true;
        }
        let outcome = consensus::decide(quorum, reviewers.len(), &verdicts, cancelled);
        let record = consensus::Record {
            version: consensus::RECORD_VERSION,
            id: consensus::new_id(),
            question,
            quorum,
            reviewers,
            verdicts,
            outcome,
            session: ctx.parent_args.session_id.clone().unwrap_or_default(),
            run: self.cancel_scope.run.clone(),
            decided_at: tauri_plugin_agent_tools::audit::now(),
        };
        self.invocations.note(
            "consensus.decided",
            serde_json::json!({
                "gate": record.id,
                "outcome": record.outcome.tag(),
                "reviewers": record.reviewers.len(),
                "approvals": record.verdicts.iter().filter(|v| v.vote == consensus::Vote::Approve).count(),
            }),
        );
        match consensus::save(&data, &project, &record) {
            Ok(_) => consensus::render(&record),
            Err(e) => format!(
                "ERROR [{}]: the gate was decided ({}) but could not be recorded, so it does not count: {}",
                e.kind().tag(),
                record.outcome.tag(),
                e.message()
            ),
        }
    }

    /// The `list_subagent_runs` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_list_subagent_runs(&self, ctx: &SubagentContext) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let mut out = crate::core::agent::subagent::format_subagent_runs(&ctx.bg.list());
        if let Some(report) = ctx.bg.failure_report(None) {
            out.push_str("\n\n");
            out.push_str(&report);
        }
        let durable = crate::core::agent::durable_subagent::list(
            std::path::Path::new(&ctx.parent_args.jan_data_folder),
            ctx.parent_args.session_id.as_deref().unwrap_or_default(),
        );
        if !durable.is_empty() {
            out.push_str("\n\n");
            out.push_str(&crate::core::agent::durable_subagent::format_durable(&durable));
        }
        out
    }

    /// The `cancel_subagent` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_cancel_subagent(&self, ctx: &SubagentContext, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let run_id = match parse_await_args(args) {
            Ok(r) => r,
            Err(e) => return format!("ERROR: {e}"),
        };
        let data = std::path::Path::new(&ctx.parent_args.jan_data_folder);
        let owner = ctx.parent_args.session_id.as_deref().unwrap_or_default();
        if crate::core::agent::durable_subagent::is_durable(data, owner, &run_id) {
            return match tauri_plugin_agent_tools::worker::cancel(data, owner, &run_id) {
                Ok(state) => {
                    self.invocations.note(
                        "agent.ended",
                        serde_json::json!({ "child": run_id, "stoppedBy": "cancelled", "mode": "durable" }),
                    );
                    format!("Durable subagent {run_id} is now {}.", state.tag())
                }
                Err(e) => format!("ERROR [{}]: {}", e.kind().tag(), e.message()),
            };
        }
        let cancelled = ctx.bg.cancel(&run_id);
        // Only a run this call actually stopped is an ending: one that
        // had already finished, or was never this parent's, is not.
        if matches!(
            cancelled,
            crate::core::agent::subagent::SubagentCancelOutcome::CancelledQueued
                | crate::core::agent::subagent::SubagentCancelOutcome::CancelledRunning
        ) {
            self.invocations.note(
                "agent.ended",
                serde_json::json!({ "child": run_id, "stoppedBy": "cancelled" }),
            );
        }
        crate::core::agent::subagent::format_subagent_cancel(&run_id, cancelled)
    }

    /// The `symbol_find` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_symbol_find(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if name.is_empty() {
            return "ERROR [invalid_input]: symbol_find needs a `name`.".to_string();
        }
        let want_uses = args
            .get("uses")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let want_calls = args
            .get("calls")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let data = crate::core::app::commands::resolve_jan_data_folder();
        let project = self.project_root.clone();
        // The first build of a large project can take a while: off the
        // runtime, and stopped with the run.
        let registered = self.call_token("symbol_find");
        let refreshed = blocking_with_cancel(registered.token().clone(), move |cancel| {
            crate::core::agent::index::refresh(&data, &project, cancel)
        })
        .await;
        drop(registered);
        let Some(refreshed) = refreshed else {
            return "ERROR [io]: the symbol index build stopped unexpectedly.".to_string();
        };
        match refreshed {
            Ok((index, _)) => {
                let mut out = String::new();
                let definitions =
                    crate::core::agent::index::find_symbol(&index, &name, 20);
                if definitions.is_empty() {
                    out.push_str(&format!(
                        "Nothing named {name:?} is defined in the {} files indexed here.\n",
                        index.files.len()
                    ));
                }
                for hit in &definitions {
                    out.push_str(&format!(
                        "{}:{} defines {} ({:?})\n",
                        hit.path, hit.line, hit.name, hit.kind
                    ));
                }
                if want_uses {
                    let uses =
                        crate::core::agent::index::find_references(&index, &name, 100);
                    out.push_str(&format!("\n{} use(s):\n", uses.len()));
                    for hit in uses {
                        out.push_str(&format!(
                            "{}:{}{} {}\n",
                            hit.path,
                            hit.line,
                            if hit.is_definition { " (definition)" } else { "" },
                            hit.text
                        ));
                    }
                }
                if want_calls {
                    // AH-062: who calls it, and what it calls. Named
                    // as places to look rather than as a call graph:
                    // the reading is line-shaped, so a name used as a
                    // value reads like a call.
                    let walk =
                        crate::core::agent::index::hierarchy(&index, &name, 50);
                    out.push_str(&format!("

{} caller(s):
", walk.callers.len()));
                    for call in &walk.callers {
                        out.push_str(&format!(
                            "{}:{} in {}
",
                            call.path,
                            call.line,
                            call.within.as_deref().unwrap_or("(top level)")
                        ));
                    }
                    out.push_str(&format!("
{} call(s) made:
", walk.callees.len()));
                    for call in &walk.callees {
                        out.push_str(&format!("{}:{} {}
", call.path, call.line, call.name));
                    }
                }
                out.trim_end().to_string()
            }
            Err(e) => {
                let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
                    (&e).into();
                format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
            }
        }
    }

    /// The `mcp_resource_list` arm of [`Self::handle_subagent_tool`].
    // AH-137: an MCP server's documents, which are read rather than
    // run. Both are reads, so Plan mode keeps them.
    async fn subagent_tool_mcp_resource_list(&self) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        crate::core::agent::upstream::list_mcp_resources(&self.mcp.mcp_servers).await
    }

    /// The `mcp_resource_read` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_mcp_resource_read(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let server = args.get("server").and_then(|v| v.as_str()).unwrap_or_default();
        let uri = args.get("uri").and_then(|v| v.as_str()).unwrap_or_default();
        crate::core::agent::upstream::read_mcp_resource(
            &self.mcp.mcp_servers,
            server,
            uri,
        )
        .await
    }

    /// The `review_comments` arm of [`Self::handle_subagent_tool`].
    // AH-164. A review, worked through one comment at a time, with
    // "addressed" checked against the file rather than believed.
    async fn subagent_tool_review_comments(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let data = crate::core::app::commands::resolve_jan_data_folder();
        let project = self.project_root.clone();
        let text = |key: &str| {
            args.get(key)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let failed = |e: &crate::core::agent::review::ReviewError| {
            let harness: tauri_plugin_agent_tools::harness_error::HarnessError = e.into();
            format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
        };

        let source = text("load");
        if !source.is_empty() {
            // A path the model supplies, resolved inside the project
            // like any other path it names.
            let path = tauri_plugin_agent_tools::tools::sandbox::resolve_path(
                &project, None, &source,
            );
            if tauri_plugin_agent_tools::tools::sandbox::escapes_project(
                &project, None, &source,
            )
            .unwrap_or(true)
            {
                return format!(
                    "ERROR [sandbox_denied]: {source:?} is outside this project."
                );
            }
            return match crate::core::agent::review::load(&data, &project, &path) {
                Ok(review) => crate::core::agent::review::render(&review),
                Err(e) => failed(&e),
            };
        }

        let id = text("id");
        if id.is_empty() {
            return match crate::core::agent::review::current(&data, &project) {
                Some(review) => crate::core::agent::review::render(&review),
                None => "No review is loaded. Call this with `load` set to the path of \
                                 the review file."
                    .to_string(),
            };
        }
        let outcome = match text("outcome").as_str() {
            "addressed" => crate::core::agent::review::Outcome::Addressed,
            "answered" => crate::core::agent::review::Outcome::Answered,
            other => {
                return format!(
                    "ERROR [invalid_input]: `outcome` is addressed or answered; \
                             {other:?} is neither."
                )
            }
        };
        match crate::core::agent::review::reply(
            &data,
            &project,
            &id,
            outcome,
            &text("reply"),
        ) {
            Ok(_) => match crate::core::agent::review::current(&data, &project) {
                Some(review) => crate::core::agent::review::render(&review),
                None => "recorded".to_string(),
            },
            Err(e) => failed(&e),
        }
    }

    /// The `commit_message` arm of [`Self::handle_subagent_tool`].
    // AH-159. The harness supplies the change; the model writes the
    // words; the harness checks the words against the change. Nothing
    // here commits anything.
    async fn subagent_tool_commit_message(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let root = self.project_root.clone();
        let change = match crate::core::agent::vcs::staged(&root) {
            Ok(change) => change,
            Err(e) => {
                let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
                    (&e).into();
                return format!("ERROR [{}]: {}", harness.kind().tag(), e.message);
            }
        };
        match args.get("message").and_then(|v| v.as_str()) {
            // No message yet: this is the ask, so hand back what the
            // message has to describe.
            None => format!(
                "{}\n\nWrite the message and call this again with `message`. A subject \
                         of at most {} characters, then a blank line, then why. Describe only \
                         what is staged.",
                crate::core::agent::vcs::message_brief(&change),
                crate::core::agent::vcs::MAX_SUBJECT
            ),
            Some(message) => {
                match crate::core::agent::vcs::check_message(message, &change) {
                    Ok(checked) => format!(
                        "This message describes the staged change. Nothing has been \
                                 committed; run the commit yourself when you are ready.\n\n{checked}"
                    ),
                    Err(e) => {
                        let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
                            (&e).into();
                        format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
                    }
                }
            }
        }
    }

    /// The `git_branch` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_git_branch(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        // AH-161. Listing is reading; creating or switching changes
        // the checkout, so it is a write and Plan mode does not offer
        // it (the check below is defence in depth against a stale
        // schema).
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("list")
            .trim()
            .to_string();
        let branch = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let root = self.project_root.clone();
        let changes = action == "create" || action == "switch";
        if changes && self.run_mode == crate::core::agent::plan::RunMode::Plan {
            return plan_mode_read_only_msg("git_branch");
        }
        let answer = match action.as_str() {
            "list" => crate::core::agent::vcs::branches(&root).map(|branches| {
                let mut out = String::new();
                for b in &branches {
                    out.push_str(&format!(
                        "{}{}{}{}\n",
                        if b.current { "* " } else { "  " },
                        b.name,
                        b.upstream
                            .as_ref()
                            .map(|u| format!(" -> {u}"))
                            .unwrap_or_default(),
                        if b.checked_out_elsewhere {
                            " (checked out in another worktree)"
                        } else {
                            ""
                        }
                    ));
                }
                if branches.is_empty() {
                    out.push_str("no branches");
                }
                out.trim_end().to_string()
            }),
            "create" | "switch" => {
                crate::core::agent::vcs::switch_branch(&root, &branch, action == "create")
                    .map(|change| change.note)
            }
            other => {
                return format!(
                    "ERROR [invalid_input]: git_branch takes action list, create or \
                             switch; {other:?} is not one of them. Deleting a branch is not \
                             offered: a branch is often the only record of work that is not \
                             merged."
                )
            }
        };
        match answer {
            Ok(text) => text,
            Err(e) => {
                let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
                    (&e).into();
                format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
            }
        }
    }

    /// The `semantic_search` arm of [`Self::handle_subagent_tool`].
    // AH-160, AH-166, AH-167. These change history, so Plan mode does
    // not offer them and refuses them here too; every refusal and the
    // backup that makes each step recoverable live in `vcs`.
    // AH-162, AH-163. A pull request from the branch, with a description
    // the harness keeps in step with it. Never pushes, comments, requests
    // reviewers or notifies; the refusals and the token's limits are in
    // `pull_request`.
    // AH-071. Search by meaning with the embedding model the user named;
    // without one this says so and searches nothing -- it never falls
    // back to a text search under this name.
    async fn subagent_tool_semantic_search(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        use crate::core::agent::semantic;
        let failed = |e: &tauri_plugin_agent_tools::harness_error::HarnessError| {
            format!("ERROR [{}]: {}", e.kind().tag(), e.message())
        };
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(semantic::DEFAULT_RESULTS);
        let embedder = match semantic::configured() {
            Ok(e) => e,
            Err(e) => return failed(&e),
        };
        if query.is_empty() {
            return "ERROR [invalid_input]: a semantic search needs a query".to_string();
        }
        let root = self.project_root.clone();
        let data = crate::core::app::commands::resolve_jan_data_folder();
        let token = tauri_plugin_agent_tools::lifecycle::current();
        let http = semantic::HttpEmbedder { embedder: embedder.clone(), cancel: token.clone() };
        let cancelled = move || token.as_ref().is_some_and(|t| t.is_stopped());
        match semantic::refresh(&data, &root, &embedder.id, &http, &cancelled).await {
            Ok((store, update)) => match semantic::search(&root, &store, &query, limit, &http).await {
                Ok(hits) => semantic::render(&root, &store, &update, &hits),
                Err(e) => failed(&e),
            },
            Err(e) => failed(&e),
        }
    }

    /// The `pull_request` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_pull_request(&self, name: &str, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        use crate::core::agent::pull_request as pr;
        if self.run_mode == crate::core::agent::plan::RunMode::Plan {
            return plan_mode_read_only_msg(name);
        }
        let text = |key: &str| {
            args.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
        };
        let failed = |e: &tauri_plugin_agent_tools::harness_error::HarnessError| {
            format!("ERROR [{}]: {}", e.kind().tag(), e.message())
        };
        let root = self.project_root.clone();
        let data = crate::core::app::commands::resolve_jan_data_folder();
        let branch = match crate::core::agent::vcs::divergence(&root) {
            Ok(d) => d.branch,
            Err(e) => return failed(&(&e).into()),
        };
        let recorded = match &branch {
            Some(b) => match pr::load(&data, &root, b) {
                Ok(r) => r,
                Err(e) => return failed(&e),
            },
            None => None,
        };
        let forge = || -> Result<pr::Forge, tauri_plugin_agent_tools::harness_error::HarnessError> {
            let api = pr::api_base()?;
            let token = pr::token_for(&api, &|n| std::env::var(n).ok())?;
            Ok(pr::Forge { api, token, cancel: tauri_plugin_agent_tools::lifecycle::current() })
        };
        match text("action").as_str() {
            "status" => {
                let Some(record) = recorded else {
                    return "no pull request has been opened from this branch by Jan".to_string();
                };
                let head = match pr::change(&root, &record.base) {
                    Ok(change) => change.head,
                    Err(e) => return format!("pull request #{} ({}): the branch cannot be described right now -- {}", record.number, record.url, failed(&e)),
                };
                if head == record.head {
                    format!("pull request #{} ({}): the description is in step with the branch at {}", record.number, record.url, &head[..head.len().min(12)])
                } else {
                    format!("pull request #{} ({}): the description is out of step -- it was written for {} and the branch is at {}; call sync", record.number, record.url, &record.head[..record.head.len().min(12)], &head[..head.len().min(12)])
                }
            }
            "create" => {
                let base = match text("base") { b if b.is_empty() => "main".to_string(), b => b };
                let change = match pr::change(&root, &base) {
                    Ok(c) => c,
                    Err(e) => return failed(&e),
                };
                // Checked before the forge is asked anything.
                if let Err(e) = pr::compose(&text("title"), &text("body"), &change) {
                    return failed(&e);
                }
                let forge = match forge() {
                    Ok(f) => f,
                    Err(e) => return failed(&e),
                };
                if let Err(refused) = self.approve_forge_mutation("open", &forge.api.origin().ascii_serialization()).await {
                    return refused;
                }
                let footer = self.attribution.as_ref().is_some_and(|(_, s)| s.pull_requests);
                match forge.create(&data, &root, &change, &text("title"), &text("body"), footer).await {
                    Ok((record, how)) => format!("{how} pull request #{}: {}", record.number, record.url),
                    Err(e) => failed(&e),
                }
            }
            "sync" => {
                let forge = match forge() {
                    Ok(f) => f,
                    Err(e) => return failed(&e),
                };
                let Some(record) = recorded else {
                    return "ERROR [not_found]: no pull request has been opened from this branch by Jan; create one first".to_string();
                };
                let change = match pr::change(&root, &record.base) {
                    Ok(c) => c,
                    Err(e) => return failed(&e),
                };
                if let Err(refused) = self.approve_forge_mutation("update", &forge.api.origin().ascii_serialization()).await {
                    return refused;
                }
                match forge.sync(&data, &root, &record, &change).await {
                    Ok(true) => format!("updated the description of pull request #{} for {}", record.number, &change.head[..change.head.len().min(12)]),
                    Ok(false) => format!("pull request #{} is already in step with the branch", record.number),
                    Err(e) => failed(&e),
                }
            }
            other => format!(
                "ERROR [invalid_input]: pull_request takes action create, sync or status; {other:?} is not one of them."
            ),
        }
    }

    /// The `git_split | git_history` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_git_split_git_history(&self, name: &str, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        use crate::core::agent::vcs;
        if self.run_mode == crate::core::agent::plan::RunMode::Plan {
            return plan_mode_read_only_msg(name);
        }
        let root = self.project_root.clone();
        let text = |key: &str| {
            args.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_string()
        };
        let answer = if name == "git_split" {
            match serde_json::from_value::<Vec<vcs::SplitGroup>>(
                args.get("groups").cloned().unwrap_or_default(),
            ) {
                Err(e) => {
                    return format!(
                        "ERROR [invalid_input]: `groups` must be a list of {{files, message}}: {e}"
                    )
                }
                Ok(mut groups) => {
                    // Each commit of the split carries Flint's co-author
                    // trailer, as a `git commit` through the git tool does.
                    attribute_split(self.attribution.as_ref(), &mut groups);
                    let scope = tauri_plugin_agent_tools::lifecycle::current();
                    vcs::apply_split(&root, &groups, &|| {
                        scope.as_ref().is_some_and(|t| t.is_stopped())
                    })
                    .map(|outcome| vcs::render_split(&outcome))
                }
            }
        } else {
            match text("action").as_str() {
                "status" => vcs::history_status(&root),
                "rebase" => vcs::rebase_start(&root, &text("onto")).map(|op| vcs::render_op(&op)),
                "cherry_pick" => vcs::cherry_pick(&root, &text("commit")).map(|op| vcs::render_op(&op)),
                "continue" => vcs::continue_op(&root, &text("backup")).map(|op| vcs::render_op(&op)),
                "abort" => vcs::abort_op(&root, &text("backup")).map(|op| vcs::render_op(&op)),
                other => {
                    return format!(
                        "ERROR [invalid_input]: git_history takes action status, rebase, \
                                 cherry_pick, continue or abort; {other:?} is not one of them."
                    )
                }
            }
        };
        match answer {
            Ok(text) => text,
            Err(e) => {
                let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
                    (&e).into();
                format!("ERROR [{}]: {}", harness.kind().tag(), e.message)
            }
        }
    }

    /// The `dispatch_subagent` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_dispatch_subagent(&self, ctx: &SubagentContext, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let req = match parse_dispatch_args(args) {
            Ok(r) => r,
            Err(e) => return format!("ERROR: {e}"),
        };
        let child_name = req.subagent_name.clone();
        // AH-101: a durable child is a job of its own, not a task in
        // this process.
        if req.durable {
            return match crate::core::agent::durable_subagent::dispatch(
                &ctx.parent_args,
                req,
                &crate::core::agent::subagent::ParentRun {
                    routing: self.routing.clone(),
                    conversation: None,
                    model: ctx.model_id.clone(),
                    budget_remaining: ctx.tokens_remaining(),
                    token_rates: ctx.token_rates(),
                    usd_remaining: ctx.usd_remaining(),
                    send_reasoning: ctx.send_reasoning,
                    model_settings: crate::core::agent::subagent::load_model_settings(),
                },
            ) {
                Ok(run_id) => {
                    self.invocations.note(
                        "agent.dispatched",
                        serde_json::json!({
                            "child": run_id,
                            "agent": child_name,
                            "mode": "durable",
                            "parentRun": self.cancel_scope.run,
                        }),
                    );
                    format!(
                        "Durable subagent started as a job of its own. run_id={run_id}. It keeps running if this run or the app ends. Call await_subagent with this run_id to collect its result -- also from a later run of this conversation; list_subagent_runs shows it and cancel_subagent stops it. Anything it would need approval for is denied, because nobody is attached to it."
                    )
                }
                Err(e) => format!("ERROR: {e}"),
            };
        }
        // AH-100: a fork copies the conversation this turn is
        // dispatching from. Read here rather than held by the child,
        // so what it gets is what the parent had when it asked.
        let forked = req.fork_context.then(|| {
            self.live_conversation
                .lock()
                .map(|live| live.clone())
                .unwrap_or_default()
        });
        match spawn_subagent(
            &ctx.bg,
            &ctx.parent_args,
            req,
            &crate::core::agent::subagent::ParentRun {
                routing: self.routing.clone(),
                conversation: forked,
                model: ctx.model_id.clone(),
                budget_remaining: ctx.tokens_remaining(),
                token_rates: ctx.token_rates(),
                usd_remaining: ctx.usd_remaining(),
                send_reasoning: ctx.send_reasoning,
                model_settings: crate::core::agent::subagent::load_model_settings(),
            },
            &self.events,
        ) {
            Ok(run_id) => {
                // AH-004: the parent's record says which child it
                // started and which request asked for it, so a nested
                // run is reachable from the run that caused it.
                self.invocations.note(
                    "agent.dispatched",
                    serde_json::json!({
                        "child": run_id,
                        "agent": child_name,
                        "mode": "background",
                        "parentRun": self.cancel_scope.run,
                    }),
                );
                let mut out = format!(
                    "Subagent started in the background. run_id={run_id}. Continue working, then call await_subagent with this run_id to collect its result. While it runs you can send it a message with message_send (to={run_id}), and read anything it sends you with message_check."
                );
                if let Some(c) = ctx.bg.checkout_of(&run_id) {
                    out.push_str(&format!(
                        " It works in a checkout of its own at {} (branch {}), so its changes are not in the project until the user reviews and applies them.",
                        c.path, c.branch
                    ));
                }
                out
            }
            Err(e) => format!("ERROR: {e}"),
        }
    }

    /// The `await_subagent` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_await_subagent(&self, ctx: &SubagentContext, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let run_id = match parse_await_args(args) {
            Ok(r) => r,
            Err(e) => return format!("ERROR: {e}"),
        };
        // Reading the rest of an answer that came back shortened: it
        // was already collected, so there is nothing to wait for.
        if let Some(offset) = crate::core::agent::subagent::parse_await_offset(args) {
            return crate::core::agent::subagent::read_retained_result(&run_id, offset);
        }
        let data = std::path::Path::new(&ctx.parent_args.jan_data_folder);
        let owner = ctx.parent_args.session_id.as_deref().unwrap_or_default();
        let awaited = if crate::core::agent::durable_subagent::is_durable(data, owner, &run_id) {
            crate::core::agent::durable_subagent::await_child(
                data,
                owner,
                &run_id,
                std::time::Duration::from_millis(500),
                || false,
            )
            .await
            .map_err(|e| crate::core::agent::subagent::SubagentError::Upstream(e.message().to_string()))
        } else {
            await_subagent(&ctx.bg, &run_id).await
        };
        // How the child ended, against the parent's run. Sizes only:
        // the child's own report is its own record.
        self.invocations.note(
            "agent.ended",
            match &awaited {
                Ok(text) => serde_json::json!({
                    "child": run_id,
                    "stoppedBy": "done",
                    "textChars": text.chars().count(),
                }),
                Err(e) => serde_json::json!({
                    "child": run_id,
                    "stoppedBy": "error",
                    "detail": bound_detail(&e.to_string()),
                }),
            },
        );
        let outcome = match awaited {
            Ok(text) if text.trim().is_empty() => {
                "The subagent finished but produced no text output.".to_string()
            }
            Ok(text) => text,
            Err(e) => format!("ERROR: {e}"),
        };
        // Which other children have failed, so a parent collecting one
        // answer is not the last to learn that a sibling went wrong.
        let outcome = match ctx.bg.failure_report(Some(&run_id)) {
            Some(report) => format!("{outcome}\n\n{report}"),
            None => outcome,
        };
        // A child's report reads as "done" whether or not its changes
        // are anywhere the user can see; this says where they are.
        match ctx.bg.checkout_of(&run_id) {
            Some(c) => format!(
                "{outcome}\n\n(Its changes are in its own checkout at {} on branch {}, waiting for the user's review; none has been applied to the project.)",
                c.path, c.branch
            ),
            None => outcome,
        }
    }

    /// The `create_subagent` arm of [`Self::handle_subagent_tool`].
    async fn subagent_tool_create_subagent(&self, args: &serde_json::Value) -> String {
        #[allow(unused_imports)]
        use crate::core::agent::subagent::{
            await_subagent, format_subagent_list, parse_await_args, parse_create_args,
            parse_dispatch_args, spawn_subagent, subagent_dir_for, SubagentRegistry, SubagentScope,
        };
        let (def, scope, overwrite) = match parse_create_args(args) {
            Ok(v) => v,
            Err(e) => return format!("ERROR: {e}"),
        };
        if scope == SubagentScope::User {
            if let Err(refused) = self.approve_user_subagent(&def.name).await {
                return refused;
            }
        }
        let dir = match subagent_dir_for(&self.project_root, scope) {
            Ok(d) => d,
            Err(e) => return format!("ERROR: {e}"),
        };
        let scope_label = match scope {
            SubagentScope::User => "user",
            SubagentScope::Project => "project",
            // Unreachable: create_subagent rejects the plugin and
            // built-in scopes before this point.
            SubagentScope::Plugin => "plugin",
            SubagentScope::Builtin => "built-in",
        };
        let mut registry = SubagentRegistry::load(&self.project_root);
        match registry.create_in(&dir, def.clone(), scope, overwrite) {
            Ok(shadows) => {
                let mut msg =
                    format!("Created {scope_label}-scope subagent '{}'.", def.name);
                if shadows {
                    msg.push_str(
                        " Note: it shadows a user-scope subagent of the same name.",
                    );
                }
                msg
            }
            Err(e) => format!("ERROR: {e}"),
        }
    }


    pub(super) async fn handle_ask_tool(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::interaction::{register, AskError, AskRequest};

        let Some(registry) = &self.ask_requests else {
            return "ERROR [interactive_ui_required]: ask requires an attached interactive UI"
                .to_string();
        };
        let request = match AskRequest::parse(args) {
            Ok(request) => request,
            Err(error) => return format!("ERROR: {error}"),
        };
        let (request_id, receiver) = register(registry).await;
        // Resolve the configured timeout once, before sending the event: the
        // same value both arms the timer below and rides on the event so the
        // TUI can render a countdown without re-reading config (and so the
        // displayed deadline never disagrees with actual enforcement).
        let timeout = ask_timeout_setting();
        if self
            .events
            .send(StreamEvent::AskRequest {
                request_id: request_id.clone(),
                request: request.clone(),
                timeout_secs: timeout.map(|d| d.as_secs()),
            })
            .is_err()
        {
            let _ = crate::core::agent::interaction::respond(
                registry,
                &request_id,
                Err(AskError::Cancelled),
            )
            .await;
            return "ERROR [ask_cancelled]: interactive UI disconnected".to_string();
        }
        let outcome = match timeout {
            Some(duration) => match tokio::time::timeout(duration, receiver).await {
                Ok(received) => received,
                Err(_elapsed) => {
                    // No answer in time: auto-select each question's recommended
                    // (else first) option. Deregister so a late user answer is
                    // rejected, and tell the UI to drop the now-dead prompt. This
                    // is a distinct resolution from a user cancel, so it never
                    // returns the `ask_cancelled` error below.
                    let results = request.auto_selected_results();
                    let _ = crate::core::agent::interaction::respond(
                        registry,
                        &request_id,
                        Ok(results.clone()),
                    )
                    .await;
                    let _ = self.events.send(StreamEvent::AskResolved {
                        request_id: request_id.clone(),
                    });
                    return format!(
                        "NOTE [ask_timeout]: no answer within the configured ask timeout; auto-selected the recommended (else first) option(s).\n{}",
                        request.render_results(&results)
                    );
                }
            },
            None => receiver.await,
        };
        match outcome {
            Ok(Ok(results)) => match request.validate_results(&results) {
                Ok(()) => request.render_results(&results),
                Err(error) => format!("ERROR: invalid ask response: {error}"),
            },
            Ok(Err(AskError::Cancelled)) | Err(_) => {
                "ERROR [ask_cancelled]: user cancelled the question".to_string()
            }
        }
    }

    /// Applies one todo mutation and emits `StreamEvent::TodoUpdate` with the
    /// full resulting snapshot so session history can reconstruct state.
    pub(super) async fn handle_todo_tool(&self, args: &serde_json::Value) -> String {
        use crate::core::agent::todo::{parse_target, render_result, TodoPhase};
        let Some(registry) = &self.todo_registry else {
            return "ERROR [todo_unavailable]: todo tool requires an attached session".to_string();
        };
        let op = args.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let mut list = registry.lock().await;
        let result: Result<(), String> = match op {
            "init" => {
                let phases = if let Some(list_val) = args.get("list").and_then(|v| v.as_array()) {
                    list_val
                        .iter()
                        .map(|p| {
                            let name = p
                                .get("phase")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let items = p
                                .get("items")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str())
                                        .map(|s| crate::core::agent::todo::TodoItem {
                                            content: s.to_string(),
                                            status: crate::core::agent::todo::TodoStatus::Pending,
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            TodoPhase { name, tasks: items }
                        })
                        .collect()
                } else if let Some(items) = args.get("items").and_then(|v| v.as_array()) {
                    vec![TodoPhase {
                        name: String::new(),
                        tasks: items
                            .iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| crate::core::agent::todo::TodoItem {
                                content: s.to_string(),
                                status: crate::core::agent::todo::TodoStatus::Pending,
                            })
                            .collect(),
                    }]
                } else {
                    return "ERROR: init requires 'list' or 'items'".to_string();
                };
                list.init(phases)
            }
            "start" => match args.get("task").and_then(|v| v.as_str()) {
                Some(task) => list.start(task),
                None => return "ERROR: start requires 'task'".to_string(),
            },
            "done" => match parse_target(args) {
                Ok(target) => list.done(target),
                Err(e) => return format!("ERROR: {e}"),
            },
            "drop" => match parse_target(args) {
                Ok(target) => list.drop_target(target),
                Err(e) => return format!("ERROR: {e}"),
            },
            "rm" => match parse_target(args) {
                Ok(target) => list.rm(target),
                Err(e) => return format!("ERROR: {e}"),
            },
            "append" => {
                let phase = args.get("phase").and_then(|v| v.as_str()).unwrap_or("");
                let items: Vec<String> = args
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default();
                if phase.is_empty() || items.is_empty() {
                    return "ERROR: append requires 'phase' and non-empty 'items'".to_string();
                }
                list.append(phase, items)
            }
            "view" => Ok(()),
            other => return format!("ERROR: unknown todo op '{other}'"),
        };
        match result {
            Ok(()) => {
                let snapshot = list.clone();
                drop(list);
                let _ = self.events.send(StreamEvent::TodoUpdate {
                    list: snapshot.clone(),
                });
                render_result(&snapshot)
            }
            Err(error) => format!("ERROR: {error}"),
        }
    }
}

impl CompositeToolInvoker {
    /// Split a batch by the project's `[[tool_rules]]`: the calls that may run,
    /// and the ones a rule refused, each with its position in the batch. Each
    /// call that passes is noted at once, so `max_calls` and `no_repeat` see
    /// the calls listed before it in the same batch; `after` only counts calls
    /// that ran and succeeded, which are noted once the batch's results are in.
    pub(super) fn apply_tool_rules(
        &self,
        tool_calls: &[serde_json::Value],
    ) -> (Vec<serde_json::Value>, Vec<(usize, ToolOutcome)>) {
        if self.tool_rules.is_empty() {
            return (tool_calls.to_vec(), Vec::new());
        }
        let mut log = self.call_log.lock().unwrap();
        let mut allowed = Vec::new();
        let mut refused = Vec::new();
        for (index, call) in tool_calls.iter().enumerate() {
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default();
            let args = parse_tool_args(call).unwrap_or(serde_json::Value::Null);
            match log.refusal(&self.tool_rules, name, &args) {
                Some(text) => {
                    let id = call.get("id").and_then(|i| i.as_str()).unwrap_or_default();
                    refused.push((index, ToolOutcome::refused_by_rule(id.to_string(), text)));
                }
                None => {
                    allowed.push(call.clone());
                    log.record(name, &args);
                }
            }
        }
        (allowed, refused)
    }

    /// Who this run acts as, as the execution record names an agent.
    pub(super) fn agent_name(&self) -> String {
        use tauri_plugin_agent_tools::subject::Subject;
        match &self.subject {
            Subject::MainAgent => "main".to_string(),
            Subject::NamedAgent(n) | Subject::AgentRole(n) => n.clone(),
            other => other.to_string(),
        }
    }

    /// The durable identity the record attributes this run's calls to
    /// (AH-110): the subject spelling, so a renamed agent does not rewrite
    /// what an old event points at. Empty for a subject that is not an agent.
    pub(super) fn agent_identity(&self) -> String {
        use tauri_plugin_agent_tools::subject::Subject;
        match &self.subject {
            Subject::MainAgent => "agent".to_string(),
            Subject::NamedAgent(n) => format!("agent:{n}"),
            Subject::AgentRole(n) => format!("role:{n}"),
            _ => String::new(),
        }
    }

    pub(super) fn activity_event(
        &self,
        tc: &serde_json::Value,
        phase: tauri_plugin_agent_tools::activity::Phase,
    ) -> tauri_plugin_agent_tools::activity::ToolActivityEvent {
        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let function = tc.get("function");
        let name = function.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("");
        let mut e = tauri_plugin_agent_tools::activity::ToolActivityEvent::new(id, name, phase);
        e.session = self.cancel_scope.session.clone();
        e.run = self.cancel_scope.run.clone();
        e.agent = self.agent_name();
        e.agent_id = self.agent_identity();
        // The request that asked for this call, so the record joins the call
        // to its prompt snapshot and to what that request cost.
        e.invocation = self.invocations.current();
        e.source = "agent-loop".into();
        e.project = self.project_root.to_string_lossy().to_string();
        if phase == tauri_plugin_agent_tools::activity::Phase::Requested {
            e.input = function
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        e
    }

    /// How a secret-write question ended, in the activity record, so a write
    /// Bypass or a person let through is distinguishable from an ordinary one.
    pub(super) fn note_secret_decision(&self, tc: &serde_json::Value, detail: &str) {
        let Some(data) = &self.record_to else { return };
        let mut e = self.activity_event(tc, tauri_plugin_agent_tools::activity::Phase::Allowed);
        e.detail = detail.to_string();
        tauri_plugin_agent_tools::activity::append(data, &e.redacted());
    }

    /// Every call, as it is asked for, before any gate.
    pub(super) fn record_requested(&self, tool_calls: &[serde_json::Value]) {
        let Some(data) = &self.record_to else { return };
        for tc in tool_calls {
            let e = self.activity_event(tc, tauri_plugin_agent_tools::activity::Phase::Requested);
            tauri_plugin_agent_tools::activity::append(data, &e.redacted());
        }
    }

    /// How each call ended: refused by the harness (typed), failed, or done,
    /// with its output and its own diff.
    pub(super) fn record_outcomes(&self, tool_calls: &[serde_json::Value], outcomes: &[ToolOutcome]) {
        use tauri_plugin_agent_tools::activity::Phase;
        let Some(data) = &self.record_to else { return };
        for outcome in outcomes {
            let Some(tc) = tool_calls
                .iter()
                .find(|tc| tc.get("id").and_then(|v| v.as_str()) == Some(outcome.id.as_str()))
            else {
                continue;
            };
            // AH-009: the classification decides, and travels with the record
            // so every surface says the same thing about the same failure.
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let failure = tauri_plugin_agent_tools::harness_error::classify_tool(
                name,
                &outcome.content,
            );
            let phase = if outcome.refusal.is_some() {
                Phase::Refused
            } else {
                match failure.as_ref().map(HarnessError::kind) {
                    None => Phase::Succeeded,
                    // A call the user stopped, or one that ran out of time, is
                    // not the same thing as a call that failed.
                    Some(ErrorKind::Cancelled) => Phase::Cancelled,
                    Some(ErrorKind::Timeout) => Phase::TimedOut,
                    Some(_) => Phase::Failed,
                }
            };
            let mut e = self.activity_event(tc, phase);
            e.output = Some(outcome.content.clone());
            if let Some(failure) = failure.as_ref() {
                // Not `kind`, which says what the call acted on (a path, a
                // command): what kind of *failure* it was.
                e.error_kind = failure.kind().tag().to_string();
            }
            e.refusal = outcome.refusal.map(|r| r.code().to_string());
            if phase != Phase::Succeeded {
                e.detail = outcome.content.chars().take(400).collect();
            }
            e.diff = outcome.diff.clone();
            e.resources = tauri_plugin_agent_tools::resources::take_call(&self.cancel_scope.run, &outcome.id);
            tauri_plugin_agent_tools::activity::append(data, &e.redacted());
        }
    }

    /// Fire-and-forget `post-tool-batch` hooks for this turn's calls. Returns
    /// at once; see `tauri_plugin_agent_tools::hooks::fire_post_tool_batch`.
    pub(super) fn fire_post_tool_batch_hook(&self, tool_calls: &[serde_json::Value]) {
        let names: Vec<String> = tool_calls
            .iter()
            .filter_map(|tc| {
                tc.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect();
        // A subagent's turns tell the hook so (`FLINT_HOOK_AGENT`).
        let agent = if matches!(self.subject, tauri_plugin_agent_tools::subject::Subject::MainAgent) {
            "main"
        } else {
            "subagent"
        };
        let _ = tauri_plugin_agent_tools::hooks::fire_post_tool_batch_as(
            &self.project_root,
            names,
            agent,
            self.allow_network,
            self.allow_home_read,
            self.sandbox,
            None,
        );
    }

    /// Fire-and-forget `pre-compact` / `post-compact` hooks. Returns at once;
    /// see `tauri_plugin_agent_tools::hooks::fire_compaction`.
    pub(super) fn fire_compaction_hook(&self, event: tauri_plugin_agent_tools::hooks::Event) {
        let agent = if matches!(self.subject, tauri_plugin_agent_tools::subject::Subject::MainAgent) {
            "main"
        } else {
            "subagent"
        };
        let _ = tauri_plugin_agent_tools::hooks::fire_compaction(
            &self.project_root,
            event,
            agent,
            self.allow_network,
            self.allow_home_read,
            self.sandbox,
            None,
        );
    }

    /// Answers the calls that are neither built-ins, MCP tools nor host tools:
    /// the allowlist refusal, then `ask`, `todo`, code mode, the MCP catalogue,
    /// `lsp`, `advisor`, `schedule_task` and the subagent / git family. Returns
    /// true when the call was handled (its outcome is already in `out`), false to
    /// let the dispatcher carry on with the gate. The checks run in the order
    /// they always did: the allowlist comes before every other branch.
    async fn intercept_special(
        &self,
        tc: &serde_json::Value,
        name: &str,
        out: &mut Vec<ToolOutcome>,
    ) -> bool {
        // Before every other branch -- ask, todo, subagent dispatch, MCP,
        // built-ins -- and before any gate, prompt or auto-approval: a tool
        // this run was not offered is refused, whatever its name.
        if let Some(allowed) = &self.allowed_tools {
            if !allowed.contains(name) {
                let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mut refused = ToolOutcome::refused(id, name, HarnessRefusal::ToolNotOffered);
                // Transcript audit #11: name the offered tools it was
                // probably meant to be.
                refused.content.push_str(&tauri_plugin_agent_tools::tools::call_shape::did_you_mean(
                    name,
                    allowed.iter().map(String::as_str),
                ));
                out.push(refused);
                return true;
            }
        }
        if name == "ask" {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            let content = self.handle_ask_tool(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        if name == "todo" {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            let content = self.handle_todo_tool(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        // `[tools] code_mode`: one script, several read-only calls. Each
        // inner call re-enters `invoke`, so it meets the same allowlist,
        // `[[tool_rules]]` and permission gate as a call the model made.
        if name == crate::core::agent::code_mode::TOOL_NAME {
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !self.code_mode {
                out.push(ToolOutcome::refused(id, name, HarnessRefusal::ToolNotOffered));
                return true;
            }
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            let content = self.handle_code_tool(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        // Searching and loading held-back MCP schemas reads only this
        // run's own tool list, so it needs no gate.
        if name == crate::core::agent::mcp_catalog::TOOL_NAME {
            if let Some(deferred) = &self.deferred_mcp {
                let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let Some(args) = parse_tool_args(tc) else {
                    out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                    return true;
                };
                out.push(ToolOutcome::plain(id, deferred.handle(&args)));
                return true;
            }
        }
        // AH-057: read-only, so it is answered in Plan mode as well, and it
        // needs no subagent context.
        if name == "lsp" {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            let content = self.handle_lsp_tool(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        #[cfg(feature = "cli")]
        if name == "advisor" {
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args = parse_tool_args(tc).unwrap_or_default();
            let content = self.handle_advisor(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        if name == "schedule_task" {
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            let content = self.handle_schedule_task(&args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        // Subagent tools are handled ahead of the fs/exec gate and the MCP
        // fallback: they orchestrate nested runs, not filesystem access.
        if name == "symbol_find"
            || name == "git_branch"
            || name == "git_split"
            || name == "git_history"
            || name == "pull_request"
            || name == "semantic_search"
            || name == "commit_message"
            || name == "review_comments"
            || name == "mcp_resource_list"
            || name == "mcp_resource_read"
            || crate::core::agent::subagent::is_subagent_tool(name)
        {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Plan mode blocks the ones that can change something (a
            // subagent, a commit, a branch, a pull request). They are not
            // advertised in Plan; this is defense in depth against a stale
            // tool schema. Auto-approval cannot override. The read-only
            // ones Plan does advertise run as usual.
            if self.run_mode == crate::core::agent::plan::RunMode::Plan
                && !plan_mode_offers_tool(name)
            {
                out.push(ToolOutcome::plain(id, plan_mode_read_only_msg(name)));
                return true;
            }
            let Some(args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                return true;
            };
            // R16: these tools are left out of the offered set when the
            // project denies them, but a model can call a tool it was not
            // shown. The deny is enforced here too, as it is for MCP tools.
            if self.permissions.is_denied(name, &self.subject) {
                out.push(ToolOutcome::plain(id, denied_by_policy_msg(name, &self.project_root)));
                return true;
            }
            // Commits, rebases and branch switches rewrite the checkout
            // without passing the write/exec gate: ask like the git tool.
            if let Some(what) = repo_mutation(name, &args) {
                if let Err(refused) = self.approve_repo_mutation(name, &what, &args).await {
                    out.push(ToolOutcome::plain(id, refused));
                    return true;
                }
            }
            let content = self.handle_subagent_tool(name, &args).await;
            out.push(ToolOutcome::plain(id, content));
            return true;
        }
        false
    }

    /// Routes a call that is not a built-in: a host tool (answered by the
    /// client) or an MCP tool, gated by Plan mode, the deny list and the grants.
    /// Allowed MCP calls are queued in `mcp_calls` and run together after the
    /// sequential pass; host reads join `host_read_calls`.
    async fn route_non_builtin(
        &self,
        tc: &serde_json::Value,
        name: &str,
        out: &mut Vec<ToolOutcome>,
        mcp_calls: &mut Vec<serde_json::Value>,
        #[cfg(feature = "cli")] host_read_calls: &mut Vec<(String, String, serde_json::Value)>,
    ) {
        let id = tc
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Host tools execute in the client, not here. The call leaves the
        // process instead of running in it, and the host's declared
        // capability decides the gate (see `host_gate`). `is_host_tool` is
        // constant `false` off the headless build, which has no client.
        if self.is_host_tool(name) {
            let gate = self.host_gate(name);
            if self.run_mode == crate::core::agent::plan::RunMode::Plan
                && gate != HostGate::Read
            {
                out.push(ToolOutcome::plain(id, plan_mode_read_only_msg(name)));
                return;
            }
            if self.permissions.is_denied(name, &self.subject) {
                out.push(ToolOutcome::plain(id, denied_by_policy_msg(name, &self.project_root)));
                return;
            }
            let args: serde_json::Value = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Object(Default::default()));
            // A read is deferred and joined with the other auto-allowed
            // reads below, so two camera frames do not wait on each other.
            #[cfg(feature = "cli")]
            if gate == HostGate::Read {
                host_read_calls.push((id, name.to_string(), args));
                return;
            }
            let needs_prompt = match gate {
                HostGate::Read | HostGate::Host => false,
                // An actuator is prompted even under `auto_approve`: that
                // is the whole point of declaring one. A session grant
                // still covers it, since the user said so explicitly.
                HostGate::Actuator => !self.bypass,
                HostGate::Opaque => !(self.auto_approve || self.bypass),
            };
            if needs_prompt {
                match self.approve_host_tool(&id, name).await {
                    Ok(Ok(())) => {}
                    Ok(Err(denied)) => {
                        out.push(ToolOutcome::plain(id, denied));
                        return;
                    }
                    Err(reason) => {
                        return_cancelled_outcome(out, &id, name, reason);
                        return;
                    }
                }
            }
            #[cfg(feature = "cli")]
            {
                let (content, parts, details) = self.call_host_tool(name, &args).await;
                out.push(ToolOutcome {
                    parts,
                    details,
                    ..ToolOutcome::plain(id, content)
                });
            }
            // Unreachable off the headless build, where `is_host_tool` is
            // constant `false`.
            #[cfg(not(feature = "cli"))]
            {
                let _ = &args;
                out.push(ToolOutcome::plain(id, String::new()));
            }
            return;
        }
        // Plan mode blocks all MCP tools: their capability is arbitrary
        // and unknowable, so they are never advertised in Plan and are
        // hard-denied here as defense in depth. Auto-approval cannot override.
        if self.run_mode == crate::core::agent::plan::RunMode::Plan {
            out.push(ToolOutcome::plain(id, plan_mode_read_only_msg(name)));
            return;
        }
        // Deny-listed MCP tools are never advertised, but guard anyway.
        if self.permissions.is_denied(name, &self.subject) {
            out.push(ToolOutcome::plain(
                id,
                denied_by_policy_msg(name, &self.project_root),
            ));
            return;
        }
        // The grant is about the server that will receive the call, not
        // the tool name alone: another server can publish the same name.
        // An unregistered tool resolves to no server, which no grant
        // made for a real server covers.
        let server = self
            .mcp
            .tool_to_server
            .get(name)
            .cloned()
            .unwrap_or_default();
        // A tool that lets the model approve its own commands on the
        // server (`approve_command`, `whitelist_add`, ...) is asked
        // about every time: no auto-approval and no grant answers for
        // it, or the model could approve past Flint's own prompt.
        let self_approval =
            tauri_plugin_agent_tools::mcp_trust::is_self_approval_tool(name);
        if (!self_approval || self.bypass)
            && (self.auto_approve || self.bypass
                || self.grants.lock().unwrap().covers_mcp(&server, name))
        {
            mcp_calls.push(tc.clone());
            return;
        }
        match self.prompt_mcp_permission(&id, name).await {
            Ok((PermissionDecision::AllowOnce, _)) => mcp_calls.push(tc.clone()),
            Ok((PermissionDecision::AllowAlways, _)) if self_approval => mcp_calls.push(tc.clone()),
            Ok((PermissionDecision::AllowAlways, _)) => {
                self.grants.lock().unwrap().grant_mcp(&server, name);
                mcp_calls.push(tc.clone());
            }
            Ok((PermissionDecision::Deny, request_id)) => out.push(ToolOutcome::plain(
                id,
                denied_by_user_message(name, &request_id),
            )),
            Err(reason) => return_cancelled_outcome(out, &id, name, reason),
        }
        return;
    
    }

    /// Builds the future for an auto-allowed read-only call so it can run
    /// concurrently with the others once the gating pass is over. The future
    /// outlives this borrow of `self`, so it owns what it needs.
    fn schedule_read(
        &self,
        tool: &'static tauri_plugin_agent_tools::tools::BuiltinTool,
        args: serde_json::Value,
        id: String,
        name: &str,
    ) -> impl std::future::Future<Output = ToolOutcome> {
        use tauri_plugin_agent_tools::tools::{handlers::execute_builtin_with_diff, ToolContext};
        // The future outlives this borrow of `self`, so it owns its roots
        // and builds the context inside.
        let root = self.project_root.clone();
        let store = self.store_root.clone();
        let enabled = self.enabled_skills.clone();
        let user_skills = self.user_skills.clone();
        let allow_network = self.allow_network;
        let allow_home_read = self.allow_home_read;
        let sandbox = self.sandbox;
        let scratch = self.scratch_root.clone();
        // The run's identity and record folder, which `write` and `edit`
        // carry: a read is remembered against it, and without it the
        // file a run has just read would still be "not read" when the
        // run goes to change it.
        let run_scope = self.cancel_scope.run.clone();
        let record_to = self.record_to.clone();
        // Everything `tool_context_with_run` carries, so a concurrent
        // read sees the same mailbox, policy and tool set as a
        // sequential one (a skill read must honour `available_tools`).
        let session_id = self.cancel_scope.session.clone();
        let session_messaging = self.session_messaging;
        let sandbox_fs = self.sandbox_fs.clone();
        let permissions = self.permissions.clone();
        let subject = self.subject.clone();
        let available_tools = self.available_tools.clone();
        let nul_programs = self.nul_programs.clone();
        let format_on_edit = self.format_on_edit;
        let check_syntax = self.check_syntax;
        // Reads run concurrently, so each needs its own token under the
        // run's scope rather than sharing one.
        let registered = self.call_token(&id);
        let timeout_id = id.clone();
        let call_timeout = read_only_tool_timeout(tool.name, &args);
        bounded_read_only_call(
            async move {
                let ctx = ToolContext::new(&root, &store, &enabled)
                    .with_network(allow_network)
                    .with_home_readonly(allow_home_read)
                    .with_sandbox(sandbox)
                    .with_scratch_root(&scratch)
                    .with_user_skills(user_skills.as_deref())
                    .with_fs_config(Some(&sandbox_fs))
                    .with_permissions(&permissions, &subject)
                    .with_available_tools(&available_tools)
                    .with_format_on_edit(format_on_edit)
                    .with_check_syntax(check_syntax)
                    .with_nul_programs(&nul_programs)
                    .with_cancel(registered.token().clone());
                let ctx = match record_to.as_deref() {
                    Some(data) => {
                        let ctx = ctx.with_run(&run_scope, data);
                        if session_messaging {
                            ctx.with_mailbox_as(&session_id, data)
                        } else {
                            ctx
                        }
                    }
                    None => ctx,
                };
                // Held until the future completes, then dropped, which
                // deregisters it.
                let _registered = registered;
                let (text, diff, images) = execute_builtin_with_diff(tool, &args, &ctx).await;
                let text = tauri_plugin_agent_tools::tools::call_shape::explain(tool.name, &args, text);
                ToolOutcome {
                    diff,
                    images: images.unwrap_or_default(),
                    ..ToolOutcome::plain(id, text)
                }
            },
            timeout_id,
            name.to_string(),
            call_timeout,
        )
    }

    pub(super) async fn dispatch_calls(
        &self,
        tool_calls: &[serde_json::Value],
        on_complete: &OnComplete<'_>,
    ) -> Result<Vec<ToolOutcome>, HarnessError> {
        // `note_diagnostics` appends the project checker's verdict to the last
        // write's result once the batch is done, so an outcome announced before
        // that would show a display text the transcript does not have. With
        // diagnostics on, nothing is announced early; the caller's sweep shows
        // every result with its note.
        let silent = |_: &ToolOutcome| {};
        let on_complete: &OnComplete<'_> =
            if crate::core::agent::diagnostics::enabled(&self.project_root) {
                &silent
            } else {
                on_complete
            };
        use tauri_plugin_agent_tools::tools::{
            gate::Decision, handlers::execute_builtin_with_diff, is_builtin, lookup, Capability,
        };
        let mut out: Vec<ToolOutcome> = Vec::with_capacity(tool_calls.len());
        let mut mcp_calls: Vec<serde_json::Value> = Vec::new();
        // Auto-allowed read-only built-ins (no prompt, no filesystem mutation)
        // are deferred and executed concurrently after the gating pass. Anything
        // that prompts, writes, execs, or dispatches stays sequential so
        // permission prompts don't interleave and writes can't race.
        let mut read_futures = Vec::new();
        // Host tools declared `read`: auto-allowed like the built-in reads and
        // run concurrently with each other once the gating pass is over.
        #[cfg(feature = "cli")]
        let mut host_read_calls: Vec<(String, String, serde_json::Value)> = Vec::new();
        // How many of `out` `on_complete` has already seen. The sequential pass
        // `continue`s out of many arms, so announcing at the top of the next
        // iteration (and once more after the loop) covers every arm with one
        // call site -- and still lands before the next call's gate can prompt
        // or run, which is the moment a finished edit must not be held past.
        let mut announced = 0;
        // `[screening]`, loaded on the first web/browser result.
        let mut screening_cfg = None;
        for tc in tool_calls {
            announce_screened(&self.project_root, tool_calls, &mut out, &mut announced, &mut screening_cfg, on_complete);
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if self.intercept_special(tc, name, &mut out).await {
                continue;
            }
            if !is_builtin(name) {
                #[cfg(feature = "cli")]
                self.route_non_builtin(tc, name, &mut out, &mut mcp_calls, &mut host_read_calls)
                    .await;
                #[cfg(not(feature = "cli"))]
                self.route_non_builtin(tc, name, &mut out, &mut mcp_calls).await;
                continue;
            }
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let Some(mut args) = parse_tool_args(tc) else {
                out.push(ToolOutcome::refused_invalid_args(id, name, &raw_args_str(tc)));
                continue;
            };
            let tool = lookup(name).expect("is_builtin implies lookup");
            // Transcript audit #5: a backslash JSON turned into a TAB.
            if let Err(e) = tauri_plugin_agent_tools::tools::path_repair::repair_args_on_disk(
                name,
                tool.path_args,
                &mut args,
                &self.project_root,
                Some(self.scratch_root.as_path()),
            ) {
                out.push(ToolOutcome::plain(id, format!("ERROR: {e}")));
                continue;
            }
            // Flint's attribution on a commit or pull request, added before the
            // call is judged or put to the user, so the prompt shows exactly
            // what will be committed or posted.
            attribute_git_args(self.attribution.as_ref(), name, &mut args, &self.project_root);
            let (decision, forced_reason, secret_findings) =
                match self.gate_builtin(tool, name, &args).await {
                    Gated::Refused(text) => {
                        out.push(ToolOutcome::plain(id, text));
                        continue;
                    }
                    Gated::Decided {
                        decision,
                        forced_reason,
                        secret_findings,
                    } => (decision, forced_reason, secret_findings),
                };
            // Read and Net tools are non-mutating and safe to run concurrently
            // once allowed: reads hit the filesystem, web tools do outbound HTTP.
            if matches!(decision, Decision::Allow)
                && matches!(tool.capability, Capability::Read | Capability::Net)
            {
                read_futures.push(self.schedule_read(tool, args, id, name));
                continue;
            }
            // The harness's own word that this call ended in the null-device
            // refusal; text in the output never counts.
            let null_refusal = tauri_plugin_agent_tools::unsandboxed_retry::RefusalSignal::default();
            let (text, diff, images) = match decision {
                Decision::Allow => {
                    // The token lives as long as the call: the guard is held
                    // across the await, so a stop_scope on this run reaches it.
                    let registered = self.call_token(&id);
                    // Allowed with the scan flagging the change only when Bypass
                    // answered the prompt for the person.
                    if !secret_findings.is_empty() {
                        self.note_secret_decision(tc, "auto-approved (Bypass)");
                    }
                    let ctx = self
                        .streaming_tool_context(&id)
                        .with_cancel(registered.token().clone())
                        .with_refusal_signal(null_refusal.clone())
                        .with_credential_override(!secret_findings.is_empty());
                    execute_builtin_with_diff(tool, &args, &ctx).await
                }
                Decision::HardDeny(reason) => {
                    (hard_deny_msg(name, reason, &self.project_root), None, None)
                }
                Decision::Prompt(kind) => {
                    match self
                        .prompt_and_run(
                            PromptCall {
                                tc,
                                tool,
                                name,
                                id: &id,
                                args: &args,
                                kind,
                                forced_reason,
                                secret_findings: &secret_findings,
                                null_refusal: &null_refusal,
                            },
                            &mut out,
                        )
                        .await
                    {
                        Some(result) => result,
                        None => continue,
                    }
                }
            };
            // Failed only because Windows' null device refuses sandboxed
            // programs: offer this exact command outside the sandbox, through
            // the same prompt, and tell the model what happened -- the same
            // offer and the same words as the desktop.
            let text = if name == "bash"
                && tauri_plugin_agent_tools::unsandboxed_retry::qualifies(
                    name,
                    self.sandbox,
                    // A failed run, or one refused before it ran because its
                    // program opens NUL (`tools::nul_programs`).
                    tauri_plugin_agent_tools::tools::handlers::bash_result_failed(&text)
                        || text.trim_start().starts_with("ERROR"),
                    null_refusal.is_set(),
                ) {
                self.settle_null_device_refusal(&id, &args, text).await
            } else {
                text
            };
            // Transcript audit #12: a refusal of the arguments shows the call
            // it expected.
            let text = tauri_plugin_agent_tools::tools::call_shape::explain(name, &args, text);
            out.push(ToolOutcome {
                diff,
                images: images.unwrap_or_default(),
                ..ToolOutcome::plain(id, text)
            });
        }
        announce_screened(&self.project_root, tool_calls, &mut out, &mut announced, &mut screening_cfg, on_complete);
        // Driven together but announced one by one as each resolves: a fast
        // read should not wait on a slow one batched beside it. `out` is put in
        // call order below, so the completion order here costs nothing.
        {
            use futures::StreamExt;
            let mut reads: futures::stream::FuturesUnordered<_> =
                read_futures.into_iter().collect();
            while let Some(outcome) = reads.next().await {
                out.push(outcome);
                announce_screened(&self.project_root, tool_calls, &mut out, &mut announced, &mut screening_cfg, on_complete);
            }
        }
        #[cfg(feature = "cli")]
        {
            use futures::StreamExt;
            let mut calls: futures::stream::FuturesUnordered<_> = host_read_calls
                .iter()
                .map(|(id, name, args)| async move {
                    let (content, parts, details) = self.call_host_tool(name, args).await;
                    ToolOutcome {
                        parts,
                        details,
                        ..ToolOutcome::plain(id.clone(), content)
                    }
                })
                .collect();
            while let Some(outcome) = calls.next().await {
                out.push(outcome);
                announce_screened(&self.project_root, tool_calls, &mut out, &mut announced, &mut screening_cfg, on_complete);
            }
        }
        if !mcp_calls.is_empty() {
            // AH-023. MCP calls are cancellable through the same token as
            // everything else. The MCP layer has its own oneshot channel and
            // its own timeout; racing here is what joins them to the canonical
            // stop, so one cancellation reaches every kind of work instead of
            // two systems each knowing half.
            let mcp_ids: Vec<String> = mcp_calls
                .iter()
                .map(|c| {
                    c.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string()
                })
                .collect();
            let registered = self.call_token(&mcp_ids.join(","));
            let waiting = registered.token().clone();
            tokio::select! {
                biased;
                results = self.mcp.invoke(&mcp_calls) => {
                    // Late results lose: a batch that completes while the run
                    // is being stopped must not report success.
                    match waiting.stopped() {
                        None => out.extend(results?),
                        Some(reason) => {
                            for id in &mcp_ids {
                                self.cancelled(&mut out, id, "mcp", reason);
                            }
                        }
                    }
                }
                _ = async {
                    while !waiting.is_stopped() {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                } => {
                    let reason = waiting
                        .stopped()
                        .unwrap_or(tauri_plugin_agent_tools::lifecycle::StopReason::Cancelled);
                    for id in &mcp_ids {
                        self.cancelled(&mut out, id, "mcp", reason);
                    }
                }
            }
        }
        // `[screening]`: what MCP tools returned is scanned for control text
        // and secrets before the model reads it. Web/browser results were
        // screened as they were announced (`announce_screened`).
        crate::core::agent::screening::screen_batch(&self.project_root, &mcp_calls, &mcp_calls, &mut out);
        // The MCP batch answers as one, so this is the earliest it is announceable.
        announce_screened(&self.project_root, tool_calls, &mut out, &mut announced, &mut screening_cfg, on_complete);
        let order: HashMap<&str, usize> = tool_calls
            .iter()
            .enumerate()
            .filter_map(|(i, tc)| tc.get("id").and_then(|v| v.as_str()).map(|id| (id, i)))
            .collect();
        out.sort_by_key(|o| *order.get(o.id.as_str()).unwrap_or(&usize::MAX));
        if self.bypass {
            for outcome in out.iter_mut() {
                note_bypass_refusal(outcome);
            }
        }
        self.note_diagnostics(tool_calls, &mut out).await;
        Ok(out)
    }

    /// Every check a built-in call passes before it runs or is put to the
    /// person, in its fixed order: Plan mode, the gate (`resolve_decision`),
    /// the autonomous classifier, the destructive-command check, the judge,
    /// saved scoped approvals, the credential scan, then the bypass /
    /// auto-approval / forced-prompt rewrite. A refusal is the call's result.
    pub(super) async fn gate_builtin(
        &self,
        tool: &'static tauri_plugin_agent_tools::tools::BuiltinTool,
        name: &str,
        args: &serde_json::Value,
    ) -> Gated {
        use tauri_plugin_agent_tools::tools::{
            gate::{resolve_decision, with_secret_flag, Decision, PromptKind},
            handlers::secret_findings,
            Capability,
        };
        // Plan mode: mutation-capable builtins (Write/Exec) are hard-denied
        // BEFORE the normal gate, without a permission prompt, and auto-approval
        // cannot override this (unlike the normal prompt suppression below).
        // Read/Net/workspace-read tools fall through to the usual gate.
        if self.run_mode == crate::core::agent::plan::RunMode::Plan
            && matches!(tool.capability, Capability::Write | Capability::Exec)
        {
            return Gated::Refused(plan_mode_read_only_msg(name));
        }
        let snapshot = { self.grants.lock().unwrap().clone() };
        let decision = resolve_decision(
            tool,
            args,
            &self.project_root,
            Some(self.scratch_root.as_path()),
            // The CLI works *in* the project, so it has no separate
            // read-only root to attach.
            &[],
            &self.permissions,
            &snapshot,
            self.sandbox,
            // The run's resolved `allow_network` and the project's domain
            // lists, capped by the machine policy (Jozkah/jan#226): both
            // surfaces go through the same gate so a rule cannot mean two
            // things.
            &NetworkPolicy {
                allowed: self.allow_network,
                allow_domains: self.allow_domains.clone(),
                deny_domains: self.deny_domains.clone(),
            },
            // AH-007. Not `MainAgent` unconditionally: a subagent dispatched
            // under a name is judged as that name, so a project can grant
            // its parent something and withhold it from the child.
            &self.subject,
        );
        // Autonomous-mode safety classifier (findings F1), consulted only
        // for the write/exec calls auto-approval would otherwise wave
        // through, and only when a project opted in with `[auto_mode]`. It
        // is a second layer over the gate below, not a replacement: a
        // blocked class of action (force push, `curl | bash`, editing the
        // agent's own config, ...) is refused before the auto-approval turns
        // the prompt into a silent yes. Off by default -> `block_reason` is
        // `None` and nothing here changes.
        if self.auto_approve {
            if let Decision::Prompt(PromptKind::Write | PromptKind::Exec) = decision {
                if let Some(block) =
                    self.auto_mode.block_reason(name, tool.capability, args)
                {
                    return Gated::Refused(auto_mode_refusal_msg(name, &block));
                }
            }
        }
        // Auto-approval suppresses the prompts for writes and commands inside
        // the project, and still honors HardDeny, so the hidden `.jan`
        // invariant (while the shell is sandboxed) and explicit agent.toml
        // denies hold. R21: it never covers a read or write that escapes the
        // project -- those reach host files no sandbox confines, gate.rs
        // documents them as never auto-approved, and a headless run with
        // nobody to ask them is refused.
        //
        // Two exceptions put the call to the user anyway, through the same
        // prompt: a shell command that matches a destructive pattern
        // (`rm -rf ~`, `git push --force`, ...), whatever grant or mode
        // would otherwise allow it; and the call after a long streak of
        // auto-approved ones, so an unattended run checks in periodically.
        let git_destructive = (name == "git")
            .then(|| tauri_plugin_agent_tools::tools::git_tool::plan_from_args(args).ok())
            .flatten()
            .and_then(|p| p.destructive);
        let destructive = git_destructive.filter(|_| !self.bypass).or_else(|| (name == "bash" && !self.bypass)
            .then(|| args.get("command").and_then(|v| v.as_str()))
            .flatten()
            .and_then(|c| {
                // Inside the project or the run's own scratch directory is
                // ordinary work; both are resolved and canonicalised, so an
                // absolute path into either is not asked about.
                crate::core::agent::destructive::forced_prompt_reason(
                    c,
                    &crate::core::agent::destructive::Scope::new([
                        &self.project_root,
                        &self.scratch_root,
                    ]),
                )
            }));
        // `[auto_mode] judge`: a second model looks at a call that is about
        // to be put to the person or waved through by auto-approval. It can
        // refuse the call; "ask", an error, a timeout or no judge at all
        // leave it exactly where it was. Calls the gate already allows
        // (reads, explicit allows) or denies never reach it.
        if self.judge.is_some()
            && (matches!(decision, Decision::Prompt(_))
                || (matches!(decision, Decision::Allow) && destructive.is_some()))
        {
            if let crate::core::agent::auto_mode::GateOutcome::Deny(block) =
                self.consult_judge(name, args).await
            {
                return Gated::Refused(judge_refusal_msg(name, &block));
            }
        }
        // A scoped approval the user saved with "always" (a folder, a command
        // prefix) answers a plain prompt for a call it covers. It sits here,
        // after every deny, `[[tool_rules]]` and the judge, and only turns an
        // ordinary prompt into an allow: asked-every-time calls and
        // destructive commands are out of its reach.
        let decision = if matches!(decision, Decision::Prompt(_)) && destructive.is_none() {
            match self.record_to.as_deref() {
                Some(data) => tauri_plugin_agent_tools::scoped_rules::upgrade(
                    decision,
                    data,
                    &self.project_root,
                    tool,
                    args,
                ),
                None => decision,
            }
        } else {
            decision
        };
        // The credential scan, asked before the call runs instead of
        // refused after it: a flagged write becomes a question the person
        // can answer for this one write. Applied after saved rules and
        // session grants so neither can answer it, and never for a call
        // the gate already refused.
        let secret_findings = if matches!(tool.name, "write" | "edit")
            && !matches!(decision, Decision::HardDeny(_))
        {
            secret_findings(tool, args, &self.tool_context()).await
        } else {
            Vec::new()
        };
        let decision = with_secret_flag(decision, !secret_findings.is_empty());
        use std::sync::atomic::Ordering as StreakOrdering;
        // Said in the prompt, so the person knows why a call that would
        // otherwise have run on its own is in front of them. A forced prompt
        // also offers no "always": it would record a grant this check
        // overrides anyway.
        let mut forced_reason: Option<String> = None;
        let decision = match decision {
            // Bypass answers every prompt a person could: writes outside
            // the project, always-ask host tools, `ask` rules. Denials
            // never reach this match.
            Decision::Prompt(_) if self.bypass => Decision::Allow,
            Decision::Prompt(PromptKind::Write | PromptKind::Exec)
                if self.auto_approve && destructive.is_none() =>
            {
                let streak = self
                    .auto_approved_streak
                    .fetch_add(1, StreakOrdering::Relaxed)
                    + 1;
                if self.auto_approve_limit > 0 && streak > self.auto_approve_limit {
                    forced_reason = Some(format!(
                        "Auto-approval paused: {} tool calls ran without asking. Allow this one to continue.",
                        self.auto_approve_limit
                    ));
                    Decision::Prompt(PromptKind::Exec)
                } else {
                    Decision::Allow
                }
            }
            Decision::Prompt(kind) if destructive.is_some() => {
                forced_reason = destructive
                    .as_ref()
                    .map(|d| format!("Destructive command: {d}."));
                Decision::Prompt(kind)
            }
            Decision::Allow if destructive.is_some() => {
                forced_reason = destructive
                    .as_ref()
                    .map(|d| format!("Destructive command: {d}."));
                Decision::Prompt(PromptKind::Exec)
            }
            // Changes the computer or reads something private: asked every
            // time, so no "always" is offered for it.
            Decision::Prompt(PromptKind::Ask)
                if tauri_plugin_agent_tools::tools::is_always_ask(name) =>
            {
                forced_reason = Some("Asked every time: it changes this computer or reads something private.".to_string());
                Decision::Prompt(PromptKind::Ask)
            }
            // Asked every time, with what was found; no "always".
            Decision::Prompt(PromptKind::Secret) => {
                forced_reason = Some(secret_prompt_text(&secret_findings));
                Decision::Prompt(PromptKind::Secret)
            }
            other => other,
        };
        if matches!(decision, Decision::Prompt(_)) {
            // Someone is about to be asked: the streak starts over.
            self.auto_approved_streak.store(0, StreakOrdering::Relaxed);
        }
        Gated::Decided {
            decision,
            forced_reason,
            secret_findings,
        }
    }

    /// A call the gate put to the person: deferred, answered early, or asked
    /// now; then run, refused as stale, or reported as denied. `None` means
    /// the result was already pushed to `out`.
    pub(super) async fn prompt_and_run(
        &self,
        call: PromptCall<'_>,
        out: &mut Vec<ToolOutcome>,
    ) -> Option<(String, Option<String>, Option<Vec<tauri_plugin_agent_tools::tools::ImageContentPart>>)> {
        use tauri_plugin_agent_tools::tools::{
            gate::PromptKind,
            handlers::{execute_builtin_with_diff, preview_diff, stage_change},
            Capability,
        };
        let PromptCall {
            tc,
            tool,
            name,
            id,
            args,
            kind,
            forced_reason,
            secret_findings,
            null_refusal,
        } = call;
        let secret_findings = secret_findings.to_vec();
        // Only a person can say "write anyway", and only now: it is
        // never put off to be answered later, and never refused as
        // if they had said no when nobody was asked.
        if kind == PromptKind::Secret && !self.can_prompt() {
            out.push(ToolOutcome::plain(id.to_string(), secret_unattended_msg(name, &secret_findings)));
            return None;
        }
        // A question answered while this run was paused, or one to put
        // off now because nobody is here: see `approval_flow`.
        let early_digest = approval_digest(name, args);
        let early = if kind == PromptKind::Secret {
            crate::core::agent::approval_flow::Settled::Ask
        } else {
            self.settle_deferred(name, &early_digest)
        };
        if let crate::core::agent::approval_flow::Settled::Refuse(message) = early {
            out.push(ToolOutcome::plain(id.to_string(), message));
            return None;
        }
        let summary =
            crate::core::agent::approval_flow::call_summary(tool.name, tool.path_args, args);
        if matches!(early, crate::core::agent::approval_flow::Settled::Ask) {
            if let Some(ttl) = self.approvals.defer_unattended.filter(|_| !self.can_prompt()) {
                let content = self.defer_content(tool, args).await;
                if let Some(message) = self.defer_call(name, kind, &summary, &early_digest, ttl, &content) {
                    out.push(ToolOutcome::plain(id.to_string(), message));
                    return None;
                }
            }
        }
        let request_id = next_permission_id();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permission_requests
            .lock()
            .await
            .insert(request_id.to_string(), tx);
        let capability = match tool.capability {
            Capability::Read => "read",
            Capability::Write => "write",
            Capability::Exec => "exec",
            // Net tools resolve to Allow in the gate and never reach
            // this prompt arm; label defensively for completeness.
            Capability::Net => "net",
        };
        let prompt_kind = match kind {
            PromptKind::ReadEscape => "read_escape",
            PromptKind::Write => "write",
            PromptKind::WriteEscape => "write_escape",
            PromptKind::Exec => "exec",
            PromptKind::Ask => "ask",
            PromptKind::Secret => "secret",
        };
        let path = tool
            .path_args
            .first()
            .and_then(|k| args.get(*k))
            .and_then(|v| v.as_str())
            .map(String::from);
        let command = self.prompt_command(tool, name, args);
        let diff = preview_diff(tool, args, &self.tool_context()).await;
        // AH-146/AH-148. Staged against the file as it is at the
        // moment the question is asked. Kept until the answer comes
        // back, because the answer is only an answer about *that*
        // file.
        let staged = stage_change(tool, args, &self.tool_context()).await;
        // The approval is about these exact arguments: path repair
        // and git attribution have already rewritten them above, so
        // what is hashed here is what the prompt shows and what
        // must run.
        let args_digest = approval_digest(name, args);
        record_approval_digest(&request_id, &args_digest);
        let registered = self.call_token(id);
        let waiting = registered.token().clone();
        let decision = match early {
            // Answered while the run was paused: no question to raise.
            crate::core::agent::approval_flow::Settled::Allow => PermissionDecision::AllowOnce,
            crate::core::agent::approval_flow::Settled::Deny => PermissionDecision::Deny,
            _ => {
                let _ = self.events.send(StreamEvent::PermissionRequest {
                    request_id: request_id.to_string(),
                    tool_name: name.to_string(),
                    capability: capability.to_string(),
                    path,
                    command,
                    diff,
                    patch: staged.as_ref().map(|(_, patch)| patch.view()),
                    prompt_kind: prompt_kind.to_string(),
                    offers_always: forced_reason.is_none(),
                    reason: forced_reason.clone(),
                    args_digest: Some(args_digest),
                    call_id: Some(id.to_string()),
                });
                // AH-023. The wait itself is cancellable: a run stopped
                // while someone is deciding must not sit here until they
                // answer, and the pending request must not outlive the call
                // that raised it. Waiting only on `rx` meant a cancelled run
                // stayed parked on a question nobody was going to answer.
                tokio::select! {
                    answer = rx => answer.unwrap_or(PermissionDecision::Deny),
                    _ = async {
                        while !waiting.is_stopped() {
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                        }
                    } => PermissionDecision::Deny,
                }
            }
        };
        // Best-effort cleanup if the respond command didn't consume it.
        // Also the path that removes a pending request whose call was
        // cancelled, so the approval UI does not keep offering it.
        self.permission_requests.lock().await.remove(&request_id);
        // Taken whatever the answer, so it never outlives this
        // prompt; checked below against what is about to run.
        let approved_digest = take_approval_digest(&request_id);
        // The form's answer and the "answer later" mark belong to this
        // prompt alone; taken whatever the decision so neither outlives it.
        let chosen_scope = crate::core::agent::approval_flow::take_scope_choice(&request_id);
        let put_off = crate::core::agent::approval_flow::take_defer_mark(&request_id)
            && kind != PromptKind::Secret
            && matches!(decision, PermissionDecision::Deny)
            && matches!(early, crate::core::agent::approval_flow::Settled::Ask);

        // An answer that arrives for a call that has already been
        // stopped is stale: recorded, never acted on.
        if let Some(reason) = waiting.stopped() {
            // A reason typed for a prompt that was stopped is never read.
            let _ = take_deny_reason(&request_id);
            self.cancelled(out, id, name, reason);
            return None;
        }
        // "Write anyway" is for this one write: an "always" answer
        // (a client that offers none can still send one) is read as
        // once, and grants nothing.
        let decision = if kind == PromptKind::Secret && decision == PermissionDecision::AllowAlways {
            PermissionDecision::AllowOnce
        } else {
            decision
        };

        // AH-148. A prompt can stay open for minutes, and in that
        // time an editor, a formatter or another agent can write
        // the same file. Applying the approved change then would
        // overwrite work nobody reviewed -- for `write`, silently.
        // So an approval is checked against the file it was given
        // about, and refused with nothing written if that file has
        // moved on. A refusal, not a merge: the model re-reads and
        // proposes again against what is actually there.
        let stale = match (&staged, decision) {
            (Some((target, patch)), PermissionDecision::AllowOnce)
            | (Some((target, patch)), PermissionDecision::AllowAlways) => patch
                .check_base(
                    tauri_plugin_agent_tools::patch::BaseStamp::read(target).await,
                )
                .err()
                .map(|refusal| refusal.message(&target.display().to_string())),
            _ => None,
        };
        // The approval is bound to the arguments it was shown:
        // whatever is about to run is hashed again, and anything
        // that no longer matches the prompt is refused unrun.
        let stale = stale.or_else(|| match decision {
            PermissionDecision::AllowOnce | PermissionDecision::AllowAlways => {
                approved_args_refusal(approved_digest.as_deref(), name, args)
            }
            PermissionDecision::Deny => None,
        });
        Some(if let Some(message) = stale {
            (message, None, None)
        } else {
            match decision {
                PermissionDecision::AllowOnce => {
                    let secret = kind == PromptKind::Secret;
                    if secret {
                        self.note_secret_decision(tc, "approved: write anyway (this one write)");
                    }
                    let ctx = self
                        .streaming_tool_context(&id)
                        .with_cancel(registered.token().clone())
                        .with_refusal_signal(null_refusal.clone())
                        .with_credential_override(secret);
                    execute_builtin_with_diff(tool, args, &ctx).await
                }
                PermissionDecision::AllowAlways => {
                    // Thread-scoped only; never persisted to agent.toml.
                    // An exec grant covers the exact command the user was
                    // shown and nothing else (AH-037). Granting the base
                    // instead let "allow always" for `git status` cover
                    // `git push`, and made every chaining trick free:
                    // `&&`, `|`, `;` and `$(...)` compose commands out of
                    // separately-approved bases.
                    //
                    // With the form's answer (`approval_flow`) the grant is
                    // as narrow as the scope picked: a folder or a command
                    // prefix is saved as a rule, "once" grants nothing.
                    if self.remember_choice(
                        chosen_scope.as_ref(),
                        forced_reason.is_none(),
                        tool,
                        kind,
                        args,
                    ) {
                        if matches!(tool.capability, Capability::Exec) {
                            let command =
                                args.get("command").and_then(|v| v.as_str()).unwrap_or("");
                            self.grants.lock().unwrap().grant_command(command);
                        } else {
                            self.grants.lock().unwrap().grant(kind);
                        }
                    }
                    let ctx = self
                        .streaming_tool_context(&id)
                        .with_cancel(registered.token().clone())
                        .with_refusal_signal(null_refusal.clone());
                    execute_builtin_with_diff(tool, args, &ctx).await
                }
                PermissionDecision::Deny => {
                    let content = if put_off {
                        Some(self.defer_content(tool, args).await)
                    } else {
                        None
                    };
                    let deferred = content.and_then(|content| {
                        self.defer_call(
                            name,
                            kind,
                            &summary,
                            &early_digest,
                            self.approvals.defer_unattended.unwrap_or(0),
                            &content,
                        )
                    });
                    match deferred {
                        Some(message) => (message, None, None),
                        None if matches!(early, crate::core::agent::approval_flow::Settled::Deny) => (
                            format!("ERROR: tool '{name}' denied by user (answered while the run was paused)"),
                            None,
                            None,
                        ),
                        None if kind == PromptKind::Secret => {
                            (secret_denied_message(name, &request_id, &secret_findings), None, None)
                        }
                        None => (denied_by_user_message(name, &request_id), None, None),
                    }
                }
            }
        })
    }

    /// What the permission prompt shows as the command: the browser action,
    /// the git command line, an always-asked host tool's plan in words, or
    /// an exec tool's command.
    fn prompt_command(
        &self,
        tool: &tauri_plugin_agent_tools::tools::BuiltinTool,
        name: &str,
        args: &serde_json::Value,
    ) -> Option<String> {
        use tauri_plugin_agent_tools::tools::Capability;
        if name == "browser" {
            // What the browser will do, naming the element by what
            // the last snapshot called it, never the typed text.
            Some(tauri_plugin_agent_tools::tools::browser_tool::display(
                args,
                &self.cancel_scope.run,
            ))
        } else if name == "git" {
            // The exact command line, so the prompt names what
            // will run rather than a blob of arguments.
            tauri_plugin_agent_tools::tools::git_tool::plan_from_args(args)
                .ok()
                .map(|p| p.display())
        } else if tauri_plugin_agent_tools::tools::is_always_ask(name) {
            // What an always-asked host tool will do, in words,
            // so the prompt is not a bare tool name.
            use tauri_plugin_agent_tools::tools::{
                clipboard, host_action, host_build, host_package, host_powershell, host_ssh, host_wsl, open_path,
            };
            match name {
                "host_action" => host_action::plan(args).ok().map(|a| host_action::summary(&a)),
                "host_build" => host_build::plan(args).ok().map(|p| {
                    format!(
                        "{} (in {})",
                        p.display(),
                        args.get("cwd").and_then(|v| v.as_str()).unwrap_or("the project folder")
                    )
                }),
                "clipboard" => clipboard::plan(args).ok().map(|a| clipboard::summary(&a)),
                "open_path" => open_path::plan(args).ok().map(|p| open_path::summary(&p)),
                "host_package" => host_package::plan(args).ok().map(|p| host_package::summary(&p)),
                "host_ssh" => host_ssh::plan(args).ok().map(|p| host_ssh::display(&p)),
                "host_wsl" => host_wsl::plan(args).ok().map(|p| {
                    format!(
                        "{} (from {})",
                        host_wsl::display(&p),
                        args.get("cwd").and_then(|v| v.as_str()).unwrap_or("the project folder")
                    )
                }),
                "host_powershell" => host_powershell::plan(args).ok().map(|p| {
                    format!(
                        "PowerShell (in {}):\n{}",
                        args.get("cwd").and_then(|v| v.as_str()).unwrap_or("the project folder"),
                        host_powershell::display(&p)
                    )
                }),
                "skill_write" | "memory_write" => {
                    let what = if name == "skill_write" { "Save skill" } else { "Save memory" };
                    let field = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    Some(format!("{what} '{}':
{}", field("name"), field("content")))
                }
                _ => None,
            }
        } else {
            matches!(tool.capability, Capability::Exec)
                .then(|| args.get("command").and_then(|v| v.as_str()))
                .flatten()
                .map(String::from)
        }
    }

    /// AH-064. After a turn that changed files, tell the model what the
    /// project's own checker says about *those* files.
    ///
    /// Opt-in per project (`[tools] diagnostics = true`), because running a
    /// compiler after every edit costs real time on a large project and a
    /// harness that silently does it feels broken. The note is appended to the
    /// last write's result rather than sent as its own message, so it arrives
    /// where the model is already looking and costs no extra turn.
    pub(super) async fn note_diagnostics(&self, tool_calls: &[serde_json::Value], out: &mut [ToolOutcome]) {
        use crate::core::agent::diagnostics;
        if !diagnostics::enabled(&self.project_root) {
            return;
        }
        // Which files this turn actually changed, from the calls that were
        // made and did not fail.
        let mut touched: Vec<String> = Vec::new();
        for tc in tool_calls {
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if name != "write" && name != "edit" {
                continue;
            }
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let failed = out
                .iter()
                .find(|o| o.id == id)
                .is_some_and(|o| o.content.starts_with("ERROR"));
            if failed {
                continue;
            }
            // A call whose arguments were refused as invalid never ran, so it
            // touched nothing; skip it rather than reading a parsed empty set.
            let Some(args) = parse_tool_args(tc) else {
                continue;
            };
            if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
                let relative = std::path::Path::new(path)
                    .strip_prefix(&self.project_root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| path.replace('\\', "/"));
                touched.push(relative);
            }
        }
        if touched.is_empty() {
            return;
        }

        let project = self.project_root.clone();
        // The check runs on a blocking thread, and the run's own cancellation
        // is mirrored into the flag it polls -- so stopping the run stops the
        // compiler instead of waiting for it.
        let registered = self.call_token("diagnostics");
        let report = blocking_with_cancel(registered.token().clone(), move |flag| {
            diagnostics::collect(&project, flag, 60)
        })
        .await;
        drop(registered);

        let Some(Ok(report)) = report else { return };
        let Some(note) = report.render_for(&touched) else { return };
        // Appended to the last changing call's result: the model reads tool
        // results, and a note that arrives anywhere else is a note it may not
        // read at all.
        if let Some(last) = out
            .iter_mut()
            .rev()
            .find(|o| !o.content.starts_with("ERROR"))
        {
            last.content.push_str("\n\n");
            last.content.push_str(&note);
        }
    }
}

/// What [`CompositeToolInvoker::gate_builtin`] made of a built-in call.
pub(super) enum Gated {
    /// Refused before anything ran; the text is the call's result.
    Refused(String),
    /// Allowed, refused by policy, or to be put to the person.
    Decided {
        decision: tauri_plugin_agent_tools::tools::gate::Decision,
        /// Why a prompt is forced (and offers no "always").
        forced_reason: Option<String>,
        secret_findings: Vec<tauri_plugin_agent_tools::secrets::SecretFinding>,
    },
}

/// One call on its way to the permission prompt.
pub(super) struct PromptCall<'a> {
    pub tc: &'a serde_json::Value,
    pub tool: &'static tauri_plugin_agent_tools::tools::BuiltinTool,
    pub name: &'a str,
    pub id: &'a str,
    pub args: &'a serde_json::Value,
    pub kind: tauri_plugin_agent_tools::tools::gate::PromptKind,
    pub forced_reason: Option<String>,
    pub secret_findings: &'a [tauri_plugin_agent_tools::secrets::SecretFinding],
    pub null_refusal: &'a tauri_plugin_agent_tools::unsandboxed_retry::RefusalSignal,
}
