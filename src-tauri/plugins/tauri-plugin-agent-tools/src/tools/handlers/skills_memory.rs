//! The skill and memory tools: list, read and write skills; list, read,
//! write and propose memories.

use super::*;

/// What a skill declares it depends on and this run cannot supply (AH-123,
/// AH-124): a skill that is not installed, one installed at a version the
/// requirement rules out, or a tool nothing here provides.
///
/// Resolution is the caller's, not the skills module's: a dependency may live
/// in the project's store or in the user's, and only here is that known.
pub(super) fn skill_requirements_unmet(ctx: &ToolContext<'_>, name: &str, parsed: &skills::ParsedSkill) -> Vec<String> {
    let lookup = |wanted: &str| {
        ctx.skill_project
            .and_then(|project| skills::read_raw(project, wanted).ok())
            .or_else(|| skills::read_raw_with_user(ctx.store_root, ctx.user_skills_root, wanted).ok())
    };
    skills::unmet_requirements(name, parsed, &lookup, ctx.available_tools)
}

/// `skill_list` tool: catalog of `name — description` lines for ENABLED skills
/// only (disabled skills must stay invisible to the model). Empty if none.
///
/// With an attached project (`ctx.skill_project`), that project's skills and
/// its enabled plugins' skills come first, filtered by the project's own
/// `[skills].enabled`; see [`skills::catalog_for_model`].
/// A skill description cut to its first line and 120 characters, for a list.
pub(super) fn skill_summary(description: &str) -> String {
    const MAX: usize = 120;
    let first = description.trim().lines().next().unwrap_or("").trim();
    if first.chars().count() <= MAX {
        return first.to_string();
    }
    let cut: String = first.chars().take(MAX - 3).collect();
    format!("{}...", cut.trim_end())
}

pub(super) fn skill_list(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    // Case-insensitive, over the name and the summary shown: what the model
    // searches is what it can see.
    let query = arg_str(args, "query").map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let offered = skills::catalog_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
    );
    let lines = offered
        .into_iter()
        // A skill this run could not carry out is not offered: a catalogue
        // entry is an invitation, and one that always ends in a refusal is a
        // worse answer than not listing it.
        .filter(|meta| match (ctx.permissions, ctx.subject) {
            (Some(permissions), Some(subject)) => {
                skills::unusable_tools(&meta.needs, permissions, subject).is_empty()
            }
            _ => true,
        })
        // AH-124: and neither is a skill whose dependencies are not here. The
        // catalogue is an offer; one that cannot be taken up is worse than no
        // entry at all.
        .filter(|meta| {
            // The body the listing layer would hand over, not a same-named
            // skill of another layer.
            match skills::read_for_model_with_user(
                ctx.skill_project,
                ctx.store_root,
                ctx.user_skills_root,
                ctx.enabled_skills,
                &meta.name,
            ) {
                Ok(raw) => {
                    let parsed = skills::parse(&raw);
                    // `paths:` skill: offered only where the project has a match.
                    skills::paths_match(ctx.project_root, &parsed.paths)
                        && skill_requirements_unmet(ctx, &meta.name, &parsed).is_empty()
                }
                Err(_) => true,
            }
        })
        .collect::<Vec<_>>()
        .iter()
        .map(|m| {
            // AH-123: a declared version is part of a skill's identity, so it
            // is shown where the skill is named. A skill that declares none is
            // listed as it always was, rather than as some invented version.
            let name = match &m.version {
                Some(version) => format!("{} (v{version})", m.name),
                None => m.name.clone(),
            };
            let summary = skill_summary(&m.description);
            if summary.is_empty() {
                name
            } else {
                format!("{name} — {summary}")
            }
        })
        .filter(|line| query.as_ref().is_none_or(|q| line.to_lowercase().contains(q.as_str())))
        .collect::<Vec<_>>();
    match (&query, lines.is_empty()) {
        (Some(q), true) => format!("No skill matches `{q}`. Call `skill_list` without a query to see every skill."),
        _ => lines.join("\n"),
    }
}

/// `skill_read` tool: a skill's full instructions (frontmatter stripped). A
/// disabled skill, a skill of a disabled plugin, or one with
/// `disable-model-invocation: true` is treated as absent so it never reaches
/// the model. Reading a skill grants nothing: scripts it mentions still run
/// only through `bash`, under the gate.
pub(super) fn skill_read(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    // The whitelist is applied per layer: an attached project's own
    // `[skills].enabled`, the caller's for the store and the user's skills.
    let raw = match skills::read_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
        name,
    ) {
        Ok(raw) => raw,
        Err(e) => return e,
    };
    let parsed = skills::parse(&raw);
    if !parsed.model_invocable {
        return format!("ERROR: skill '{name}' not found");
    }
    if !skills::paths_match(ctx.project_root, &parsed.paths) {
        return format!(
            "ERROR: skill '{name}' applies only to files matching {}, and this project has none",
            parsed.paths.join(", ")
        );
    }
    // `context: fork`: the skill runs in a subagent so its instructions and
    // working notes stay out of this conversation. `inline: true` is what the
    // subagent passes to read the body itself.
    if parsed.fork && arg_str(args, "file").is_none() && !arg_bool(args, "inline") {
        return format!(
            "The skill '{name}' runs in its own context. Call `dispatch_subagent` with              subagent_name \"skill-{name}\", a `description` that states the user's task and says              \"first call skill_read with name '{name}' and inline true, then carry it out\",              and `allowed_tools` including skill_read plus the tools the task needs. Report              only its answer back."
        );
    }
    // AH-040: a skill that says which tools it needs is withheld where this
    // run may not use them. Handing over instructions whose every step will be
    // refused wastes a turn and reads, to the model, as the harness being
    // broken rather than as a policy it cannot cross.
    if let (Some(permissions), Some(subject)) = (ctx.permissions, ctx.subject) {
        let blocked = skills::unusable_tools(&parsed.needs, permissions, subject);
        if !blocked.is_empty() {
            return format!(
                "ERROR [permission_denied]: the skill '{name}' needs {}, which this run may not \
                 use. Its instructions are not loaded; do the work with what you have, or ask \
                 for the policy to be changed.",
                blocked.join(", ")
            );
        }
    }
    // AH-124: a skill whose dependencies are absent is not loaded. Failing
    // here, naming what is missing, is worth more than instructions that refer
    // to a skill the model will be told does not exist three turns from now.
    let unmet = skill_requirements_unmet(ctx, name, &parsed);
    if !unmet.is_empty() {
        return format!(
            "ERROR [invalid_input]: the skill '{name}' cannot be loaded here: {}. Its \
             instructions are not loaded; install what it needs, or do the work without it.",
            unmet.join("; ")
        );
    }
    let entry = skills::locate_for_model_with_user(
        ctx.skill_project,
        ctx.store_root,
        ctx.user_skills_root,
        ctx.enabled_skills,
        name,
    );
    // A bundled file (`themes/x.md`, `scripts/run.py`) is read from inside the
    // skill's own folder, which the file tools cannot be pointed at by a
    // relative path: those resolve against the workspace.
    if let Some(file) = arg_str(args, "file") {
        return match entry {
            Some(entry) => skills::read_bundled(&entry, file, &|path| {
                match (ctx.permissions, ctx.subject) {
                    (Some(permissions), Some(subject)) => permissions
                        .denies_call(
                            "read",
                            &[crate::resource::Resource::Path(path.to_path_buf())],
                            subject,
                        )
                        .is_some(),
                    _ => false,
                }
            }),
            None => format!("ERROR: skill '{name}' has no bundled files"),
        };
    }
    let mut body = parsed.body;
    if let Some(listing) = entry.as_ref().and_then(|e| skills::bundle_listing(e, name)) {
        body.push_str(&listing);
    }
    body
}

/// `skill_write` tool: create/update a skill (new ones as `<name>/SKILL.md`).
/// The `[skills].enabled` whitelist is honored for writes too: a disabled skill
/// is treated as read-only so the model cannot silently overwrite (or resurrect)
/// a skill the user has turned off or locked out of the catalog.
pub(super) fn skill_write(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    // An attached project's skills (its own and its plugins') are read-only
    // here: the folder is mounted read-only, and a same-named store skill
    // would be shadowed by it and never read back.
    if let Some(project) = ctx.skill_project {
        if skills::project_claims(project, name) {
            return format!(
                "ERROR: skill '{name}' is provided by the attached project folder \
                 and is read-only here"
            );
        }
    }
    if !skills::is_enabled(ctx.enabled_skills, name) {
        return format!("ERROR: skill '{name}' is disabled and read-only");
    }
    match skills::write(ctx.store_root, name, content) {
        Ok(()) => format!("Wrote skill '{name}'"),
        Err(e) => e,
    }
}

/// The memory tools delegate to `crate::memory` so the built-ins and the
/// management commands share one implementation.
pub(super) async fn memory_list(store: &Path) -> String {
    memory::list(store).await.join("\n")
}

pub(super) async fn memory_read(args: &serde_json::Value, store: &Path) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    match memory::read(store, name).await {
        Ok(content) => content,
        Err(e) => e,
    }
}

pub(super) async fn memory_write(args: &serde_json::Value, store: &Path) -> String {
    let Some(name) = arg_str(args, "name") else {
        return "ERROR: missing required argument 'name'".to_string();
    };
    let Some(content) = arg_str(args, "content") else {
        return "ERROR: missing required argument 'content'".to_string();
    };
    match memory::write(store, name, content).await {
        Ok(file) => format!("Wrote {} bytes to memory/{file}", content.len()),
        Err(e) => e,
    }
}


pub(super) async fn memory_propose(args: &serde_json::Value, ctx: &ToolContext<'_>) -> String {
    use crate::memory::inferred::{self, Decision};
    use crate::memory::record::{MemoryId, Scope};

    let Some(content) = arg_str(args, "content") else {
        return "ERROR: memory_propose needs `content`.".to_string();
    };
    let content = content.trim();
    if content.is_empty() {
        return "ERROR: memory_propose needs a non-empty `content`.".to_string();
    }

    // Narrowest scope that is true, and `session` when the model does not say:
    // a guess that applies too widely is the expensive mistake.
    let scope = match args
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("session")
    {
        "user" => Scope::User,
        "project" => Scope::Project,
        _ => Scope::Session,
    };

    // Project records live in the project's own store, the one every reader
    // (`commands`, `context::load_memories`, the settings page) opens. This
    // used to write to `<project>/.jan`, one level above it, so a project
    // memory the model proposed was saved where nothing ever looked.
    let store_root = match scope {
        Scope::Project => crate::workspace::project_store(ctx.project_root),
        _ => ctx.store_root.to_path_buf(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let existing = inferred::existing_records(&store_root, scope);
    let decision = inferred::decide(
        MemoryId::new(format!("mem-{now}-{:016x}", fnv1a(content))),
        content,
        &existing,
        &inferred::Context {
            scope,
            // Read-only here; `create::commit` writes the id down only if the
            // memory is actually saved (#312).
            project_id: Some(crate::memory::identity::project_id_read_only(ctx.project_root))
                .as_deref(),
            session_id: ctx.session_id,
            temporary: ctx.temporary,
            now,
            automatically_save: inferred::automatic_saving_enabled(ctx.store_root),
        },
    );

    // The web app files a proposal card under `provenance.session_id`
    // (`memory_proposals_list`), which `create::propose` leaves empty: without
    // this the card of an agent-proposed memory never showed in its chat.
    let source_session = ctx.session_id.map(str::to_string);
    let decision = match decision {
        Decision::Save(mut proposal) => {
            proposal.record.provenance.session_id = source_session;
            Decision::Save(proposal)
        }
        Decision::Pending { mut proposal, reason } => {
            proposal.record.provenance.session_id = source_session;
            Decision::Pending { proposal, reason }
        }
        refused => refused,
    };

    match decision {
        Decision::Save(proposal) => match crate::memory::create::commit(&store_root, &proposal) {
            Ok(id) => format!(
                "Remembered ({}). id: {}",
                scope_name(scope),
                id.as_str()
            ),
            Err(e) => format!("ERROR: could not save that memory: {e}"),
        },
        Decision::Pending { proposal, reason } => {
            // Stored, not dropped. The question has to survive the turn that
            // asked it -- and a restart -- or the user is asked once, in a
            // place they may not be looking, and never again.
            // `Status::Proposed` keeps it out of every prompt meanwhile.
            let pending = inferred::as_pending(&proposal, reason);
            match crate::memory::store::upsert(&store_root, &pending) {
                Ok(()) => format!(
                    "Not saved yet -- the user has been asked. {} Do not propose it again in this conversation.",
                    reason.explain()
                ),
                Err(e) => format!("ERROR: could not record that proposal: {e}"),
            }
        }
        Decision::Refused { reason } => {
            format!("ERROR: refused: {reason} Do not propose this again.")
        }
    }
}

pub(super) fn scope_name(scope: crate::memory::record::Scope) -> &'static str {
    use crate::memory::record::Scope;
    match scope {
        Scope::Session => "this conversation",
        Scope::Project => "this project",
        Scope::User => "everywhere",
    }
}

/// FNV-1a over the content, so the same fact proposed twice lands on the same
/// id and confirms rather than multiplying.
pub(super) fn fnv1a(bytes: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
