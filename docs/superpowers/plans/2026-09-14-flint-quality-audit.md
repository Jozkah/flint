# Flint Quality Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce, fix, and verify Flint navigation, Rooms, branding, asset, and packaging defects.

**Architecture:** Preserve existing Rooms hard-limit architecture, fixing only proven scheduling or persistence gaps. Keep transcript follow-state local to its scroll container. Classify Jan references before changing user-facing branding; retain compatibility and historical names.

**Tech Stack:** React 19, TypeScript, Vitest, Tailwind CSS, Zustand, Tauri 2, Rust, Make.

**Spec:** `docs/superpowers/specs/2026-09-14-flint-quality-audit-design.md`

## Global Constraints

- Work on explicitly approved `main`.
- Add failing behavioral tests before production fixes.
- Never rename compatibility APIs, package namespaces, data directories, upstream attribution, dates, or third-party model identifiers.
- Do not publish draft release.

---

### Task 1: Rooms termination and deduplication

**Files:** `web-app/src/lib/rooms/engine.ts`, `limits.ts`, `repetition.ts`, related tests.

- [ ] Trace scheduling, completion, persistence, and cancellation paths.
- [ ] Run existing Rooms tests and reproduce reported prompt behavior structurally.
- [ ] Add focused failing tests for any uncovered loop, duplicate, or post-completion path.
- [ ] Apply minimum fix and rerun focused tests.
- [ ] Commit verified changes.

### Task 2: Rooms transcript scrolling

**Files:** `web-app/src/containers/rooms/RoomTranscript.tsx`, Rooms route layout, `RoomTranscriptScroll.test.tsx`.

- [ ] Compare container sizing and follow behavior with working transcript routes.
- [ ] Add failing test for any remaining forced-follow or overflow defect.
- [ ] Apply minimum fix and rerun focused tests.
- [ ] Commit verified changes.

### Task 3: Navigation containment

**Files:** `web-app/src/components/shell/AppRail.tsx`, `AppRail.test.tsx`.

- [ ] Inspect fixed-tile box model and responsive states.
- [ ] Add failing containment test if current contract is incomplete.
- [ ] Apply minimum fix and rerun focused tests.
- [ ] Commit verified changes.

### Task 4: Branding and logo audit

**Files:** user-facing web copy, migration code/tests, asset manifests, Tauri bundle configuration.

- [ ] Classify remaining Jan matches as product copy, compatibility, attribution/history, date, or third-party name.
- [ ] Add failing tests for confirmed visible stale branding or asset references.
- [ ] Replace only incorrect product branding and verify canonical Flint asset derivatives.
- [ ] Commit verified changes.

### Task 5: Packaging and updater warning

**Files:** Tauri configuration/build scripts and focused build tests.

- [ ] Trace `__TAURI_BUNDLE_TYPE` warning against installed Tauri versions and configuration.
- [ ] Fix only if repository-controlled and testable; otherwise document upstream/toolchain blocker.
- [ ] Run `yarn typecheck`, `yarn test`, `yarn build:web`, and `make build JAN_ENGINE_VARIANT=cpu JAN_ENGINE_JOBS=4`.
- [ ] Inspect bundle names, sidecars, hashes, commit/tag provenance.
- [ ] Push verified commits to `main`; replace draft assets only if binaries changed.
