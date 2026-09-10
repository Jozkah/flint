# janhq/jan#8812 — installing Jan Desktop silently overwrites a standalone agent CLI

- Upstream: https://github.com/janhq/jan/issues/8812
- Kind: issue, open upstream
- Priority: P0 (destructive, silent downgrade of another tool)
- Status in this fork: **fixed** (`6e67724`); Unix runtime verification pending

## Applies to us

Yes, on both platforms, in different forms.

- **Unix.** `setup_jan_cli` (`src-tauri/src/core/setup.rs`) skipped its
  `which jan` guard whenever the app version changed, and
  `install_jan_cli_sync` copied the bundled build over `~/.local/bin/jan` with
  no check of what was there — the same path `scripts/install-jan-agent.sh`
  installs to.
- **Windows.** No file is overwritten (the desktop CLI stays in its resource
  directory), but `add_to_path_windows` pruned `%LOCALAPPDATA%\Programs\Jan` as a
  "stale" PATH entry — exactly where `scripts/install-jan-agent.ps1` installs —
  and prepended its own directory, displacing the standalone CLI just as
  silently.

## Fix

`src-tauri/src/core/system/cli_provenance.rs` decides what the automatic,
on-launch install may do:

- A desktop-installed CLI is recognised by a marker file (`.jan-desktop-cli`)
  written beside it, or by being byte-identical to the bundled build.
- Anything else at the install target, or any other `jan` earlier on PATH, is
  left alone and logged.
- Ours is refreshed on version change, and reinstalled when nothing on PATH
  reaches it (a fresh Windows install whose PATH entry was never written).
- The Windows PATH rewrite no longer prunes an entry that still holds a CLI.

The settings button (`install_jan_cli`) still replaces unconditionally — there
the user asked for it — and records the marker.

## Trade-off

A desktop-installed CLI from before this change that differs from the new
bundle has no marker, so it is treated as foreign and no longer auto-updated.
Refusing to guess is the safe side of that line; the settings button
re-establishes ownership.

## Verification

- 12 unit tests in `cli_provenance.rs` (ownership, decision, PATH parsing);
  full Rust lib suite 807 passed.
- The Unix copy path does not compile into this Windows build and has **not**
  been executed. Runtime verification needs a Linux or macOS host.
