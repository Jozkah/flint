# Flint

**A private, local-first AI workspace for your desktop.** Chat with models on your own computer, let an agent work on your files and projects with your approval, and see exactly what it used and changed.

Flint is an independent fork of the open-source [Jan](https://github.com/janhq/jan) app, with its own design and features. Your existing Jan data carries over (see [Migrating from Jan](#migrating-from-jan)).

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="docs/FEATURES.md">All features</a> ·
  <a href="docs/BUILDING.md">Build from source</a>
</p>

<p align="center">
  <img src="docs/screenshots/01-overview.png" alt="Flint's Overview: tokens generated, generation speed and tool-call success, token throughput by day, latest activity and agent runs" width="100%">
</p>

## What Flint is

- **Chat** for questions, writing and documents. Conversations stay on your computer, can be grouped into projects, and can run side by side in a split view.
- **Cowork** for tasks that touch files. An agent reads, writes and runs commands in a sandbox or a managed copy of your project, asks before doing anything you have not allowed, and ends every run with a plain summary of what it did, what it checked and what is left to review.
- **Local-only by design.** No telemetry, analytics, update checks or model downloads. Flint only reaches the network when you add a cloud provider key, a remote MCP server, or turn on web search.

## Highlights

- **Discussion Rooms:** several models from different providers discuss a topic in one room, with a moderator, budgets, `@mentions`, optional file and tool access, and a final synthesis.
- **Agents that work together:** parallel sub-agents, six built-in roles (explorer, planner, implementer, reviewer, tester, security), teams, and sessions that can message one another.
- **Review before anything changes:** a diff before every write, per-hunk apply, managed Git worktrees, checkpoints and rewind, and flags on risky changes such as dependencies, lock files and migrations.
- **Permissions in plain language:** each prompt says what will happen and what denying does. "Allow once" is never saved, and every standing grant can be revoked.
- **"What Flint is using":** for every reply, you can see which model, instructions, memory, tools and attachments applied.
- **Honest run records:** a live tool timeline, replay, audit export, and summaries that only count real test, build and lint commands as checks.
- **Usage and cost:** token and prompt-cache counts per message and session, spend budgets, and a dashboard.
- **Your models:** GGUF through the bundled llama.cpp engine, MLX on Apple silicon, or any OpenAI- or Anthropic-compatible provider with your own key. Keys are stored in the OS keyring.
- **Sandboxed shell commands** on every OS: bubblewrap on Linux, Seatbelt on macOS, AppContainer on Windows.
- **A command line** for headless agent runs, a JSON-lines API and background jobs.

See [docs/FEATURES.md](docs/FEATURES.md) for the full list and for what is not finished yet.

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/03-chat.png" alt="Chat with tool calls, a terminal block and pull-request status" width="100%"><br>Chat with tool calls | <img src="docs/screenshots/04-cowork.png" alt="Cowork: an agent working in a project folder" width="100%"><br>Cowork: an agent working in a project |
| <img src="docs/screenshots/06-room.png" alt="A room with several models discussing" width="100%"><br>A Discussion Room | <img src="docs/screenshots/08-models.png" alt="Models" width="100%"><br>Models |
| <img src="docs/screenshots/11-tools-mcp.png" alt="Tools & MCP" width="100%"><br>Tools & MCP | <img src="docs/screenshots/17-settings-permissions.png" alt="Settings: Permissions" width="100%"><br>Permissions |
| <img src="docs/screenshots/21-chat-light.png" alt="Chat, light theme" width="100%"><br>Chat, light theme | <img src="docs/screenshots/22-cowork-light.png" alt="Cowork, light theme" width="100%"><br>Cowork, light theme |

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| <img src="docs/screenshots/02-new-chat.png" alt="New chat" width="100%"><br>New chat | <img src="docs/screenshots/05-rooms.png" alt="Rooms" width="100%"><br>Rooms |
| <img src="docs/screenshots/07-library.png" alt="Library" width="100%"><br>Library | <img src="docs/screenshots/09-provider-llamacpp.png" alt="A local provider (llama.cpp)" width="100%"><br>A local provider (llama.cpp) |
| <img src="docs/screenshots/10-provider-openai.png" alt="A cloud provider" width="100%"><br>A cloud provider | <img src="docs/screenshots/12-extensions.png" alt="Extensions" width="100%"><br>Extensions |
| <img src="docs/screenshots/13-system-monitor.png" alt="System Monitor" width="100%"><br>System Monitor | <img src="docs/screenshots/14-logs.png" alt="Logs" width="100%"><br>Logs |
| <img src="docs/screenshots/15-settings-appearance.png" alt="Settings: Appearance" width="100%"><br>Settings: Appearance | <img src="docs/screenshots/16-settings-memory.png" alt="Settings: Memory" width="100%"><br>Settings: Memory |
| <img src="docs/screenshots/20-overview-light.png" alt="Overview, light theme" width="100%"><br>Overview, light theme | <img src="docs/screenshots/23-room-light.png" alt="A room, light theme" width="100%"><br>A room, light theme |
| <img src="docs/screenshots/24-models-light.png" alt="Models, light theme" width="100%"><br>Models, light theme | |

</details>

## Install

Installers for Windows, macOS and Linux are attached to each release on the [Releases](https://github.com/Jozkah/flint/releases) page. If a release has no installer yet, [build Flint from source](docs/BUILDING.md).

The installers are **not code-signed**, so your OS warns you the first time you open Flint:

- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** right-click (or Control-click) Flint in Applications and choose **Open**, then **Open** again. Alternatively, try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **macOS local models need Apple silicon** (M1 or later). On Intel Macs you can still use cloud providers.

**You bring your own models.** Import a GGUF file you already have (Models → llama.cpp → Import), use an MLX model on Apple silicon, or add a cloud provider with your own key. Flint does not download models for you.

## Getting started

1. **Open Flint.** A short first-run guide asks what you want to do and explains the difference between local and cloud processing. You can skip it and reopen it from Settings → General.
2. **Choose a model** in **Models**. The fit indicator separates what was *measured on this device* from what is only *estimated*. An estimate never stops you from trying a model.
3. **Start a chat.** Attach files with **+**, and open **What Flint is using** in the header to see what applies to the conversation.
4. **Use Cowork for file work.** Attach a project folder or work in the sandbox, then describe the task. Flint asks before any change or command you have not allowed.
5. **Review the result.** The run summary says what happened and what is unresolved. The **Changes** panel shows real diffs, and checkpoints restore earlier states.

## Migrating from Jan

Flint keeps Jan's bundle identifier (`jan.ai.app`) and data path, so it detects an existing Jan install. On first launch, you can **copy** your Jan data into Flint, **reuse** it in place, **move** it (a backup is kept), or **start fresh**. You choose which categories to bring. A newer Flint item is never silently overwritten, and a failed migration rolls back. You can run the assistant again later from **Settings → General → Migrate from JAN**.

Jan compatibility is kept: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), and `JAN.md` project files (alongside `FLINT.md`) all still work. API keys stay in the OS keyring.

## Build from source

```bash
git clone https://github.com/Jozkah/flint.git
cd flint
corepack enable
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
yarn download:bin
yarn dev
```

Before you run these commands, install the toolchain (Git, Node 20+, Rust, and CMake/LLVM on Windows). The first build needs about 30 GB of disk space. [docs/BUILDING.md](docs/BUILDING.md) covers the per-OS setup, building installers, the local llama.cpp engine and troubleshooting.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Flint is licensed under the [Apache License 2.0](LICENSE), the same license as upstream Jan. Upstream copyright and attribution notices are kept in [`LICENSE`](LICENSE) and throughout the source.

## Acknowledgements

Flint builds on [Jan](https://github.com/janhq/jan), its contributors and its history. It also uses [llama.cpp](https://github.com/ggerganov/llama.cpp), [Tauri](https://tauri.app/) and [Scalar](https://github.com/scalar/scalar).
