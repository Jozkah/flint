# Agent harness verification

How harness work is proven, and the standing record of what has actually been
executed. Owned by `lane-11-cross-platform-verification`.

## What "verified" requires

A registry item reaches `verified` only when all twelve acceptance rules hold:

1. Production implementation.
2. Real call-site wiring -- the code is reached from the agent run path.
3. Success path.
4. Refusal or error path.
5. Cancellation and race behaviour.
6. Persistence across restart, where applicable.
7. Unit tests.
8. Integration tests.
9. Route or UI tests, where applicable.
10. Security or mutation tests, wherever authority is involved.
11. Documentation.
12. Registry status updated.

A type, a button, a config parser or a mock does not satisfy rule 1, and an
unconsumed module does not satisfy rule 2.

## Execution rules

These exist because the failure mode of a long programme is a claim that was
never run.

- **Bounded commands only.** Every command has an explicit timeout. No command
  runs longer than ten minutes without visible progress.
- **Nothing long-running is hidden** behind a pipe or a background task.
- **No repeated retries of a stalled build or download.** A stall is recorded as
  a blocker, not spun on.
- **Platform claims require execution.** macOS, Windows, Linux and WebView
  behaviour is never reported as validated unless it ran on that platform. A
  cross-compile, a type-check or a code reading is not a platform validation.
- **Infrastructure failures are not results.** A GitHub Actions run with
  `runner_id: 0`, an empty runner name and no executed steps is a
  runner-allocation failure. It is ignored, verification continues locally, and
  the fact is recorded here rather than reported as a red build.
- **Blockers are documented, not worked around.** A suite that cannot run is
  recorded below with the reason.

## Command inventory

| Scope | Command | Bounded by |
| --- | --- | --- |
| Feature registry schema and drift | `node scripts/agent-harness/validate-registry.mjs` | seconds |
| Feature registry tests | `node --test "scripts/agent-harness/*.test.mjs"` | seconds |
| Harness crate tests | `cargo test --manifest-path src-tauri/harness/Cargo.toml` | seconds |
| Harness crate lint | `cargo clippy --manifest-path src-tauri/harness/Cargo.toml --all-targets -- -D warnings` | ~1 min cold |
| Tools plugin | `cargo check --manifest-path src-tauri/plugins/tauri-plugin-agent-tools/Cargo.toml --no-default-features` | ~1 min warm |
| App crate, CLI config | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features --features cli --all-targets` | CI |
| App crate, desktop config | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features --features test-tauri --all-targets` | CI |
| JavaScript suites | `yarn test:core`, `yarn test:web`, `yarn test:ext` | CI |

The two app-crate configurations are mutually exclusive feature sets of one
crate, so neither alone proves the other compiles. Both must pass before a phase
that touches `core/agent/` closes.

## Per-phase evidence

### Phase 0 -- Foundation

Executed on Linux (`x86_64`, rustc 1.94.1, Node 22) on the branch
`feat/cowork-background-tasks`, rebased onto `776fa06`.

| Command | Result |
| --- | --- |
| `cargo test --manifest-path src-tauri/harness/Cargo.toml` | 54 passed, 0 failed |
| `cargo clippy --manifest-path src-tauri/harness/Cargo.toml --all-targets -- -D warnings` | clean |
| `node --test "scripts/agent-harness/*.test.mjs"` | 26 passed, 0 failed |
| `node scripts/agent-harness/validate-registry.mjs` | 200 features, schema and drift clean |
| `cargo check --no-default-features` (tools plugin) | clean, 40s cold |

Two defects were found and fixed during this phase:

- Temporary directories in the fixture library collided when two were created in
  the same millisecond, and the create-time cleanup would then delete a live
  sibling's directory. Caught by its own test; fixed with a process-wide counter.
- The first draft of the foundation crate carried a `worktree` module defining a
  `jan/agent/` branch convention, while `core/agent/worktree.rs` on this branch
  already owns `jan/cowork/`. Two conventions would make worktree cleanup unable
  to tell an abandoned agent tree from a developer's own. The module was removed
  rather than reconciled; `AH-012` points at the shipped one.

The audit that produced the initial registry statuses ran against `adfd071`,
which was 282 commits stale. Statuses were re-derived against the current head
before this was committed; the re-audit is recorded with the Phase 0 report.

#### Not run in Phase 0, and why

| Not run | Reason |
| --- | --- |
| App crate `cargo check` in either configuration | Phase 0 adds no code to `src-tauri/src`. The harness crate is a standalone workspace with no dependants yet, so the app crate's build is unchanged. It is checked in CI on every push regardless. |
| JavaScript test suites (`yarn test:*`) | Phase 0 changes no workspace source. The registry tooling is dependency-free Node with its own suite, deliberately so that it runs before `yarn install`. |
| macOS, Windows and WebView validation | Not executed. No Phase 0 code is platform-specific; the first items needing it are the process jail and worktree work in Phases 2 and 5. |
| Golden-repository and security-corpus suites | Not built yet -- `AH-197` and `AH-198` are `missing` in the registry. |

### Phase 1 -- Core execution (in progress)

Executed on Linux (`x86_64`, rustc 1.94.1) on `feat/agent-harness-phase-1`.
Both mutually exclusive configurations of the app crate are run for every
change, because neither proves the other -- and in this phase the desktop
configuration twice caught a mistake the CLI one could not see.

| Command | Result |
| --- | --- |
| `cargo test --no-default-features --features cli --lib` | 1492 passed, 0 failed |
| `cargo test --no-default-features --features cli --bins` | 15 passed, 0 failed |
| `cargo test --no-default-features --features test-tauri --lib` | 802 passed, 0 failed |
| `cargo clippy --no-default-features --features cli --all-targets -- -D warnings` | clean |
| `cargo clippy --no-default-features --features test-tauri --all-targets -- -D warnings` | clean |
| `cargo test --manifest-path src-tauri/harness/Cargo.toml` | 54 passed |
| `jan cli agent runs list` / `runs show` | run against the built binary |

The suite was **1425 passed / 1 failed** when the phase opened. The failure was
pre-existing, confirmed by re-running with the branch's changes stashed:
`agent::global_config`'s tests repoint `HOME` process-wide, and a parallel
`git commit` in the plugin test could then not resolve a committer identity.

#### Defects found by the work itself

Recorded because each was caught by a check rather than by reading:

- The fixture temporary directory collided within a millisecond, and its
  create-time cleanup would delete a live sibling's directory (Phase 0).
- Three mid-run-nudge tests issued thirteen byte-identical tool calls -- which
  is the doom loop the new detector stops. The fixture was unrealistic, not the
  detector.
- A `#[cfg(feature = "cli")]` was displaced from the test below it by an
  insertion. Only the desktop configuration failed, because `[budget]` is
  CLI-only. The same class of mistake -- inserting between an attribute and its
  item -- happened three times in this phase and was caught by a build each
  time, never by review.
- The headless CLI leaked backgrounded shell trees on every exit. The desktop
  app reaps on graceful exit; the CLI had no equivalent, and
  `std::process::exit` runs no destructors.

#### Not run in Phase 1, and why

| Not run | Reason |
| --- | --- |
| JavaScript suites (`yarn test:*`) | No file under `web-app` is touched. The Cowork harness is unaffected because it never reaches `run_orchestration_streamed`. |
| macOS, Windows, WebView | Not executed. Nothing in this phase is platform-specific; the process-group and reaping behaviour is exercised by the plugin's own tests on Linux only. |
| Any CI job | Structurally unavailable -- see below. |

#### CI produced no evidence for this phase

Two independent reasons, both verified against the API rather than assumed:

1. `rust-check.yml` triggers on `pull_request` only for base `main` or `dev`.
   The Phase 1 pull request is stacked on `feat/cowork-background-tasks`, so
   the Rust jobs never trigger for it at all. This resolves when Phase 0 merges
   and the branch is retargeted.
2. The one workflow that does run -- docs, because the registry lives under
   `docs/` -- fails with `runner_id: 0`, an empty runner name, and no executed
   steps, on every head. Per the execution rules above that is an
   infrastructure failure, recorded and not treated as a red build. No re-run
   was spent: the signature is established across many heads and both pull
   requests, so another attempt produces another phantom failure, not evidence.

Local verification is therefore the only evidence for this phase, which is why
it is listed in full above and in each commit message.

### Phases 2-8

Recorded here as each phase closes, in the same shape: commands executed with
their results, then commands not executed with the reason.

## Platform matrix

Filled in as platform-specific work lands. Empty cells mean *not executed*, never
*assumed to pass*.

| Area | Linux | macOS | Windows | WebView |
| --- | --- | --- | --- | --- |
| Harness foundation crate (Phase 0) | passed | not run | not run | n/a |
| Run recording, budgets, loop detection (Phase 1) | passed | not run | not run | n/a |
| Process jail (`bubblewrap` / Seatbelt / AppContainer) | not run | not run | not run | n/a |
| Per-agent worktrees | not run | not run | not run | n/a |
| Desktop agent surfaces | not run | not run | not run | not run |

## Known blockers

| Blocker | Effect | Status |
| --- | --- | --- |
| GitHub runners are never allocated on this fork | No CI evidence for any change | Recorded, not worked around. Verification is local and listed per phase. |
| `rust-check.yml` does not trigger for a pull request based on a feature branch | The Phase 1 pull request gets no Rust checks | Resolves when Phase 0 merges and Phase 1 is retargeted to `main`. Not fixed by widening the filter, which is deliberate. |
| No macOS or Windows machine in this environment | Per-OS behaviour cannot be validated | Recorded. The platform matrix keeps those cells empty rather than assuming them. |
