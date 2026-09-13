# JAN

A private, local-first AI workspace for your desktop: chat with models on your own computer, let an agent work on files and projects with your approval, and see exactly what it used and changed.

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-cowork-parallel-agents.png" alt="JAN Cowork with parallel agents and a live timeline" width="100%">

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#a-visual-tour">Visual tour</a> ·
  <a href="#features">Features</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

---

## What JAN is

JAN puts two ways of working side by side:

- **Chat** for questions, writing and documents. Conversations stay on your computer, can be grouped into projects, and can run side by side in a split view.
- **Cowork** for tasks that touch files. An agent reads, writes and runs commands in a sandbox or a managed copy of your project, asks before it does anything you have not allowed, and ends every run with a plain summary of what happened, what it checked and what is left to review.

Everything is designed to be understandable without prior AI experience: plain-language approvals, a short first-run guide, and explanations of technical terms where they appear.

### Local-only by design

This build does not phone home. There is no telemetry, no analytics, no update check, no model catalogue and no downloader. Nothing reaches the network until you set it up yourself:

| Capability | Reaches the network only when |
|---|---|
| Cloud model providers | You add your own API key for one |
| MCP servers | You add a server that is not on your machine |
| Web search | You turn it on and supply a key |

Automated guards in `web-app/src/__tests__/localOnly.test.ts` and `scripts/local-only-guard.mjs` fail the build if telemetry, update checks, vendor services or download sources are reintroduced.

## Install

This repository does not publish installers. Build JAN from source (below); the result is a normal desktop app for Windows, macOS or Linux.

**You bring your own models.** Use a GGUF model file you already have (Settings → Models → llama.cpp → Import), an MLX model on Apple silicon, or a cloud provider with your own key. Nothing is downloaded for you.

## Getting started

1. **Open JAN.** The first-run guide asks what you want to do — ask a question, work with documents, or build or change a project — and explains the difference between local and cloud processing. You can skip the guide at any time and reopen it from Settings → General.
2. **Choose a model.** Import a local model or add a provider in **Models**. Each model shows whether it is loaded, and the fit indicator separates what was *measured on this device* from what is only *estimated*. Estimates never block you from trying a model.
3. **Start a chat.** Type in the composer and press Enter. Attach files with **+**. Open **What JAN is using** in the conversation header to see the model, instructions, attachments, memory and tools that apply to the conversation.
4. **Try Cowork for file work.** Open **Cowork** from the Workspace sidebar, attach a project folder or work in the session sandbox, and describe the task. When the agent wants to change a file or run a command you have not allowed, JAN shows what it wants to do, the files involved, the scope of the permission and what happens if you deny it.
5. **Review the result.** The run summary explains what happened, where the result is, which commands were actually run and checked, and what is still unresolved. The **Changes** panel shows real diffs; checkpoints let you restore earlier states.

## A visual tour

Screenshots of the real app with demo content. Phone layouts are the same app in a 390×844 window.

### Chat

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-chat-conversation.png" alt="A conversation with a formatted table and code" width="100%">
Replies render tables, lists and code, and everything stays on your computer.

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-split-conversations.png" alt="Two independent conversations side by side" width="100%">
**Split conversations.** Two chats side by side, each with its own model, draft and stream.

### Cowork: agents that work on your files

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-cowork-managed-worktree-review.png" alt="Reviewing an agent's changes from a managed worktree" width="100%">
**Managed worktrees and review.** The agent works in an isolated copy of your project. You review each file and hunk, then apply what you want or reject it.

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-cowork-parallel-agents.png" alt="A team of agents working in parallel with a live timeline" width="100%">
**Parallel agents.** Explorer, security, reviewer and planner roles work at the same time, and the timeline shows each dispatch as it happens.

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-cowork-tool-call-timeline.png" alt="The execution timeline with tool call details" width="100%">
**Tool call history.** Every call is recorded with its phases, approvals, duration, input and output, and the diff it produced.

### Context and token usage

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-what-jan-is-using.png" alt="The What JAN is using panel" width="100%">
**What JAN is using.** See the model, instructions, memory and tools that apply to a conversation, and what was verified in the request that was actually sent.

<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-message-token-usage.png" alt="Token usage for one message" width="100%">
**Token usage.** Input, cached input and output for each message, marked "Not reported" when a provider does not report a figure.

### Phone-sized windows

<p>
<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-phone-chat.png" alt="A conversation on a phone-sized window" width="240">
<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-phone-split-switch.png" alt="Switching between split panes on a phone-sized window" width="240">
<img src="https://gist.githubusercontent.com/Jozkah/47ba31b0bf01179589eaa2daa1dd9268/raw/c5578ef64d07db5fdcb238916c166c4ef302c829/jan-phone-navigation.png" alt="The navigation sheet on a phone-sized window" width="240">
</p>

## Features

### The workspace
- One layout everywhere: a rail for **Workspace, Library, Models, Tools, Search, System and Settings**, a resizable sidebar for the current area, a context bar for the current page, and a status bar that shows loaded models, runs in progress, waiting approvals and the local API server.
- Works at any window size: below 1024px the navigation moves into a sheet, dialogs become bottom sheets on phones, and touch targets are at least 44px.
- Light, dark and system themes, with an accent colour you choose: Vermilion, Ink, Moss or any hex value. Text and focus colours are adjusted for contrast in both themes; success, warning and error colours never change.

### Chat
- Streaming replies with Stop, Retry, message editing and deletion, attachments, temporary chats, and per-chat model and reasoning settings.
- **Split conversations**: two conversations side by side, each with its own model, draft, attachments, approvals and stream.
- **Projects** group conversations with shared instructions and files.
- **What JAN is using** shows what applies to a conversation and distinguishes what is available, selected, and actually sent.

### Cowork
- Agent runs in a session sandbox or a managed worktree, with Autonomous, Ask-before-changes and review modes.
- Output panel with **Preview, Code, Changes, Activity and Timeline**; per-hunk review of proposals; checkpoints with safe restore (a safety checkpoint is taken first).
- Plain-language approvals and run summaries; steering a running agent; sub-agents and background jobs with a full execution record.

### Models
- Local llama.cpp models (and MLX on Apple silicon), plus cloud providers with your own keys.
- Evidence-based compatibility: a real on-device test, measured results kept per settings, and honest estimates that never block you.
- A preferred default model, model settings in an inspector, and a status for every model.

### Tools, memory and permissions
- MCP servers with validated setup, clear connection states and trust bound to each server's configuration.
- Skills and plugins, including project skills.
- Memory scoped to a conversation, a project or all conversations, with proposals you approve and conflicts you settle.
- A Permissions page listing every standing grant with a Revoke button, plus an audit of recent decisions.

### For developers
- OpenAI-compatible local API server (default port 1337).
- `jan` command-line agent and TUI built from the same core.

## Build from source

### Prerequisites

- Node.js 20 or newer and Yarn 4.5.3 (`corepack enable`)
- Rust (stable) for Tauri
- Make
- Windows: Visual Studio 2022 Build Tools (MSVC x64 and Windows SDK), LLVM (`clang-cl`), Ninja and CMake; run `make` from Git Bash
- macOS on Apple silicon: the Metal toolchain (`xcodebuild -downloadComponent MetalToolchain`)
- CUDA Toolkit only for CUDA engine builds

### Run in development

```bash
git clone <this repository>
cd jan
make dev
```

`make dev` installs dependencies, builds the core packages and the engine, and launches the app.

### Other targets

- `make build` — production build
- `make test` — tests and linting
- `make build-cli` — the `jan` command-line agent
- `make clean` — remove build output

Or with Yarn directly:

```bash
yarn install
yarn build
yarn dev
```

### Engine variants

Choose the llama.cpp engine build with `JAN_ENGINE_VARIANT` (tokens `cpu`, `vulkan`, `metal`, `cuda12`, `cuda13`, `hip`/`rocm`, joined with `-`):

```bash
make dev JAN_ENGINE_VARIANT=cuda13
```

On Windows, if an engine build fails with an nvcc "Could not open output file" error, the build path is too long: the build script relocates it automatically, or set `JAN_ENGINE_BUILD_DIR` to a short path such as `C:\jb`.

## Documentation in this repository

- `docs/ATELIER_IMPLEMENTATION.md` — the design system, shell and feature map
- `docs/BEGINNER_WORKFLOWS_HANDOFF.md` — onboarding, permissions, results and model-fit behaviour
- `docs/IMPLEMENTATION_BASELINE.md` — contracts the interface relies on
- `docs/AGENT_HARNESS_FEATURE_REGISTRY.md` — the agent capability registry
- `CONTRIBUTING.md` — how to contribute

## License

Apache 2.0.

## Acknowledgements

Built on [llama.cpp](https://github.com/ggerganov/llama.cpp), [Tauri](https://tauri.app/) and [Scalar](https://github.com/scalar/scalar).
