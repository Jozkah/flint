# Flint 0.9

Flint is a local-first AI application and coding-agent workspace based on
[Jan](https://github.com/menloresearch/jan) by Menlo Research. This first Flint
release consolidates the redesigned application (Graphite Studio), the agent
workspace, multi-model collaboration (Discussion Rooms), first-launch migration
from Jan, and runtime improvements including a llama.cpp engine upgrade.

Flint preserves Jan's Apache-2.0 license, the "software developed by Menlo
Research" acknowledgement, the `jan.ai.app` bundle identifier, and upstream
provenance. See `LICENSE`.

Development base: upstream Jan commit `1c70d7288`
(`feat(llamacpp): upgrade to 0.3.0 … (#8826)`).

---

## Migration from JAN

Flint is designed to sit alongside, and upgrade in place from, an existing Jan
installation.

- **Detection.** On first launch Flint looks for a legacy Jan data folder in the
  standard per-user location. Because Flint keeps the `jan.ai.app` bundle
  identifier and the existing data path, an installed Jan upgrades in place and
  keeps its data.
- **Copy to Flint.** Duplicates the Jan data into Flint's data location, leaving
  the original Jan data untouched.
- **Reuse JAN data.** Points Flint at the existing Jan data in place, without
  copying.
- **Move to Flint.** Relocates the Jan data into Flint's data location.
- **Start fresh.** Skips migration and begins with an empty Flint profile; the
  Jan data is left as-is.
- **Preservation and backups.** The migration paths never delete the source Jan
  data as part of Copy, Reuse, or Start-fresh; Move relocates it. Threads,
  assistants, model settings, and provider configuration carry over.
- **Credentials and keychain.** Provider API keys live in the OS keyring, not in
  plaintext settings; migration preserves the keyring-backed credentials and the
  backend settings store rather than copying secrets into new plaintext files.
- **Legacy compatibility.** Legacy data paths, `JAN_*` environment variables,
  the `jan://` protocol, and `JAN.md` project files all continue to work
  (details under **Compatibility**).
- **Rollback and recovery.** Copy, Reuse, and Start-fresh are non-destructive to
  the original Jan data, so reverting to Jan is possible after migration.
  Corrupt persisted state (for example a damaged mailbox or room state file) is
  quarantined and recovered rather than crashing the app.

Flint retains Jan's license, attribution, acknowledgements, research model
names, and upstream provenance. These are intentionally **preserved**, not
removed.

---

## Removed

- **Stale user-facing "Jan" branding** in the active product presentation
  (app name, window title, wordmark, default assistant, visible strings, locale
  copy) — replaced by Flint. Legal attribution, the `jan.ai.app` identifier,
  `jan://`, `JAN.md`, `JAN_*` fallbacks, and research model names are
  intentionally retained and are **not** removed.
- **Deprecated llama.cpp settings controls** that upstream retired: the
  `defrag_thold` control and the automatic "increase context size" setting were
  removed from the settings UI and migrated out of persisted state; the manual
  "Increase Context Size" action replaces the latter.
- **Legacy `llama.cpp` provider entry** is migrated away in favor of the current
  `llamacpp` local engine (a persisted-state migration clears the stale entry).

---

## Added

### Product identity and interface
- **Flint product identity**: app name, window title, rail wordmark, default
  assistant, packaging (`Flint-Desktop` binary, `Flint` installers), and the
  `flint://` deep-link scheme.
- **Graphite Studio redesign** with a neutral charcoal dark theme and a
  reworked navigation/workspace layout.

### Migration and compatibility infrastructure
- **First-launch JAN migration assistant**: a migration engine (Rust core) and
  six registered Tauri commands supporting the Copy, Reuse, Move, and
  Start-fresh paths against a legacy Jan data folder.
- **`FLINT.md` project files** discovered by the web app, the Rust project-init,
  and the CLI/agent context, with **legacy `JAN.md`** still read as a fallback.
- **`FLINT_*` environment variables** preferred, with **`JAN_*`** honored as a
  fallback.

### Agent sessions and messaging
- **Session-to-session agent messaging**: a backend mailbox for cross-session
  messages between agent sessions.
- **Attributed messages and replies**: delivered rows carry a sender label, and
  replies are addressed back to the originating session.
- **`stop_session`**: a permission-safe stop of a running same-project peer
  session, gated by explicit user approval.
- **Same-project agent discovery and isolation**: sessions discover peers in the
  same project only, and messages are fenced to their project.

### Multi-model Discussion Rooms
- **Discussion Rooms**: a room engine, store, and controller with list/room/
  editor/transcript UI and a typed persistence service.
- **Multiple providers and models in one room**, with moderator and speaking
  policies.
- **Shared transcripts and addressed replies**, room controls, budgets/limits,
  persistence, restart recovery, termination, and synthesis.

### Accounting, attachments, and runtime
- **Token usage and prompt-cache accounting** (AH-211): provider-reported
  prompt-cache counts carried end to end, per request, turn, and session.
- **Vision-disabled attachment handling**: warns before sending images to a
  model without vision capability.
- **llama.cpp b10809 (0.4.0)** bundled engine upgrade.

### Security, tests, and tooling
- New **security protections**: project-scoped message isolation, prompt-
  injection fencing, secret redaction in logs and audit records, and
  corrupt-state quarantine (see **Security**).
- New **tests and diagnostics**: real-app "cowork smoke" journeys, a session
  event log per session, and Discussion Rooms / messaging regression suites.
- **Release tooling**: this changelog, aligned version sources, and a
  pre-commit gate compatible with Git for Windows.

---

## Improved

- **Navigation and workspace experience** redesigned (Graphite Studio),
  including the settings surface and provider workflows.
- **Model and provider workflows**: clearer provider grouping (local vs remote),
  and provider reachability shown as offline only when a real request failed.
- **Local inference / llama.cpp runtime** upgraded to b10809.
- **Streaming, cancellation, and restart behavior** for agent runs and rooms,
  including restart recovery.
- **Tool permissions** model for agent tools.
- **Context and token reporting** (prompt-cache accounting).
- **Persistence and corrupt-state recovery** for mailbox and room state.
- **Installer and packaging** renamed to Flint; Windows build path fixes
  (MAX_PATH / long paths).
- **Documentation and onboarding**: README rewrite and desktop docs.

---

## Fixed

- **Cross-project access**: session messaging is restricted to same-project
  peers; mailbox reads/writes are project-scoped.
- **Message and prompt injection**: message bodies are fenced and scrubbed so
  delivered content cannot be interpreted as instructions.
- **Secrets in logs**: API keys and private-key-shaped strings are redacted from
  audit records and event logs.
- **Duplicated message delivery**: mail is claimed at drain so a message is
  delivered once.
- **Stale sessions and stale stop requests**: `stop_session` guards against
  acting on a run that already ended.
- **Corrupt mailbox / room state**: damaged state files are quarantined and
  recovered instead of crashing.
- **Room persistence and synthesis**: transcript framing, dissent capping, and
  storage-error classification.
- **Provider failures**: provider on a still-resolving single-label LAN endpoint
  (for example `http://host:port/v1`) no longer disappears from the settings
  list while its address is being resolved; the model selector shows configured
  providers' models regardless of whether a keyring key is re-seeded yet.
- **Title-bar and window behavior**: macOS titlebar / hidden-titlebar handling.
- **Attachment handling**: images are blocked (with a warning) for non-vision
  models.
- **Windows path escaping and library loading**: manifest link scoping and build
  path fixes for Windows.
- **Build, packaging, and migration defects**: version sources aligned to
  `0.9.0`; a `noImplicitAny` typecheck error fixed; dependency/lock/migration
  changes applied only when acknowledged.

---

## Security

- **Permission isolation**: agent tools run under an explicit permission model;
  cross-session actions require the same project.
- **Approval requirements**: `stop_session` requires explicit user approval and
  cannot stop sessions outside the current project.
- **Same-project restrictions**: session discovery, messaging, and stopping are
  confined to the current project.
- **Message fencing**: incoming message bodies are fenced and scrubbed against
  prompt injection.
- **Secret redaction**: API keys and private-key material are redacted in logs,
  audit trails, and event logs; provider keys live only in the OS keyring and
  are stripped from persisted settings.
- **Loop and rate limits**: Discussion Rooms enforce budgets and turn/speaking
  limits.
- **Corrupt-state handling**: damaged mailbox and room state files are
  quarantined and recovered rather than trusted.
- **Migration safety**: Copy/Reuse/Start-fresh are non-destructive to source Jan
  data; secrets are not copied into new plaintext files.
- **Signing and artifact integrity**: release artifacts are built and signed by
  the GitHub Actions release matrix, with SHA-256 checksums published alongside
  them (see **Downloads** for current signing status).

---

## Compatibility

- **Operating systems / architectures (targeted by the release matrix):**
  macOS (Apple Silicon, and Intel/universal where the build system supports it),
  Windows x64, and Linux x86_64 (AppImage / `.deb`, and `.rpm`/ARM64 where
  supported).
- **Legacy Jan data** is supported in place (same `jan.ai.app` identifier and
  data path).
- **`JAN_*` environment variables** are still honored (with `FLINT_*` preferred).
- **`jan://`** deep links continue to work alongside `flint://`.
- **`JAN.md`** project files are still discovered (with `FLINT.md` preferred).
- **Retained**: package/crate names, the persisted `jan.ai.app` identifier,
  research model names, and all legal references and attribution.
- **Known unsupported**: cross-compiled installers are not treated as verified
  native builds; unsigned local builds are not production-ready.

---

## Known Limitations

- **Migration assistant UI is pending.** The migration engine (Rust core) and
  its six Tauri commands are complete and tested; the guided first-launch UI is
  not built yet.
- **Flint logo image pending.** `jan-logo.png` still carries the previous
  wordmark; a Flint logo image has not yet been produced. Text branding is Flint
  throughout.
- **Release artifacts are built by CI.** See **Downloads** — at tag time the
  fork's GitHub Actions billing is unavailable and no signing secrets are
  configured on the fork, so signed native installers are not yet attached.

---

## What's Changed

Highlighted merged work (grouped; the full list is in the comparison link
below). Fork pull requests: **#15** Graphite integration, **#14/#13** Cowork
background tasks, **#12** README rewrite, **#11** Atelier integration, plus the
project-memory lane merge.

- `feat(design)`: Graphite Studio redesign and neutral charcoal dark theme
- `feat(migration)`: JAN→Flint first-launch data-migration core and the six
  Tauri commands
- `feat(env)`: prefer `FLINT_*` environment variables with `JAN_*` fallback
- `feat(project-init)`/`feat(agent)`/`feat(cowork)`: write and discover
  `FLINT.md`, keep reading legacy `JAN.md`
- `rebrand(ui|packaging|docs)`: Flint app name, window title, wordmark,
  locales; `Flint-Desktop` binary and `flint://` deep link
- `feat(agent-tools)`: backend mailbox for cross-session messaging
- `feat(messaging)`: `stop_session`, a permission-safe stop of a same-project
  peer
- `feat(rooms)`: Discussion Rooms engine, store, controller, UI, and persistence
- `feat(usage)`: prompt-cache accounting carried end to end (AH-211)
- `feat(chat)`: warn before sending images to a non-vision model
- `chore(llamacpp)`: upgrade bundled llama.cpp engine to b10809 (0.4.0)
- `feat(cowork|agent|harness|memory|mcp|permissions|settings|cli)`: extensive
  agent-workspace, harness, memory, MCP, and settings work (≈74 `feat(cowork)`,
  45 `feat(agent)`, 19 `feat(memory)`, 14 `feat(mcp)` commits, among others)
- `fix(...)`: cross-session isolation, prompt-injection fencing, secret
  redaction, duplicate-delivery, corrupt-state recovery, provider visibility,
  Windows path/build, titlebar, and attachment fixes
- `test(smoke|rooms|messaging)`: real-app smoke journeys and regression suites

## New Contributors

Contributors in this range (by commit count): Jozkah, Joel, Claude (co-author),
thinhlpg, Isabel Wu, Lawyered. First-time-contributor determination requires
GitHub release data and will be finalized at publish time.

## Full Changelog

https://github.com/Jozkah/jan/compare/1c70d7288a5811d72e5cec8bd61f052e40981bca...v0.9.0

## Downloads

Native installers are produced by the GitHub Actions release matrix on their
corresponding operating systems and are **not** attached at the time this
changelog was written.

| Platform | Arch | Artifact | Checksum | Signed / Notarized |
|---|---|---|---|---|
| macOS | arm64 (and Intel/universal where supported) | `.dmg` / app archive | SHA-256 (pending CI) | Pending — requires Apple signing + notarization secrets |
| Windows | x64 | `.exe` / `.msi` | SHA-256 (pending CI) | Pending — requires Windows signing secret |
| Linux | x86_64 | AppImage / `.deb` (`.rpm` where supported) | SHA-256 (pending CI) | Pending — requires signing secret |
| Source | — | Git tag `v0.9.0` archive | SHA-256 (GitHub-generated) | — |

**Signing status:** No signing or notarization secrets are configured on the
fork, and the fork's Actions billing is currently unavailable, so no signed
native artifacts are attached yet. A SHA-256 checksum file and an SBOM will be
published alongside the artifacts when the release matrix runs. Unsigned local
builds are **not** production-ready and must not be described as signed.
