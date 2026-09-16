# Flint 0.9.0

Flint is a local-first, private fork of [Jan](https://github.com/menloresearch/jan) built into a full agentic workspace. This is the first tagged Flint release, and it gathers everything Flint adds on top of Jan: a private local-only build, a one-click migration path from an existing Jan install, the **Cowork** agentic coding workspace, tool-using **Discussion Rooms**, a reconstructable agent runtime, cross-chat **Memory**, fingerprint-pinned **MCP**, native **Skills**, and the Graphite/Atelier redesign.

## Highlights

- **Local-first and private.** Telemetry, update checks, model discovery and catalogue fetches are removed and the whole repo is guarded against phoning home; web search no longer reports back what it returned. Flint runs against your own models and providers, and nothing leaves the machine unless you send it.
- **Migrate from Jan in one launch.** Flint keeps Jan's identifier and data path, detects an existing Jan install on first run, and offers to Copy, Reuse, Move or Start fresh — per category, with conflict policies, a recoverable backup, rollback and idempotent resume.
- **Cowork — an agentic coding workspace.** A right-rail workspace with a Code panel, a Changes (Git) rail with real diff gutters, an Activity rail, per-chat models and temporary chats. Cowork answers with a **reviewable proposal** you apply hunk-by-hunk, runs on a **managed worktree** with checkpoints and safety-point restores, can **dispatch a team** of coordinated subagents, and reports every change's true origin from recorded evidence.
- **Discussion Rooms that can use tools.** Multi-model discussions, with you in control, that now do work: an attached folder with read/read-and-edit file tools, your trusted MCP servers, and web research — every call shown as a colour-coded chip. (See *New in this release* below.)
- **An agent runtime you can reconstruct.** Every run writes a versioned event log; a run interrupted mid-turn resumes carrying its unfinished work; token and dollar ceilings hold across runs; every tool call carries a deadline and a cancellation token; and a Timeline rail lets you step through a finished run and see what kind of failure occurred.
- **Repository intelligence.** A stored repository index with caller/callee walking, semantic code search over a model you name, LSP-backed language servers, impact and test-coverage analysis following imports, project-tooling detection, and formatter discovery that runs on what the agent edits.
- **Version control that understands the tree.** Branch and commit about what is actually staged, read a diverged branch or a stopped merge, split commits, guided rebase and cherry-pick, open pull requests and keep their descriptions in step, and work a review one comment at a time — with destructive git gated apart from safe git.
- **Cross-chat Memory.** One canonical record per scope with an enforced precedence chain stated in every prompt; the model proposes, you decide; user-level memory with per-scope recall and a forget that leaves no text; versioned provenance; and a Memory settings page that surfaces and settles conflicts.
- **MCP you can trust.** Servers are trusted by fingerprint, not the name they chose; OAuth tokens live in the secret store and refresh ahead of expiry with declared, enforced scopes; per-server liveness, logs and budgets; a server's documents and prompts; and imported servers launched confined or not at all.
- **Native Skills and permissions.** User-level skills in the CLI and the agent loop that declare the tools they need and their version; a permission policy as a reviewed file a project cannot loosen; write authority issued as a grant over a root; and six versioned built-in roles enforced at the call site.
- **A headless CLI.** A JSON-lines API that streams a run's canonical events with adjustable verbosity, a persistent local log and a local-only diagnostic bundle, and a harness benchmark against a fixed task set.
- **The Graphite / Atelier redesign.** One Atelier shell — rail, contextual sidebar, context bar and status bar — with a neutral charcoal dark theme, bundled typefaces, a contrast-checked accent, an intention-led first run, global settings search, a command palette, and a system monitor with filterable logs.

### New in this release: tool-using Discussion Rooms

Rooms — multi-model discussions with you in control — can now **use tools**, not just talk.

- **A working folder and file tools.** Attach a folder to a room, then give a participant **Read-only** or **Read & edit** access. Read-only participants can `read`, `ls`, `find` and `grep` inside the folder; Read & edit adds `write`/`edit`, confined to that folder by a direct-edit grant so a write can never land outside it.
- **Your MCP servers.** Tools from the MCP servers you have trusted are offered to participants and routed to the exact server they came from. Only servers whose current definition you trusted appear, so a call is never refused mid-turn.
- **Web research.** With web search on, participants get `web_search` and `web_fetch` and can cite what they find.
- **A clear tool trace.** Every tool call shows as a chip in the transcript, coloured by kind exactly like the Cowork tab — built-in indigo, reads cyan, writes amber, MCP violet, failures red — and expands to show the call's input and result.
- **Conclude early.** A participant can end a discussion once the objective is met instead of grinding out every round.
- **Continue past a limit.** When a room stops on a rounds/turns/tokens/time/cost limit, one click continues it for however many more rounds you ask — every limit is lifted together, so it actually runs on instead of stopping again.
- **Pick up a stopped room with a message.** Sending a message to a paused, completed or stopped room resumes it and the participants respond; at a limit it offers to extend.
- **Automatic compaction.** A discussion longer than a model's context window is summarised down instead of silently dropping the oldest messages, with a "Compacting…" note while it happens.
- **No more spinning.** A room whose participants are all waiting on you (e.g. asking for a file it does not have) pauses and hands back to you rather than looping.
- **Presentation.** Each participant has its own colour, reflected in `@mentions`; `@room`, `@user` (your accent colour) and `@moderator` are distinct; messages render Markdown; and the settings panel is a tidy collapsible accordion. New participants default to read-only tools when their model supports them.

### Fixes

- **"Allow all MCP permissions" no longer runs built-in tools without asking.** That setting is about MCP servers, as its label says — it was also silently approving Cowork's own `write`/`edit`/`bash` in Ask mode. It now only auto-approves an MCP server's tools; a built-in tool is still asked about.
- **A disabled tool can no longer execute.** Disabling a tool used to only hide it from the model; a model that re-emitted an earlier call could still run it. The call is now refused.
- **Cowork context bar.** The left-rail **"Workspace"** label no longer wraps to "Workspa ce", the context-bar buttons share one height, "Autonomous" mode reads **"Auto mode"**, and token usage is shown in a single place instead of two.
- **Rooms settings.** The room model picker now offers the same models as the Home and Cowork bars, and the settings panel no longer overlaps its **Save** button.
- **A tool call with a stray brace no longer fails.** Some models append an extra `}` or trailing text after otherwise-valid tool arguments (e.g. `{"path":"…"}}`); `read`, `ls` and `grep` were refused with "JSON parsing failed" and the run stalled. The first complete arguments object is now recovered and the call runs, in both Cowork and Rooms.
- **The `bash` tool tells the model which shell it is.** On Windows the sandbox cannot run bash inside its AppContainer, so a command is handed to PowerShell — but the model wrote bash syntax like `cp a b && echo done`, which Windows PowerShell rejects (`&&` is not a separator), failing the call and everything that depended on it. `bash`'s description now says to use PowerShell syntax when that is the real shell.
- **A giant file write no longer loops.** A `write` of a whole large file could overrun the model's output budget, cutting the arguments off mid-content so they never parsed; the generic error made the model resend the same oversized write and loop. The refusal now says the arguments were cut off and to build the file in smaller pieces, and no longer dumps the whole blob back into the conversation.
- **Auto-compaction no longer overflows the window.** Compaction fit the input to the exact context window using a token estimate; a denser real count (code- and JSON-heavy tool output) overflowed the server by a handful of tokens, a hard failure with no retry. A small window-proportional margin is now reserved, so the estimate's slack triggers one more compaction instead of failing the run.

## Migration

**Flint detects an existing Jan installation on first launch.**

Because Flint keeps Jan's bundle identifier (`jan.ai.app`) and data path, an existing Jan install is found automatically, and the first-launch assistant offers four choices. **Copy to Flint** duplicates the selected data and preserves your original Jan installation and data untouched. **Reuse Jan data** shares the selected existing data in place, with concurrency protection so both apps do not corrupt it. **Move to Flint** copies into Flint and then removes the Jan source once every item succeeds, keeping a recoverable backup and supporting rollback. **Start fresh** begins with an empty Flint profile and leaves Jan untouched. You can also migrate later from **Settings > General > Migrate from Jan**.

You choose which categories to bring — conversations and assistants, models, settings and provider credentials, configuration, extensions and logs, and the agent workspace and rooms — and how to resolve items that already exist in Flint. A newer item already in Flint is never silently overwritten. A failed migration rolls back to the previous state, an interrupted migration resumes idempotently, partial data is quarantined, and every run records a manifest. Your existing Jan data is never deleted automatically.

Your existing settings, credentials, providers, models, threads, projects, rooms, mailboxes, and extensions are preserved where compatible. Secrets continue through the protected keychain/backend-store path and are never copied into plaintext or logs. Legacy compatibility is kept throughout: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), `JAN.md` project files (alongside `FLINT.md`), the legacy data locations, and the persisted identifiers all continue to work.

---

## What's Changed
* Cowork code workspace, Activity rail, and global settings search by @Jozkah in https://github.com/Jozkah/jan/pull/1
* feat(chat): per-chat model settings, and a reasoning-effort bar by @Jozkah in https://github.com/Jozkah/jan/pull/2
* feat: Jan complete Cowork workspace — Code, Preview, Changes (Git), Activity, Settings search, per-chat models, temporary chats by @Jozkah in https://github.com/Jozkah/jan/pull/4
* feat(models): rename models, and put the list in an order by @Jozkah in https://github.com/Jozkah/jan/pull/5
* Cowork coding harness: make the declared modes real by @Jozkah in https://github.com/Jozkah/jan/pull/6
* feat(cowork): report the context the run actually got — a repository map, and the payload it really sent — plus the harness feature registry (Phase 0 only) by @Jozkah in https://github.com/Jozkah/jan/pull/7
* JAN Atelier redesign, integrated with phase 6 and beginner workflows by @Jozkah in https://github.com/Jozkah/jan/pull/11
* docs(readme): rewrite the README for the finished app by @Jozkah in https://github.com/Jozkah/jan/pull/12
* docs(readme): fix the model import path and the local-only guard claim by @Jozkah in https://github.com/Jozkah/jan/pull/13
* docs(readme): make the screenshot captions read as captions by @Jozkah in https://github.com/Jozkah/jan/pull/14
* JAN Graphite Studio redesign, with neutral charcoal dark theme by @Jozkah in https://github.com/Jozkah/jan/pull/15

## New Contributors
* @Jozkah made their first contribution in https://github.com/Jozkah/jan/pull/1

**Full Changelog**: https://github.com/Jozkah/jan/commits/v0.9.0

---

Flint is an independent fork of [Jan](https://github.com/menloresearch/jan) by Menlo Research and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements, and upstream provenance.
