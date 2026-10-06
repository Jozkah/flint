# Headless Flint Web Server Design

## Purpose

Run Flint as a production service on Windows, Linux, or macOS and use its full desktop interface from a browser on another device. The host must not need an active desktop session. Initial deployment is on a private network, including Tailscale. The service must work after a restart without running Vite or opening a Tauri window.

## Current architecture and constraint

`yarn dev` starts a Tauri desktop application whose Vite server supplies the UI during development. A production desktop build packages that UI into the Tauri webview. Browser requests to the Vite address cannot use Tauri commands, events, extension engines, filesystem access, or desktop process state.

The existing remote-access server (`src-tauri/src/core/remote`) authenticates paired phones and serves a separate mobile application under `/m/`. Its RPC handlers run in the open desktop webview through Tauri events. The headless CLI (`flint`) runs without a GUI but currently supports remote providers only. Neither path can serve the complete desktop application headlessly as it stands.

## Approaches considered

1. **Extend the phone API and display the mobile UI at desktop width.** Reuses authentication and server, but does not provide the full desktop interface or its settings and Studio workflows.
2. **Proxy Tauri commands from the browser into a hidden desktop app.** Reuses most frontend code, but still requires a graphical session and exposes powerful native commands through a generic proxy. It fails the headless requirement.
3. **Move application services behind a headless API and adapt the desktop frontend to use them.** More work, but satisfies the host and interface requirements. Selected approach.

## Service architecture

Add a `flint serve` mode to the existing Rust CLI binary. It runs the same durable data and agent core used by the desktop application, without Tauri. It binds loopback by default and supports an explicitly selected private-network address. The production desktop web bundle is served from a dedicated path. A versioned HTTP API and event stream supply service data and mutations. The browser's service hub selects web-remote adapters when booted from this server; desktop builds retain their Tauri adapters.

The existing remote-access server's host validation, origin checks, path sanitization, token hashing, rate limits, and TLS planning should be reused where they are independent of Tauri. Pairing by approving a request in the desktop window cannot be reused in headless mode. Headless bootstrap generates an administrator credential at first launch and prints it once to the host terminal. Browser sign-in exchanges it for a short-lived, HttpOnly, SameSite=Strict session cookie. The service stores only a password hash and session hashes. Authentication covers HTML and API routes except sign-in assets and health status. Mutating requests require same-origin checks and CSRF protection. The service rejects non-TLS connections from non-loopback addresses unless transport is already secured by an explicit private-network mode such as Tailscale.

Each browser session has its own view state. Threads, messages, model inventory, settings, projects, Studio jobs, download jobs, and agent runs remain in shared server state, with revisioned events so multiple tabs can refresh without overwriting each other. File uploads use bounded streaming and server-side path validation. Local path pickers and operating-system dialogs receive browser-specific alternatives. Commands that only make sense for desktop windows are hidden or disabled with an explanation in browser mode.

## API boundaries

The API is organized by service domain rather than exposing arbitrary Tauri `invoke` names:

- `/api/v1/session`: sign-in, sign-out, current user, and credential rotation.
- `/api/v1/threads`, `/api/v1/messages`, `/api/v1/projects`: durable chat and project data.
- `/api/v1/providers`, `/api/v1/models`, `/api/v1/downloads`: provider configuration, model discovery, local model management, downloads, and progress.
- `/api/v1/agents`: start, observe, approve, stop, and resume agent runs.
- `/api/v1/studio`: image and video models, generation jobs, LoRA inputs, output files, and progress.
- `/api/v1/settings`, `/api/v1/files`, `/api/v1/events`: remaining shared settings, bounded uploads/downloads, and live updates.

Each endpoint uses a typed request and response schema shared by server and web adapters. Errors have stable codes and user-readable messages. Long-running calls return a job ID, and events carry updates. Reconnection retrieves a snapshot before replaying newer events. No browser request can select arbitrary server filesystem paths or invoke shell/native commands without the same policy and approval gate used by local agents.

## Local inference and Studio

The current CLI can drive remote providers but cannot initialize the Tauri-backed local model engines. Extract llama.cpp process control and model inventory behind a Tauri-free runtime interface; both desktop and `flint serve` implement or call that interface. Keep model files and metadata in the same data folder so switching between desktop and server mode does not duplicate downloads. The server owns one inference scheduler and unloads models safely when switching workloads.

Likewise, move stable-diffusion.cpp process control, model import, LoRA selection, and Studio job state to a Tauri-free service. Its outputs are served through authenticated file endpoints. The browser never receives unrestricted local file paths. Server mode reports unsupported hardware or unavailable sidecars as explicit errors rather than showing a successful job.

## Distribution and operations

Build the static web bundle and server binary together for Windows, Linux, and macOS. `flint serve` resolves assets relative to the binary/install location, with an explicit `--assets-dir` for development and diagnostics. Provide `--listen`, `--port`, `--data-dir`, and certificate/key options, with safe defaults and validation. Document Tailscale/private-network setup, first sign-in, credential rotation, backups, and upgrades. Health and readiness endpoints distinguish a live process from initialized data, engines, and assets. Shutdown stops active jobs, flushes durable state, and closes listeners.

## Acceptance criteria

1. A fresh installation starts headlessly on each target OS, serves a production bundle, and requires sign-in before application data is returned.
2. A remote browser can use the desktop layouts for chat, projects, models, agent runs, Studio, settings, and downloads. Status changes appear without page reload.
3. Local models and Studio jobs run on the host, survive browser disconnects, and expose cancellation and clear errors.
4. Two browser tabs see consistent shared data; a service restart restores durable state without leaving jobs falsely marked active.
5. Private-network access is explicit and encrypted. Invalid origin/host, missing auth, path traversal, oversized uploads, and unapproved tool actions are rejected.
6. Desktop Tauri behavior and the existing paired-phone application remain working.
7. CI builds and exercises the headless server on Windows, Linux, and macOS; browser end-to-end tests cover sign-in, chat, downloads, agent stop, and Studio job lifecycle.

## Delivery slices

1. **Server and authentication:** headless CLI mode, static bundle, sign-in, health, security tests, packaging.
2. **Shared data and desktop browser shell:** typed data API, web service adapters, chat and settings read/write flows, event reconciliation.
3. **Execution:** local/remote providers, model downloads, agent lifecycle and approvals.
4. **Studio and parity:** generation engines, LoRAs, files, remaining desktop routes, cross-platform end-to-end tests and documentation.

Each slice must leave a usable, testable server for the routes it enables. The full-interface requirement is met only when all slices and acceptance criteria pass.
