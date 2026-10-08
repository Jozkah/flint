# Building Flint from source

These steps take you from a fresh machine to a running Flint. Do them in
order. Every block is a command to paste into a terminal: **PowerShell** on
Windows, **Terminal** on macOS and Linux.

The first build needs an internet connection (it downloads packages and the
bun and uv helper binaries) and about 30 GB of free disk space. It compiles
Rust, so expect 10–30 minutes the first time; later builds are much faster.

## 1. Install the tools (once per machine)

**Windows 10/11** — `winget` is built in:

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Rustlang.Rustup
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install -e --id LLVM.LLVM
winget install -e --id Kitware.CMake
winget install -e --id Ninja-build.Ninja
winget install -e --id ezwinports.make
```

The LLVM installer does not add itself to `PATH`; this adds it for your
user account:

```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User"); [Environment]::SetEnvironmentVariable("Path", "$p;C:\Program Files\LLVM\bin", "User")
```

Close and reopen PowerShell, then make Rust use the MSVC toolchain:

```powershell
rustup default stable-msvc
```

**macOS** — install the Xcode command-line tools and [Homebrew](https://brew.sh), then:

```bash
xcode-select --install
brew install git node rustup cmake ninja
rustup default stable
```

On Apple silicon, also run `xcodebuild -downloadComponent MetalToolchain`.

**Linux (Debian/Ubuntu)**:

```bash
sudo apt update
sudo apt install -y git curl build-essential cmake ninja-build file libssl-dev libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

Close and reopen the terminal after installing, so the new tools are on
your `PATH`. Check that everything is there:

```bash
git --version
node --version
cargo --version
make --version
```

On Windows, also check `clang --version`.

Node.js must be version 20 or newer.

## 2. Get the code and turn on Yarn

```bash
git clone https://github.com/Jozkah/flint.git
cd flint
corepack enable
```

`corepack enable` switches on the Yarn version the project pins (4.10.3). If
it fails with a permissions error, run that one command in an Administrator
PowerShell (Windows) or prefix it with `sudo` (macOS/Linux).

## 3. Install dependencies and build the shared packages and extensions

```bash
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
```

## 4a. Run Flint in development

```bash
yarn download:bin
yarn dev
```

The app window opens once the Rust side has compiled. Edits to the
interface reload live. Stop it with `Ctrl+C` in the terminal.

## 4b. Or build the installable app

One command does it, from any terminal including PowerShell, straight after
cloning (steps 2 and 3 are not needed for it):

```bash
node scripts/build-installer.mjs
```

It checks the tools from step 1 and names any that are missing with the
command that installs them, then builds the llama.cpp engine and the app and
prints where the installers are. On Windows it needs neither `make` nor Git
Bash, finds LLVM in its default folder even when it is not on `PATH`, and does
not need `corepack enable`. Pass an engine variant to build for a GPU, for
example `node scripts/build-installer.mjs vulkan` (see
[Local models](#local-models-the-llamacpp-engine) below).

The same build by hand, after steps 2 and 3: the installer bundles Flint's
llama.cpp engine, so build that first. On Windows, run this one in **Git
Bash** (installed with Git; search the Start menu for it), not PowerShell,
whose `bash` is WSL:

```bash
make build-engine JAN_ENGINE_VARIANT=cpu
```

`cpu` works on every machine. For GPU speed pick another variant (see
[Local models](#local-models-the-llamacpp-engine) below). Then, back in any
terminal in the `flint` folder:

```bash
yarn build
```

`yarn build` stops at once, with a message, if the engine
(`src-tauri/resources/bin/flint-llama-worker`) has not been built. Set
`FLINT_SKIP_ENGINE_CHECK=1` to bypass that check.

When it finishes, the installers are in `src-tauri/target/release/bundle/`:

- Windows: an `.exe` under `nsis\` and an `.msi` under `msi\` (the app itself is `src-tauri\target\release\Flint-Desktop.exe`)
- macOS: a `.dmg` under `dmg/` and the `.app` under `macos/`
- Linux: `.deb` and `.AppImage` files under `deb/` and `appimage/`

## Updating to the latest code

```bash
git pull
yarn install
yarn build:tauri:plugin:api
yarn build:core
```

Then run `yarn dev` or `yarn build` again.

## Useful commands

| Command | What it does |
|---|---|
| `yarn dev` | Run the desktop app in development |
| `yarn build` | Build the installable desktop app |
| `yarn build:web` | Build only the web interface (fast check) |
| `yarn workspace @janhq/web-app typecheck` | Type-check the interface (rebuilds the Tauri plugins' `dist-js` first, so their types are never stale) |
| `yarn lint` | Lint the interface |
| `yarn test:web` | Run the interface tests |
| `yarn build:cli` | Build the `flint` command-line agent into `src-tauri/resources/bin/` |

On macOS and Linux the Makefile wraps the same steps: `make dev`, `make build`,
`make test`, `make build-cli` and `make clean`.

## Local models (the llama.cpp engine)

`yarn dev` runs without the engine; cloud providers and OpenAI-compatible
servers work either way. To run models on your own machine in development,
build the engine once (in Git Bash on Windows):

```bash
make build-engine-dev JAN_ENGINE_VARIANT=cpu
```

Pick the variant for your hardware with `JAN_ENGINE_VARIANT` (tokens `cpu`,
`vulkan`, `metal`, `cuda12`, `cuda13`, `hip`/`rocm`, joined with `-`).
`make dev` builds the engine automatically when the toolchain is complete.
CUDA variants need the CUDA Toolkit.

## Troubleshooting

- **`cross-env: command not found` or `tauri: command not found`** — run `yarn install` first, from the repository root.
- **Type errors about `@janhq/tauri-plugin-…-api` or `@janhq/core`** — the shared packages are stale; run `yarn build:tauri:plugin:api` and `yarn build:core` again. The web-app `typecheck` script and `yarn build:extensions` both rebuild the plugins' `dist-js` themselves, so after merging a branch that changes a plugin's `guest-js` either one picks the change up.
- **"ServiceHub not initialized" or "Failed to resolve import @janhq/assistant-extension" in `yarn dev`** — the bundled extensions are not built; run `yarn build:extensions`.
- **"Sidecar verification failed … empty (0 bytes)"** — placeholder binaries are in the way. Delete everything in `src-tauri/resources/bin/` and run `yarn download:bin`, then build again.
- **"the engine build needs clang on PATH"** — LLVM is installed but not on `PATH`; run the `PATH` command from step 1 and reopen the terminal.
- **Windows: `wsl: Failed to translate` during `make`** — you ran `make` from PowerShell; run it from Git Bash.
- **Windows: `link.exe` not found or linker errors** — the Visual Studio Build Tools are missing or Rust is on the GNU toolchain; rerun the Build Tools install above and `rustup default stable-msvc`.
- **Windows: nvcc "Could not open output file"** while building a CUDA engine — the build path is too long; set `JAN_ENGINE_BUILD_DIR` to a short path such as `C:\jb`.
- **Running out of disk space** — the Rust build folder `src-tauri/target` can reach 25–30 GB; delete it to reclaim space (the next build is slower).
