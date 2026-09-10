# Test isolation and harness defects found in batch 3

Not upstream items; recorded so the checkpoint's test counts can be trusted.

## agent-tools plugin (`1c1df33`)

Six tests failed together under the full suite. Root cause was a production
bug: `jail::probe` cached every outcome under the shell's path, including a
per-attempt timeout or a missing scratch, so one slow first launch made every
shell "unavailable" for the rest of the process. Only verdicts about the shell
are cached now. The tests shared fixed thread ids and one scratch in the host
temp root; they now own per-test sessions (`workspace::TestSession`, removed on
drop) under a per-process base, and the kill test spawns in its own process
group as production does (a console control event from another test binary
ended it first: 4/40 under load before, 0/40 after).

Proof: 739 passed serial x3, parallel x3, shuffled seeds 7/11/1234/4242/90210;
the six isolated x10; no `jan-agent-tests-*` left behind. Other plugin modules
still leak temp dirs (`jan-activity-*`, `jan-policy-*`, ...): filed as a
separate task.

## Main crate (`7add9ef`, `e2bf504`)

- `JAN_HOME` was set under two different locks, so `with_temp_home` users and
  auth `TempSecrets` users swapped each other's home mid-test (2-3 CLI failures
  per run). One reentrant `TEST_ENV_LOCK` now covers every mutator of the
  process environment; the proxy tests take their environment as a parameter.
- MCP lock-file tests shared the mock app's app-data folder with
  `cleanup_own_locks`; each now has its own identifier.
- `is_process_alive` used `tasklist`; under load it reported the running test
  process dead. It now asks the kernel.
- `CI=e2e` served a relative `./data` folder that the settings store resolved
  under the installed app's `%APPDATA%\jan.ai.app\data`, so harness runs wrote
  `store.json` there and skipped the MCP migrations. The data folder is now
  anchored at the working directory.

## Smoke harness

- The fixture port is configurable (`COWORK_SMOKE_PORT`): concurrent harness
  runs from other worktrees on this machine all bound 8080 and re-scripted each
  other's fixture.
- `COWORK_SMOKE_KEEP=<dir>` keeps the profile so a second process is a real
  restart.

## Harness isolation holes (found while running the real-WebView gates)

- **System credential store.** Provider keys go to the OS keyring under
  `jan-providers` / `<provider>`, which is not scoped to a data folder. Every
  earlier harness run read the developer's real entries (anthropic, gemini,
  exa, ...) and wrote a `cowork-smoke-mock` entry with a fake value into the
  real Windows Credential Manager. The harness now calls
  `provider_secrets::use_file_secrets_only()` (compiled only with the
  `cowork-smoke` feature), so keys stay in the isolated data folder's
  encrypted file; a lane run showed zero keyring accesses. The stale
  `cowork-smoke-mock.jan-providers` entry is still in the credential store:
  left for the user to remove.
- **Real app-data `store.json`.** See the data-folder anchoring above:
  `%APPDATA%\jan.ai.app\data\store.json` (`version`, `mcp_version`) was
  written by harness runs, not by the user's Jan.
- **Shared cargo target directory.** Another Claude session on this machine
  (worktree `token-usage-accounting-viz`) builds with `CARGO_TARGET_DIR`
  pointed at this checkout's `src-tauri/target`. Its older agent-tools plugin
  exported a 28-command permission list that ended up in this app's ACL
  (`memory_retrieve`, `memory_record_propose_inferred`,
  `advertised_tool_schemas` denied). Gate builds for this batch use a
  private target directory; unit-test binaries are unaffected (their ACL is
  not exercised). (A `cowork_smoke.exe` seen running from this target and
  first put down to that session was most likely the harness's own
  sandbox-helper clone; see below.)
- **The harness started a copy of itself for every sandboxed shell.** The
  agent-tools plugin runs the current executable as its Windows sandbox
  helper, and the harness `main` did not hand off to
  `run_sandbox_helper_if_requested()` as the app's own `main` does, so each
  Cowork tool call launched a second full harness (WebView, fixture server,
  scenario run). Four were found running at once; they are what wedged the
  WebView in later scenarios. Fixed.

## Stopping a command depended on WMI (agent-tools plugin)

At the checkpoint gate the plugin suite failed again: the five kill tests and
`a_pid_that_does_not_exist_reports_gone`, each with
`Failed("ERROR: This operation returned because the timeout period expired.")`.
The machine's WMI service had stopped answering (`tasklist` and
`Get-CimInstance Win32_Process` both hung; `Get-Process` and `netstat` were
fine). `kill_tree` shelled out to `taskkill /T`, which asks WMI for the process
tree, so no kill could succeed -- not even of a pid that did not exist. For a
user in that state, the Stop button and cancellation could stop nothing.

`kill_tree` now walks the tree from a Toolhelp process snapshot and terminates
each member by handle, with no service involved. Every descendant is opened
before anything is terminated, so a pid recycled mid-kill is never hit, and a
process whose recorded parent pid merely coincides with the root (an orphan of
an earlier owner of that pid) is skipped because it was created before the
root. A second pass catches children started while the first ran. New tests:
the whole tree (`cmd` running `ping`) dies with its root, an exited but
uncollected process reports `Gone`, and the OS error classification (refusal,
no such process, other) is covered without aiming a kill at a protected
process.

Proof, with WMI still hung: the kill tests 33/33 in 0.17 s (previously 5 of
them failed after 246 s of timeouts); the full plugin suite 740 passed at 16
threads.

## Reload-free restart scenarios

The thread-durability and message-deletion scenarios reloaded the page in
place to prove state is read back from disk. In this harness that reload left
the WebView2 page permanently unanswered (with `location.reload()` and with
`location.replace('/')` alike) before the app wrote or read anything, so both
failed without exercising the product. Each is now split at the point where
it reloaded: the first half runs in a fresh profile kept with
`COWORK_SMOKE_KEEP` and leaves a handoff file, and a second process on that
profile does the checks. The torn-tail half first confirms the fragment is
still on disk, so it cannot pass against a file the first process had already
healed. That is also closer to what #8019 is about: a crash, then a new start.

The malformed-tool-call scenario waited for the fixture's plain reply after the
follow-up, but the fixture answers any request whose history carries a tool
result with its summary. The session had in fact answered (one new request,
correct history with `arguments: "{}"`); the scenario now waits for a reply
drawn after the follow-up.
