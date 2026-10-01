# Flint 0.9.0

Flint is a local-first fork of [Jan](https://github.com/janhq/jan), rebuilt into an agentic desktop workspace for local and user-chosen models. This first Flint release combines the rebrand and migration path with Cowork, tool-using Discussion Rooms, an auditable agent runtime, Memory, MCP and Skills, remote access, a redesigned interface, and a fully branded Windows installer.

This changelog is release-oriented: it lists shipped features, additions and meaningful changes versus the Jan base. It intentionally does **not** list follow-up bug fixes whose only purpose was repairing a Flint feature introduced during 0.9.0 development. Bug-fix entries are kept where they apply to inherited/original Jan behavior or an upstream Jan issue.

## Highlights

- **Local-first and private.** Telemetry and automatic update checks stay disabled, while model discovery is intentionally user-initiated through Hugging Face **Discover** instead of hidden background catalogue traffic. Models, providers and data remain under the user's control, and external access only happens through features the user enables or invokes.
- **Hugging Face Discover.** Search Hugging Face, inspect model details and README, and download the exact GGUF quantization (or MLX repository on Apple silicon) you choose, with hardware-aware recommendations, gated-model token support, resumable/cancellable downloads and size/SHA-256 verification. Nothing is contacted until you open Discover, search, or click Download.
- **Jan → Flint migration.** Existing Jan data is detected on first launch with Copy, Reuse, Move and Start fresh modes, per-category selection, conflict handling, backup/rollback and resumable migration.
- **Cowork.** A full agentic coding workspace with managed worktrees, proposals, hunk review, Code/Preview/Changes/Activity panels, checkpoints, subagents, multiple attached folders, PR state/checks and browser verification.
- **Discussion Rooms.** Multi-model rooms with per-participant models, tools, folder access, MCP, web research, reasoning controls, limits, pausing/resuming and automatic context compaction.
- **Auditable agent runtime.** Versioned event logs, replayable execution records, deadlines/cancellation, budgets, retry policy, background jobs, subagents, readiness checks, loop protection and run timelines.
- **Repository intelligence.** Stored repository indexes, caller/callee traversal, semantic search, LSP integration, impact/test analysis, project-tool detection, formatter discovery and diagnostics.
- **Git and GitHub workflows.** First-class git tooling, branching/commits, split commits, rebase/cherry-pick flows, PR creation/review, conflict status, CI check hand-off and approval boundaries for remote operations.
- **Memory, MCP and Skills.** Cross-chat scoped Memory, fingerprint-pinned MCP trust, OAuth secret handling, per-server health/logs/budgets, native Skills, plugin-scoped Skills and reviewed permission policies.
- **Redesigned Flint UI.** New shell/sidebar/header, Overview dashboard, Slate/Violet appearance system, Inter, duotone iconography, redesigned settings/components, split view, groups, phone layouts, notifications and System Monitor.
- **Remote access preview.** Pair a phone over Tailscale, LAN or loopback and use Chat, Cowork and Rooms while models, keys and files remain on the desktop.
- **SDK and CLI.** JavaScript/Python Agent SDKs, protocol v1, host tools, Flint tools over MCP, JSON-lines CLI, diagnostics and benchmark tooling.
- **Fully custom Windows installer.** The NSIS installer is now a real Flint-styled setup flow rather than a stock/passive Tauri wizard, with the actual Flint app icon, Inter, app colors, custom controls, install options, progress, completion and matching uninstall screens.

## Final 0.9.0 additions

These are the significant additions merged after the previous 0.9.0 changelog pass.

### Built-in assistants and JEV routing

- Added four specialist assistants alongside the default Flint generalist:
  - **Quartz** — research, analysis, comparisons, calculations and evidence synthesis.
  - **Coal** — software engineering, implementation, debugging, testing and code review.
  - **Blaze** — creative/product ideation, UX concepts, naming and polished copy.
  - **Redstone** — automation, integrations, systems workflows and repeatable operations.
- Added distinct Flint-style pixel icons and behavior/sampling profiles for all four specialists.
- Existing installs receive the specialists through assistant migration v4 without overwriting an existing assistant that already uses one of the built-in IDs.
- Optional JEV routing can choose Flint/Quartz/Coal/Blaze/Redstone once per new user message and suggest an advisory **Review / Ask / Auto** work style.
- JEV routing never grants permissions or changes Cowork authority. Custom/project assistants stay pinned, and invalid or unconfident routing falls back to Flint.
- Cowork can inject the selected specialist persona beneath its existing policy/project instructions, while Flint itself keeps the normal Cowork baseline.
- Automatic work profiles are re-evaluated for each new user message and can use JEV ranking with Flint's local classifier as fallback.

### Remote access and mobile parity

- The mobile app now has real paginated chat history while preserving scroll position and rendering system/tool messages.
- Phone-created Cowork sessions can select an existing recent desktop folder without widening write authority.
- Rooms can be created, updated and deleted from the phone.
- Room participants can change model and Auto/On/Off reasoning from mobile; moderator model/state, speaking mode, limits and room control actions are available remotely.
- Thread rename/pin/delete and Cowork fork/delete are real phone actions.
- Unsupported desktop-only actions are shown as computer-managed instead of pretending to be selectable mobile controls.
- Pairing exposes a QR code plus a selectable/copyable link and retains a manual fallback when clipboard storage is unavailable.

### Browser verification

- Verify in browser and the screenshot tool now support Chrome, Edge, Brave, Opera/Opera GX, Vivaldi, Arc and Chromium.
- **Choose a browser…** lets the user select a Chromium-based executable manually.
- The chosen browser is shared by the verification runner and screenshot tooling for the current Flint session.
- Windows discovery uses real install layouts, including Arc's Windows app-execution alias.

### Attachments, images and forking

- Added file attachments to Cowork messages. Documents are read inline or through embeddings, as in Chat, and reach the model with the message.
- Added **Fork chat** to Chat, from the sidebar or from any reply, so a conversation can branch from any point into a new chat.
- Added image description for models that cannot see. An attached image is described by a vision-capable model so a text-only model can use it, and the description is embedded so image content is searchable in Chat.
- Attached images show above the message as one large card, or a row of tiles for several, in Chat and Cowork, and the composer previews them at a size worth looking at.
- Clicking an image opens a viewer with arrow-key stepping, zoom by buttons, keys or wheel, drag when zoomed, save under its name and Esc to close.
- Cowork keeps a resized copy of each attached image in the session, so images open again after a restart.

### Routing, skills and parameters

- Added switches under **Settings → Jev** for **Route to the right assistant** and **Apply skills automatically**, next to the existing work-profile switch, so each automatic choice can be turned off on its own.
- A reply now names the assistant that answered it, with that assistant's icon, so a turn routed to Quartz, Coal, Blaze or Redstone shows it.
- A reply shows **Used N skills** on its speed line, and pressing it lists the skills.
- Hovering a parameter in **Add parameter** shows the value the model reports as its default, read from llama.cpp's `/props` for local models and from a self-hosted vLLM server's render endpoint for a server on your own network.
- Reply actions show a tooltip each, a dot separates the cache figure from the speed, and the row holds still while hovering.
- The Windows installer, Flatpak metadata and credits name Jozkah.

### Rooms: assistants, tools and folders

- Each participant can be given its own **assistant** and **work role**, picked from menus that match the composer's, with an **Other** role that takes free text and a way to add a custom assistant.
- A participant runs with its assistant's sampling (temperature, top-p, top-k and the like) as well as its instructions, and is told which language to write in.
- A room can attach **several folders**, each with the same access as the main one.
- A new **Like Cowork** access level lets a participant read, edit, run commands with the shell, use git, and call skills and plugins. Anything that changes files or runs a command asks for approval, and a refused call is reported instead of retried.
- Tool calls in a room are folded to one line saying what they did, such as **Ran 10 commands, edited 1 file**. Opening it shows a chip per call, hovering a chip shows what it was given and what came back, and **Details** lays every call out in its own card.
- A live turn says what the participant is doing (thinking, writing, running a named tool, or waiting for your approval) and lists the calls finished so far, instead of a fixed "Speaking…".
- Each reply shows the tokens it wrote and how fast, at the end of its header, also for turns that only made tool calls. A message to a participant is coloured like that participant.
- **`/clear`** forgets a room's chat, its accumulated state, or everything including its scratch files and waiting prompts, and never touches its settings or folders.
- A long turn of tool calls is charged to the room's token budget once, not once per call.
- Regenerating a title is also available for Cowork sessions and rooms.

### Models that have gone away

- Starting or resuming a room, chat or Cowork session with a model that is no longer available asks which model to use instead of failing or silently skipping the participant.
- Refreshing a provider's model list now removes models the server no longer lists, and an empty answer never clears the saved ones.

### Reply language

- A new **Reply language** setting under **Settings → General** makes the model answer in a chosen language in chats, Cowork and rooms, whatever language the user, files or tool results are in. Code, commands and paths are left alone. **Automatic** keeps the old behaviour.
- Rooms repeat the language rule in the last message of every turn, where a long turn of tool results cannot push it out of reach.

### Titles, spacing and assistants on replies

- **Regenerate title** in the sidebar menu of a chat, Cowork session or room rewrites the name from what the conversation is about. The chat, Cowork and Rooms menus are split into groups, and submenu triggers use the same text size as items.
- Cowork replies and room messages name the assistant that wrote them, and a rule marks where the assistant changes. Messages sit closer together.
- `/compact` and automatic compaction show a **Compacting the conversation…** row in Chat and Cowork while they run, instead of nothing until the summary appears.
- Sidebar preview cards show a written summary of the conversation instead of its first prompt, and size to fit it.

### Fixes to original Jan behavior

- Opening a chat no longer animates every message in, which made long chats slow to appear. A chat's messages are also read when the pointer reaches its row.
- A site without a favicon tries its common icon names before falling back to a letter.

### Run summary and opening pages

- A finished run's folded steps now say what the run did, such as **Ran 20 commands, created 8 files, used 6 tools +645 −0**, instead of a bare step count.
- Each step inside a folded run is one closed line saying what it did, such as **Read AUDIT.md** or **Failed to run Diffed original vs patched files**, and opens on click. The run's line counts failures, as in **Ran 54 commands, read 4 files (2 failed)**. The bash tool takes an optional `description` for that line.
- Added an **`open_in_browser`** tool. The model can put a page in front of the user, shown as an **Opened in Browser** card with an **Open** button and a link menu. A page on this computer opens at once; any other site waits for the user to press **Open**.

### Git approvals

- Inline approvals keep **More options** available instead of hiding it when the immediate request only exposes Allow once.
- Added **Allow all temporarily** for non-destructive remote Git/GitHub operations in the current conversation.
- Temporary Git trust stays in renderer memory, is never persisted as an Always allow grant, is not offered to temporary chats and never covers destructive Git operations.

### Search, MCP and interface additions

- Added a DuckDuckGo MCP preset using `uvx duckduckgo-mcp-server`.
- Added **DuckDuckGo** as a native web-search provider that needs no API key, account or instance URL. Results are read in page order with ads and repeated links dropped, and a bot check is reported as an error that names the way out instead of an empty result list.
- Naming a configured MCP server that is off now offers to enable it, instead of the model silently going without its tools.
- The model picker searches by the remote a model sits behind and labels each row with it when more than one remote offers the same model.
- Native web-search providers can show their real favicon in Flint UI surfaces.
- Added a **New group** action to the Move to group flow.
- Compact split-pane labels use **Auto** / **Edit** while retaining full accessible labels.
- Settings rows, including the Local API Server model selector, use the constrained Flint layout correctly.

### Inference and repository targeting

- Upgraded the bundled llama.cpp engine from 0.4.1 / b10964 to **0.5.0 / b11146**, with matching packages and lockfiles.
- Active release workflows, package metadata, project links and web-search identification now target `Jozkah/flint` rather than the upstream repository where appropriate.

### Local models and engine settings

- Added **Find models already on this computer** to the model import dialog. It lists GGUF models kept by LM Studio, Ollama, the Hugging Face cache, llama.cpp and GPT4All, honouring `HF_HUB_CACHE`, `HF_HOME`, `LLAMA_CACHE` and `OLLAMA_MODELS`. It runs only when asked, skips projector files and later shards, and a chosen model is used where it lives instead of being copied.
- Sending a message with no model selected now picks one and sends, instead of stopping at "select a model": your default, the last used model, a connected remote provider, then the only local model or the lightest by the size in its name. Embedding models are never chosen.
- Added an **Additional arguments** setting for llama-server (for example `--rope-scaling yarn --no-warmup`). The options apply to every model and win over the individual settings. Options that would move the server or change the files it opens, such as the host, port, API key and model paths, are ignored.
- A tool call a local model writes as text is now run. Hermes and Qwen 2.5, Qwen3-Coder, GLM, Mistral and Llama 3.1 call formats are recognised when the server could not parse them, for llama.cpp, MLX and OpenAI-compatible models. Only calls naming a tool the request offered are run, and a call the server already parsed is never run twice.
- The model-fit check uses the KV cache type a model is configured with instead of assuming f16, and no longer counts an integrated GPU's memory twice.
- A quantized V cache is held at f16 when flash attention is off, which llama.cpp cannot load, and a DFlash draft defaults to greedy sampling.
- The Anthropic `/messages` endpoint merges scattered system and developer messages into one leading system message, which strict chat templates such as Qwen3's require.
- An image returned by an MCP tool (a screenshot tool, for one) no longer floods a local model's context as base64 text. For llama.cpp and MLX it is replaced by a note in what the model reads and, for a model that can see, attached again as an image. Remote providers and the stored conversation are unchanged.
- The Local API Server answers "no model is running" and "the engine is not answering" with a JSON error that has a `code` and a `Retry-After`, keeps 502 for an unreachable remote provider, finds an MLX model when a client writes `.` as `_`, and explains a port the system refuses (Windows reserved ranges) instead of showing a bare error.
- The Local API Server's timeout now limits silence rather than the whole request, so a long generation from a large local model is no longer cut off mid-stream.
- The hardware probes behind the memory and GPU readouts run off the main thread, which could freeze the window on Windows. Every closed `<think>` block, not only the first, is removed before a reply is sent back to the model.
- Loading a model whose file was moved, deleted or only partly downloaded now fails with that reason, naming the file, instead of the loader's own error.
- An image over the 10 MB attachment limit, such as a large PNG screenshot, is re-encoded to fit instead of being refused. The tool list sent to the model is sorted by name, so an MCP server reconnecting in a different order no longer discards the prompt cache.
- A WebP image sent to a local vision model is converted to PNG first, because llama.cpp cannot read WebP and the image was failing or dropped.
- Adding a self-hosted OpenAI-compatible server by its bare address, such as `http://host:8000`, now finds its models: the model list is also tried under `/v1` when the first address answers 404, and pasted spaces and trailing slashes are ignored.
- Editing a message you sent with images keeps the images instead of dropping them.
- The copy buttons for API keys and secrets show "copied" only once the clipboard write has succeeded.
- Added **voice input**: a microphone beside Send dictates into the message box, with the words spliced in at the caret phrase by phrase while you talk. Speech is turned into text on this computer by Voxtral Mini 3B, a one-time download of about 3 GB that runs next to your chat model and unloads a few minutes after you stop. Press the microphone again to keep the text, or Escape to throw the dictation away.
- Added **Studio**, a new page for making images and video on this computer with stable-diffusion.cpp. The engine (30 MB for the Vulkan build, about 900 MB for NVIDIA CUDA) is downloaded once on request, checked against its published checksum and tested before use; the models are downloaded on request through the same resumable Hugging Face downloader. **Z-Image Turbo** (about 7.8 GB) makes images and **Wan 2.2 TI2V 5B** (about 8.5 GB) makes clips of 1 to 5 seconds, both Apache-2.0. Results are kept in a gallery with the prompt, size, steps and seed beside each one, and a clip shows a memory warning on a machine with under 32 GB. Windows only for now.
- Studio has a stage-first layout: settings on the left (model, shape, number or length, seed, things to avoid), a large live preview with the prompt docked under it and example prompts while it is empty, an Activity list of this session's jobs on the right, and the gallery below. Hovering a picture shows its prompt, seed and time with **Remix** (same prompt, new seed) and delete; clicking opens the same image viewer the chat uses, with zoom, arrow keys and save.
- Fixed a model download that could come out corrupt after a pause and resume in quick succession: the old transfer could still have the partial file open when the new one started, and its late open wiped what the new one had written, so a file of the right size failed its checksum hours later. Only one transfer now writes a given partial file at a time, and a pause while waiting for it is honoured.
- Studio retries a run that ran out of graphics memory with part of the model kept in system memory (then more of it), instead of failing a run that would fit; the setting that worked is kept for the next run.
- Studio shows a desktop notification when an image or video is ready or a model finishes downloading, but only while Flint is not the window in front. Permission is asked for when you start the job.
- Studio shows about how long a clip will take before it starts, scaled from the last clip made on this computer (pixels, frames and steps), and says nothing until there is one to scale from.
- Studio's shape choices are now the standard proportions (1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16 and 21:9) at about the same picture area each, with the exact size on hover. The model name no longer gets cut off in the settings column, and an empty stage is a compact box instead of a tall empty square.
- Studio shares the graphics card with chat: loading the image model stops the chat models, and starting a chat model stops the image model, which also unloads after ten idle minutes. Cancelling a run stops the engine, and the next run starts it again.
- The Local API Server gained `POST /v1/images/generations` (base64 only, sizes in steps of 16, 1 to 4 images, a model that is already loaded) and the OpenAI Videos routes `POST /v1/videos`, `GET /v1/videos/{id}` and `GET /v1/videos/{id}/content`, with the same error shape as the rest of the API. Image models stay out of `/v1/models`.
- A chat started from the phone with no model chosen now picks one on the computer, as the desktop does, and says so plainly when nothing can answer. The phone's copy buttons say "Copy failed" instead of staying silent when the connection has no clipboard, and a phone's chat history no longer shows a model's reasoning.
- A reply's token details show **Draft accepted**, for example `75% (30/40)`, when speculative decoding (MTP, DFlash or EAGLE-3) ran, so you can see whether a draft is paying off.

### Release infrastructure

- Tag pushes matching `v*` start the Flint release build, which attaches the Windows, macOS and Linux bundles to the existing release for that tag.
- Moving an existing release tag rebuilds it and replaces the bundles already attached to that release.
- The older tag build workflow is now manual-only: it needs an explicit tag, never touches a published release, and clears stale assets from a draft before uploading.
- Reusable release workflows use `$GITHUB_OUTPUT` instead of deprecated `::set-output` handling.

### Windows installer

- `tauri.windows.conf.json` permanently points NSIS builds at Flint's custom template, so local and CI builds use the same installer.
- Normal installer launches use the interactive Flint flow; silent/passive/update paths remain supported.
- Added Flint-styled welcome, installation options, existing-install maintenance, progress, completion, uninstall confirmation/progress and uninstall completion views.
- Installer typography, light/dark tokens, DPI behavior and controls match Flint's app design.
- The title bar and brand mark use the **real Flint application icon** generated from the app's canonical icon source.
- The installer exposes install location, desktop shortcut and launch-after-install choices while retaining Tauri's packaging/update engine underneath.
- NSIS UI compilation runs with `/WX`, treating every NSIS warning as a CI failure before the release-grade Windows bundle build is allowed to run.
- Added a custom **Flint MSI wizard** in place of the stock WiX dialogs, with full-page artwork from the app's tokens, Inter, bitmap buttons and native install-path and progress controls.
- The MSI install-location page opens the standard Windows folder picker, and the wizard is compiled and validated in CI on a throwaway product.

### Skills that apply themselves

- Added **bundled-file reading**: `skill_read` takes a `file` argument for the templates, themes and scripts a skill ships, and lists them at the end of the skill, so a skill's own relative paths work in chat and Cowork instead of being refused as outside the workspace.
- Installed skill and plugin folders are readable by the file tools, read-only; credential files and the project's deny rules still apply.
- Cowork and chat prompts now list the installed skills (global, plugin and the attached folder's own) with a read-it-first instruction, and Rooms participants with tools get the same wording.
- Added **automatic activation**: `always: true` in the frontmatter (or **Always active** in the skills manager), `triggers:` phrases, or an optional JEV pick place a skill's instructions in that turn's prompt, within a size budget.
- Skills from plugins or an opened repository are never trusted into the system prompt by their own frontmatter. A trigger only tells the model to read the skill, and always-active needs the user's opt-in, kept per folder for project skills.
- Work profiles now apply to normal chat as well as Cowork, with the same picker, and run alongside skill activation and assistant routing instead of one after another.

### Context and speed in chat

- Added a **context circle** to the composer in Chat and Cowork. Hovering shows a card with a bar coloured by kind (messages, system tools, MCP tools, skills, memory, system prompt), the tokens left before auto-compact, **Compact session**, and an expandable breakdown that opens onto each MCP server and tool.
- Providers that report no window size get an empty ring with the same card.
- The hover card shows the latest reply's generation speed and the conversation's average.

### Hugging Face Discover

- Added a **Browse Hugging Face** button to the Models page, and Discover entry points from onboarding, from an empty local provider and from `flint://` and `jan://` model links. The sidebar row counts active downloads.
- Discover shows model avatars and Hugging Face author pictures, capability chips, fit badges with MLX fit, a sturdier memory estimate and a highlighted recommendation for the device.
- Pausing a model download takes effect at once, even on a stalled connection, and keeps the partial file so a resume continues from it. A late-finishing earlier attempt can no longer remove the handle of a newer one.
- A model's README is shown without its YAML metadata block, and a repository id such as `../name` is refused.

## Core Flint capabilities

### Identity, privacy and migration

- Rebranded the product, desktop binary, visible UI, documentation, agent identity and deep links as Flint while retaining compatibility paths needed to upgrade existing Jan installations.
- Added `flint://` while preserving the legacy `jan://` deep link.
- Prefer `FLINT_*` environment variables with `JAN_*` compatibility fallbacks.
- Write/discover `FLINT.md` project guidance while continuing to read legacy `JAN.md`.
- Migration supports Copy, Reuse, Move and Start fresh; per-category import; conflict policies; recoverable backup; rollback; idempotent resume; quarantine of partial data and a migration manifest.
- Migration can be reopened from Settings → General → Migrate from Jan.

### Cowork workspace

- Code, Preview, Changes (Git), Activity and session-details panels.
- Managed worktrees and per-session branches, including parallel sessions on the same repository.
- Reviewable proposals, hunk-by-hunk application, patch-bundle export/import and checkpoints/rewind with restore previews.
- Multiple attached folders with independent access levels and Windows AppContainer grants for editable folders.
- Subagent teams, restart/replace, isolated checkouts, consensus reviewers and recorded change attribution.
- Live bash output, repository diff gutters, editable Code panel, inline blame and file-path navigation from tools/diffs/replies.
- PR state/checks, conflict and behind indicators, **Fix this check**, PR ownership per session and merge-base conflict workflows.
- Verify in browser with isolated temporary browser profiles, bounded local origins, screenshots, console output and pass/fail steps.
- Automatic context compaction and explicit `/compact` support.
- Run-phase status text for waiting, thinking, tool execution, tool-result reading and writing.

### Agent runtime and repository intelligence

- Versioned execution/event records, replay, invocation IDs and a persistent timeline.
- Token, dollar and turn ceilings; deadlines/cancellation; retry policy; process-tree reaping; loop detection and emergency stop.
- Durable background jobs and subagents, role allowlists, readiness probes and structured error taxonomy.
- Prompt-cache-aware request construction and proactive compaction before provider context overflow.
- Repository index, name lookup, callers/callees, semantic code search, LSP lifecycle, impact analysis, test coverage analysis, project-tool detection and formatter discovery.
- Native git inspection/cloning, branch/commit/rebase/cherry-pick helpers, PR/review workflows and dependency-license checks.

### Discussion Rooms

- Persistent multi-participant room engine and UI.
- Per-participant model choice, Reasoning Auto/On/Off, effort and llama.cpp Thinking Budget where supported.
- Per-participant tool access, trusted MCP servers and web research.
- Room limits, control actions, early completion and per-speaker history compaction.

### Memory, MCP, Skills and permissions

- Scoped Memory with precedence, proposal/review, provenance, export/import, project binding and idle-time consolidation.
- MCP trust by fingerprint, per-server auto-approve, OAuth tokens in the secret store, proactive refresh, scopes, documents/prompts, ping health, logs, budgets and confinement.
- User-level native Skills and plugin Skills with declared tools/versions.
- Reviewed project policy, scoped write grants, plain-language approval descriptions and destructive-operation gates.
- Optional JEV skill suggestion and attachment reranking with off/shadow/on modes, bounded time/cost and protected key storage.

### Chat, models and providers

- Per-chat model settings and reasoning controls, temporary chats, split view up to four panes, attachment aliases and a unified `@` menu.
- Native `web_search` / `web_fetch`, web-required message holding, queued/steered messages and automatic/manual compaction.
- Shared slash-command menu across Home, Cowork and Rooms.
- Transcript/tool timeline modes, live thinking timer and streamed ANSI terminal output.
- Model Doctor tool-calling probe and model-fit/readiness information.
- Provider chains/failover, custom request headers, predefined local providers, provider card management and LAN-aware networking.
- You.com native web search/fetch provider support.
- Per-model llama.cpp chat-template kwargs and backend selection improvements.

### Design and system

- New Flint shell with resizable sidebar, top header/breadcrumb and Overview dashboard.
- Slate default accent, Violet option, Inter, contrast-checked custom accent colors, first-paint theme application and Reduce motion support.
- Duotone icon set and Flint/model/provider branding.
- Redesigned buttons, dialogs, menus, sheets, switches, inputs, segmented controls, chips, Library, Models, providers, Tools & MCP, Extensions, Logs and System Monitor.
- Groups for chats, Cowork sessions and Rooms, with optional inherited folder bindings.
- Phone layouts across the desktop UI, notifications menu, global settings search and redesigned command palette.
- System Monitor includes CPU, memory, drives, network, temperatures, swap, uptime and usage bars.
- Optional finish sounds for Chat/Cowork and taskbar/Dock attention while an approval is waiting.

### Remote access, SDK and CLI

- Off-by-default remote HTTP/WebSocket server restricted to Tailscale, private LAN or loopback addresses.
- HTTPS with user certificate, Tailscale certificate or LAN self-signed certificate; paired-device tokens are stored as hashes and can be revoked immediately.
- Installable mobile web app for Chat, Cowork, Rooms, Models, Tools, System and phone-oriented Settings.
- JavaScript and Python SDKs over frozen protocol v1, host-declared tools and Flint built-ins over MCP.
- Headless JSON-lines CLI, local diagnostics bundle, benchmark harness, session export/search and `flint doctor` hardware information.

## Inherited / upstream Jan fixes included in Flint 0.9.0

These are kept because they fix behavior inherited from the Jan base rather than a Flint-only feature introduced during this release.

- Respect `JAN_DATA_FOLDER` wherever the legacy override is supposed to win.
- Fall back safely when a configured data folder no longer exists without moving user data (`janhq/jan#8855`).
- Park an unsent composer draft when starting a new session instead of making **New session** a silent no-op (`janhq/jan#8864`).
- Namespace duplicate MCP tool names from different servers and avoid mutating inline attachments (`janhq/jan#8975`).
- Make the Local API Server CORS switch actually control CORS and stop forwarding the caller's Origin/Referer upstream (`janhq/jan#8836`).
- Explain why the local model list is empty when the data folder is unusable (`janhq/jan#8374`).
- Keep the latest user message when trimming history and surface provider context-window errors through the context UI instead of raw provider HTTP errors.
- Prevent malformed or nameless interrupted tool calls from being resent into later provider requests.
- Preserve thread/message integrity across deletes and concurrent saves, including safe handling of unreadable thread metadata.
- Keep provider/model selection consistent when providers are added, removed or temporarily unreachable.
- Keep the model selector's search popup inside the window while typing instead of letting it slide off-screen.
- Keep the composer's assistant, sampling, tools and web-search controls usable while a reply streams; they apply to the next message.
- Harden archive extraction, secret storage, proxy forwarding and Local API Server request handling inherited from the base application.

---

Flint is an independent fork of [Jan](https://github.com/janhq/jan) by [janhq](https://github.com/janhq) and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements and upstream provenance.
