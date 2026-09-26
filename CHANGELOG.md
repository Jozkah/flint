# Flint 0.9.0

Flint is a local-first fork of [Jan](https://github.com/janhq/jan), rebuilt into a full agentic workspace that runs against your own models and keeps your data on your machine. This first tagged release brings together everything Flint adds on top of Jan: a local-only build that never phones home, one-click migration from an existing Jan install, the **Cowork** agentic coding workspace, tool-using **Discussion Rooms**, an agent runtime you can reconstruct, cross-chat **Memory**, fingerprint-pinned **MCP**, native **Skills**, and a redesigned interface with an Overview dashboard.

## Highlights

- **Local-first and private.** Telemetry, update checks, model discovery and catalogue fetches are removed and the whole repo is guarded against phoning home; web search no longer reports back what it returned. Flint runs against your own models and providers, and nothing leaves the machine unless you send it.
- **Migrate from Jan in one launch.** Flint keeps Jan's identifier and data path, detects an existing Jan install on first run, and offers to Copy, Reuse, Move or Start fresh — per category, with conflict policies, a recoverable backup, rollback and idempotent resume.
- **Cowork — an agentic coding workspace.** A workspace with an output rail with a Code panel, a Changes (Git) rail with real diff gutters, an Activity rail, per-chat models and temporary chats. Cowork answers with a **reviewable proposal** you apply hunk-by-hunk, runs on a **managed worktree** with checkpoints and safety-point restores, can **dispatch a team** of coordinated subagents, and reports every change's true origin from recorded evidence. A session can attach **several folders**, and on Windows **Edit this folder** now works through AppContainer grants.
- **Discussion Rooms that use tools.** Multi-model discussions, with you in control, that now do work rather than only talk. Attach a folder and give each participant **Read-only** or **Read & edit** file tools (`read`/`ls`/`find`/`grep`, and `write`/`edit` confined to that folder by a direct-edit grant), your trusted MCP servers (routed to the exact server, never offered when untrusted), and web research (`web_search`/`web_fetch`) — every call rendered as a colour-coded tool chip, matching the Cowork tab, that expands to its input and result. A participant can conclude early once the objective is met; a room stopped on a rounds/turns/tokens/time/cost limit continues for as many more rounds as you ask; a message to a paused, completed or stopped room resumes it; a discussion past the model's context window compacts automatically with a "Compacting…" note; and a room whose participants are all waiting on you hands back instead of spinning. Each participant has its own colour across `@mentions`, messages render Markdown, and new participants default to read-only tools when their model supports them.
- **An agent runtime you can reconstruct.** Every run writes a versioned event log; a run interrupted mid-turn resumes carrying its unfinished work; token and dollar ceilings hold across runs; every tool call carries a deadline and a cancellation token; and a Timeline rail lets you step through a finished run and see what kind of failure occurred.
- **Repository intelligence.** A stored repository index with caller/callee walking, semantic code search over a model you name, LSP-backed language servers, impact and test-coverage analysis following imports, project-tooling detection, and formatter discovery that runs on what the agent edits.
- **Version control that understands the tree.** Branch and commit about what is actually staged, read a diverged branch or a stopped merge, split commits, guided rebase and cherry-pick, open pull requests and keep their descriptions in step, and work a review one comment at a time — with destructive git gated apart from safe git.
- **Cross-chat Memory.** One canonical record per scope with an enforced precedence chain stated in every prompt; the model proposes, you decide; user-level memory with per-scope recall and a forget that leaves no text; versioned provenance; and a Memory settings page that surfaces and settles conflicts.
- **MCP you can trust.** Servers are trusted by fingerprint, not the name they chose; OAuth tokens live in the secret store and refresh ahead of expiry with declared, enforced scopes; per-server liveness, logs and budgets; a server's documents and prompts; and imported servers launched confined or not at all.
- **Native Skills and permissions.** User-level skills in the CLI and the agent loop that declare the tools they need and their version; a permission policy as a reviewed file a project cannot loosen; write authority issued as a grant over a root; and six versioned built-in roles enforced at the call site.
- **A headless CLI.** A JSON-lines API that streams a run's canonical events with adjustable verbosity, a persistent local log and a local-only diagnostic bundle, and a harness benchmark against a fixed task set.
- **A redesigned interface.** A sidebar and top header in place of the rail and status bar, an Overview dashboard as the start page, a neutral Slate default accent, Inter, duotone icons, restrained motion, phone layouts, chat groups with drag and undo delete, and pull-request status in Cowork — keeping the intention-led first run, global settings search, command palette and system monitor with filterable logs.
- **Agent SDK and slash commands.** JavaScript and Python SDK clients speak a frozen protocol v1 over JSON-RPC. A host tool contract lets a client declare tools that it runs itself. Flint's built-in tools are also available over MCP. Slash commands now work in the Home, Cowork and Rooms composers.
- **A sandbox that can reach the network, safely.** Agent runs now have network access by default through a LAN-capable sandbox, with a toggle that policy can restrict and a native `git_clone`. A long round of security hardening covers bash rules, symlinks, secrets, `web_fetch` to private addresses and repository git config.
- **A git tool with real approvals.** Git and `gh` run outside the sandbox through a dedicated `git` tool: reads run freely, local changes follow the session's mode, and every push, pull request, issue or repository change shows an approval naming the exact command and remote. Repository config that would run programs is refused, and MCP tools that approve their own commands are never offered.
- **Toolchains in the Windows sandbox.** Settings → Agent Tools lets the sandbox use a toolchain installed in your profile (such as Python) by granting one folder, revocable at any time; folders that need an administrator show the exact command instead. When Windows' NUL device refuses sandboxed programs, Flint offers to rerun that one command outside the sandbox, with your approval, and asks up front for programs known to need it.
- **Agents that ask, verify and stop looping.** The agent asks structured questions with its own suggested options, is told the shell, sandbox limits and access mode up front, reruns existing tests after a change, and a loop guard now catches repeated approve/execute cycles.
- **Long runs that keep going, and messages that wait their turn.** Chat, Cowork and Rooms compact the context automatically as it fills, with `/compact` to do it by hand. A message sent while a run is working waits in a queue you can edit, drag to reorder or remove, or steers the run at its next tool call; Stop keeps the queue for you to send or discard.
- **A richer System Monitor.** Drives, network rates, temperatures, per-core CPU, swap, uptime and host details, with usage bars throughout.
- **AI-written MCP descriptions.** Generate "About this server" text for your MCP servers with a model you choose, reviewing each one before it is saved.

## Migration

**Flint detects an existing Jan installation on first launch.**

Because Flint keeps Jan's bundle identifier (`jan.ai.app`) and data path, an existing Jan install is found automatically, and the first-launch assistant offers four choices. **Copy to Flint** duplicates the selected data and preserves your original Jan installation and data untouched. **Reuse Jan data** shares the selected existing data in place, with concurrency protection so both apps do not corrupt it. **Move to Flint** copies into Flint and then removes the Jan source once every item succeeds, keeping a recoverable backup and supporting rollback. **Start fresh** begins with an empty Flint profile and leaves Jan untouched. You can also migrate later from **Settings > General > Migrate from Jan**.

You choose which categories to bring — conversations and assistants, models, settings and provider credentials, configuration, extensions and logs, and the agent workspace and rooms — and how to resolve items that already exist in Flint. A newer item already in Flint is never silently overwritten. A failed migration rolls back to the previous state, an interrupted migration resumes idempotently, partial data is quarantined, and every run records a manifest. Your existing Jan data is never deleted automatically.

Your existing settings, credentials, providers, models, threads, projects, rooms, mailboxes, and extensions are preserved where compatible. Secrets continue through the protected keychain/backend-store path and are never copied into plaintext or logs. Legacy compatibility is kept throughout: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), `JAN.md` project files (alongside `FLINT.md`), the legacy data locations, and the persisted identifiers all continue to work.

---

## What's Changed

### Testing round before release
- feat(web-app): show a command's non-zero exit as an amber failed check
- feat(agent): rerun existing tests after a change, and test with real files
- build: rebuild the Tauri plugin APIs before the web-app typecheck
- feat(web-app): remind about waiting approvals, never drop them silently
- fix(web-app): cap web_fetch text and skip a URL that just failed
- fix(web-app): title a chat once, and never keep the raw prompt
- fix(web-app): keep tool results and failures in saved chats
- feat: a first-class git tool, and no self-approving MCP tools
- fix(web-app): say so when a chat turn returns nothing at all
- feat(agent): state the shell, sandbox limits and working rules up front
- feat(agent): teach the agent when and how to use `ask`
- feat(cowork): state the shell, sandbox limits and working rules up front
- feat(cowork): teach the agent to ask, and show the plan in plan review
- feat(web-app): drive cards and usage bars across System Monitor
- feat(hardware): CPU and drive temperatures on Windows
- feat(agent-tools): let the Windows sandbox use a user-installed toolchain
- feat(web-app): drives, network, temperatures and more on System Monitor
- feat(web-app): generate MCP server descriptions with AI
- feat(hardware): a detailed system snapshot for the System Monitor
- feat(cowork): apply a Review only file to the attached folder
- fix(web-app): list unreachable providers' models last, muted
- fix(web-app): show a fallback reply when a run ends after tools with no text
- fix(web-app): make the composer tools control a single button
- fix(web-app): title a chat once, and again when its first message is edited
- fix(web-app): give the delete-message confirm button its own name
- fix(web-app): hide tokens/sec for tiny or instant replies
- feat(web-app): collapsible Details sections and richer Activity rows
- fix(a11y): name every settings control, valid lists and ARIA, focusable log
- docs(readme): build the bundled extensions before yarn dev
- fix(server): say the Local API port is taken when another app holds it
- fix(chat): a new chat gets its own transport; servers named in a message are routed

### Local-first and privacy
- fix(tools): reject malformed MCP and RAG tool names before provider serialization, preventing "Expected 'function.name' to be a string" generation failures
- perf(inference): keep GPU-capable Vulkan as the default engine build and document throughput tuning for Flash Attention, batching, offload, and parallel sequences
- feat(app): local-only build — no telemetry, no catalog, no downloads (#10)
- feat(local-only): finish removing telemetry, update checking and model discovery, and guard the whole repo
- refactor(privacy): remove telemetry build vars, the analytics injection, the catalogue URLs and the update feed
- refactor(core): remove the updater, the CLI's telemetry, and the mirror
- fix(privacy): stop telling Google what the web search returned
- fix(docs): fetch OpenAI status directly and never report a fake "operational", and leave analytics out of a docs build that has no GTM secret

### Flint identity and migration
- rebrand(ui): present the product as Flint — app name, window title, sidebar wordmark, default assistant, and every locale
- rebrand(ui): Flint in the agent identity and the remaining visible strings
- rebrand(agent): the default persona says Flint agent harness
- rebrand(packaging): rename the desktop binary to Flint-Desktop and register the `flint://` deep link, keeping `jan://`
- rebrand(docs): Flint navigation labels, keeping the research model names
- docs(rebrand): add an original Flint logo and replace the Jan logo in the favicon, boot splash, window title, and in-app badges
- docs(readme): rewrite the README as "Flint — a fork of Jan" with provenance, migration and feature sections (#12)
- docs(license): retain Apache-2.0, the upstream copyright, acknowledgements and upstream provenance
- feat(migration): first-launch Jan to Flint data-migration core and the six Tauri commands
- feat(migration): a guided first-launch migration assistant UI
- feat(migration): Copy, Reuse, Move and Start-fresh modes, with per-category selection
- feat(migration): conflict policies — keep the newer Flint item, use the Jan item, or keep both under a suffix
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
- feat(i18n): add a Turkish locale, and fill in missing Simplified Chinese translations

### Cowork workspace
- feat(cowork): complete Cowork workspace — Code, Preview, Changes (Git), Activity, Settings search, per-chat models, temporary chats (#4)
- feat(cowork): a read-only code workspace, an Activity rail, and global settings search (#1)
- feat(cowork): make the declared coding-harness modes real (#6)
- feat(cowork): report the real context — a repository map and the payload actually sent — with a harness feature registry (#7)
- feat(cowork): the managed worktree — make it real, use the tree the run actually uses, and finish its lifecycle including recovery
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
- feat(cowork): preview the restore diff before rewinding, and stream bash output live
- feat(cowork): point out a repeated bash command in the approval dialog and on its approval card
- feat(cowork): tell the model its real environment and working directory, and which toolchains the sandbox can run
- feat(cowork): say that MCP servers from Settings are not offered
- feat(cowork): attach more than one folder to a session, each with its own access, seen by subagents too
- feat(cowork): session details estimate the context (system prompt, instructions, tool schemas) before the first run
- feat(cowork): Edit this folder on Windows, through AppContainer grants withdrawn when the grant goes
- feat(cowork): compact a long run automatically instead of stopping at the context window

### Agent runtime and harness
- feat(agent): core execution — a run that can be reconstructed (#8)
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
- perf(agent): keep the request prefix byte-stable so providers reuse the prompt cache - append a changed system prompt instead of rewriting the head, and project a canonical accepted history apart from the wire request
- feat(agent): proactive compaction - compact before dispatch when the projected request crosses the resolved model context threshold, with in-place microcompaction of stale tool results and a refill circuit-breaker, keeping the reactive overflow path as a fallback
- feat(agent-tools): `request_access`, `list_plugins`, and shell-aware failure hints
- feat(agent): ask before destructive commands and before long auto-approved runs, using one shared rule set that judges paths against the resolved scope
- feat(agent): ask the user for guidance when a run is stuck, and remind the model of its todo list every turn
- feat(agent): tell the model when a background bash job finishes
- feat(agent): load MCP tools on demand when there are too many to send, and bound the skill catalogue in the system prompt
- feat(agent-tools): tolerant fallback matching for `edit` `old_string`, and atomic file replacement in `write` and `edit`

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
- feat(hooks): the project's own commands run around a tool call (AH-127/128/129), and command hooks on lifecycle events receive a redacted JSON payload
- feat(agent-tools): tool descriptions say when to use each tool, and `edit` gains `replace_all`
- feat(agent): named per-project profiles, chosen per run (AH-186)
- feat(agent): rules about which model answers what (AH-194)
- feat(agent): answer "what should I run now", and a one-shot check that a project is in working order (AH-072)
- feat(diagnostics): the compiler's answer, in the turn that caused it (AH-063/064)
- feat(agent): native-git recovery for private GitHub repositories - a `git_inspect` tool, steering to `gh`/`git` over anonymous web crawling, and a structured RecoveryReport
- feat(agent): native `git_clone` with guidance in the prompt, and point git use at `git_inspect`
- feat(grep): group results by file and highlight matches

### Discussion Rooms
- feat(rooms): the Discussion Room engine, store and controller
- feat(rooms): the Discussion Rooms UI — list, room page, editor, transcript and controls
- feat(rooms): persistence commands and a typed service
- feat(rooms): compact each speaker's history at the threshold, by that participant's own model settings

### Cross-session messaging
- feat(agent-tools): backend mailbox for cross-session messaging
- feat(mail): one run can say something to another while both are running (AH-103)
- feat(messaging): a typed mailbox client, a queue sender and transcript attribution
- feat(messaging): mailbox presence sync and delivery into Cowork sessions
- feat(messaging): message cards, reply, and a wake-up switch
- feat(messaging): `stop_session`, a permission-safe stop of a same-project peer
- feat(agent-tools): confine a local MCP server to its session's authority
- feat(cowork): Cowork in the new design, with an output rail and Activity, Preview, Code and session-details panels
- feat(cowork): the run summary shows while the run is going
- feat(cowork): pull-request state and checks for a Cowork folder, read through the GitHub CLI (`agent_pr_status`) with no token stored

### Agent SDK
- feat(sdk): JavaScript and Python agent SDK clients, with preview documentation and examples
- feat(agent): a frozen protocol v1 with generated schemas, a completed RPC handshake, and provenance reported for every outbound provider request
- feat(agent): a host tool contract: a client declares tools it executes itself, with capabilities, validation, image results and RPC verbs
- feat(mcp): serve Flint's built-in tools over MCP, reporting bash failures as `isError`
- feat(agent): correlate agent requests with the provider's billing records, and read recorded usage and spend from the usage API

### MCP
- feat(mcp): trust a server by fingerprint, not the name it chose, with a per-server auto-approve toggle
- feat(mcp): OAuth tokens in the secret store refreshed ahead of expiry, with declared and enforced scopes (AH-134, AH-135)
- feat(mcp): read a server's documents and prompts, and prove a listing is followed to the end (AH-137, AH-138, AH-143)
- feat(mcp): check server liveness with the protocol ping, and show per-server state, failures and explanations (AH-139)
- feat(mcp): per-server logs and budgets, and portable agent bundles (AH-140, AH-144, AH-145)
- feat(mcp): launch an imported server confined, or not at all
- feat(mcp): let filesystem and jailed MCP servers read a session's attached folders
- feat(mcp): imported servers may edit a folder on Windows under a live AppContainer grant
- fix(mcp): duplicate tool names from two servers are namespaced as `{server}_{tool}` (janhq/jan#8975), and inline attachments are no longer mutated
- fix(mcp): adopt tokens that another process already refreshed instead of racing it, ignore superseded auth refreshes, and ignore OAuth callbacks carrying another flow's state
- fix(mcp): open a server's card and show the failure when it cannot connect or start, including on collapsed cards
- fix(mcp): resolve `.cmd` shims for bare commands on Windows and from the CLI, and pass the AppContainer helper the variables it needs
- fix(mcp): stop a deactivated server's health monitor, stop treating every Bun process as an orphaned server, and stop logging other processes' command lines during port cleanup
- fix(mcp): scrub a crashed server's stderr, carry split UTF-8 bytes across reads, and keep URL secrets out of connection errors
- fix(mcp): reject duplicate server names in add-by-JSON, merge desktop saves with the file on disk, and keep an unreadable trust file instead of overwriting it

### Memory
- feat(memory): one canonical record per scope, a precedence chain enforced and stated in every prompt (AH-081..085)
- feat(memory): let the model propose a memory and Flint decide; review before storing and refuse what must not be stored
- feat(memory): user-level memory with per-scope recall, clear, and a forget that leaves no text (AH-082)
- feat(memory): export and import memories with their versioned provenance, and where each was used (AH-083)
- feat(memory): a Memory settings page on the real commands, surfacing and settling conflicts (AH-085)
- feat(memory): inject remembered facts into the real system prompt, and make the automatic-save setting govern saving
- feat(memory): idle-time memory consolidation ("autoDream")
- feat(chat,context): project memory binding, request attribution and a verified context panel

### Context, usage and cost
- feat(context): learn a model's real window from the server that refused it, and classify what filled it (AH-077, AH-087)
- feat(context): warn as the window fills, on every surface, and diff what the model received against the previous request (AH-077, AH-086)
- feat(usage): flag prompt-cache reuse from provider-reported counts, per request, turn and session (AH-211)
- feat(spend): what a run cost, against where costs were declared (AH-175)
- feat(agent): attribute CPU and memory to the run that used them (AH-174)
- fix(context): stop treating a missing context window as a window of zero, and stop guessing 32k for unknown models
- feat(cli): `--max-budget-usd` and `--max-session-tokens` ceilings, and `--max-turns`, which exits with code 53 when turns run out with tools still in flight
- fix(chat): report a compaction summary only when the re-trim kept it

### Activity and timeline
- feat(activity): one canonical model of what a run did, persisted as one timeline per session and shown in the conversation
- feat(timeline): a Timeline rail over the session's event log; step through a finished run and see what kind of failure it was (AH-172, AH-176)
- feat(tree): what a run started, as a tree (AH-173)
- feat(net): record what the model was sent and where every request goes, and trust custom certificate authorities (AH-190)

### Skills, permissions and security
- feat(skills): user-level native skills in the CLI and the agent loop, declaring the tools they need and their version (AH-040, AH-121, AH-123, AH-124)
- feat(cowork): offer enabled plugin skills to Cowork's skill tools, and refresh on plugin changes
- feat(agent): a plugin lifecycle with typed errors, local installs, and enable/disable
- feat(extensions): scope plugins and skills to the workspace or make them global, with enable/disable
- feat(permissions): describe tool requests and refusals in plain language, and offer only real scopes
- feat(permissions): let a rule name the one subject it is about, without binding the others (AH-007)
- feat(policy): a permission policy as a reviewed file a project cannot loosen (AH-052, AH-187)
- feat(agent-tools): issue write authority as a grant over a root, not a path, and hold the shell to the same roots
- feat(cowork): separate where Flint may write from how freely it acts, and default a repository to review
- feat(agent-tools): offer an unsandboxed retry, through the approval prompt, when Windows' NUL device refuses the sandbox; the card shows the rerun with the first attempt collapsed, the CLI asks the same y/n question, and programs known to open NUL (`go`, `git`, configurable with `[tools].nul_programs` in agent.toml) are offered up front instead of failing first
- feat(security): enforce the project's tool policy on the desktop path
- feat(agent): an autonomous-mode safety classifier (findings F1), off by default
- security(harness): detect credentials once, and redact them on every durable path
- fix(mcp): scrub server stderr before it reaches the application log
- fix(security): guard archive extraction paths, and keep the legacy filesystem commands inside the data folder
- fix(server): stop forwarding the caller's Origin and Referer upstream, and make the Local API Server CORS switch actually switch CORS (#8836)
- feat(agent): network is on by default in a LAN-capable sandbox, with a toggle that policy can restrict
- feat(settings): control the auto-approve pause from the Permissions page, and bring the destructive-command guard to Chat
- fix(security): keep `web_fetch` off local and private addresses, and refuse cross-origin redirects on Local API Server upstream calls
- fix(secrets): serialize secret-file updates across processes, never key the fallback file with a public constant, keep the local API key and proxy password in the keyring, and wipe keyring secrets on a full reset
- fix(proxy): stop forwarding the local `X-Api-Key` to the upstream provider

### CLI
- feat(cli): a headless JSON-lines API that streams a run's canonical events, with adjustable verbosity (AH-181, AH-182, AH-183)
- feat(cli): a persistent local log and a previewed, local-only diagnostic bundle
- feat(cli): benchmark the harness against a fixed task set (AH-196)
- feat(sessions): hand a session to another computer and say what did not come along
- feat(agent): search past runs and take a transcript out (AH-178)
- feat(cli): `flint doctor` prints hardware info (`--json`), and `flint cli models list-local|info|delete` manage local models

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
- chore(llamacpp): upgrade the bundled llama.cpp engine to b10964 (0.4.1)
- feat(providers): add You.com as a native web search/fetch provider (#8921)
- feat(llamacpp): per-model chat-template kwargs and backend selection improvements
- fix(llamacpp): let an explicit GPU Layers setting reach the router
- fix(mlx): kill an abandoned load's server, keep concurrent loads off one port, release the session lock during load, apply `--ctx-size` and the KV bound correctly, set the cache limit to 20 GiB, require the API key on `/v1/cancel`, and stop logging context-limit stops as parse errors
- fix(llamacpp): time out and bound engine worker calls, keep a streaming model busy until it drains, check HTTP status on remote GGUF fetches, and make KV and memory estimates overflow-safe
- fix(net): keep provider connections alive, retry a request that never connected, and tell an unreachable host apart from a DNS failure
- fix(tls): accept CA bundles on UNC paths, mapped drives and short names, and apply exactly the certificates that were validated
- fix(server): surface Anthropic and Gemini mid-stream errors, decode SSE bytes across chunk boundaries, and make the Verbose Server Logs switch reach the API server
- fix(reasoning): keep Anthropic thinking budgets under the output ceiling
- fix(auth): refresh an expired account token once for concurrent callers, keep a rotated Claude Code token when write-back fails, and restore the previous credential when a login's config write fails
- fix(claude-code): Reset removes custom environment variables, which are shell-quoted and cleaned up on Windows without a console flash
- fix(models): drop a model locally only after its delete succeeds, and probe vision once per dropdown open
- fix(providers): send `api_type` when registering a provider with the backend
- fix(vector-db): skip chunks of another dimension in linear search; move RAG to calamine 0.36 for RUSTSEC-2026-0194

### Chat and composer
- feat(chat): warn before sending images to a model without vision
- feat(chat): per-chat model settings and a reasoning-effort bar (#2)
- feat(chat): temporary chat lifecycle — keep, discard, and a leave guard (#3)
- feat(chat): split a conversation into two independent panes, with a Details inspector
- feat(chat): attach text and code without asking the model to see it
- feat(composer): one @ menu for files, skills, agents and aliases, and name a selection as an alias
- feat(web-search): native `web_search` / `web_fetch` tooling and provider improvements
- feat(chat): queue messages while a run works, and steer it with one at its next tool call; edit, drag to reorder or remove queued messages, in Chat and Cowork; Stop or a failed run holds the queue with Send and Discard instead of dropping it
- feat(chat): compact automatically at the threshold, show where it happened, and compact by hand with `/compact`
- fix(threads): keep a conversation's tail reachable when a message is removed, and never leave a torn thread file behind
- fix(threads): opening "Delete all" and pressing Enter no longer deletes every thread
- fix(chat): a tool call with unparseable arguments no longer breaks the rest of the conversation
- fix(chat): a new chat starts from the last-used model, or the first local one
- fix(messages): never persist or replay a tool call without arguments
- feat(chat): sidebar chats grouped as Pinned, one collapsible group per project, then Ungrouped, with a filter and status marks (working, recent, waiting, pull request)
- feat(chat): drag a chat onto a group, hover a row for a preview, and move between rows with the arrow keys
- feat(chat): undo a chat delete from the toast
- feat(chat): the window title leads with the number of approvals waiting
- feat(chat): a new transcript and tool timeline, chat header, model picker, Details column and split pane
- feat(composer): a new composer with an assistant menu and a tools drawer
- fix(chat): the chat list shows each thread's real time and sorts correctly
- feat(composer): a shared slash-command menu in the Home, Cowork and Rooms composers, served per surface from the desktop catalogue
- feat(reasoning): a live thinking timer
- feat(terminal): stream bash output live and render ANSI colours
- fix(chat): queue a send while the previous turn's tools are pending, and stop a superseded request from ending the newer run
- fix(chat): record why a turn failed, render message times in local time, and keep Increase Context Size working when an MLX unload fails
- fix(chat): count pages read separately from search hits in the sources badge, and recheck project documents before using the tool cache
- fix(threads): keep a thread's model when its assistant is set to None, skip an unreadable `thread.json`, refuse unsafe thread ids, and remove a deleted thread's agent scratch directory
- fix(messages): handle a failed backend delete, and keep updates made while a message is being saved
- fix(websearch): strip YAML front matter from fetched pages, and cap response bodies while reading them
- fix(web): truncate long tool-card details, and keep string tracking across escaped quotes in tool-argument repair

### Design, onboarding and system
- feat(design): a new interface design, replacing the Graphite and Atelier redesigns (#15, #11): a 250px sidebar (Workspace, Engine, Chats, Support) beside a main panel with a 52px top header and breadcrumb, and a local-status card in the sidebar footer
- feat(design): new colour tokens, a neutral Slate default accent, a Violet accent and Inter as the interface font, with a derived, contrast-checked accent; a saved Vermilion accent moves to Slate once
- feat(design): theme, accent, font size and motion apply before first paint (no white flash in dark mode), and a new start-up loader follows the theme and Reduce motion
- feat(design): a duotone icon set, brand logos for models and providers, and the flint rock as the favicon
- feat(design): motion that follows Flint's own Reduce motion setting: the sidebar selection glides between rows, pages fade in, primary buttons ripple, the theme toggle reveals the new theme from the button, and figures count up
- feat(design): redesigned components — buttons, dialogs, menus, sheets, switches, inputs, frames, segmented controls, chips and empty states — and redesigned Library, Models, provider, Tools & MCP, Extensions, Logs and System monitor pages
- feat(overview): an Overview dashboard as the start page after setup — tokens generated, average speed and tool-call success with sparklines, tokens per day, latest activity and Cowork runs — from a local store that keeps 90 days, never leaves the machine and can be reset
- feat(design): a notifications menu behind the header bell
- feat(design): phone layouts for every page with every feature kept: a navigation sheet, a header overflow menu, stacked frames, and tabs or sheets for side panels
- feat(ui): right-click context menus for plugins, skills, projects, messages, MCP servers and project files
- feat(rooms): a Rooms landing page with running, waiting, turns and models figures, a "waiting for you" section, filters, room cards and templates; a room tree in the sidebar; and a new room page
- feat(onboarding): an intention-led first run that resumes, skips and can be reopened
- feat(settings): global settings search with focusable, structural targets grouped by section
- feat(settings): a Permissions page to inspect and revoke grants, and a Memory page
- feat(search): a redesigned search dialog and command palette, with rebindable shortcuts
- feat(system): a system monitor and filterable log viewers
- feat(settings): a new settings layout; Appearance gains a Reduce motion switch, an accent picker with a custom colour picker, and a font size that scales the whole interface
- fix(a11y): name the message edit and delete buttons

---

Flint is an independent fork of [Jan](https://github.com/janhq/jan) by [janhq](https://github.com/janhq) and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements, and upstream provenance.
- feat(groups): a shared conversation-groups store that projects migrate into once, with folder bindings read without listing their contents
- feat(logs): the Logs page as the design draws it: search, level filter and a line count above terminal-style lines, newest first
- fix(dialogs): per-item delete dialogs cancel correctly, the busy-on-exit Cancel stops the pending quit, and a project file delete asks for confirmation
- fix(settings): really lock Local API Server fields while it runs, reject a root data folder before unloading models, and merge settings writes with the file on disk
- fix(app): write the app configuration and `projects.json` atomically, clean up agent and MCP processes on force quit, and log an unusable store instead of crashing
- fix(windows): keep an aborted upgrade usable, clean up stale `.old` binaries, and never delete the install directory recursively
- fix(build): pick sidecar downloads from the host triple, fetch AppImage tools for the host architecture, stop the AppImage repackage when a step fails, and read the pinned llama.cpp tag correctly on Windows checkouts with CRLF line endings
