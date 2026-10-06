# Headless Flint Web Server Implementation Plan

> **For agentic workers:** Implement tasks in order. Keep each task independently testable and reviewable.

**Goal:** Serve Flint's full desktop interface from a headless production service on Windows, Linux, and macOS over a private network.

**Architecture:** Add a Rust server mode to the existing `flint` binary. Reuse the durable core and remote server's security helpers, then replace Tauri-only frontend services with typed browser adapters. Extract local inference and Studio process control from Tauri to shared services.

**Tech Stack:** Rust, Tokio, Hyper, TypeScript, React, Vite, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-headless-web-server-design.md`

## Global constraints

- Bind loopback by default. Private-network binding is explicit and must use TLS or a documented secure tunnel.
- Every application-data route requires authentication. Reject invalid Host and Origin headers.
- Do not expose arbitrary Tauri commands, local filesystem paths, or unsandboxed shell operations over the network.
- Maintain the current Tauri desktop and paired-phone flows.
- A route is complete only when its browser adapter and server handler work in a production build.

## Review focus

- Restart during a running agent or Studio job must not show a false running state afterward.
- Expired or revoked sessions must stop HTTP mutations and event streams.
- A browser reconnect must reconcile missed events with a fresh snapshot.
- Uploaded names and paths must not escape the configured data directory.
- Two browsers must not overwrite shared settings with stale local state.

## Task 1: Headless server and authentication

**Files:** `src-tauri/src/bin/flint.rs`, new `src-tauri/src/core/web_server/` modules, `src-tauri/src/core/mod.rs`, `src-tauri/Cargo.toml`, build scripts, server tests.

1. Add failing tests for loopback binding, invalid Host/Origin, missing/expired authentication, path traversal, and restart persistence.
2. Implement `flint serve` with validated bind and asset paths, production static files, health/readiness, admin bootstrap, sign-in, sign-out, and session rotation.
3. Add bounded HTTP request bodies, security headers, and graceful shutdown.
4. Package assets with the CLI on each OS; verify installed layouts and document start commands.
5. Run Rust tests and release builds on the supported platforms.

## Task 2: Shared durable data API and browser shell

**Files:** new web server domain handlers, `web-app/src/services/` browser adapters, app boot and platform selection, generated API types, integration tests.

1. Define typed schemas for threads, messages, projects, settings, providers, models, and errors.
2. Move Tauri command internals needed by these domains into shared core functions. Tauri commands become thin wrappers.
3. Add authenticated domain routes and revisioned event stream.
4. Add browser service adapters. Render the existing desktop route tree with browser-safe window/path/dialog behavior.
5. Verify create/edit/delete and two-tab reconciliation against a built server.

## Task 3: Agent runs, providers, and downloads

**Files:** `src-tauri/src/core/cli/json_api.rs`, shared agent runtime, model runtime adapters, web server handlers, browser adapters, integration tests.

1. Extract the existing JSON-lines agent runner into a transport-independent controller with run, status, approve, cancel, resume, and event methods.
2. Make provider configuration and secret storage available to the headless service through the same data folder.
3. Extract llama.cpp process and local-model inventory operations into a Tauri-free runtime, including download progress and stop.
4. Add authenticated API routes and browser adapters, then test disconnect/reconnect and process restart.

## Task 4: Studio and complete route parity

**Files:** Studio process/runtime modules, server routes, browser adapters, browser UI where a native dialog must be replaced, tests, documentation.

1. Extract stable-diffusion.cpp process control, model import, LoRA selection, and generation state into shared services.
2. Serve generated output through authenticated file routes and bounded uploads.
3. Audit every desktop route for a Tauri-only dependency; add browser implementation or explicit unsupported-state behavior.
4. Exercise Studio, files, settings, agent stop, model download, and chat in production browser end-to-end tests.
5. Run Windows, Linux, and macOS release builds and document private-network deployment and upgrades.

## Completion gate

Do not describe the feature as complete until every acceptance criterion in the spec passes on a production build. Keep partial work on its feature branch until a usable slice is ready for review.
