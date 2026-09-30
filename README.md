# Flint

**A local-first AI workspace for your desktop.** Chat with models on your own computer, let an agent work on your files and projects with your approval, and see exactly what it used and changed.

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
  <img src="docs/screenshots/01-overview.png" alt="Flint's Overview dashboard: tokens generated, generation speed and tool-call success, token throughput by day, latest activity and a table of agent runs" width="100%">
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

All screenshots use an invented example project ("acme-weather") and made-up data.

| | |
|---|---|
| <img src="docs/screenshots/02-code-panel.png" alt="The Code panel beside a Cowork chat: an edited TypeScript file with change markers in the gutter and inline blame" width="100%"><br>Code panel with change markers and blame | <img src="docs/screenshots/03-cowork-tools.png" alt="A Cowork run with expanded tool calls, a bash result, an approval card waiting for an answer and the Changes panel" width="100%"><br>Cowork: tool calls, results and the Changes panel |
| <img src="docs/screenshots/04-approval.png" alt="An approval card asking to run git push, with Deny, Allow once, and under More options Allow in this conversation and Always allow" width="100%"><br>Approval card with its permission options | <img src="docs/screenshots/05-pr-bar.png" alt="Two Cowork sessions side by side, each with its worktree bar and a Create pull request action" width="100%"><br>Two sessions, each in its own worktree |
| <img src="docs/screenshots/06-what-changed.png" alt="The What changed card of a finished Cowork run: files changed in a managed worktree, the tests and checks that passed, and what the assistant only mentioned" width="100%"><br>What changed: the run's own record | <img src="docs/screenshots/07-rooms.png" alt="The Rooms page: counts for running rooms, rooms waiting for you, turns this week and models taking part, then a card per room" width="100%"><br>Rooms overview |
| <img src="docs/screenshots/08-room.png" alt="A Discussion Room where three models discuss a retry policy, with tool chips, a vote, and controls to steer the discussion" width="100%"><br>A Discussion Room with tool chips and a vote | <img src="docs/screenshots/09-models.png" alt="The Models page: loaded models with live speed, provider cards, and the installed models" width="100%"><br>Models: loaded models and providers |
| <img src="docs/screenshots/10-queued-messages.png" alt="The Cowork composer with a steering message and a queued message waiting while the run works" width="100%"><br>Steering and queued messages | <img src="docs/screenshots/11-code-panel-light.png" alt="The Code panel in the light theme" width="100%"><br>Light theme |
| <img src="docs/screenshots/12-tools-mcp.png" alt="The Tools and MCP page: MCP server cards with connection state, call rate, tools and an auto-approve switch" width="100%"><br>Tools and MCP servers | <img src="docs/screenshots/13-permissions.png" alt="The Permissions page: standing grants per conversation and for every conversation, trusted MCP servers and approvals that need renewing, each with Revoke" width="100%"><br>Permissions: every standing grant |
| <img src="docs/screenshots/14-library.png" alt="The Library: documents, code, pages and media that Cowork runs produced" width="100%"><br>Library of Cowork artifacts | <img src="docs/screenshots/15-what-flint-is-using.png" alt="The Details panel of a chat with What Flint is using expanded: the model, instructions and saved memory that applied, and whether each was sent" width="100%"><br>What Flint is using, per conversation |

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
