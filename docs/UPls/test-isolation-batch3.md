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
