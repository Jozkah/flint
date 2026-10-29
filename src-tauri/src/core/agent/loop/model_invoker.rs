use super::*;

/// One provider a request may be sent to (AH-193).
///
/// A fallback chain is a list of these: the first is the run's own model, the
/// rest are what `[agent].fallback` names, resolved the same way the primary
/// is. Nothing here is chosen automatically -- a chain exists only because the
/// user wrote one down.
#[derive(Debug, Clone)]
pub(crate) struct ProviderLane {
    pub model_id: String,
    pub upstream_url: String,
    pub api_keys: Vec<String>,
    /// The wire API this provider speaks (`anthropic`, `google`, ...), `None`
    /// for chat/completions. The converter is derived from it at send time, so
    /// a fallback is not sent the primary's wire format.
    pub api_type: Option<String>,
}

/// The chain to try after `primary`, in order, with what would be tried twice
/// removed (AH-193).
///
/// A chain that names the primary, or names the same fallback twice, is a
/// configuration mistake rather than an instruction: trying a provider that
/// has already failed cannot help, it doubles the time the user waits for the
/// failure, and -- for a lane that is merely slow -- it doubles the load on
/// the thing that is already struggling. The first mention of each is kept, so
/// the order the user wrote is the order they are tried.
pub(super) fn distinct_chain(primary: &str, candidates: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = vec![primary.trim().to_ascii_lowercase()];
    let mut out = Vec::new();
    for candidate in candidates {
        let name = candidate.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_ascii_lowercase();
        if seen.contains(&key) {
            log::warn!("agent: fallback {name} is already in the chain; skipping the repeat");
            continue;
        }
        seen.push(key);
        out.push(name.to_string());
    }
    out
}

/// Whether a failed request may be tried on the next provider (AH-193).
///
/// The decision itself lives in the harness error taxonomy (AH-009), so the
/// chain, the retry policy and what the user is told all read one
/// classification instead of each matching the text their own way.
///
/// A run the user stopped never fails over, whatever the error says: not
/// every dispatch error is classified with the run's token, and provider
/// cancel words alone read as a transport fault (O03-017).
pub(crate) fn is_failover_worthy(error: &HarnessError) -> bool {
    !run_stopped() && tauri_plugin_agent_tools::harness_error::may_try_another(error)
}

pub(super) struct HttpModelInvoker {
    pub(super) client: Client,
    pub(super) upstream_url: String,
    pub(super) api_keys: Vec<String>,
    /// Provider registry, used to strip a `<provider>/` qualifier from the
    /// request's `model` field (the upstream must receive the bare model id).
    pub(super) provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    /// When the provider fronts a native (non-chat/completions) wire API
    /// (Anthropic `/messages`, OpenAI `/responses`, Google `generateContent`),
    /// this converter translates the request and decodes the upstream stream
    /// back into chat shape. `None` keeps the verbatim chat/completions path.
    pub(super) converter: Option<Box<dyn UpstreamConverter>>,
    /// The wire API `converter` was built for (`anthropic`, `google`,
    /// `openai-responses`), `None` for chat/completions. Reported in each
    /// request's provenance record (upstream janhq/jan#9056).
    pub(super) api_type: Option<String>,
    /// Native provider converters still use reqwest 0.12 while the default
    /// agent path uses genai's reqwest 0.13 client.
    pub(super) converter_client: reqwest::Client,
    /// Who this dispatch belongs to, so a snapshot can be found by run or
    /// session later. AH-078.
    pub(super) snapshot_identity: tauri_plugin_agent_tools::snapshot::Identity,
    /// Who a provenance record names (upstream #9056): the child run's id
    /// (`None` for the main run), the session as the handshake reports it, and
    /// the configured provider the model resolved to. Kept apart from
    /// `snapshot_identity`, whose run id is the cancellation scope's and is
    /// minted for the main run too.
    pub(super) provenance: ProvenanceIdentity,
    /// The run's request ids (AH-004): minted here, read by the tool invoker.
    pub(super) invocations: std::sync::Arc<Invocations>,
    /// Providers to try after this one, in order (AH-193). Empty unless the
    /// project configured a chain.
    pub(super) fallbacks: Vec<ProviderLane>,
    /// The ceilings that hold across runs (AH-191, AH-192), and the ledger
    /// they are judged against.
    ///
    /// Checked here rather than in the turn loop because this is the moment
    /// something is spent: every dispatch that costs tokens or money passes
    /// through, including a retry, a fallback and a compaction summary. `None`
    /// is the ordinary case -- no quotas.toml, no ceilings, no ledger read.
    pub(super) quota: Option<(std::path::PathBuf, crate::core::agent::quota::Quotas)>,
    /// Sent as `X-Client-Request-Id` on every request this invoker makes, so
    /// the provider's usage records can be looked up by session (upstream
    /// #9034, see [`crate::core::agent::correlation`]). `None` sends nothing.
    pub(super) client_request_id: Option<String>,
    /// Hide Secrets, when it is on for this process: every request is filtered
    /// just before it leaves, and the completion is mapped back. `None` = off,
    /// and then nothing in the request or the reply changes.
    pub(super) secrets: Option<Arc<crate::core::agent::secrets::SecretFilter>>,
}

/// The converter a model's provider needs, and the wire API it speaks: one
/// lookup answers both, so the provenance record cannot name a different API
/// from the one the request is built for.
pub(super) async fn wire_for(
    model_id: &str,
    provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
) -> (Option<Box<dyn UpstreamConverter>>, Option<String>) {
    match resolve_api_type_for_model(model_id, provider_configs).await {
        Some(api_type) => (converter_for(Some(&api_type)), Some(api_type)),
        None => (None, None),
    }
}

pub(super) fn converter_http_client() -> reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);
    CLIENT.clone()
}

/// The identity a provenance record is reported under (upstream #9056).
#[derive(Debug, Default, Clone)]
pub(super) struct ProvenanceIdentity {
    pub(super) run_id: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) provider: Option<String>,
}

impl ProvenanceIdentity {
    /// Resolved once per invoker: the same model-to-provider lookup the request
    /// itself resolves through, without a URL or a credential -- the record
    /// names the provider, it does not authenticate to it.
    pub(super) async fn resolve(
        model_id: &str,
        provider_configs: &Arc<Mutex<HashMap<String, ProviderConfig>>>,
        session_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Self {
        let provider = {
            let configs = provider_configs.lock().await;
            match model_id.split_once('/') {
                Some((prefix, _)) if configs.contains_key(prefix) => Some(prefix.to_string()),
                _ => {
                    let mut offering: Vec<&String> = configs
                        .iter()
                        .filter(|(_, c)| c.models.iter().any(|m| m == model_id))
                        .map(|(name, _)| name)
                        .collect();
                    offering.sort();
                    offering.first().map(|name| name.to_string())
                }
            }
        };
        Self {
            run_id: run_id.map(str::to_string),
            session_id: session_id.map(str::to_string),
            provider,
        }
    }
}

#[async_trait]
impl ModelInvoker for HttpModelInvoker {
    async fn invoke(
        &self,
        request: &serde_json::Value,
        events: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<serde_json::Value, HarnessError> {
        // `provider/model` is the CLI's explicit selection syntax. The upstream
        // URL + credential have already been resolved from that qualifier, so
        // the body must carry the bare model id - providers like OpenCode GO
        // reject a provider-qualified id with "model not supported".
        // Hide Secrets: filtered just before it leaves, mapped back on return.
        let mut normalized = match &self.secrets {
            Some(filter) => filter.filter_request(request),
            None => request.clone(),
        };
        if let Some(model) = normalized.get("model").and_then(|m| m.as_str()) {
            let pc = self.provider_configs.lock().await;
            let bare = crate::core::agent::upstream::strip_provider_prefix(model, &pc);
            if bare != model {
                normalized["model"] = serde_json::json!(bare);
            }
        }
        // AH-191/AH-192: a ceiling that has already been reached stops the
        // run here, before anything is spent against it. The ledger grows as
        // the run goes, so a run that crosses its ceiling mid-way stops there
        // rather than at the end.
        if let Some((data_folder, quotas)) = &self.quota {
            match crate::core::agent::quota::exceeded(data_folder, quotas) {
                Ok(Some(reached)) => {
                    return Err(crate::core::agent::quota::refusal(&reached));
                }
                Ok(None) => {}
                // A ledger that cannot be read is not a licence to spend: the
                // ceiling exists, and whether it has been reached is unknown.
                Err(e) => return Err((&e).into()),
            }
        }
        // AH-004: this request's id, minted before anything it causes.
        let invocation = self.invocations.begin();
        // AH-078. `normalized` is the payload as it will go on the wire: the
        // last point at which a snapshot is the dispatch rather than a
        // reconstruction of it. Taken here, after context construction and
        // after the model id is rewritten, and redacted before it is written.
        //
        // Never fails the call: a snapshot is a witness, and losing one must not
        // stop the model request it describes.
        {
            use tauri_plugin_agent_tools::snapshot::{append, capture, Identity};
            let identity = Identity {
                session: self.snapshot_identity.session.clone(),
                run: self.snapshot_identity.run.clone(),
                thread: self.snapshot_identity.thread.clone(),
                agent: self.snapshot_identity.agent.clone(),
                provider: self.snapshot_identity.provider.clone(),
                // One id per provider request, shared with everything that
                // request causes: its tools, its usage, its reply.
                invocation: invocation.clone(),
                turn: String::new(),
                attempt: 1,
                // A request carrying tool results back is the same turn
                // continuing (AH-087): reading it as another first request
                // would make one turn look like several.
                kind: dispatch_kind(&normalized),
            };
            let snapshot = capture(&normalized, &identity);
            append(
                &crate::core::app::commands::resolve_jan_data_folder(),
                &snapshot,
            );
            // The record's link from this request to the exact payload it
            // sent (AH-004/AH-078).
            self.invocations.record(
                "message.completed",
                &format!("dispatch:{invocation}"),
                &invocation,
                serde_json::json!({
                    "phase": "dispatched",
                    "snapshotId": snapshot.id,
                    "hash": snapshot.hash,
                    "model": normalized.get("model").and_then(serde_json::Value::as_str).unwrap_or_default(),
                }),
            );
            let _ = events.send(StreamEvent::PromptSnapshot {
                id: snapshot.id.clone(),
                hash: snapshot.hash.clone(),
                redactions: snapshot.redactions.len(),
            });
        }
        // Upstream janhq/jan#9056: a content-free identity record for the
        // request, on the run's stream, before it goes out -- so a harness sees
        // it even when the call then fails.
        {
            fn non_empty(v: &str) -> Option<&str> {
                (!v.is_empty()).then_some(v)
            }
            let _ = events.send(crate::core::agent::provenance::of_request(
                &normalized,
                crate::core::agent::provenance::RequestIdentity {
                    run_id: self.provenance.run_id.as_deref().and_then(non_empty),
                    session_id: self.provenance.session_id.as_deref().and_then(non_empty),
                    provider: self.provenance.provider.as_deref().and_then(non_empty),
                    api_type: self.api_type.as_deref(),
                },
            ));
        }

        let mut out = self
            .dispatch_to(
                &self.upstream_url,
                &self.api_keys,
                self.converter.as_deref(),
                &normalized,
                events,
                &invocation,
            )
            .await;

        // AH-193: the configured chain, in order, and only for a failure that
        // says the request never reached a model. Each attempt is its own
        // request in the record, so nothing is attributed to the provider that
        // did not answer, and a tool call cannot be run twice -- a failed
        // dispatch produced no reply to call anything from.
        let mut invocation = invocation;
        // Which provider the request is on now. Without this the record says
        // every fall-back came from the run's own model, so a chain of three
        // reads as though the second lane was never tried.
        let mut from = normalized
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        for lane in &self.fallbacks {
            let Err(reason) = &out else { break };
            if !is_failover_worthy(reason) {
                break;
            }
            let previous = invocation.clone();
            invocation = self.invocations.begin();
            self.invocations.record(
                "message.completed",
                &format!("fallback:{invocation}"),
                &invocation,
                serde_json::json!({
                    "phase": "fell-back",
                    "from": from,
                    "to": lane.model_id,
                    "afterInvocation": previous,
                    "reason": bound_detail(reason.message()),
                "failureKind": reason.kind().tag(),
                }),
            );
            log::warn!(
                "agent: {from} did not answer ({}: {}); falling back to {}",
                reason.kind().tag(),
                bound_detail(reason.message()),
                lane.model_id
            );
            let mut next = normalized.clone();
            next["model"] = serde_json::json!(lane.model_id);
            // The lane's own wire format, not the primary's.
            let lane_converter = converter_for(lane.api_type.as_deref());
            out = self
                .dispatch_to(
                    &lane.upstream_url,
                    &lane.api_keys,
                    lane_converter.as_deref(),
                    &next,
                    events,
                    &invocation,
                )
                .await;
            from = lane.model_id.clone();
            if out.is_ok() {
                normalized = next;
                break;
            }
        }
        // What the request cost and what came back, against the request
        // itself (AH-004). A failure is recorded too: a request that never
        // answered is part of what the run did.
        match &out {
            Ok(completion) => self.record_completion_for(
                &invocation,
                completion,
                normalized
                    .get("model")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            ),
            Err(e) => self.invocations.record(
                "message.completed",
                &format!("failed:{invocation}"),
                &invocation,
                serde_json::json!({
                    "phase": "failed",
                    "detail": bound_detail(e.message()),
                    "error": e.to_wire(),
                }),
            ),
        }
        if self.secrets.is_some() {
            // The model saw placeholders; the tool and the saved thread get the
            // real values back. The next request hides them again.
            return out.map(|mut c| {
                crate::core::agent::secrets::restore_completion(&mut c);
                c
            });
        }
        out
    }
}

/// Watch one request's stream, record that it streamed, and pass every event
/// on untouched (AH-004).
///
/// The record holds the fact and the size, never the words: the reply's text is
/// already in the transcript, and a log that copied it would be a second place
/// for the same content to leak from. One event when the reply first produces
/// something -- saying whether that was content or reasoning -- and one for the
/// reasoning the provider supplied, so a reader can see what a request actually
/// did and where anything else in the log fell relative to it.
pub(super) fn tee_stream(
    invocations: std::sync::Arc<Invocations>,
    invocation: String,
    out: mpsc::UnboundedSender<StreamEvent>,
) -> (mpsc::UnboundedSender<StreamEvent>, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let watching = tokio::spawn(async move {
        let (mut text, mut reasoning) = (0usize, 0usize);
        while let Some(event) = rx.recv().await {
            // The id is the same either way, so the first delta of the reply
            // is the one that is recorded and a later one cannot overwrite it.
            match &event {
                StreamEvent::Token { text: delta } if !delta.is_empty() => {
                    if text == 0 {
                        invocations.record(
                            "message.started",
                            &format!("stream:{invocation}"),
                            &invocation,
                            serde_json::json!({ "phase": "streaming", "first": "content" }),
                        );
                    }
                    text += delta.chars().count();
                }
                StreamEvent::Reasoning { text: delta } if !delta.is_empty() => {
                    if reasoning == 0 {
                        invocations.record(
                            "message.started",
                            &format!("stream:{invocation}"),
                            &invocation,
                            serde_json::json!({ "phase": "streaming", "first": "reasoning" }),
                        );
                    }
                    reasoning += delta.chars().count();
                }
                _ => {}
            }
            // A consumer that has gone away does not stop the watching: the
            // record of what the provider sent is still owed.
            let _ = out.send(event);
        }
        if reasoning > 0 {
            invocations.record(
                "message.reasoning",
                &format!("reasoning:{invocation}"),
                &invocation,
                serde_json::json!({ "chars": reasoning, "supplied": "provider" }),
            );
        }
    });
    (tx, watching)
}

/// Whether this request starts a turn or continues one.
///
/// A continuation is what a tool result produces: the history ends with the
/// output of a call the model asked for, and the request is the same turn
/// carrying it back. Read from the payload rather than tracked, so it is true
/// of the bytes actually sent.
pub(super) fn dispatch_kind(body: &serde_json::Value) -> tauri_plugin_agent_tools::snapshot::DispatchKind {
    use tauri_plugin_agent_tools::snapshot::DispatchKind;
    let last_role = body
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .and_then(|m| m.last())
        .and_then(|m| m.get("role"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if last_role == "tool" {
        DispatchKind::Continuation
    } else {
        DispatchKind::Initial
    }
}

/// One line of a failure, short enough for the record to hold it.
/// Whether this run's own cancel signal has fired. A failed stream is a
/// cancellation only then, never because the provider's text said "canceled"
/// (O03-017).
fn run_stopped() -> bool {
    tauri_plugin_agent_tools::lifecycle::current().is_some_and(|t| t.is_stopped())
}

pub(super) fn bound_detail(text: &str) -> String {
    text.chars().take(400).collect()
}

impl HttpModelInvoker {
    /// Send one request to one provider. Split out so the primary and every
    /// fallback go the same way, including the native-wire converter.
    ///
    /// The upstream layer returns prose; it becomes a classified failure here,
    /// at the one boundary where prose enters the loop (AH-009).
    pub(super) async fn dispatch_to(
        &self,
        upstream_url: &str,
        api_keys: &[String],
        converter: Option<&dyn UpstreamConverter>,
        body: &serde_json::Value,
        events: &mpsc::UnboundedSender<StreamEvent>,
        invocation: &str,
    ) -> Result<serde_json::Value, HarnessError> {
        // AH-004: what streamed back is recorded against this request, in
        // order, before the reply that closes it.
        let (tee, watching) =
            tee_stream(self.invocations.clone(), invocation.to_string(), events.clone());
        let out = self
            .send_to(upstream_url, api_keys, converter, body, &tee)
            .await;
        // The watcher ends when the last event is in, which is what puts the
        // stream's events in the log before the completion's.
        drop(tee);
        let _ = watching.await;
        out
    }

    /// One request on the wire, with no recording of its own.
    pub(super) async fn send_to(
        &self,
        upstream_url: &str,
        api_keys: &[String],
        converter: Option<&dyn UpstreamConverter>,
        body: &serde_json::Value,
        events: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<serde_json::Value, HarnessError> {
        if let Some(converter) = converter {
            // The streaming layer speaks prose; it is classified once, here,
            // and every decision after this reads the kind (AH-009).
            crate::core::agent::upstream::stream_converted_chat_completions(
                &self.converter_client,
                upstream_url,
                api_keys,
                converter,
                body,
                events,
                self.client_request_id.as_deref(),
            )
            .await
            .map_err(|e| {
                tauri_plugin_agent_tools::harness_error::classify_upstream_at(&e, Stage::Stream, run_stopped())
            })
        } else {
            stream_openai_chat_completions(
                &self.client,
                upstream_url,
                api_keys,
                // The agent speaks OpenAI chat/completions to default providers.
                None,
                body,
                events,
                self.client_request_id.as_deref(),
            )
            .await
            .map_err(|e| {
                tauri_plugin_agent_tools::harness_error::classify_upstream_at(&e, Stage::Stream, run_stopped())
            })
        }
    }
}

impl HttpModelInvoker {
    /// The provider's own counts for this request, and what its reply was made
    /// of: sizes and counts only -- the words are in the transcript.
    ///
    /// `model` is the provider that actually answered, which after a fallback
    /// is not the one the run started with (AH-193).
    pub(super) fn record_completion_for(
        &self,
        invocation: &str,
        completion: &serde_json::Value,
        model: &str,
    ) {
        self.record_completion(invocation, completion);
        if !model.is_empty() {
            self.invocations.record(
                "usage.reported",
                &format!("answered:{invocation}"),
                invocation,
                serde_json::json!({ "answeredBy": model, "requests": 1 }),
            );
        }
    }

    pub(super) fn record_completion(&self, invocation: &str, completion: &serde_json::Value) {
        if let Some(usage) = Usage::from_completion(completion) {
            let mut payload = serde_json::json!({
                "inputTokens": usage.prompt_tokens,
                "outputTokens": usage.completion_tokens,
                "totalTokens": usage.total_tokens,
                "requests": 1,
            });
            // Cache shares of the prompt, only when the provider said.
            if let Some(v) = usage.cached_prompt_tokens {
                payload["cachedInputTokens"] = v.into();
            }
            if let Some(v) = usage.cache_write_tokens {
                payload["cacheWriteTokens"] = v.into();
            }
            self.invocations.record(
                "usage.reported",
                &format!("usage:{invocation}"),
                invocation,
                payload,
            );
        }
        let message = extract_choice_message(completion);
        let text = message
            .and_then(|m| m.get("content"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let reasoning = message
            .and_then(|m| m.get("reasoning_content").or_else(|| m.get("reasoning")))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let tool_calls = extract_tool_calls(completion).len();
        let finish = completion
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .and_then(|c| c.first())
            .and_then(|c| c.get("finish_reason"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        self.invocations.record(
            "message.completed",
            &format!("message:{invocation}"),
            invocation,
            serde_json::json!({
                "phase": "completed",
                "textChars": text.chars().count(),
                "reasoningChars": reasoning.chars().count(),
                "toolCalls": tool_calls,
                "finishReason": finish,
            }),
        );
    }
}
