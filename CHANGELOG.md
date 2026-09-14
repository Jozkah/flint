# Flint 0.9

## Migration

**Flint detects an existing JAN installation on first launch.**

Because Flint keeps JAN's bundle identifier (`jan.ai.app`) and data path, an existing JAN install is found automatically, and the first-launch assistant offers four choices. **Copy to Flint** duplicates the selected data and preserves your original JAN installation and data untouched. **Reuse JAN data** shares the selected existing data in place, with concurrency protection so both apps do not corrupt it. **Move to Flint** copies into Flint and then removes the JAN source once every item succeeds, keeping a recoverable backup and supporting rollback. **Start fresh** begins with an empty Flint profile and leaves JAN untouched. You can also migrate later from **Settings â†’ General â†’ Migrate from JAN**.

You choose which categories to bring â€” conversations and assistants, models, settings and provider credentials, configuration, extensions and logs, and the agent workspace and rooms â€” and how to resolve items that already exist in Flint. A newer item already in Flint is never silently overwritten. A failed migration rolls back to the previous state, an interrupted migration resumes idempotently, partial data is quarantined, and every run records a manifest. Your existing JAN data is never deleted automatically.

Your existing settings, credentials, providers, models, threads, projects, rooms, mailboxes, and extensions are preserved where compatible. Secrets continue through the protected keychain/backend-store path and are never copied into plaintext or logs. Legacy compatibility is kept throughout: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), `JAN.md` project files (alongside `FLINT.md`), the legacy data locations, and the persisted identifiers all continue to work.

Flint is an independent fork of [Jan](https://github.com/menloresearch/jan) by Menlo Research and preserves JAN's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements, and upstream provenance.

---

## What's Changed
* fix(tools): reject malformed MCP and RAG tool names before provider serialization, preventing Expected 'function.name' to be a string generation failures
* perf(inference): keep GPU-capable Vulkan as the default engine build and document throughput tuning for Flash Attention, batching, offload, and parallel sequences
* feat(app): local-only build â€” no telemetry, no catalog, no downloads by @Jozkah in https://github.com/Jozkah/jan/pull/10
* feat(local-only): finish removing telemetry, update checking and model discovery, and guard the whole repo
* refactor(privacy): remove telemetry build vars, the analytics injection, the catalogue URLs and the update feed
* refactor(core): remove the updater, the CLI's telemetry, and the mirror
* fix(local-only): guard the shipped bundle, and stop downloading an embedding model at startup
* fix(privacy): stop telling Google what the web search returned
* rebrand(ui): present the product as Flint â€” app name, window title, rail wordmark, default assistant, and every locale
* rebrand(ui): Flint in the agent identity and the remaining visible strings
* rebrand(agent): the default persona says Flint agent harness
* rebrand(packaging): rename the desktop binary to Flint-Desktop and register the `flint://` deep link, keeping `jan://`
* rebrand(docs): Flint navigation labels, keeping the research model names
* docs(rebrand): add an original Flint logo and replace the JAN logo in the favicon, boot splash, window title, and in-app badges
* docs(readme): rewrite the README as "Flint â€” a fork of Jan" with provenance, migration and feature sections by @Jozkah in https://github.com/Jozkah/jan/pull/12
* docs(readme): fix the model-import path and the local-only guard claim by @Jozkah in https://github.com/Jozkah/jan/pull/13
* docs(readme): make the screenshot captions read as captions by @Jozkah in https://github.com/Jozkah/jan/pull/14
* docs(license): retain Apache-2.0, the Menlo Research copyright, acknowledgements and upstream provenance
* feat(migration): first-launch JAN â†’ Flint data-migration core and the six Tauri commands
* feat(migration): register the six migration Tauri commands
* feat(migration): a guided first-launch migration assistant UI
* feat(migration): Copy, Reuse, Move and Start-fresh modes, with per-category selection
* feat(migration): conflict policies â€” keep the newer Flint item, use the JAN item, or keep both under a suffix
* feat(migration): a recoverable backup for Move, with rollback and retry on failure
* feat(migration): idempotent resume of an interrupted migration, and quarantine of partial data
* feat(migration): a migration manifest recording mode, categories, results and status
* feat(migration): reopen the assistant any time from Settings â†’ General â†’ Migrate from JAN
* feat(env): prefer `FLINT_*` environment variables, with a `JAN_*` fallback
* feat(project-init): write `FLINT.md` and keep discovering legacy `JAN.md` (Rust)
* feat(cowork): discover `FLINT.md`, still reading legacy `JAN.md` (web)
* feat(agent): the CLI/agent context reads `FLINT.md` and falls back to legacy `JAN.md`
* fix(app): honour `JAN_DATA_FOLDER` everywhere it is meant to win
* fix(app): fall back from a data folder that is gone, without moving the user's data (#8855)
* chore(compat): keep the `jan.ai.app` identifier, legacy data locations and persisted IDs so an existing JAN install upgrades in place
* feat(agent-tools): backend mailbox for cross-session messaging
* feat(mail): one run can say something to another while both are running (AH-103)
* feat(messaging): a typed mailbox client, a queue sender and transcript attribution
* feat(messaging): mailbox presence sync and delivery into Cowork sessions
* feat(messaging): message cards, reply, and a wake-up switch
* feat(messaging): `stop_session`, a permission-safe stop of a same-project peer
* feat(agent-tools): confine a local MCP server to its session's authority
* fix(messaging): claim mail at drain, fence bodies, scrub, and recover the registry
* fix(messaging): `stop_session` needs `fs.read`, like the mailbox it writes to
* fix(session-messaging): recover a corrupt mailbox state file, with a self-contained isolation smoke
* fix(cowork): a run belongs to the session that started it (#8905)
* fix(cowork): Stop ends a run whatever it is waiting on (#8905)
* fix(cowork): give every file an explicit origin, and stop project reads crossing projects
* feat(rooms): the Discussion Room engine, store and controller
* feat(rooms): the Discussion Rooms UI â€” list, room page, editor, transcript and controls
* feat(rooms): persistence commands and a typed service
* feat(design): rooms and agent messages in Graphite
* fix(rooms): frame transcript text, cap dissent, classify storage errors, and redact
* fix(rooms): refuse ids Windows would alias (trailing dot, device names)
* feat(cowork): complete Cowork workspace â€” Code, Preview, Changes (Git), Activity, Settings search, per-chat models, temporary chats by @Jozkah in https://github.com/Jozkah/jan/pull/4
* feat(cowork): a read-only code workspace, an Activity rail, and global settings search by @Jozkah in https://github.com/Jozkah/jan/pull/1
* feat(cowork): make the declared coding-harness modes real by @Jozkah in https://github.com/Jozkah/jan/pull/6
* feat(cowork): report the real context â€” a repository map and the payload actually sent â€” with a harness feature registry by @Jozkah in https://github.com/Jozkah/jan/pull/7
* feat(agent): core execution â€” a run that can be reconstructed by @Jozkah in https://github.com/Jozkah/jan/pull/8
* feat(agent): repository intelligence by @Jozkah in https://github.com/Jozkah/jan/pull/9
* feat(harness): the feature registry and Phase 0 foundation, and one versioned event log per session exported through the UI
* feat(agent): the Rust agent loop writes its calls and runs to the session's execution record (AH-004, AH-050)
* feat(agent): a run interrupted mid-turn resumes with its turn, carrying its unfinished work (AH-026)
* feat(agent): one lifecycle primitive for timeouts and cancellation, propagated through the real dispatcher
* feat(agent): every tool call gets a deadline and a cancellation token, and is timed
* feat(agent): token and dollar ceilings that hold across runs (AH-017, AH-191, AH-192)
* feat(agent): a configurable turn ceiling, one retry policy, and a call that can reap its own process tree
* feat(agent): stop a run that has settled into repeating itself
* feat(ui): a reachable emergency stop (AH-051)
* feat(agent): let a dispatch start a subagent from a copy of this conversation (AH-100)
* feat(agent): durable subagents and background jobs that outlive the app that started them (AH-101, AH-102)
* feat(cowork): dispatch a team through the real run, coordinate subagents on shared work, and give a team its own row with its children under it
* feat(cowork): restart or replace a failed team member (AH-111); review team children and decide overlaps before they run
* feat(cowork): give an isolated team task a checkout of its own, and isolate Rust subagents
* feat(cowork): fork a session without forking its authority (AH-201)
* feat(agent): consensus gates decided by independent read-only reviewers (AH-112)
* feat(cowork): the managed worktree â€” make it real, use the tree the run actually uses, and finish its lifecycle including recovery
* feat(cowork): checkpoints and two meanings of rewind, wired into Cowork with a safety point on restore
* feat(cowork): answer an opening request with a proposal, not an edit; review it by hunk and apply only what was chosen
* feat(proposals): a proposed change is stored, bound and applied by the backend
* feat(cowork): export a managed worktree as a reviewable patch bundle, and import one back through proposal review
* feat(patch): an approval applies to the file that was reviewed, or not at all
* feat(cowork): real read-only Git working-tree review in the Changes rail, with real diff gutters
* feat(changes): say which agent made every change, durably (AH-110)
* feat(cowork): report change origins from recorded evidence, not from the model
* feat(index): a stored repository index, name lookup, and walking a function's callers and callees (AH-053..062)
* feat(agent): semantic code search over a user-named embedding model (AH-071)
* feat(agent): speak LSP to language servers and manage their lifecycle (AH-057, AH-058)
* feat(impact): what a change can affect, and which tests cover it, following imports (AH-065/066/067/151)
* feat(agent): detect project tooling and tell the model what kind of project it is in (AH-068/069/070)
* feat(tools): find the project's formatter and run it on what the agent edits (AH-149, AH-150)
* feat(agent): group a suite's failures, and tell a flake from a regression (AH-152, AH-153)
* feat(vcs): branch, commit about what is actually staged, and read a diverged branch or stopped merge (AH-159, AH-161, AH-165, AH-171)
* feat(agent): commit splitting, guided rebase and cherry-pick (AH-160, AH-166, AH-167)
* feat(agent): open pull requests and keep their descriptions in step (AH-162, AH-163)
* feat(review): work a review one comment at a time, and check that each is addressed (AH-164)
* feat(tools): gate destructive git apart from safe git usage
* feat(agent): check dependencies against the licences a project allows (AH-158)
* feat(hooks): the project's own commands run around a tool call (AH-127/128/129)
* feat(agent): named per-project profiles, chosen per run (AH-186)
* feat(agent): rules about which model answers what (AH-194)
* feat(readiness): probe eight components independently and gate tools on them
* feat(agent): answer "what should I run now", and a one-shot check that a project is in working order (AH-072)
* feat(cli): a headless JSON-lines API that streams a run's canonical events, with adjustable verbosity (AH-181, AH-182, AH-183)
* feat(cli): a persistent local log and a previewed, local-only diagnostic bundle
* feat(cli): benchmark the harness against a fixed task set (AH-196)
* feat(permissions): describe tool requests and refusals in plain language, and offer only real scopes
* feat(permissions): let a rule name the one subject it is about, without binding the others (AH-007)
* feat(policy): a permission policy as a reviewed file a project cannot loosen (AH-052, AH-187)
* feat(agent-tools): issue write authority as a grant over a root, not a path, and hold the shell to the same roots
* feat(cowork): separate where Jan may write from how freely it acts, and default a repository to review
* feat(security): enforce the project's tool policy on the desktop path
* feat(roles): ship six versioned built-in roles and enforce each role's allowlist at the call in the Rust loop (AH-094..099)
* feat(agents): titling and compaction run as hidden, tool-free, audited utility agents
* feat(skills): user-level native skills in the CLI and the agent loop, declaring the tools they need and their version (AH-040, AH-121, AH-123, AH-124)
* feat(cowork): offer enabled plugin skills to Cowork's skill tools, and refresh on plugin changes
* feat(agent): a plugin lifecycle with typed errors, local installs, and enable/disable
* feat(mcp): trust a server by fingerprint, not the name it chose, with a per-server auto-approve toggle
* feat(mcp): OAuth tokens in the secret store refreshed ahead of expiry, with declared and enforced scopes (AH-134, AH-135)
* feat(mcp): read a server's documents and prompts, and prove a listing is followed to the end (AH-137, AH-138, AH-143)
* feat(mcp): check server liveness with the protocol ping, and show per-server state, failures and explanations (AH-139)
* feat(mcp): per-server logs and budgets, and portable agent bundles (AH-140, AH-144, AH-145)
* feat(mcp): launch an imported server confined, or not at all
* feat(memory): one canonical record per scope, a precedence chain enforced and stated in every prompt (AH-081..085)
* feat(memory): let the model propose a memory and Jan decide; review before storing and refuse what must not be stored
* feat(memory): user-level memory with per-scope recall, clear, and a forget that leaves no text (AH-082)
* feat(memory): export and import memories with their versioned provenance, and where each was used (AH-083)
* feat(memory): a Memory settings page on the real commands, surfacing and settling conflicts (AH-085)
* feat(memory): inject remembered facts into the real system prompt, and make the automatic-save setting govern saving
* feat(chat,context): project memory binding, request attribution and a verified context panel
* fix(memory): forgetting reaches the prompts it was already sent in (AH-083), and the automatic-save toggle reaches the backend
* feat(context): learn a model's real window from the server that refused it, and classify what filled it (AH-077, AH-087)
* feat(context): warn as the window fills, on every surface, and diff what the model received against the previous request (AH-077, AH-086)
* feat(usage): flag prompt-cache reuse from provider-reported counts, per request, turn and session (AH-211)
* feat(spend): what a run cost, against where costs were declared (AH-175)
* feat(agent): attribute CPU and memory to the run that used them (AH-174)
* fix(context): stop treating a missing context window as a window of zero, and stop guessing 32k for unknown models
* feat(activity): one canonical model of what a run did, persisted as one timeline per session and shown in the conversation
* feat(timeline): a Timeline rail over the session's event log; step through a finished run and see what kind of failure it was (AH-172, AH-176)
* feat(tree): what a run started, as a tree (AH-173)
* feat(record): one invocation id per request, replayed from the canonical record (AH-004, AH-032)
* feat(replay): replay a recorded run, and a Chat turn records the payload it sent (AH-032, AH-078, AH-083)
* feat(net): record what the model was sent and where every request goes, and trust custom certificate authorities (AH-190)
* feat(errors): restore the harness error taxonomy so a tool failure is classified once (AH-009)
* feat(diagnostics): the compiler's answer, in the turn that caused it (AH-063/064)
* feat(models): evidence-based model fit, a real compatibility test, and a preferred default
* feat(models): rename models, and put the list in an order by @Jozkah in https://github.com/Jozkah/jan/pull/5
* feat(models): show a provider as offline only when a request actually failed
* feat(providers): custom request headers, with secrets kept secret (#8208)
* feat(providers): fail over to a configured provider chain when one cannot be reached (AH-193)
* feat(providers): add llmman as a predefined local provider
* feat(net): resolve a short hostname to the machine it names, and name certificate failures
* fix(providers): keep a still-resolving single-label LAN provider in the settings list, and keep asking until the resolver knows it
* fix(providers): treat LAN endpoints as local, say what actually failed, and stop burying the reason
* fix(models): stop dropping a provider's models from the model bar, and stop handing local providers a cloud model id
* fix(models): say why the local model list is empty when the data folder was unusable (#8374)
* chore(llamacpp): upgrade the bundled llama.cpp engine to b10809 (0.4.0)
* feat(llamacpp): per-model chat-template kwargs and backend selection improvements
* fix(llamacpp): let an explicit GPU Layers setting reach the router
* feat(chat): warn before sending images to a model without vision
* feat(chat): per-chat model settings and a reasoning-effort bar by @Jozkah in https://github.com/Jozkah/jan/pull/2
* feat(chat): temporary chat lifecycle â€” keep, discard, and a leave guard by @Jozkah in https://github.com/Jozkah/jan/pull/3
* feat(chat): split a conversation into two independent panes, with a Details inspector
* feat(chat): attach text and code without asking the model to see it
* feat(composer): one @ menu for files, skills, agents and aliases, and name a selection as an alias
* feat(web-search): native `web_search` / `web_fetch` tooling and provider improvements
* feat(design): the Graphite Studio redesign with a neutral charcoal dark theme by @Jozkah in https://github.com/Jozkah/jan/pull/15
* feat(design): the JAN Atelier redesign, integrated with the agent phases and beginner workflows by @Jozkah in https://github.com/Jozkah/jan/pull/11
* feat(design): one Atelier shell with a rail, contextual sidebar, context bar and status bar
* feat(design): Atelier and Graphite components â€” buttons, dialogs, menus, sheets, switches, inputs, model dialogs and pickers
* feat(design): bundled typefaces and a derived, contrast-checked accent
* feat(onboarding): an intention-led first run that resumes, skips and can be reopened
* feat(settings): global settings search with focusable, structural targets grouped by section
* feat(settings): a Permissions page to inspect and revoke grants, and a Memory page, in the Atelier language
* feat(search): an Atelier search dialog and command palette, with rebindable shortcuts
* feat(system): a system monitor and filterable log viewers
* feat(sessions): hand a session to another computer and say what did not come along
* feat(agent): search past runs and take a transcript out (AH-178)
* refactor(web-app): replace tabler icons with lucide-react in the Atelier UI
* fix(ui): one header-row component so the two pages cannot drift, and a closed dialog stops swallowing clicks
* fix(design): keep keyboard focus rings visible, and use the navigation sheet below 1024px
* fix(a11y): name the message edit and delete buttons
* fix(threads): keep a conversation's tail reachable when a message is removed, and never leave a torn thread file behind
* fix(threads): opening "Delete all" and pressing Enter no longer deletes every thread
* fix(chat): a tool call with unparseable arguments no longer breaks the rest of the conversation
* fix(chat): a new chat starts from the last-used model, or the first local one
* fix(messages): never persist or replay a tool call without arguments
* security(harness): detect credentials once, and redact them on every durable path
* fix(secrets): take credentials out of tool output before the transcript keeps it
* fix(mcp): scrub server stderr before it reaches the application log
* fix(security): guard archive extraction paths, and keep the legacy filesystem commands inside the data folder
* fix(server): stop forwarding the caller's Origin and Referer upstream, and make the Local API Server CORS switch actually switch CORS (#8836)
* fix(gate): an exec grant covers the command the user was shown, and no other
* fix(permissions): judge a subagent by its own name, not its parent's
* fix(agent): forge approval, safe undo, hardened git, no auto-approved escapes (R18-R21)
* fix(cowork): stopping a run withdraws its approval prompt, and a late yes runs nothing
* fix(cowork): an ingested file cannot break out of its envelope, and gate files that never reach the backend
* fix(windows): use the native title bar, and put the window back where it was
* fix(windows): embed the ComCtl32 v6 manifest in test and example binaries, and build a real environment block for the sandboxed spawn
* fix(windows): isolate test config roots, stop rejecting Windows paths, and make the build and its preflight work on Windows
* fix(cowork): make the tool-activity timeline work end to end on Windows, and quote every PowerShell quote
* fix(titlebar): keep the macOS traffic lights clear of the app name and the header
* fix(startup): never cancel the loader's removal
* fix(scripts): give Windows sidecar stubs the `.exe` suffix the preflight checks
* fix(packaging): keep the smoke harness out of the bundler's binary list
* test(smoke): drive the real Tauri app from a cowork-smoke harness across file, diff, isolation, composer, settings-search and messaging/rooms/migration scenarios
* test(migration): realistic-data Copy/Reuse/Move/Fresh, interrupted-resume, rollback and conflict coverage
* build(release): align the version sources to 0.9.0 and add the Flint 0.9 changelog
* fix(hooks): make the pre-commit gate one Git for Windows can start, and keep it on LF
* fix(ci): validate workflow inputs before any script sees them, and stop running upstream's template (#7871)

* feat(providers): Anthropic API-key support, and Claude account OAuth (device flow) in the Flint CLI
* feat(agent): reuse an existing Claude Code login, and the Claude Code integration that points Claude Code at Flint's local API
* feat(providers): OpenAI API-key support, and ChatGPT/Codex account OAuth through the ChatGPT backend
* feat(providers): native Gemini/Google API-key support (Gemini has no consumer-account OAuth or dedicated CLI bridge)

**Full Changelog**: https://github.com/Jozkah/jan/compare/1c70d7288a5811d72e5cec8bd61f052e40981bca...v0.9.0

### Contributors
* @Jozkah
