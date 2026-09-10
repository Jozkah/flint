# janhq/jan#8713 (fixes #8709) — persistent CLI log and a bug-report archive

- Upstream PR: https://github.com/janhq/jan/pull/8713 (draft, by thinhlpg)
- Priority: P0 as classified (a hung run left no trail)
- Status in this fork: **adapted** (`49979d8`), reimplemented with a preview
  step; nothing uploaded

## Review

+1430 lines across the CLI: a dual logger (`file_log.rs`), a shared secret
scrubber (`secrets.rs`), a bundler (`doctor.rs`), `jan bug-report`, `/bug` in
the TUI, and start/done breadcrumbs in the agent loop and upstream stream.

The PR has no network code: no upload, no issue creation, no browser launch.
The archive is written to `<data folder>/diagnostics/` and the path printed.
There was therefore nothing to reject, but the fork's rule is stricter than
"no upload": the user sees what the bundle holds before anything is written.

## What the fork does

- **Log.** `env_logger` becomes a dual logger. stderr is unchanged (`warn`,
  `info` under `-v`, `RUST_LOG`). Every info+ record also goes to
  `<data folder>/logs/jan.log`, rotating at 5 MB with three segments, resyncing
  instead of double-rotating when another `jan` process got there first.
  Credentials are scrubbed at the file sink. The TUI mutes only the stderr sink
  while it owns the terminal (it used to set the `log` facade to `Off`, which
  would have silenced the file too).
- **Bundle.** `jan bug-report [--thread ID] [--show MEMBER] [--yes] [--out DIR]`
  builds the archive in memory and prints each member, its size, what was
  stripped, the destination, and "Nothing is uploaded or sent anywhere."
  `--show` prints one member's redacted text and writes nothing. Saving needs a
  yes at the prompt, or `--yes` when stdin is not a terminal; it never
  overwrites. `/bug`, `/bug show <member>`, `/bug save` do the same in the TUI,
  and `/bug save` writes exactly the previewed bundle.
- **Redaction.** The PR's rules, plus a password-assignment rule; the field
  label is kept so a redacted JSON record still parses; then the agent tools'
  own line-shape scanner (`tauri_plugin_agent_tools::secrets::redact_secrets`)
  as a second pass.
- **Breadcrumbs.** `stream: model=... upstream=...` / `stream: done outcome=
  elapsed=`, `agent: run finished outcome= elapsed=`; errors bounded by
  `log_brief`, URLs cut at `?`.

Not taken: the PR's subagent breadcrumbs and the `log_brief` calls inside
`genai_bridge` (the fork's code there differs; the run-level pair already
brackets a stall).

## Verification

```
cargo test --lib --no-default-features --features cli     1498 passed (x3)
cargo test --no-default-features --features cli --bin jan   14 passed
```

Real `jan.exe`, isolated `JAN_DATA_FOLDER`, a thread seeded with a random
`sk-` key and `DB_PASSWORD = ...`:

- preview (stdin not a terminal): members listed, "Nothing written", no
  `diagnostics/` directory created;
- `--show thread/messages.jsonl`: both values `<redacted>`, still valid JSON;
- `--yes --out DIR`: exactly one `.tar.gz`; no member contains the key or the
  password;
- `--upload`: rejected by the argument parser (there is no such flag).
