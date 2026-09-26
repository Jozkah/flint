# Flint features

Everything below is implemented in Flint, on top of upstream [Jan](https://github.com/janhq/jan). Sections marked "inherited from Jan" build on upstream work.

## Multi-agent collaboration (Flint)

- **Session-to-session messaging:** agent sessions in the same project can message one another through a backend mailbox. Messages are attributed to the sender, replies are addressed back, and delivery is project-scoped and fenced against prompt injection.
- **`stop_session`:** a permission-safe way to stop a running peer session in the same project, gated by explicit user approval, with protection against acting on a run that already ended.
- **Multi-model Discussion Rooms:** put several providers and models in one room with moderator and speaking policies, a shared transcript with addressed replies, per-room budgets and limits, persistence, restart recovery, termination, and synthesis. Participants have their own colours, `@mentions` are colour-matched, and messages render Markdown.
- **Tool-using rooms:** give a participant read-only or read/edit access and attach a working folder — writes are confined to it by a direct-edit grant. Participants can also use your trusted MCP-server tools (routed to the exact server) and web search. Every call shows as a colour-coded chip that expands to its input and result, just like Cowork. A participant can conclude a discussion early; a stopped room resumes when you message it and offers to continue past a limit; and long discussions compact themselves to fit each model's context window.
- **First-launch JAN migration assistant:** see [Migrating from Jan](../README.md#migrating-from-jan).

## Local inference and providers (inherited from Jan, extended)

- **Local inference:** run GGUF models on your own machine via the bundled llama.cpp engine (upgraded to b10809 in this release), or MLX models on Apple silicon. You bring your own model files; nothing is downloaded for you.
- **Providers:** add cloud providers (OpenAI-compatible and Anthropic-style endpoints) with your own key, or point Flint at a LAN / self-hosted OpenAI-compatible server. Keys live in the OS keyring.
- **Token & prompt-cache accounting:** provider-reported usage and prompt-cache reuse are tracked per request, turn, and session.

## Workspace and design

- **Flint Atelier design:** ivory and graphite themes in light and dark, IBM Plex Sans and Mono with Newsreader (bundled, never fetched), and Lucide icons throughout.
- **Accent colour:** choose Vermilion, Ink, Moss or any hex value. Colours are derived per theme and checked for contrast, invalid hex is refused, there is a reset, and older accent settings migrate. Success, warning and error colours never change.
- **One layout for every screen:** a rail for Workspace, Library, Models, Tools, Search, System and Settings; a resizable sidebar; a context bar for the current page; and a status bar showing loaded models, runs, waiting approvals and the Local API server.
- **Any window size:** below 1024px navigation moves into a sheet; on phones dialogs become bottom sheets, touch targets are at least 44px, and the layout follows the on-screen keyboard.
- **System area:** system monitor, app logs and Local API server logs in one log viewer.
- **Library** of artifacts from your sessions, with "Go to session".
- **Settings search** across every settings page, grouped by section.
- **Command palette and custom shortcuts:** rebind any shortcut, conflicts are refused, and defaults can be restored.
- **First-run guide:** asks what you want to do, explains local and cloud processing, can be skipped or reopened, and finishes without downloading anything.
- **Plain-language help** for terms like worktree, context, MCP server, checkpoint and agent; advanced settings are grouped separately.
- **Accessibility:** agent screens have screen-reader roles, labels and announcements, work fully from the keyboard, and keep focus rings visible.

## Chat

- **Split conversations:** two independent chats side by side, each with its own model, draft, attachments, queue, approvals and Stop.
- **Temporary chats** that you can keep or discard, with a warning before you leave.
- Per-chat model and reasoning settings.
- **Text and code attachments** also work with models that have no vision.
- **What Flint is using:** for each reply, the model, instructions, memory, tools and attachments that applied, and whether each was actually present in the request that was sent.
- **Collection memory** follows a chat's collection; temporary chats use no memory.
- **Sensible default model:** your preferred default, then the last model used, then the first local model. Flint never switches to a cloud provider on its own.
- **Safer editing:** deleting a message keeps later replies, "Delete all" cannot be triggered by Enter, and interrupted writes cannot leave a damaged thread.

## Cowork: modes, scope and planning

- **Run modes:** Auto, Ask before changes, and Review (a repository starts in Review).
- **Plan mode:** read-only exploration; leaving it requires approving the plan.
- **Write scope** is granted separately from how freely Flint acts, and shell commands are held to the same folders.
- **Readiness check** of each part of the setup before tools are allowed.
- **Describe this project:** a read-only survey of a new folder that proposes a Flint.md.
- **Todo list** that survives restarts, and a **shared task board** where tasks start only when their dependencies are done.
- **One @ menu** for files, folders, skills, agents and saved aliases, including line ranges.
- **Steering:** redirect, answer or interrupt a run while it works.

## Cowork: worktrees, changes and review

- **Managed Git worktrees** per session and per agent, on Windows too, with lifecycle management, recovery and safe cleanup that never loses unmerged work.
- **Diff before approval** for every write; Stop withdraws a pending prompt so a late "yes" runs nothing.
- **Per-hunk review:** apply only the hunks you choose; applying over changed content fails loudly and merge conflicts are shown.
- **Risky changes flagged:** dependency, lock file and migration changes need an explicit acknowledgement.
- **Secret scan** blocks diffs that contain credentials, and new dependencies are checked against allowed licences.
- **Changes panel** with the working tree, line-numbered diffs and a count of Flint's own changes.
- **Change attribution:** every change records which agent and run made it.
- **Format on edit** with the project's own formatter.
- **Worktree bundles:** export a reviewable patch bundle and import it through the same review.
- **Checkpoints and rewind:** restoring first takes a safety checkpoint, refuses to overwrite newer edits and verifies the result. Undo and redo a turn's file changes.
- **Read-only code workspace:** file explorer, code viewer, open files from the transcript, by drag and drop or with Ctrl/Cmd+O.

## Cowork: agents, teams and background work

- **Agent profiles** from project, user and plugin folders, each with its own model and tools and never more authority than its parent.
- **Six built-in roles:** explorer, planner, implementer, reviewer, tester and security, each with an enforced tool list.
- **Parallel sub-agents** that can start from a copy of the conversation, run in the background, message each other, and be listed, cancelled, restarted or replaced one by one.
- **Teams:** a team row with its members underneath, isolated checkouts for isolated tasks, and review of overlapping work.
- **Consensus gates** that require agreement from several independent reviewers, with limits on how deep and wide agents can spawn.
- **Background shell jobs** you can watch and stop individually, with an honest record of how each ended.
- **Helper agents** for titles and compaction run without tools and are logged.

## Cowork: timeline, run record and limits

- **Live tool timeline** with each call's phases, approvals, duration, input, output and resulting diff.
- **One event log per session** for both Chat and Cowork, with typed errors.
- **Process tree** of what a run started, and CPU and memory per run.
- **Honest run summaries:** what was attempted, what finished and what passed; only real test, build and lint commands count as checks.
- **Replay** a finished run step by step or from its record, **export** its events or a full audit record, and **search** past transcripts.
- **Limits:** token budget, step limit, wall-clock deadline, per-tool and per-run timeouts.
- **Stopping that works:** cancelling reaches sub-agents and kills started processes; one Stop asks how far to stop; an emergency kill switch stops everything.
- **Recovery:** retries with backoff for retryable errors, stuck-loop and repeated-call detection, and runs that resume after a restart with their tool calls intact.
- **Notifications** when a run finishes or needs you, and **webhooks**.
- **Sessions:** fork a session without copying its permissions, export and import a session, or hand one to another computer.

## Coding intelligence and Git

- **Repository index** built once and kept current across edits and branch changes.
- **Language servers:** symbol search, find references, go to definition, call hierarchy, and compiler diagnostics fed back after edits.
- **Change impact:** import graph, tests that cover a file, what a change can affect, and automatic test selection.
- **Project detection** of framework, build system and test runner, plus a health scan.
- **Test triage:** failures grouped by cause and flaky tests told apart from regressions.
- **Git workflows:** commit messages, commit splitting, branch management, pull requests and description sync, working through review comments, merge conflict, rebase and cherry-pick help, and diverged-remote detection.

## Context and memory

- **Exact context accounting:** token counts from the request actually sent, split by system prompt, tools, project context, skills and messages.
- **Visible compaction** with one setting everywhere, warnings before the window fills and room reserved for each turn.
- **What the model received:** the saved request for each turn, context replay and a diff between two turns.
- **Context window size** learned from the server rather than guessed.
- **Memory scopes:** project, session and user memory with the source of every line, a stated precedence and conflict detection.
- **Memory settings:** scope tabs, a collection picker, conflict resolution, export and import, and forgetting that also reaches saved requests.
- **Memory proposals** that you review before saving; sensitive content is refused.
- **Instruction files:** Flint.md, CLAUDE.md and AGENTS.md, nearest file wins.
- **Retention limits** for saved requests, removed together with their thread.

## Models and providers

- Rename and reorder models.
- **Evidence-based model fit:** "Measured on this device" is kept separate from "Estimate", estimates never block you, and a real compatibility test protects other loaded models.
- **Preferred default model** and one model status vocabulary across the app.
- Provider fallback and routing rules.
- **Fully local runs** with no network dependency.
- **Custom request headers** with secret values, and **llmman** as a built-in local provider.
- **Accurate provider status:** offline only after a real failure, LAN endpoints treated as local, and the actual failure reason shown.
- **Proxy settings** with authentication and no-proxy rules.

## Tools, MCP, skills and plugins

- **MCP servers:** tools, resources and prompts, protocol health checks, per-server logs, restart without restarting Flint, cancellation, pagination and per-server size limits.
- **MCP sign-in (OAuth)** with tokens in the OS keychain, refreshed automatically, and requested scopes shown and enforced.
- **Trust bound to a server's configuration:** changing, renaming or deleting a server invalidates its approvals with a stated reason.
- **Validated MCP setup** with clear connection states and a per-server auto-approve switch.
- **Sandboxed servers:** imported and local servers are confined to the session's permissions.
- **Skills** from project and user folders with versions, requirements and enforced tool scopes.
- **Plugins:** a manifest format, install and remove without running plugin code, a marketplace index, and a Cowork plugin manager to enable, disable, install and remove.
- **Lifecycle hooks** that run sandboxed with timeouts and a declared failure policy.
- **Imports:** OpenCode and Qwen agent definitions, Claude Code project settings (opt-in), and portable bundles of agents, skills, commands and policy.

## Permissions and safety

- **Permission rules** by capability, path, command (compound commands are split first), agent, skill and MCP server; deny wins and the most specific rule applies.
- **Network controls:** one switch for all tools and domain allow and deny lists.
- **Secrets:** protected secret files, redaction in logs and transcripts, and credentials in the OS keychain.
- **Destructive Git commands** gated separately.
- **Plain-language approval prompts** that say what will happen, which files are involved and what denying does, offer only real scopes, and focus Deny first.
- **Allow once is never saved,** and an approval covers only the exact command or file shown.
- **Permissions page:** every standing grant with Revoke, trusted MCP servers, invalidated approvals with reasons and the latest audit decisions.
- **Policy files:** import and export a permission policy, and a machine policy a project cannot loosen.

## Usage and cost

- **Token usage per message and per session:** input, cached input, cache writes, output and total, marked "Not reported" when a provider does not report a figure.
- **Token and cost dashboard** per run and period, priced where you set prices.
- **Usage quotas and spend budgets** across runs.
- **Correct generation speed** for providers that stream without a start event.

## Privacy and local-only

- No telemetry, analytics, update checks, model catalogue or downloader.
- **No outside calls you did not set up:** extensions no longer fetch, vendor hosts are removed, and web search results are not sent to third parties.
- **Automated local-only guards** over the source and the shipped app.
- **Request log** of what the model was sent and where every request went.
- **Local API server:** a working CORS switch, and caller origins are not forwarded.
- **Diagnostic bundle** that is redacted, previewed and never uploaded.

## The `jan` command line

- **Headless agent runs:** text or JSON output, a live event stream, output density, profiles, plan and ask modes, sandbox control, and resume or continue after an interruption.
- **`jan cli agent serve`:** a JSON-lines API to start runs, stream events, answer approvals and cancel.
- **Agent tools from the terminal:** process tree, test triage, health scan, licence check, transcript search, quotas and spend, compaction, bundles, agent imports, policy import and export, repository index, run state, agent mail, Git helpers, change impact and context inspection.
- **Background jobs** that outlive the process (`jan cli job`).
- **MCP from the terminal:** prompts, logs and OAuth sign-in management.
- **Benchmarks** (`jan cli bench`) and **bug reports** (`jan bug-report`, `/bug` in the TUI) with a local log file.
- **Slash commands** with arguments from built-ins, skills and plugins (command line only).

## Platforms

- **OS sandbox for shell commands:** bubblewrap on Linux, Seatbelt on macOS and AppContainer on Windows.
- **Windows:** working builds and sidecars, managed worktrees, the tool timeline and native window controls, with the window position restored.
- **macOS:** window controls kept clear of the header, and the whole header drags the window.
- **Custom data folder** honoured everywhere, with a safe fallback if it disappears.

## Verification tooling

- **Machine-readable feature registry** with validation, rendering and architecture decision records.
- Benchmark harness, golden repositories and a prompt-injection and escalation corpus.
- **Real-app scenario harness** (`cowork-smoke`) that drives the actual desktop app with a local model fixture.

## Not finished yet

- Semantic code search is built but has not been verified against a real embedding model.
- Custom CA certificates are verified on Windows only.
- The desktop app has no slash commands or marketplace browsing; those are available from the command line or as agent tools only.
- A full screen-reader pass has not been done.
