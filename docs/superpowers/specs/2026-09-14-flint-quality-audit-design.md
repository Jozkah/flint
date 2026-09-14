# Flint Quality Audit Design

## Goal

Verify and fix reported navigation, Rooms, branding, asset, and packaging defects on current `main`, then rebuild release artifacts from verified source.

## Scope

- Keep sidebar navigation content within fixed tiles across viewport and scaling states.
- Ensure Rooms runs terminate within configured hard limits, reject duplicate committed responses, propagate cancellation, and cannot schedule work after completion.
- Keep Rooms transcript independently scrollable during streaming. Auto-follow pauses when users leave the bottom and resumes near the bottom.
- Replace incorrect user-facing Jan product or default-assistant branding with Flint.
- Preserve compatibility identifiers, migration APIs, package namespaces, upstream attribution, historical text, dates, and third-party model names.
- Use one canonical original flint-inspired pixel-art logo and verified derivatives. Do not copy Mojang artwork.
- Verify Windows bundles contain Flint-named executables and investigate Tauri updater bundle metadata warning.

## Architecture

Existing Rooms limits remain authoritative. Engine fixes belong at scheduling, persistence, and state-transition boundaries; UI rendering must not hide engine duplication. Transcript follow state remains local to the scroll container and responds to user scroll position. Branding changes use semantic classification: visible product copy changes, compatibility surfaces remain stable. Asset generation uses existing repository scripts/configuration where available.

## Method

For each reported symptom: reproduce against current `main`, trace root cause, compare existing working patterns, add a regression test that fails for the expected reason, apply minimum production change, rerun focused tests. Already-fixed symptoms receive verification evidence rather than redundant edits.

## Verification

- Focused Rooms engine, controller, transcript-scroll, shell-navigation, migration, branding, and resource tests.
- Full `yarn test` and `yarn typecheck`.
- Production web build.
- `make build JAN_ENGINE_VARIANT=cpu JAN_ENGINE_JOBS=4`.
- Inspect NSIS/MSI names, bundled sidecars, hashes, Git commit/tag provenance, and draft release metadata.

## Release Safety

Do not publish the draft release. Replace draft assets only after source commit, clean content diff, passing verification, successful packaging, and matching `main`/tag provenance. Report unsigned binaries and unresolved updater/signing warnings explicitly.
