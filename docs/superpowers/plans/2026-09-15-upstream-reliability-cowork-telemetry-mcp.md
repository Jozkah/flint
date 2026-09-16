# Flint Upstream Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt selected upstream reliability, Cowork, telemetry, MCP, logging, and desktop-test improvements without regressing Flint behavior or identity.

**Architecture:** Treat upstream commits as behavioral references. Keep Flint stores, access routing, streaming sanitization, Rooms/Cowork lifecycle, and product identifiers; add only missing behavior behind existing interfaces. Every production behavior begins with a focused failing regression test.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, Tauri 2, Rust, NSIS, WebdriverIO.

**Spec:** User request and approved conflict-resolution design in this task.

## Global Constraints

- Work only in `C:\Users\Jozkah\Desktop\Coding\jan` on current `release/flint` branch.
- Preserve Flint branding, versioning, executables, identifiers, custom tool streaming, `function.name` sanitization, filesystem MCP access routing, transcript scrolling, stop behavior, and Rooms/Cowork behavior.
- Exclude Windows ARM64, macOS-only UI work, unrelated TUI-only work, Jan identity, and unnecessary CI-only changes.
- Push only after requested verification passes without errors or warnings.

---

### Task 1: Windows installer and worker reliability

**Files:** `.github/workflows/template-tauri-build-windows-x64*.yml`, `src-tauri/tauri.bundle.windows.nsis.template`, `src-tauri/plugins/tauri-plugin-llamacpp/{Cargo.toml,src/engine/worker.rs}`, Cargo lockfiles, focused tests.

**Interfaces:** Consumes Flint binaries `Flint-Desktop.exe`, `flint.exe`, `flint-llama-worker.exe`; produces workspace-independent NSIS paths, kill-on-close worker ownership, graceful cleanup, locked binary/DLL recovery.

- [ ] Add tests failing on hard-coded runner paths, wrong worker identity, absent locked-file recovery, and absent Windows job confinement.
- [ ] Run tests; confirm expected failures.
- [ ] Substitute neutral workspace placeholder in both Windows workflows.
- [ ] Add Windows job-object confinement with `windows-sys`.
- [ ] Adapt stop/unlock macros to Flint worker, engine DLLs, bun, and uv.
- [ ] Run focused tests and Rust checks.
- [ ] Commit `fix(windows): harden Flint installer updates`.

### Task 2: Cowork correctness and navigation

**Files:** Existing Cowork run/session hooks, route, navigation tabs, model dropdown, transports, focused tests.

**Interfaces:** Consumes Flint per-session run map and persisted model; produces isolated concurrent runs, session-local models, surface restoration.

- [ ] Add failing tests for first-response concurrency, stop isolation, background completion, model switching, and Chat/Cowork/Settings restoration.
- [ ] Reconcile only failing deltas; do not import upstream route rewrites.
- [ ] Run focused suites plus Flint scrolling, stopping, tool, sanitization, and access regressions.
- [ ] Commit `fix(cowork): reconcile session isolation and restoration`.

### Task 3: Artifact, plan, and tool-call UX

**Files:** `CoworkArtifactCard.tsx`, Cowork dispatch/runtime/message/route files only where tests require, corresponding tests.

**Interfaces:** Produces full artifact title access, recoverable plan review, approved execution, one running-tool announcement.

- [ ] Add failing behavior tests for titles, plan approval/recovery, and announcement deduplication.
- [ ] Implement minimal deltas while retaining Flint timing/activity and stop semantics.
- [ ] Run focused suites.
- [ ] Commit `fix(cowork): harden plan and tool activity UX`.

### Task 4: Telemetry and streamed-write performance

**Files:** Shared step metadata, partial-JSON/streaming-argument helpers if useful, custom transport, runner/subagent/turn/run/token hooks, Cowork route/types, focused tests.

**Interfaces:** Produces completion-token TPS over generation duration, refreshed context limits, bounded display previews, stable historical transcript plus live tail.

- [ ] Add failing tests excluding request/prompt time from TPS and preferring provider generation timing.
- [ ] Add failing tests for context growth, bounded incomplete JSON, and stable historical-turn references.
- [ ] Share step metadata without removing Flint attribution, cache telemetry, cutoff, or sanitization.
- [ ] Bound displayed write arguments only; retain complete dispatch/record arguments.
- [ ] Render stable turns separately from frame-batched live tail.
- [ ] Run focused suites.
- [ ] Commit `perf(cowork): bound streamed writes and unify TPS`.

### Task 5: RMCP/OAuth and log rotation

**Files:** `src-tauri/Cargo.toml`, lockfile, RMCP call sites under `src-tauri/src/core`, `src-tauri/src/lib.rs`, focused Rust tests.

**Interfaces:** Consumes Flint fingerprint trust, OAuth scopes/secret store, stale-resource rejection, server activation policy; produces updated discovery/protocol behavior, desktop browser prompt, isolated app-log rotation.

- [ ] Upgrade RMCP; compile to expose API changes.
- [ ] Adapt APIs without replacing Flint OAuth/trust/config policy.
- [ ] Add regressions for discovery, stale configuration, invalid tool names, and log-target filtering.
- [ ] Port desktop prompt behavior; skip unrelated TUI presentation.
- [ ] Run focused Rust suites and checks.
- [ ] Commit `fix(mcp): update discovery and preserve Flint routing`.

### Task 6: Desktop E2E harness

**Files:** Standalone `e2e` project, root script wiring, test-only Tauri hooks only when required.

**Interfaces:** Produces Flint-branded WebdriverIO smoke coverage against built desktop app.

- [ ] Port smallest functional upstream harness.
- [ ] Adapt names, selectors, metadata, and paths to Flint.
- [ ] Omit CI/dependabot-only changes unless validation requires them.
- [ ] Validate E2E TypeScript; run smoke test when runtime is available.
- [ ] Commit `test(e2e): add Flint desktop smoke harness`.

### Task 7: Verification and push

- [ ] Run `yarn workspace @janhq/web-app typecheck`.
- [ ] Run relevant Vitest suites, then broader web suite when feasible.
- [ ] Run `cargo check --release --workspace` from `src-tauri`.
- [ ] Run production web build.
- [ ] Run Windows installer build when feasible.
- [ ] Fix every error and warning; repeat gates until clean.
- [ ] Review diff, Flint identity scan, status, commits.
- [ ] Push current branch only after all required feasible gates pass.
