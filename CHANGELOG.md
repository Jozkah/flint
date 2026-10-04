# Flint 0.9.0

Flint is a local-first fork of [Jan](https://github.com/janhq/jan), rebuilt into an agentic desktop workspace for local and user-chosen models. This first release adds Cowork, tool-using Discussion Rooms, an auditable agent runtime, Memory, MCP and Skills, remote access, a redesigned interface and a branded Windows installer.

This changelog lists additions and meaningful changes versus the Jan base. Bug fixes are listed only where they apply to original Jan behavior or an upstream Jan issue.

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
- Jev can pick the AI model for a chat message. In **Settings > Jev > Choose the AI model** you choose Off, **Ask first** or **Always** and tick the models it may use, local or hosted, each with an optional note such as "best for code".
- Jev compares the model in use with your list for each new message and names another only when it is clearly better, so most messages stay on the current model.
- Ask first asks before the message goes to the other model; Always switches without asking and the reply names the model that answered. Your model picker is never changed.
- Only models that can use tools, or see an image, are offered when the message needs that. A temporary chat is never sent to Jev, and routing needs Skill suggestion to be On.
- In Cowork the same choice is made once per message, so a tool loop keeps one model, and only models that can use tools, with no smaller known context window than the session's model, are offered.

### Remote access and mobile parity
- Added a **custom host name** for remote access, so a phone can pair through a name you choose instead of an address.

- The mobile app now has real paginated chat history while preserving scroll position and rendering system/tool messages.
- Phone-created Cowork sessions can select an existing recent desktop folder without widening write authority.
- Rooms can be created, updated and deleted from the phone.
- Room participants can change model and Auto/On/Off reasoning from mobile; moderator model/state, speaking mode, limits and room control actions are available remotely.
- Thread rename/pin/delete and Cowork fork/delete are real phone actions.
- Unsupported desktop-only actions are shown as computer-managed instead of pretending to be selectable mobile controls.
- Pairing exposes a QR code plus a selectable/copyable link and retains a manual fallback when clipboard storage is unavailable.
- The phone can use Studio: make images and video on the desktop, watch progress, stop a run and browse the gallery with Remix and Delete.
- The phone has a microphone button beside Send; it records speech and the desktop turns it into text.
- The phone can browse Hugging Face, start model downloads and show their progress.
- The phone has a read-only side panel showing what Flint is using, the Cowork code files and the live preview.
- The phone gets push notifications when an approval is waiting, a run finishes or fails, a pull request merges, a room needs you or a reply is done, with no Flint-hosted server in between.
- Approval notifications have **Allow once** and **Deny** buttons, and notification settings let you choose the events, set quiet hours (approvals still come through) and hide message content.
- You can attach photos, camera shots and files from the phone; large uploads resume in chunks and large photos are shrunk first.
- The phone can browse the Cowork folder read-only, insert file references into a message and open a live preview of an app running on the desktop's localhost, for paired phones only.
- Phone pairing keeps working for the current visit when the phone's browser storage is blocked or full, and a paired phone can no longer set a room's folder or tool access.

### Browser verification

- Verify in browser and the screenshot tool now support Chrome, Edge, Brave, Opera/Opera GX, Vivaldi, Arc and Chromium.
- **Choose a browser…** lets the user select a Chromium-based executable manually.
- The chosen browser is shared by the verification runner and screenshot tooling for the current Flint session.
- Windows discovery uses real install layouts, including Arc's Windows app-execution alias.

### Attachments, images and forking
- An image read by the `read` tool in Cowork and Chat now reaches a model that can see, with a note for one that cannot, and the tool row shows a thumbnail. Saved chats keep a note instead of the image data.

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
- Starting or resuming a room with a model that has no known context window opens a dialog to enter one or pick the safe 8,192 default, instead of silently budgeting for it.
- A room compacts ahead of growth, leaving room for the tool output a participant usually adds, clears old tool output or ends a step with a written reply before it crosses the speaker's own window, and retries a refusal for length once against the window the server named.

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
- Numeric parameter fields keep what you type: `0.` and `0,` no longer collapse to 0, `0,5` is no longer stored as text, and `.` or `,` works as the decimal separator.

- Opening a chat no longer animates every message in, which made long chats slow to appear. A chat's messages are also read when the pointer reaches its row.
- A site without a favicon tries its common icon names before falling back to a letter.
- Chat titles are made with the conversation's own model instead of whichever model was picked last.
- In split view each pane keeps its own model choice.
- Automatic compaction no longer fails when its own summary request is too big for the model; it retries with smaller excerpts.
- Compaction tries once more when a long conversation produces an unusually short summary, and keeps finished tool calls with their results so the model does not repeat them.
- A long session on a model with no known context window is now compacted, using the window named in a refusal or else 128K.
- The chat no longer jumps up and down while a reply streams, and a tool trace or reasoning section you collapsed stays collapsed.
- **Stop all** stops only the current chat instead of everything.
- If a llama.cpp model fails to start, the failure is now shown instead of nothing happening.
- A failed model import shows the real error instead of "Unknown error", and a model file name without an extension no longer comes out empty.
- A short reply from a fast model now shows its speed, and the reply actions appear on hover or focus, always visible on touch screens.
- Requests to local models and the local API server on this computer no longer go through a system or VPN proxy.
- Save dialogs, such as a memory export or saving a code block, suggest the file name instead of showing "Untitled".
- The duplicate model picker in the Details panel is gone.

### Run summary and opening pages

- A finished run's folded steps now say what the run did, such as **Ran 20 commands, created 8 files, used 6 tools +645 −0**, instead of a bare step count.
- Each step inside a folded run is one closed line saying what it did, such as **Read AUDIT.md** or **Failed to run Diffed original vs patched files**, and opens on click. The run's line counts failures, as in **Ran 54 commands, read 4 files (2 failed)**.
- Added an **`open_in_browser`** tool. The model can put a page in front of the user, shown as an **Opened in Browser** card with an **Open** button and a link menu. A page on this computer opens at once; any other site waits for the user to press **Open**.

### Git approvals

- Inline approvals keep **More options** available instead of hiding it when the immediate request only exposes Allow once.
- Added **Allow all temporarily** for non-destructive remote Git/GitHub operations in the current conversation.
- Temporary Git trust stays in renderer memory, is never persisted as an Always allow grant, is not offered to temporary chats and never covers destructive Git operations.

### Privacy and security

- Added a **Hide Secrets** option that replaces API keys, passwords in URLs and secret-looking environment values with placeholders before a request goes to the model, and restores the real values when the model's tool calls run. It is off by default.
- The MCP config file, which can hold keys entered during plugin setup, is now readable only by its owner on macOS and Linux.
- The secret scanner catches dotted credentials such as `API_TOKEN` values, and no longer blocks code that merely mentions a value such as `spend.spent`.
- Hovering a chat, Cowork session or room in the sidebar no longer sends the conversation to a model: the preview summary is written only by a model running on this computer, and other providers get a plain preview made from your own messages.
- A remote provider with no API key now says **No API key** in the provider list instead of **Connected**.

### Search, MCP and interface additions
- Studio is a three-column workspace (model, settings and prompt, activity and generations) with a chat-style engine picker and equal-height columns.
- System Monitor was redesigned with a GPU switch and fills its empty cards, and the Hardware settings page is gone.

- Added a DuckDuckGo MCP preset using `uvx duckduckgo-mcp-server`.
- Added **DuckDuckGo** as a native web-search provider that needs no API key, account or instance URL. Results are read in page order with ads and repeated links dropped, and a bot check is reported as an error that names the way out instead of an empty result list.
- Naming a configured MCP server that is off now offers to enable it, instead of the model silently going without its tools.
- The model picker searches by the remote a model sits behind and labels each row with it when more than one remote offers the same model.
- Native web-search providers can show their real favicon in Flint UI surfaces.
- Added a **New group** action to the Move to group flow.
- Compact split-pane labels use **Auto** / **Edit** while retaining full accessible labels.
- Settings rows, including the Local API Server model selector, use the constrained Flint layout correctly.
- MCP servers no longer all start when Flint launches; each starts the first time a chat, Cowork or room needs it, with its tool list coming from a saved cache until then.
- An idle MCP server stops by itself after 15 minutes, which can be changed, and keeps its saved tools.
- MCP settings show each server's state (stopped, starting, running or failed) with **Start** and **Stop** buttons and a **Start with Flint** switch.
- One MCP server that hangs no longer freezes sending a message; each server is given a few seconds and a slow one falls back to its last known tools.
- Hovering a Cowork session or room in the sidebar shows a preview card, like chat rows.
- The ten new hosted providers have their own logos, the skills and memories lists scroll instead of growing the page, the Hardware bars use the full width, and Jev's settings are split into **Setup**, **Automatic** and **Work profiles** tabs, with search results opening the right one.

### Cowork and agent reliability
- Cowork runs have no step, spend or wall-clock cap any more; the context window is the only limit. With auto-compact on, the token allowance scales with the window, compaction leaves headroom for the largest recent step, and a step's reply is charged once instead of twice.
- Added a **post-tool-batch hook** that Chat, Cowork and Rooms fire when a batch of tool calls finishes. It is observe-only and detached, and a confined hook starts in the project with the hook environment.
- A refused write outside the workspace, or to a folder attached read-only, now tells the model to ask for write access with `request_access` instead of reporting the folder as read-only.

- A reply cut off by the output limit, a dropped stream or an empty reply is continued once automatically, and a run that ends without an answer shows **Continue**.
- A failed request stops retrying after three minutes, so a run no longer stalls for almost an hour.
- Cowork stops repeating an attempt that keeps failing for the same reason, such as an unavailable sandbox tool, blocked network, a read-only folder or a stale pull request.
- A bash command over the 120-second limit is refused up front and longer work is pointed to background jobs.
- When a tool installed on the computer cannot run inside the Windows sandbox, Cowork stops retrying and explains why, with the admin command that grants access.
- A steering message sent mid-run is delivered right after the current tool call.
- Cowork no longer opens a pull request unless it has checked the target branch, that the branch was pushed and that it merges cleanly, and the check now works for forks whose remote was renamed.
- On Windows the shell in Cowork works in a folder you gave edit access to, such as one under Desktop, instead of failing with Access is denied.
- PowerShell shims and Rust tools now run inside the Windows sandbox, and copy switches such as `/E /XD` no longer get every file write refused.
- **What changed** lists only the files the session itself wrote, with **Show all**, instead of thousands of unrelated files.
- The Changes panel no longer reports millions of added lines for untracked files.
- Cowork shows the memories a session proposes so you can approve them, so Settings > Remembered no longer stays empty.
- New Cowork sessions are named automatically by the model from the first prompt, without overwriting a name you set.
- Reasoning effort in Cowork is saved per session and no longer moves the global model picker, and subagent steps use the parent session's reasoning settings.
- Added **Describe this project** to the Cowork folder menu.
- Cowork and chat can read what the shell sandbox cannot see, through tools the app runs outside it. All are read-only and ask for nothing:
  - `windows_events` reads the Windows Event Log by channel, level, time, event id and source.
  - `host_query` answers one named question about this computer: processes, services, listening ports and what holds them, disks, system details, installed programs, one registry key (credential values hidden), crash reports, scheduled tasks, startup items, WSL distributions, GPU, network, Windows Update or battery.
  - `local_http` sends a GET or HEAD to a server on this computer, to check that a dev server answers. It only reaches localhost and does not follow redirects.
  - `docker` runs `ps`, `images`, `logs`, `top`, `port`, one `stats` sample, `version`, `info` and the `compose` equivalents. Anything that starts, stops, removes, builds or runs is refused and handed to you instead.
- Two more tools change things on this computer, so each call asks you first, naming the exact target, and no mode or grant answers for you:
  - `host_action` ends one process (by its number, never by name) or starts, stops or restarts one Windows service. System-critical processes and services, and Flint itself, are refused. A service that needs an administrator fails with Windows' own message.
  - `host_build` runs `gradle`, `gradlew`, `mvn`, `mvnw` or `dotnet` in the project folder, outside the shell sandbox that cannot run them (no profile-installed Java, no `~/.gradle`, no loopback for the Gradle daemon). It shows the exact command, runs only in a folder the session may write to, stops at a time limit and returns the head and tail of the log with the exit code. It also runs `go`, `cargo`, `npm`, `pnpm` and `yarn`.
  - `clipboard` reads the text on your clipboard or replaces it, and asks each time which of the two it is.
  - `open_path` opens a project file or folder on your screen, or shows it in Explorer. Programs, scripts and installers are not opened, only shown. The path must be inside the project folder, worktree or session workspace.
- The command line and background jobs already ask before these tools run; the question now names what will happen (the command, the process, the folder) and no longer offers "always". Text from Windows tools now keeps its accents and non-Latin letters.

### Inference and repository targeting

- Upgraded the bundled llama.cpp engine from 0.4.1 / b10964 to **0.5.0 / b11146**, with matching packages and lockfiles.
- Active release workflows, package metadata, project links and web-search identification now target `Jozkah/flint` rather than the upstream repository where appropriate.

### Local models and engine settings
- Added a **fallback model chain** under **Settings > General**: pick and reorder models, and a reply that fails with a server or connection error is retried on the next one. A working fallback is kept for the rest of the turn.
- Models take optional **input and output prices** (USD per million tokens) in the model dialog. Replies are priced from those, a short table of well-known hosted models, or free for local engines, and the Overview shows the estimated spend.
- Model pickers in the chat bar, Rooms, the MCP router and the CLI helper-model setting have a filter button that hides models with no API key or an unresponsive provider. The selected model always stays listed.

- Added **Find models already on this computer** to the model import dialog. It lists GGUF models kept by LM Studio, Ollama, the Hugging Face cache, llama.cpp and GPT4All. It runs only when asked, and a chosen model is used where it lives instead of being copied.
- Sending a message with no model selected now picks one and sends, instead of stopping at "select a model": your default, the last used model, a connected remote provider, then the only local model or the lightest by the size in its name. Embedding models are never chosen.
- Added an **Additional arguments** setting for llama-server (for example `--rope-scaling yarn --no-warmup`). The options apply to every model, and ones that would move the server or change the files it opens, such as host, port and model paths, are ignored.
- A tool call a local model writes as text is now run. Hermes, Qwen, GLM, Mistral and Llama 3.1 call formats are recognised when the server could not parse them. Only calls naming a tool the request offered are run, and a call the server already parsed is never run twice.
- The model-fit check uses the KV cache type a model is configured with instead of assuming f16, and no longer counts an integrated GPU's memory twice.
- A quantized V cache is held at f16 when flash attention is off, which llama.cpp cannot load, and a DFlash draft defaults to greedy sampling.
- The Anthropic `/messages` endpoint merges scattered system and developer messages into one leading system message, which strict chat templates such as Qwen3's require.
- An image returned by an MCP tool (a screenshot tool, for one) no longer floods a local model's context as base64 text. For llama.cpp and MLX it is replaced by a note and, for a model that can see, attached again as an image.
- The Local API Server answers "no model is running" and "the engine is not answering" with a JSON error that has a `code` and a `Retry-After`, keeps 502 for an unreachable remote provider, and explains a port the system refuses instead of showing a bare error.
- The Local API Server's timeout now limits silence rather than the whole request, so a long generation from a large local model is no longer cut off mid-stream.
- The hardware probes behind the memory and GPU readouts run off the main thread, which could freeze the window on Windows. Every closed `<think>` block, not only the first, is removed before a reply is sent back to the model.
- Loading a model whose file was moved, deleted or only partly downloaded now fails with that reason, naming the file, instead of the loader's own error.
- An image over the 10 MB attachment limit, such as a large PNG screenshot, is re-encoded to fit instead of being refused. The tool list sent to the model is sorted by name, so an MCP server reconnecting in a different order no longer discards the prompt cache.
- A WebP image sent to a local vision model is converted to PNG first, because llama.cpp cannot read WebP and the image was failing or dropped.
- Adding a self-hosted OpenAI-compatible server by its bare address, such as `http://host:8000`, now finds its models: the model list is also tried under `/v1` when the first address answers 404, and pasted spaces and trailing slashes are ignored.
- Editing a message you sent with images keeps the images instead of dropping them.
- The copy buttons for API keys and secrets show "copied" only once the clipboard write has succeeded.
- Added **voice input**: a microphone beside Send dictates into the message box, with the words inserted at the caret as you talk. Speech is turned into text on this computer by Voxtral Mini 3B, a one-time download of about 3 GB that unloads a few minutes after you stop. Press the microphone again to keep the text, or Escape to discard it.
- Added **Studio**, a new page for making images and video on this computer with stable-diffusion.cpp. The engine is downloaded once on request and checked against its published checksum; the models use the same resumable Hugging Face downloader. **Z-Image Turbo** makes images and **Wan 2.2 TI2V 5B** makes clips of 1 to 5 seconds, both Apache-2.0. Results are kept in a gallery with the prompt, size, steps and seed beside each one. Windows only for now.
- Studio has a stage-first layout: settings on the left, a large live preview with the prompt under it, an Activity list on the right and the gallery below. Hovering a picture shows its prompt, seed and time with **Remix** (same prompt, new seed) and delete; clicking opens the chat's image viewer.
- Fixed a model download that could come out corrupt after a pause and resume in quick succession: the old transfer could wipe what the new one had written, so a file of the right size failed its checksum. Only one transfer now writes a partial file at a time.
- Studio retries a run that ran out of graphics memory with part of the model kept in system memory (then more of it), instead of failing a run that would fit; the setting that worked is kept for the next run.
- Studio shows a desktop notification when an image or video is ready or a model finishes downloading, but only while Flint is not the window in front. Permission is asked for when you start the job.
- Studio shows about how long a clip will take before it starts, scaled from the last clip made on this computer (pixels, frames and steps), and says nothing until there is one to scale from.
- Studio's shape choices are now the standard proportions (1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16 and 21:9) at about the same picture area each, with the exact size on hover.
- Updated the built-in model lists for the cloud providers to what each one's documentation now lists, including Claude Sonnet 5.5, Opus 5.5, Fable 5.1 and Haiku 4.5, GPT-6.1 Sol, Gemini 3.x and Grok 4.x. A new chat on Anthropic or OpenAI starts on the balanced model (Sonnet 5.5, GPT-6.1 Sol) rather than the most expensive one.
- Studio lets you type your own resolution: **Custom** beside the shapes opens width and height boxes (with a swap button) that snap to multiples of 16 inside what the model accepts, and Remix on a picture made at a non-standard size keeps its exact size.
- Added ten hosted model providers to the provider list: DeepSeek, Moonshot AI (Kimi), Cohere, Perplexity, Together AI, Fireworks AI, Cerebras, SambaNova, Z.ai (GLM) and Alibaba Qwen. Each needs only its API key; Alibaba Qwen also lets you edit the endpoint.
- Fixed Studio's model download showing "Unknown size of 7.3 GB" in the first moments; it now says "Starting…" until bytes arrive.
- Studio can make pictures with hosted models as well as the one on this computer: **Where to make it** lists GPT Image 2.5, Gemini image models, Grok Imagine Image and FLUX on Together AI for each provider with an API key. The prompt goes to that provider and the pictures are saved in the same gallery. Hosted runs can be stopped.
- Discover has an **Images** switch that searches Hugging Face for picture models Studio can run. Pick a weights file and its family (Z-Image, Qwen-Image or FLUX.1) and **Add to Studio**: the text encoder and VAE it needs are downloaded with it and every file is checked against Hugging Face's published checksum. A licence that is not plainly open is shown as a warning chip.
- Studio shares the graphics card with chat: loading the image model stops the chat models, and starting a chat model stops the image model, which also unloads after ten idle minutes. Cancelling a run stops the engine, and the next run starts it again.
- Cowork and chat can make pictures: the assistant has a `generate_image` tool that uses the image model loaded in Studio and shows the result in the conversation. It never loads or swaps a model, so a call cannot unload one you are using; with none loaded it says so. The pictures are kept in the Studio gallery. The command line and background jobs have no image engine and answer that it is unavailable.
- Studio can make pictures on your own servers: an active OpenAI-compatible provider whose model list has a picture model (names such as image, FLUX, diffusion, SDXL, DALL-E, Imagen or Wan) appears under **Where to make it**. It is asked at `/images/generations` and needs no API key.
- A picture or video model file loaded as a chat model, which the chat engine cannot run, now says to load it from Studio instead of showing the engine's tensor-name error.
- The Local API Server gained `POST /v1/images/generations` (base64 only, 1 to 4 images, a model that is already loaded) and the OpenAI Videos routes `POST /v1/videos`, `GET /v1/videos/{id}` and `GET /v1/videos/{id}/content`. Image models stay out of `/v1/models`.
- A chat started from the phone with no model chosen now picks one on the computer, as the desktop does, and says so plainly when nothing can answer. The phone's copy buttons say "Copy failed" when the connection has no clipboard.
- A reply's token details show **Draft accepted**, for example `75% (30/40)`, when speculative decoding (MTP, DFlash or EAGLE-3) ran, so you can see whether a draft is paying off.

### Release infrastructure
- `node scripts/build-installer.mjs` checks the toolchain, builds the engine and the app and prints the installer paths, with no `make`, Git Bash or `corepack enable` needed on Windows. A push to `main` moves the version tag and rebuilds the release.
- The Windows engine builds with LLVM 22 and newer.

- Tag pushes matching `v*` start the Flint release build, which attaches the Windows, macOS and Linux bundles to the existing release for that tag.
- Moving an existing release tag rebuilds it and replaces the bundles already attached to that release.
- The older tag build workflow is now manual-only: it needs an explicit tag, never touches a published release, and clears stale assets from a draft before uploading.
- Reusable release workflows use `$GITHUB_OUTPUT` instead of deprecated `::set-output` handling.
- The macOS build is now Apple silicon only, and the DMG is named `_aarch64`, with a custom backdrop and icon layout.
- Release builds use lighter optimization settings, cutting build time from about 72 minutes.
- Added a Flint website, published on GitHub Pages, with a homepage, docs, install guide, FAQ, changelog, brand and legal pages.

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
- The Windows installer refuses a drive root or a user folder as the install location.
- On Windows 11 the title bar takes its colours from the app's theme and follows theme changes.

### Skills that apply themselves
- Importing from Claude Code keeps a **live link**: global skills and plugins are copied again when their source in `~/.claude` changes, and a deleted source keeps the last copy. An opt-in runs your Claude Code SessionStart and UserPromptSubmit hooks.

- Added **bundled-file reading**: `skill_read` takes a `file` argument for the templates, themes and scripts a skill ships, and lists them at the end of the skill, so a skill's own relative paths work in chat and Cowork instead of being refused as outside the workspace.
- Installed skill and plugin folders are readable by the file tools, read-only; credential files and the project's deny rules still apply.
- Cowork and chat prompts now list the installed skills (global, plugin and the attached folder's own) with a read-it-first instruction, and Rooms participants with tools get the same wording.
- Added **automatic activation**: `always: true` in the frontmatter (or **Always active** in the skills manager), `triggers:` phrases, or an optional JEV pick place a skill's instructions in that turn's prompt, within a size budget.
- Skills from plugins or an opened repository are never trusted into the system prompt by their own frontmatter. A trigger only tells the model to read the skill, and always-active needs the user's opt-in, kept per folder for project skills.
- Work profiles now apply to normal chat as well as Cowork, with the same picker, and run alongside skill activation and assistant routing instead of one after another.

### Context and speed in chat
- The context card also shows for old chats and for custom OpenAI-compatible servers: the last breakdown is kept with the chat, and a local server's window is read from llama-server's `/props`. A bar with an unknown window fades out instead of looking full, and an old breakdown says how old it is.
- The context card's meter is one fixed-height bar of used tokens, the room auto-compact keeps free and free space, with an arrow that opens the numbers behind it.
- Compaction is harder to defeat: stale tool results are cleared first, a conversation that refills right after compacting stops the loop, the summary is made once per prefix and before the trimmer acts, and it keeps an analysis/summary split.
- Chat compacts instead of stopping: a long tool loop can be folded in steps (the recent turns, then half of them with the cut inside the turn, then only the newest message), a conversation that refills right after compacting starts at a harder cut instead of failing, and a single tool result that alone fills the window keeps its head and tail and loses the middle. Manual `/compact` uses the same fallback.
- Max Context Tokens has a compact numeric field with a **Detect from model** button that asks a server refusal, the loaded runtime, the model's settings, provider metadata and the bundled family table in turn, and says unknown rather than inventing a number.

- Added a **context circle** to the composer in Chat and Cowork. Hovering shows a card with a bar coloured by kind, the tokens left before auto-compact, **Compact session**, and an expandable breakdown down to each MCP server and tool.
- Providers that report no window size get an empty ring with the same card.
- The hover card shows the latest reply's generation speed and the conversation's average.
- Added a **reasoning effort bar** beside the model selector in Chat and Cowork, with one stop per level the model supports, a Recommended mark on the model's own default and an Off stop where the model can switch reasoning off.
- Hand-added OpenAI-compatible servers whose model names show a reasoning family, such as Qwen3, DeepSeek-R1 or gpt-oss, now get the effort bar too.
- Chat uses Cowork's composer layout, with the model selector under the composer and the assistant, sampling, tools, web search and reasoning controls behind one **Options** button.

### Hugging Face Discover

- Added a **Browse Hugging Face** button to the Models page, and Discover entry points from onboarding, from an empty local provider and from `flint://` and `jan://` model links. The sidebar row counts active downloads.
- Discover shows model avatars and Hugging Face author pictures, capability chips, fit badges with MLX fit, a sturdier memory estimate and a highlighted recommendation for the device.
- Pausing a model download takes effect at once, even on a stalled connection, and keeps the partial file so a resume continues from it. A late-finishing earlier attempt can no longer remove the handle of a newer one.
- A model's README is shown without its YAML metadata block, and a repository id such as `../name` is refused.
- Discover can be filtered by parameter size, architecture, input type, gated models and downloaded-only.
- A model split into several GGUF files shows as one model, and its vision (mmproj) and speculative-decoding draft files are paired and downloaded automatically.
- Installed models show **Update available** when the repository has a newer revision.
- A model download that loses its connection retries with growing waits and continues from the bytes already saved, and a connection that goes quiet for a minute counts as dropped.
- A download whose partial file the server no longer recognises restarts cleanly instead of showing a hard error.
- Disk-full, permission-denied, file-locked and path-too-long download errors are explained in plain words.
- The download row shows a smoothed speed and the time left, for example 38 MB/s and 4 min left.

### Archive instead of delete

- Deleting a chat, room, project, Cowork session, assistant or Studio result now moves it to an **Archive** page instead of destroying it. The link sits in the sidebar's Support group, above Settings, and the phone app has its own Archive screen.
- **Restore** puts an item back where it was. **Delete permanently** is only in the right-click menu on the Archive page and asks for confirmation. Delete dialogs just say the item moves to the Archive.
- Each row has a preview that shows what the item holds without restoring it: the first messages of a chat or room, a Cowork session's last turns, a project's chats, an assistant's instructions, or a Studio result's recipe.
- The Archive is on by default. Archived items are deleted after 30 days (0 keeps them), threads untouched for a set number of days can be archived automatically (off by default), and **Empty archive** clears it.
- A Cowork session whose managed worktree holds unmerged work cannot be purged until that work is dealt with.
- A restored Cowork session registers with the session mailbox again, and sessions archived by an earlier build recover when restored.

### Export

- Chats, Cowork sessions and single messages can be exported as **Markdown**, an **Obsidian note** (frontmatter, tags and wikilinks for file references), **PDF** or **PNG**, from the thread and Cowork menus, a message's right-click menu and the command palette.
- A chat exports the branch you are viewing, or **all versions** nested under the message each replaces.
- Tool output, reasoning and absolute paths are left out unless you ask, credentials are redacted, and an export over 50 MB is refused with a message that says what to do.
- PDF uses the system print dialog. Where printing is not available it saves a print-ready HTML file instead. PNG refuses pages taller than about 16,000 pixels and says so.
- Cowork's Export submenu also holds the session bundle (JSON) used to move a session to another computer.

### Chat branches

- The version switcher on an edited or regenerated message has translated labels, announces its position (for example, "Version 2 of 3") and steps with the left and right arrow keys, keeping keyboard focus as the version changes.
- Token counts, titles, previews, the command line and the phone app now use the branch you are viewing, not every stored version. Deleting a message in the middle of a branched chat keeps the replies after it reachable.
- The phone shows the same version switcher.

### Clickable file paths

- A path written in inline code in a reply, such as `src/app.ts` or `src/app.ts:12`, becomes a link in Chat and Cowork. Source files open in the Code panel, other files and folders open in the system, and executables are only revealed.
- A path outside the session's folders stays plain text, and a link to a file that does not exist says so instead of opening an empty tab.
- Every place that opens a file or folder in the system now goes through one backend command that resolves symlinks and refuses anything outside the allowed folders, and the app no longer holds a blanket permission to open any path.
- The Code panel shows a short preview of a file that is too large to open, marks binary files, says plainly when a file is not found, and no longer shows a CRLF file as changed before you touch it.

### Scheduled tasks

- Added **Settings > Schedules**: run a saved prompt on a schedule. Choose every day, weekdays or certain days, with several times a day, or write a cron expression, and see the next run times before saving. A task can name a model, a folder and a Cowork profile.
- Scheduled runs are unattended, so each task has an explicit tool list and required limits on turns, tokens and time, plus an optional cost limit. A permission prompt is never shown: it is denied and recorded as what the run was blocked on, and the task can either carry on or stop there.
- Tasks are read-only by default, and a task that writes works in its own worktree. Runs are listed with their summary, spend and a link to the conversation.
- After a gap, a missed task runs once on the next start by default, and can instead be skipped or caught up.
- An opt-in switch can install an operating-system entry (a Windows scheduled task, a macOS LaunchAgent or a Linux systemd timer) that runs `flint cli schedule tick`, so tasks run while Flint is closed. It shows exactly what it will write and only installs after you confirm.
- `flint cli schedule` lists tasks, runs one and shows its runs.
- On Windows the closed-app task runs hidden, so no console window flashes each time it ticks.

### Agent browser

- Added an off-by-default **agent browser**: the assistant can open pages in the built-in browser pane, read text, click, type, scroll and, on Windows, take a screenshot. A glowing pointer glides to each element before it acts, follows the system's reduce-motion setting and hides while you take over.
- The first visit to a site asks, showing the full address: this visit, until Flint closes, or always, with an option for subdomains. Saved rules and the sites approved for now are listed in **Settings > Agent tools** and can be revoked.
- Loopback, private, link-local and cloud-metadata addresses are refused in every spelling. A redirect to a site that has not been approved is stopped and asked about, and page content comes back inside a block marked as untrusted.
- Clicks and typing ask for approval in Chat and Cowork, a control that looks like submit or delete asks every time, and a run has an action limit. Unattended runs only reach sites with a saved always-allow rule.
- The browser tools return a clear message in the command line and in background jobs, where there is no pane, and a hidden or minimized window gets an explanation instead of a hang.
- Toasts move clear of the Web preview pane, and the pane never covers the approvals chip.
- The browser is now interactive, with a live agent-browser window, and its approval prompt says what the tool is about to do.

### Subagent delegation
- Chat, Rooms and Cowork can hand work to subagents. **Settings > Subagents** picks the assistant, work profile and model they use, and the Tasks panel shows each one with its transcript, status and cost.
- A background subagent can ask its parent a question, tell the parent when it finishes, and be resumed by id with its earlier context.
- Subagents can run in the background with `await_task`, `task_status` and `cancel_task`, and a Room's subagents are bounded by a token limit.

### Messaging between sessions
- Sessions in any project can message each other by title, with an opt-out. A message can ask a question and wait for the answer, shown as an **Asked** card.
- `list_sessions` reports when a session is waiting for approval, and a run's final answer is sent back as the reply when it handled a message.

### Visual widgets
- Chat, Cowork and Rooms can draw inline charts and widgets in a sandboxed frame, with a **Visual widgets** setting. A frozen or self-navigating widget is replaced by a Re-run placeholder.

### Live MCP tools
- An MCP server turned on mid-chat reaches the next request in Chat and Cowork, with approval behavior unchanged. A failed server listing is retried.

### Phone and context
- The phone can answer Cowork questions and every approval, see the computer's other blocking prompts and a stopped run, show the full transcript, regenerate or edit a message, and rename a Cowork session.
- The context ring is always shown, scales to the model's window and remembers its figures per chat. Generation speed now counts reasoning and tool-argument output.
- Chats and Cowork can run your Claude Code SessionStart and UserPromptSubmit hooks after an opt-in, and Claude Code imports stay linked to `~/.claude`.
- Title and summary agents fall back through your model chain, and a refused write points to `request_access` write mode.

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
- A vLLM server's context window is read from its model list (`max_model_len`), since vLLM has no `/props`, and a Flash-Next build is never sent a reasoning effort it rejects.
- A chat's own settings, such as reasoning effort, now reach models a provider lists without a settings block, which covers custom and hosted OpenAI-compatible servers.
- Every GPU stays in the system monitor: drivers that report no device UUID no longer give each GPU the same id, so a second GPU stops overwriting the first.
- A click outside the access prompt no longer counts as Deny, and a folder grant on Windows also reaches subfolders with a protected permission list.
- The tailscale calls behind remote access no longer open a console window on Windows.
- Harden archive extraction, secret storage, proxy forwarding and Local API Server request handling inherited from the base application.

---

Flint is an independent fork of [Jan](https://github.com/janhq/jan) by [janhq](https://github.com/janhq) and preserves Jan's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements and upstream provenance.
