# janhq/jan#8412 — `jan models list` shows `[]` while the app has models

- Upstream: https://github.com/janhq/jan/issues/8412
- Kind: issue, open upstream
- Priority: P1 (the CLI hides the user's models with no explanation)
- Status in this fork: **fixed** (`0e17d54`)

## In this fork

The command is `jan cli models list` (`src-tauri/src/bin/jan.rs`). It loads
provider configs — including the desktop app's provider store — and kept only
entries where `is_cli_reachable` is true, i.e. the provider has a `base_url`.
Models on the desktop's llama.cpp engine have none: the engine runs inside the
app. A user whose models are all local therefore saw `[]`, exactly as reported,
with nothing to say why.

The other half of the report (`jan launch` printing "No models found.
Downloading default model...") has no counterpart here: the fork's CLI has no
such command or automatic download.

## Fix

`providers::model_listing` lists every configured model with a new
`reachable` field. When none can be reached from the CLI, the command says so on
stderr and prints the one line that points the CLI at the app's Local API
Server:

```
jan config set --provider jan --base-url http://localhost:1337/v1 --model <model>
```

The JSON only gains a field.

## Verification

```
cargo test --lib --no-default-features --features cli model_listing   1 passed
cargo check --no-default-features --features cli --bin jan            ok
```
