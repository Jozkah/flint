# Building Flint from source

These steps take you from a fresh machine to Flint's installer (or a running development copy). Do them in
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

## 2. Get the code

```bash
git clone https://github.com/Jozkah/flint.git
cd flint
```

Every command from here on is run **inside the `flint` folder**.

## 3. Build the installer

Run this one command, in any terminal (PowerShell, Command Prompt, Git Bash,
macOS or Linux Terminal):

```bash
node scripts/build-installer.mjs
```

That is the whole build. It checks the tools from step 1 and, if one is
missing, stops and prints the command that installs it. Otherwise it installs
the dependencies, builds Flint's llama.cpp engine, then builds the app and the
installers. It prints where they are when it finishes. Expect 20–60 minutes
the first time. On Windows it needs neither `make` nor Git Bash nor
`corepack enable`.

When it succeeds, the installers are in `src-tauri/target/release/bundle/`:

- **Windows:** the setup program is `nsis\Flint_<version>_x64-setup.exe`, and `msi\Flint_<version>_x64_en-US.msi` is the MSI. The app itself is `src-tauri\target\release\Flint-Desktop.exe`.
- **macOS:** a `.dmg` under `dmg/` and the `.app` under `macos/`.
- **Linux:** `.deb` and `.AppImage` files under `deb/` and `appimage/`.

If there is no `bundle` folder, the build did not finish. Scroll to the first
line that says `error` and see [Troubleshooting](#troubleshooting).

For a GPU build, add the variant (see [Local models](#local-models-the-llamacpp-engine)):

```bash
node scripts/build-installer.mjs vulkan
```

**Do not run `yarn build`, `yarn tauri build` or `cargo build` on their own to
get an installer.** They need the engine from the step above, and they fail
without it with `resource path ... flint-llama-worker.exe doesn't exist`.
`yarn build` now stops with a message that says so.

## 4. Or run Flint in development instead

```bash
corepack enable
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
yarn download:bin
yarn dev
```

`corepack enable` switches on the Yarn version the project pins (4.10.3). If
it fails with a permissions error, run that one command in an Administrator
PowerShell (Windows) or prefix it with `sudo` (macOS/Linux).

The app window opens once the Rust side has compiled. Edits to the interface
reload live. Stop it with `Ctrl+C` in the terminal. Development builds have no
local-model engine; see [Local models](#local-models-the-llamacpp-engine).

## Advanced: the installer build by hand

Only if you cannot use `node scripts/build-installer.mjs`. The order matters,
and the engine step is the one that most often goes wrong:

```bash
corepack enable
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
make build-engine JAN_ENGINE_VARIANT=cpu
```

On Windows run that last line in **Git Bash** (installed with Git; search the
Start menu for it), not PowerShell, whose `bash` is WSL. Check that it worked
before going on. This file must exist (`flint-llama-worker` without `.exe` on
macOS and Linux):

```bash
ls src-tauri/resources/bin/flint-llama-worker.exe
```

If it does not, the engine build failed; read its output and fix that first.
Then, in any terminal in the `flint` folder:

```bash
yarn build
```

The installers end up in the same `src-tauri/target/release/bundle/` folder.

## Updating to the latest code

```bash
git pull
yarn install
yarn build:tauri:plugin:api
yarn build:core
```

Then run `yarn dev`, or `node scripts/build-installer.mjs` to rebuild the installers.

## Useful commands

| Command | What it does |
|---|---|
| `yarn dev` | Run the desktop app in development |
| `node scripts/build-installer.mjs` | Build the engine and the installers (use this, not `yarn build`, for a first build) |
| `yarn build` | Build the app and installers, once the engine is already built |
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

- **`resource path ... flint-llama-worker.exe doesn't exist`, or "Flint's local-model engine has not been built yet"** — the engine step did not run or failed, so there is nothing to put in the installer. Run `node scripts/build-installer.mjs`; it builds the engine first. If you built by hand, `make build-engine` failed (on Windows it must run in Git Bash).
- **The build finished but there is no installer** — look for `src-tauri\target\release\bundle`. If it is missing, the build stopped at an `error` line above; the last line of the output is only a summary. `src-tauri\target\release\Flint-Desktop.exe` on its own means the app compiled and only the NSIS or MSI packaging step failed, which usually means a missing Windows tool or no internet for the WiX/NSIS download.
- **`cross-env: command not found` or `tauri: command not found`** — run `yarn install` first, from the repository root.
- **Type errors about `@janhq/tauri-plugin-…-api` or `@janhq/core`** — the shared packages are stale; run `yarn build:tauri:plugin:api` and `yarn build:core` again. The web-app `typecheck` script and `yarn build:extensions` both rebuild the plugins' `dist-js` themselves, so after merging a branch that changes a plugin's `guest-js` either one picks the change up.
- **"ServiceHub not initialized" or "Failed to resolve import @janhq/assistant-extension" in `yarn dev`** — the bundled extensions are not built; run `yarn build:extensions`.
- **"Sidecar verification failed … empty (0 bytes)"** — placeholder binaries are in the way. Delete everything in `src-tauri/resources/bin/` and run `yarn download:bin`, then build again.
- **"the engine build needs clang on PATH"** — LLVM is installed but not on `PATH`; run the `PATH` command from step 1 and reopen the terminal.
- **Windows: `wsl: Failed to translate` during `make`** — you ran `make` from PowerShell; run it from Git Bash.
- **Windows: `link.exe` not found or linker errors** — the Visual Studio Build Tools are missing or Rust is on the GNU toolchain; rerun the Build Tools install above and `rustup default stable-msvc`.
- **Windows: nvcc "Could not open output file"** while building a CUDA engine — the build path is too long; set `JAN_ENGINE_BUILD_DIR` to a short path such as `C:\jb`.
- **Running out of disk space** — the Rust build folder `src-tauri/target` can reach 25–30 GB; delete it to reclaim space (the next build is slower).
