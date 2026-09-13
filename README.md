# Jan - Open-source ChatGPT replacement

<img width="2048" height="280" alt="github jan banner" src="https://github.com/user-attachments/assets/f3f87889-c133-433b-b250-236218150d3f" />

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.ja.md">日本語</a><br/>
  <sub>The translations are upstream Jan's text and do not describe this fork's changes.</sub>
</p>

<p align="center">
  <img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/Jozkah/jan"/>
  <img alt="Github Last Commit" src="https://img.shields.io/github/last-commit/Jozkah/jan"/>
  <img alt="GitHub closed issues" src="https://img.shields.io/github/issues-closed/Jozkah/jan"/>
</p>

<p align="center">
  <a href="#build-from-source">Build from source</a>
  - <a href="#this-build-is-local-only">What was removed</a>
  - <a href="https://github.com/Jozkah/jan/issues">Bug reports</a>
  - <a href="https://github.com/janhq/jan">Upstream project</a>
</p>

Jan is bringing the best of open-source AI in an easy-to-use product. Run LLMs with **full control** and **privacy**.

This repository is a fork of [janhq/jan](https://github.com/janhq/jan) with the
network-reaching services stripped out and a desktop coding workspace added on
top. It ships no binaries of its own — you build it from source.

## This build is local-only

This fork has had every service that reaches the network on its own removed.
It does not phone home, and it will not fetch anything you did not ask it for.

**Removed**

- **Telemetry and analytics.** No PostHog, no product analytics, no consent
  prompt, no analytics settings, and no `POSTHOG_KEY` / `POSTHOG_HOST` build
  variables. Nothing counts what you do.
- **Update checking.** The desktop app ships no updater plugin and configures no
  update endpoint (`plugins.updater` is absent from `src-tauri/tauri.conf.json`),
  so it never asks whether a newer version exists — update it the way you
  installed it.
- **Vendor services.** No `jan.ai` URLs in the app's own code, no documentation,
  release, repository, community or issue-tracker links, and no vendor
  identification headers on outbound provider requests.

> **One exception, in the headless CLI.** `src-tauri/src/core/cli/updater.rs`
> still checks for updates through an analytics proxy on `jan.ai`, sending an
> anonymous install id kept in `~/.jan/cli_telemetry.json`. It only runs in
> binaries built by the nightly CI templates, which embed
> `JAN_CLI_UPDATE_CHANNEL`; a local `cargo build --features cli` is a no-op, and
> `JAN_CLI_NO_UPDATE_CHECK` opts out either way. The desktop app is unaffected.

**You bring your own models.** Point the app at models already on your
machine: add a local GGUF through **Settings → Model Providers → llama.cpp →
Import**, or an MLX model through the MLX provider.

> **In progress.** The built-in model catalogue and downloader have not been
> removed yet. Until they are, the Hub can still fetch model listings from
> HuggingFace and download weights when you use it.

**What can still reach the network, only if you set it up.** Nothing below is
configured out of the box, and nothing happens until you enter a credential:

| Capability | Reaches the network when |
|---|---|
| Cloud model providers | You enter your own API key for one |
| MCP servers | You add a server that is not on localhost |
| Web search | You enable it and supply a key |

Leave them alone and the app makes no outbound request at all — not at
startup, not while you use it.

Guards live in `web-app/src/__tests__/localOnly.test.ts`: the suite fails if an
analytics SDK, an update check, or a `jan.ai` URL is reintroduced. It scans the
web app's sources and `src-tauri/tauri.conf.json` — the Rust core is not covered,
which is why the CLI update check above survives it.


## Installation

There are no prebuilt binaries for this fork. The Microsoft Store, Flathub and
`app.jan.ai` downloads all ship **upstream Jan**, which still has telemetry and
update checking in it — installing one of those does not get you this build.

To run this fork, [build it from source](#build-from-source).

## Features

- **Local AI Models**: Download and run LLMs (Llama, Gemma, Qwen, GPT-oss etc.) from HuggingFace
- **Cloud Integration**: Connect to GPT models via OpenAI, Claude models via Anthropic, Mistral, Groq, MiniMax, and others
- **Custom Assistants**: Create specialized AI assistants for your tasks
- **OpenAI-Compatible API**: Local server at `localhost:1337` for other applications
- **Model Context Protocol**: MCP integration for agentic capabilities
- **Privacy First**: Everything runs locally when you want it to

### Workspace edition highlights

This fork extends Jan with a more complete desktop workspace for coding and
long-running agent tasks:

- **Unified workspace rail**: Open Files, Code, Changes, and Activity from one
  discoverable toolbar without leaving the conversation.
- **Read-only code workspace**: Browse project files, open referenced files from
  tool output or assistant messages, inspect syntax-highlighted source, and send
  only the selected code back into the conversation.
- **Git working-tree review**: Review modified and untracked files as real diffs
  in the Changes panel, including safe handling for symlinks and inaccessible
  paths.
- **Background activity tracking**: Follow running shell jobs from the Activity
  panel, status chip, or conversation; inspect their state and cancel individual
  jobs when needed.
- **Search across Settings**: Find settings globally, see results grouped by
  section, and jump directly to the relevant control with keyboard focus.
- **Temporary chats**: Start conversations that are not saved automatically,
  then explicitly keep or discard them, with protection against accidentally
  leaving an unfinished temporary chat.
- **Per-chat model controls**: Override the model and reasoning effort for an
  individual conversation and see the selected reasoning level at a glance.
- **Project-aware instructions**: Agent sessions automatically use the active
  project's `JAN.md` guidance while keeping project file access isolated.
- **Clickable local file references**: Open safe `@path` references from
  assistant messages directly in the Code panel.
- **macOS window polish**: Keeps the Jan header and navigation clear of the
  native close, minimize, and zoom controls.

## Build from Source

For those who enjoy the scenic route:

### Prerequisites

- Node.js ≥ 20.0.0
- Yarn ≥ 4.5.3
- Make ≥ 3.81
- Rust (for Tauri)
- (macOS Apple Silicon only) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

### Run with Make

```bash
git clone https://github.com/Jozkah/jan
cd jan
make dev
```

This handles everything: installs dependencies, builds core components, and launches the app.

**Available make targets:**
- `make dev` - Full development setup and launch
- `make build` - Production build
- `make test` - Run tests and linting
- `make clean` - Delete everything and start fresh

### Manual Commands

```bash
yarn install
yarn build
yarn dev
```

### Building on Windows

Run `make dev` from **Git Bash** (installed with Git for Windows) — make dispatches its recipes through `sh`, so a plain `cmd.exe` won't work.

You do **not** need a "Native Tools Command Prompt for VS 2022". The bundled llama.cpp engine builds with Ninja + `clang-cl`, and `clang-cl` locates the MSVC toolchain and Windows SDK on its own. What has to be installed (and on `PATH` for `ninja`/`clang-cl`/`cmake`):

- Visual Studio 2022 Build Tools (MSVC x64 workload + Windows SDK)
- LLVM (provides `clang-cl`)
- Ninja
- CMake
- CUDA Toolkit — only for `JAN_ENGINE_VARIANT=cuda12`/`cuda13` builds

Engine variants are picked with `JAN_ENGINE_VARIANT` (tokens: `cpu`, `vulkan`, `metal`, `cuda12`, `cuda13`, `hip`/`rocm`, joined by `-`), e.g.:

```bash
make dev JAN_ENGINE_VARIANT=cuda13
```

**"nvcc fatal : Could not open output file ...fattn-...cu.obj.d"** during `tauri-plugin-llamacpp(build)` means the build path crossed Windows' 260-character `MAX_PATH` limit — nvcc does not honor the long-path opt-in. The build script now detects this and automatically relocates the llama.cpp build tree to a short directory under `%LOCALAPPDATA%\jan-engine`. If you hit path-length errors anyway, set `JAN_ENGINE_BUILD_DIR` to a short path (e.g. `C:\jb`) or move the checkout closer to the drive root.

## System Requirements

**Minimum specs for a decent experience:**

- **macOS**: 13.6+ (8GB RAM for 3B models, 16GB for 7B, 32GB for 13B)
- **Windows**: 10+ with GPU support for NVIDIA/AMD/Intel Arc
- **Linux**: Most distributions work, GPU acceleration available

For detailed compatibility, see the [upstream installation
guides](https://jan.ai/docs/desktop/mac) — they describe upstream Jan, but the
hardware requirements are the same.

## Troubleshooting

If things go sideways:

1. Copy your error logs and system specs
2. Open an issue on [this fork](https://github.com/Jozkah/jan/issues)

Upstream's [troubleshooting docs](https://jan.ai/docs/desktop/troubleshooting)
still apply to anything this fork did not change. Upstream's Discord and issue
tracker do not support this fork — do not report fork bugs there.


## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full spiel.

## Links

- [This fork's issues](https://github.com/Jozkah/jan/issues) - Bugs in this build
- [janhq/jan](https://github.com/janhq/jan) - The upstream project
- [Upstream documentation](https://jan.ai/docs) - Applies to anything unchanged here

## License

Apache 2.0 - Because sharing is caring.

## Acknowledgements

Built on the shoulders of giants:

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)
