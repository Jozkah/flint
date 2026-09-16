# Flint 0.9.0

Flint is a local-first, private fork of [Jan](https://github.com/janhq/jan) built into a full agentic workspace. This is the first tagged Flint release, and it gathers everything Flint adds on top of Jan: a private local-only build, a one-click migration path from an existing Jan install, the **Cowork** agentic coding workspace, tool-using **Discussion Rooms**, a reconstructable agent runtime, cross-chat **Memory**, fingerprint-pinned **MCP**, native **Skills**, and the Graphite/Atelier redesign.

## Highlights

- **Local-first and private.** Telemetry, update checks, model discovery and catalogue fetches are removed and the whole repo is guarded against phoning home; web search no longer reports back what it returned. Flint runs against your own models and providers, and nothing leaves the machine unless you send it.
- **Migrate from Jan in one launch.** Flint keeps Jan's identifier and data path, detects an existing Jan install on first run, and offers to Copy, Reuse, Move or Start fresh — per category, with conflict policies, a recoverable backup, rollback and idempotent resume.
- **Cowork — an agentic coding workspace.** A right-rail workspace with a Code panel, a Changes (Git) rail with real diff gutters, an Activity rail, per-chat models and temporary chats. Cowork answers with a **reviewable proposal** you apply hunk-by-hunk, runs on a **managed worktree** with checkpoints and safety-point restores, can **dispatch a team** of coordinated subagents, and reports every change's true origin from recorded evidence.
- **Discussion Rooms that use tools.** Multi-model discussions, with you in control, that now do work rather than only talk. Attach a folder and give each participant **Read-only** or **Read & edit** file tools (`read`/`ls`/`find`/`grep`, and `write`/`edit` confined to that folder by a direct-edit grant), your trusted MCP servers (routed to the exact server, never offered when untrusted), and web research (`web_search`/`web_fetch`) — every call rendered as a colour-coded tool chip, matching the Cowork tab, that expands to its input and result. A participant can conclude early once the objective is met; a room stopped on a rounds/turns/tokens/time/cost limit continues for as many more rounds as you ask; a message to a paused, completed or stopped room resumes it; a discussion past the model's context window compacts automatically with a "Compacting…" note; and a room whose participants are all waiting on you hands back instead of spinning. Each participant has its own colour across `@mentions`, messages render Markdown, and new participants default to read-only tools when their model supports them.
- **An agent runtime you can reconstruct.** Every run writes a versioned event log; a run interrupted mid-turn resumes carrying its unfinished work; token and dollar ceilings hold across runs; every tool call carries a deadline and a cancellation token; and a Timeline rail lets you step through a finished run and see what kind of failure occurred.
- **Repository intelligence.** A stored repository index with caller/callee walking, semantic code search over a model you name, LSP-backed language servers, impact and test-coverage analysis following imports, project-tooling detection, and formatter discovery that runs on what the agent edits.
- **Version control that understands the tree.** Branch and commit about what is actually staged, read a diverged branch or a stopped merge, split commits, guided rebase and cherry-pick, open pull requests and keep their descriptions in step, and work a review one comment at a time — with destructive git gated apart from safe git.
- **Cross-chat Memory.** One canonical record per scope with an enforced precedence chain stated in every prompt; the model proposes, you decide; user-level memory with per-scope recall and a forget that leaves no text; versioned provenance; and a Memory settings page that surfaces and settles conflicts.
- **MCP you can trust.** Servers are trusted by fingerprint, not the name they chose; OAuth tokens live in the secret store and refresh ahead of expiry with declared, enforced scopes; per-server liveness, logs and budgets; a server's documents and prompts; and imported servers launched confined or not at all.
- **Native Skills and permissions.** User-level skills in the CLI and the agent loop that declare the tools they need and their version; a permission policy as a reviewed file a project cannot loosen; write authority issued as a grant over a root; and six versioned built-in roles enforced at the call site.
- **A headless CLI.** A JSON-lines API that streams a run's canonical events with adjustable verbosity, a persistent local log and a local-only diagnostic bundle, and a harness benchmark against a fixed task set.
- **The Graphite / Atelier redesign.** One Atelier shell — rail, contextual sidebar, context bar and status bar — with a neutral charcoal dark theme, bundled typefaces, a contrast-checked accent, an intention-led first run, global settings search, a command palette, and a system monitor with filterable logs.

## Migration

**Flint detects an existing Jan installation on first launch.**

Because Flint keeps Jan's bundle identifier (`jan.ai.app`) and data path, an existing Jan install is found automatically, and the first-launch assistant offers four choices. **Copy to Flint** duplicates the selected data and preserves your original Jan installation and data untouched. **Reuse Jan data** shares the selected existing data in place, with concurrency protection so both apps do not corrupt it. **Move to Flint** copies into Flint and then removes the Jan source once every item succeeds, keeping a recoverable backup and supporting rollback. **Start fresh** begins with an empty Flint profile and leaves Jan untouched. You can also migrate later from **Settings > General > Migrate from Jan**.

You choose which categories to bring — conversations and assistants, models, settings and provider credentials, configuration, extensions and logs, and the agent workspace and rooms — and how to resolve items that already exist in Flint. A newer item already in Flint is never silently overwritten. A failed migration rolls back to the previous state, an interrupted migration resumes idempotently, partial data is quarantined, and every run records a manifest. Your existing Jan data is never deleted automatically.

Your existing settings, credentials, providers, models, threads, projects, rooms, mailboxes, and extensions are preserved where compatible. Secrets continue through the protected keychain/backend-store path and are never copied into plaintext or logs. Legacy compatibility is kept throughout: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), `JAN.md` project files (alongside `FLINT.md`), the legacy data locations, and the persisted identifiers all continue to work.

---

## What's Changed

### Local-first and privacy
- fix(tools): reject malformed MCP and RAG tool names before provider serialization, preventing "Expected 'function.name' to be a string" generation failures
- perf(inference): keep GPU-capable Vulkan as the default engine build and document throughput tuning for Flash Attention, batching, offload, and parallel sequences
- feat(app): local-only build â€” no telemetry, no catalog, no downloads (#10)
- feat(local-only): finish removing telemetry, update checking and model discovery, and guard the whole repo
- refactor(privacy): remove telemetry build vars, the analytics injection, the catalogue URLs and the update feed
- refactor(core): remove the updater, the CLI's telemetry, and the mirror
- fix(local-only): guard the shipped bundle, and stop downloading an embedding model at startup
- fix(privacy): stop telling Google what the web search returned

### Flint identity and migration
- rebrand(ui): present the product as Flint â€” app name, window title, rail wordmark, default assistant, and every locale
- rebrand(ui): Flint in the agent identity and the remaining visible strings
- rebrand(agent): the default persona says Flint agent harness
- rebrand(packaging): rename the desktop binary to Flint-Desktop and register the `flint://` deep link, keeping `jan://`
- rebrand(docs): Flint navigation labels, keeping the research model names
- docs(rebrand): add an original Flint logo and replace the Jan logo in the favicon, boot splash, window title, and in-app badges
- docs(readme): rewrite the README as "Flint â€” a fork of Jan" with provenance, migration and feature sections (#12)
- docs(license): retain Apache-2.0, the upstream copyright, acknowledgements and upstream provenance
- feat(migration): first-launch Jan to Flint data-migration core and the six Tauri commands
- feat(migration): a guided first-launch migration assistant UI
- feat(migration): Copy, Reuse, Move and Start-fresh modes, with per-category selection
- feat(migration): conflict policies â€” keep the newer Flint item, use the Jan item, or keep both under a suffix
- feat(migration): a recoverable backup for Move, with rollback and retry on failure
- feat(migration): idempotent resume of an interrupted migration, and quarantine of partial data
- feat(migration): a migration manifest recording mode, categories, results and status
- feat(migration): reopen the assistant any time from Settings > General > Migrate from Jan
- feat(env): prefer `FLINT_*` environment variables, with a `JAN_*` fallback
- feat(project-init): write `FLINT.md` and keep discovering legacy `JAN.md` (Rust)
- feat(cowork): discover `FLINT.md`, still reading legacy `JAN.md` (web)
- feat(agent): the CLI/agent context reads `FLINT.md` and falls back to legacy `JAN.md`
- fix(app): honour `JAN_DATA_FOLDER` everywhere it is meant to win
- fix(app): fall back from a data folder that is gone, without moving the user's data (#8855)
- chore(compat): keep the `jan.ai.app` identifier, legacy data locations and persisted IDs so an existing Jan install upgrades in place

### Cowork workspace
- feat(cowork): complete Cowork workspace â€” Code, Preview, Changes (Git), Activity, Settings search, per-chat models, temporary chats (#4)
- feat(cowork): a read-only code workspace, an Activity rail, and global settings search (#1)
- feat(cowork): make the declared coding-harness modes real (#6)
- feat(cowork): report the real context â€” a repository map and the payload actually sent â€” with a harness feature registry (#7)
- feat(cowork): the managed worktree â€” make it real, use the tree the run actually uses, and finish its lifecycle including recovery
- feat(cowork): checkpoints and two meanings of rewind, wired into Cowork with a safety point on restore
- feat(cowork): answer an opening request with a proposal, not an edit; review it by hunk and apply only what was chosen
- feat(cowork): export a managed worktree as a reviewable patch bundle, and import one back through proposal review
- feat(cowork): real read-only Git working-tree review in the Changes rail, with real diff gutters
- feat(cowork): report change origins from recorded evidence, not from the model
- feat(cowork): dispatch a team through the real run, coordinate subagents on shared work, and give a team its own row with its children under it
- feat(cowork): restart or replace a failed team member (AH-111); review team children and decide overlaps before they run
- feat(cowork): give an isolated team task a checkout of its own, and isolate Rust subagents
- feat(cowork): fork a session without forking its authority (AH-201)
- feat(proposals): a proposed change is stored, bound and applied by the backend
- feat(patch): an approval applies to the file that was reviewed, or not at all
- feat(changes): say which agent made every change, durably (AH-110)

### Agent runtime and harness
- feat(agent): core execution â€” a run that can be reconstructed (#8)
- feat(harness): the feature registry and Phase 0 foundation, and one versioned event log per session exported through the UI
- feat(agent): the Rust agent loop writes its calls and runs to the session's execution record (AH-004, AH-050)
- feat(agent): a run interrupted mid-turn resumes with its turn, carrying its unfinished work (AH-026)
- feat(agent): one lifecycle primitive for timeouts and cancellation, propagated through the real dispatcher
- feat(agent): every tool call gets a deadline and a cancellation token, and is timed
- feat(agent): token and dollar ceilings that hold across runs (AH-017, AH-191, AH-192)
- feat(agent): a configurable turn ceiling, one retry policy, and a call that can reap its own process tree
- feat(agent): stop a run that has settled into repeating itself
- feat(ui): a reachable emergency stop (AH-051)
- feat(agent): let a dispatch start a subagent from a copy of this conversation (AH-100)
- feat(agent): durable subagents and background jobs that outlive the app that started them (AH-101, AH-102)
- feat(agent): consensus gates decided by independent read-only reviewers (AH-112)
- feat(agents): titling and compaction run as hidden, tool-free, audited utility agents
- feat(roles): ship six versioned built-in roles and enforce each role's allowlist at the call in the Rust loop (AH-094..099)
- feat(errors): restore the harness error taxonomy so a tool failure is classified once (AH-009)
- feat(record): one invocation id per request, replayed from the canonical record (AH-004, AH-032)
- feat(replay): replay a recorded run, and a Chat turn records the payload it sent (AH-032, AH-078, AH-083)
- feat(readiness): probe eight components independently and gate tools on them

### Repository intelligence and version control
- feat(agent): repository intelligence (#9)
- feat(index): a stored repository index, name lookup, and walking a function's callers and callees (AH-053..062)
- feat(agent): semantic code search over a user-named embedding model (AH-071)
- feat(agent): speak LSP to language servers and manage their lifecycle (AH-057, AH-058)
- feat(impact): what a change can affect, and which tests cover it, following imports (AH-065/066/067/151)
- feat(agent): detect project tooling and tell the model what kind of project it is in (AH-068/069/070)
- feat(tools): find the project's formatter and run it on what the agent edits (AH-149, AH-150)
- feat(agent): group a suite's failures, and tell a flake from a regression (AH-152, AH-153)
- feat(vcs): branch, commit about what is actually staged, and read a diverged branch or stopped merge (AH-159, AH-161, AH-165, AH-171)
- feat(agent): commit splitting, guided rebase and cherry-pick (AH-160, AH-166, AH-167)
- feat(agent): open pull requests and keep their descriptions in step (AH-162, AH-163)
- feat(review): work a review one comment at a time, and check that each is addressed (AH-164)
- feat(tools): gate destructive git apart from safe git usage
- feat(agent): check dependencies against the licences a project allows (AH-158)
- feat(hooks): the project's own commands run around a tool call (AH-127/128/129)
- feat(agent): named per-project profiles, chosen per run (AH-186)
- feat(agent): rules about which model answers what (AH-194)
- feat(agent): answer "what should I run now", and a one-shot check that a project is in working order (AH-072)
- feat(diagnostics): the compiler's answer, in the turn that caused it (AH-063/064)

### Discussion Rooms
- feat(rooms): the Discussion Room engine, store and controller
- feat(rooms): the Discussion Rooms UI â€” list, room page, editor, transcript and controls
- feat(rooms): persistence commands and a typed service
- fix(rooms): frame transcript text, cap dissent, classify storage errors, and redact
- fix(rooms): refuse ids Windows would alias (trailing dot, device names)

### Cross-session messaging
- feat(agent-tools): backend mailbox for cross-session messaging
- feat(mail): one run can say something to another while both are running (AH-103)
- feat(messaging): a typed mailbox client, a queue sender and transcript attribution
- feat(messaging): mailbox presence sync and delivery into Cowork sessions
- feat(messaging): message cards, reply, and a wake-up switch
- feat(messaging): `stop_session`, a permission-safe stop of a same-project peer
- feat(agent-tools): confine a local MCP server to its session's authority
- fix(messaging): claim mail at drain, fence bodies, scrub, and recover the registry
- fix(messaging): `stop_session` needs `fs.read`, like the mailbox it writes to
- fix(session-messaging): recover a corrupt mailbox state file, with a self-contained isolation smoke
- fix(cowork): a run belongs to the session that started it (#8905)
- fix(cowork): Stop ends a run whatever it is waiting on (#8905)
- fix(cowork): give every file an explicit origin, and stop project reads crossing projects

### MCP
- feat(mcp): trust a server by fingerprint, not the name it chose, with a per-server auto-approve toggle
- feat(mcp): OAuth tokens in the secret store refreshed ahead of expiry, with declared and enforced scopes (AH-134, AH-135)
- feat(mcp): read a server's documents and prompts, and prove a listing is followed to the end (AH-137, AH-138, AH-143)
- feat(mcp): check server liveness with the protocol ping, and show per-server state, failures and explanations (AH-139)
- feat(mcp): per-server logs and budgets, and portable agent bundles (AH-140, AH-144, AH-145)
- feat(mcp): launch an imported server confined, or not at all

### Memory
- feat(memory): one canonical record per scope, a precedence chain enforced and stated in every prompt (AH-081..085)
- feat(memory): let the model propose a memory and Flint decide; review before storing and refuse what must not be stored
- feat(memory): user-level memory with per-scope recall, clear, and a forget that leaves no text (AH-082)
- feat(memory): export and import memories with their versioned provenance, and where each was used (AH-083)
- feat(memory): a Memory settings page on the real commands, surfacing and settling conflicts (AH-085)
- feat(memory): inject remembered facts into the real system prompt, and make the automatic-save setting govern saving
- feat(memory): idle-time memory consolidation ("autoDream")
- feat(chat,context): project memory binding, request attribution and a verified context panel
- fix(memory): forgetting reaches the prompts it was already sent in (AH-083), and the automatic-save toggle reaches the backend

### Context, usage and cost
- feat(context): learn a model's real window from the server that refused it, and classify what filled it (AH-077, AH-087)
- feat(context): warn as the window fills, on every surface, and diff what the model received against the previous request (AH-077, AH-086)
- feat(usage): flag prompt-cache reuse from provider-reported counts, per request, turn and session (AH-211)
- feat(spend): what a run cost, against where costs were declared (AH-175)
- feat(agent): attribute CPU and memory to the run that used them (AH-174)
- fix(context): stop treating a missing context window as a window of zero, and stop guessing 32k for unknown models

### Activity and timeline
- feat(activity): one canonical model of what a run did, persisted as one timeline per session and shown in the conversation
- feat(timeline): a Timeline rail over the session's event log; step through a finished run and see what kind of failure it was (AH-172, AH-176)
- feat(tree): what a run started, as a tree (AH-173)
- feat(net): record what the model was sent and where every request goes, and trust custom certificate authorities (AH-190)

### Skills, permissions and security
- feat(skills): user-level native skills in the CLI and the agent loop, declaring the tools they need and their version (AH-040, AH-121, AH-123, AH-124)
- feat(cowork): offer enabled plugin skills to Cowork's skill tools, and refresh on plugin changes
- feat(agent): a plugin lifecycle with typed errors, local installs, and enable/disable
- feat(permissions): describe tool requests and refusals in plain language, and offer only real scopes
- feat(permissions): let a rule name the one subject it is about, without binding the others (AH-007)
- feat(policy): a permission policy as a reviewed file a project cannot loosen (AH-052, AH-187)
- feat(agent-tools): issue write authority as a grant over a root, not a path, and hold the shell to the same roots
- feat(cowork): separate where Flint may write from how freely it acts, and default a repository to review
- feat(security): enforce the project's tool policy on the desktop path
- feat(agent): an autonomous-mode safety classifier (findings F1), off by default
- security(harness): detect credentials once, and redact them on every durable path
- fix(secrets): take credentials out of tool output before the transcript keeps it
- fix(mcp): scrub server stderr before it reaches the application log
- fix(security): guard archive extraction paths, and keep the legacy filesystem commands inside the data folder
- fix(server): stop forwarding the caller's Origin and Referer upstream, and make the Local API Server CORS switch actually switch CORS (#8836)
- fix(gate): an exec grant covers the command the user was shown, and no other

### CLI
- feat(cli): a headless JSON-lines API that streams a run's canonical events, with adjustable verbosity (AH-181, AH-182, AH-183)
- feat(cli): a persistent local log and a previewed, local-only diagnostic bundle
- feat(cli): benchmark the harness against a fixed task set (AH-196)
- feat(sessions): hand a session to another computer and say what did not come along
- feat(agent): search past runs and take a transcript out (AH-178)

### Models, providers and inference
- feat(models): evidence-based model fit, a real compatibility test, and a preferred default
- feat(models): rename models, and put the list in an order (#5)
- feat(models): show a provider as offline only when a request actually failed
- feat(providers): custom request headers, with secrets kept secret (#8208)
- feat(providers): fail over to a configured provider chain when one cannot be reached (AH-193)
- feat(providers): add llmman as a predefined local provider
- feat(net): resolve a short hostname to the machine it names, and name certificate failures
- fix(providers): keep a still-resolving single-label LAN provider in the settings list, and keep asking until the resolver knows it
- fix(providers): treat LAN endpoints as local, say what actually failed, and stop burying the reason
- fix(models): stop dropping a provider's models from the model bar, and stop handing local providers a cloud model id
- fix(models): say why the local model list is empty when the data folder was unusable (#8374)
- chore(llamacpp): upgrade the bundled llama.cpp engine to b10809 (0.4.0)
- feat(llamacpp): per-model chat-template kwargs and backend selection improvements
- fix(llamacpp): let an explicit GPU Layers setting reach the router

### Chat and composer
- feat(chat): warn before sending images to a model without vision
- feat(chat): per-chat model settings and a reasoning-effort bar (#2)
- feat(chat): temporary chat lifecycle â€” keep, discard, and a leave guard (#3)
- feat(chat): split a conversation into two independent panes, with a Details inspector
- feat(chat): attach text and code without asking the model to see it
- feat(composer): one @ menu for files, skills, agents and aliases, and name a selection as an alias
- feat(web-search): native `web_search` / `web_fetch` tooling and provider improvements
- fix(threads): keep a conversation's tail reachable when a message is removed, and never leave a torn thread file behind
- fix(threads): opening "Delete all" and pressing Enter no longer deletes every thread
- fix(chat): a tool call with unparseable arguments no longer breaks the rest of the conversation
- fix(chat): a new chat starts from the last-used model, or the first local one
- fix(messages): never persist or replay a tool call without arguments

### Design, onboarding and system
- feat(design): the Graphite Studio redesign with a neutral charcoal dark theme (#15)
- feat(design): the Jan Atelier redesign, integrated with the agent phases and beginner workflows (#11)
- feat(design): one Atelier shell with a rail, contextual sidebar, context bar and status bar
- feat(design): Atelier and Graphite components â€” buttons, dialogs, menus, sheets, switches, inputs, model dialogs and pickers
- feat(design): bundled typefaces and a derived, contrast-checked accent
- feat(design): rooms and agent messages in Graphite
- feat(onboarding): an intention-led first run that resumes, skips and can be reopened
- feat(settings): global settings search with focusable, structural targets grouped by section
- feat(settings): a Permissions page to inspect and revoke grants, and a Memory page, in the Atelier language
- feat(search): an Atelier search dialog and command palette, with rebindable shortcuts
- feat(system): a system monitor and filterable log viewers
- refactor(web-app): replace tabler icons with lucide-react in the Atelier UI
- fix(ui): one header-row component so the two pages cannot drift, and a closed dialog stops swallowing clicks
- fix(design): keep keyboard focus rings visible, and use the navigation sheet below 1024px
- fix(a11y): name the message edit and delete buttons

---

Flint is an independent fork of [Jan](https://github.com/janhq/jan) by [janhq](https://github.com/janhq) and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements, and upstream provenance.
