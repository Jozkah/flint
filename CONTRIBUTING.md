# Contributing to Flint

Thank you for considering a contribution to Flint.

Flint is a local-first AI workspace for the desktop: chat with local or cloud models, and let an agent work on your files and projects with your approval. It is an independent fork of [Jan](https://github.com/janhq/jan), so much of the architecture below is shared with upstream, and internal package names still use the `@janhq/` scope.

## Quick Links to Component Guides

- **[Web App](./web-app/CONTRIBUTING.md)** - React UI and logic
- **[Core SDK](./core/CONTRIBUTING.md)** - TypeScript SDK and extension system
- **[Extensions](./extensions/CONTRIBUTING.md)** - Supportive modules for the frontend
- **[Tauri Backend](./src-tauri/CONTRIBUTING.md)** - Rust native integration
- **[Tauri Plugins](./src-tauri/plugins/CONTRIBUTING.md)** - Hardware and system plugins

## How Flint Works

Flint is a Tauri desktop app that runs local AI models. Here's how the components actually connect:

```
┌──────────────────────────────────────────────────────────┐
│                   Web App (Frontend)                     │
│                      (web-app/)                          │
│  • React UI                                              │
│  • Chat Interface                                        │
│  • Settings Pages                                        │
│  • Model Hub                                             │
└────────────┬─────────────────────────────┬───────────────┘
             │                             │
             │ imports                     │ imports
             ▼                             ▼
  ┌──────────────────────┐      ┌──────────────────────┐
  │     Core SDK         │      │     Extensions       │
  │      (core/)         │      │   (extensions/)      │
  │                      │      │                      │
  │ • TypeScript APIs    │◄─────│ • Assistant Mgmt     │
  │ • Extension System   │ uses │ • Conversations      │
  │ • Event Bus          │      │ • Downloads          │
  │ • Type Definitions   │      │ • LlamaCPP           │
  └──────────┬───────────┘      └───────────┬──────────┘
             │                              │
             │   ┌──────────────────────┐   │
             │   │       Web App        │   │
             │   └──────────┬───────────┘   │
             │              │               │
             └──────────────┼───────────────┘
                            │
                            ▼
                        Tauri IPC
                    (invoke commands)
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│                   Tauri Backend (Rust)                    │
│                      (src-tauri/)                         │
│                                                           │
│  • Window Management        • File System Access          │
│  • Process Control          • System Integration          │
│  • IPC Command Handler      • Security & Permissions      │
└───────────────────────────┬───────────────────────────────┘
                            │
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│                   Tauri Plugins (Rust)                    │
│                   (src-tauri/plugins/)                    │
│                                                           │
│     ┌──────────────────┐        ┌──────────────────┐      │
│     │  Hardware Plugin │        │  LlamaCPP Plugin │      │
│     │                  │        │                  │      │
│     │ • CPU/GPU Info   │        │ • Process Mgmt   │      │
│     │ • Memory Stats   │        │ • Model Loading  │      │
│     │ • System Info    │        │ • Inference      │      │
│     └──────────────────┘        └──────────────────┘      │
└───────────────────────────────────────────────────────────┘
```

### The Communication Flow

1. **JavaScript Layer Relationships**:
   - Web App imports Core SDK and Extensions as JavaScript modules
   - Extensions use Core SDK for shared functionality
   - All run in the browser/webview context

2. **All Three → Backend**: Through Tauri IPC
   - **Web App** → Backend: `await invoke('app_command', data)`
   - **Core SDK** → Backend: `await invoke('core_command', data)`
   - **Extensions** → Backend: `await invoke('ext_command', data)`
   - Each component can independently call backend commands

3. **Backend → Plugins**: Native Rust integration
   - Backend loads plugins as Rust libraries
   - Direct function calls, no IPC overhead

4. **Response Flow**:
   - Plugin → Backend → IPC → Requester (Web App/Core/Extension) → UI updates

### Real-World Example: Loading a Model

Here's what happens when you import a GGUF model and start a chat:

1. **Web App** (`web-app/`) - User picks a file under Models -> llama.cpp -> Import
2. **Extension** (`extensions/llamacpp-extension`) - Registers the model and its settings
3. **Tauri Backend** (`src-tauri/`) - Copies or links the file into the data folder
4. **Tauri Plugin** (`src-tauri/plugins/tauri-plugin-llamacpp`) - Starts the llama.cpp server process
5. **Hardware Plugin** (`src-tauri/plugins/tauri-plugin-hardware`) - Reports CPU/GPU and memory for offload settings
6. **Model ready** - User can start chatting

## Project Structure

```
flint/
├── web-app/              # React frontend (what users see)
├── src-tauri/            # Rust backend (system integration)
│   ├── src/core/         # Core Tauri commands
│   └── plugins/          # Tauri plugins (agent-tools, hardware, llamacpp, mlx, rag, ...)
├── core/                 # TypeScript SDK (API layer)
├── extensions/           # JavaScript extensions
│   ├── assistant-extension/
│   ├── conversational-extension/
│   ├── llamacpp-extension/
│   ├── mlx-extension/
│   ├── rag-extension/
│   └── vector-db-extension/
├── packages/agent-sdk/   # Agent SDK
├── docs/                 # Build guide, feature list, screenshots
├── website/              # Marketing site (Vite + React, separate npm project)
├── e2e/, autoqa/         # End-to-end and automated testing
├── scripts/              # Build utilities
│
├── package.json          # Root workspace configuration
├── Makefile              # Build automation commands
├── LICENSE               # Apache 2.0 license
└── README.md             # Project overview
```

## Development Setup

[docs/BUILDING.md](docs/BUILDING.md) is the step-by-step guide for every OS (toolchain install, first build, installers, troubleshooting).

**Prerequisites:**
- Git, Node.js ≥ 20 and Yarn 4 (via `corepack enable`)
- Rust (for Tauri); on Windows also the MSVC build tools, LLVM and CMake
- (macOS Apple Silicon only) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

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

## How Can I Contribute?

### Reporting Bugs

- **Ensure the bug was not already reported** by searching [Issues](https://github.com/Jozkah/flint/issues)
- If you can't find an open issue for the problem, [open a new one](https://github.com/Jozkah/flint/issues/new/choose)
- Security problems go through [private vulnerability reporting](https://github.com/Jozkah/flint/security/advisories/new), not public issues (see [SECURITY.md](SECURITY.md))
- Include your system specs and error logs - it helps a ton
- Provide clear steps to reproduce the issue so we can quickly identify the root cause
- Attach screenshots or screen recordings whenever possible - a visual is worth a thousand words when debugging

### Suggesting Enhancements

- Open a new issue with a clear title and description
- Explain why this enhancement would be useful
- Include mockups or examples if you can

### Your First Code Contribution

**Choose Your Adventure:**
- **Frontend UI and logic** → `web-app/`
- **Shared API declarations** → `core/`
- **Backend system integration** → `src-tauri/`
- **Business logic features** → `extensions/`
- **Dedicated backend handler** → `src-tauri/plugins/`

**The Process:**
1. Fork the repo
2. Create a new branch (`git checkout -b feature-name`)
3. Make your changes (and write tests!)
4. Commit your changes (`git commit -am 'Add some feature'`)
5. Push to the branch (`git push origin feature-name`)
6. Open a new Pull Request against `main` branch

## Testing

```bash
yarn test                    # All tests
cd src-tauri && cargo test  # Rust tests
cd autoqa && python main.py # End-to-end tests
```

## Code Standards

### TypeScript/JavaScript
- TypeScript required (we're not animals)
- ESLint + Prettier
- Functional React components
- Proper typing (no `any` - seriously!)

### Rust
- `cargo fmt` + `cargo clippy`
- `Result<T, E>` for error handling
- Document public APIs

## Git Conventions

### Branches
- `main` - main branch with latest & completed commits (target this branch for PRs)
- `release/*` - stable releases or upcoming release candidate
- `feature/*` - new features
- `fix/*` - bug fixes

### Commit Messages
- Use the present tense ("Add feature" not "Added feature")
- Be descriptive but concise
- Reference issues when applicable

Examples:
```
feat: add support for Qwen models
fix: resolve memory leak in model loading
docs: update installation instructions
```

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope)!: description`. Allowed types are `feat`, `fix`, `perf`, `revert`, `docs`, `style`, `refactor`, `test`, `build`, `ci` and `chore`. PRs are squash-merged with the PR title as the commit message, and [release-please](https://github.com/googleapis/release-please) reads those commits: `feat` bumps the minor version, `fix` and `perf` bump the patch, and a `!` or a `BREAKING CHANGE:` footer marks a breaking change. A check on each PR enforces the title format. Releases are cut on demand: run the Release Please workflow by hand to open the release PR, and merging it tags the release and builds the installers. Nothing is bumped otherwise, and nightlies continue as before.

### Pull Request Requirements
- Include a screenshot or screen recording in your PR description showing the change in action
- For bug fixes: show both the **before** (broken behavior) and **after** (fixed behavior)
- For new features or enhancements: demonstrate the feature working as expected

## Troubleshooting

If things go sideways:

1. **Check the troubleshooting section of [docs/BUILDING.md](docs/BUILDING.md)**
2. **Clear everything and start fresh:** `make clean` then `make dev`
3. **Copy your error logs and system specs**
4. **Open an [issue](https://github.com/Jozkah/flint/issues)** with the logs and steps

Common issues:
- **Build failures**: Check Node.js and Rust versions
- **Extension not loading**: Verify it's properly registered
- **Model not working**: Check hardware requirements and GPU drivers

## Getting Help

- [README](README.md) and [docs/FEATURES.md](docs/FEATURES.md) - What Flint does
- [docs/BUILDING.md](docs/BUILDING.md) - Building from source
- [GitHub Issues](https://github.com/Jozkah/flint/issues) - Bugs, questions and ideas

## License

Flint is licensed under the Apache License 2.0. By contributing, you agree that your contributions are licensed under the same terms. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
