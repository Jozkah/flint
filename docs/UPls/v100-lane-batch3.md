# Real-provider lane (llm-host:8555) — batch 3

Not an upstream item: the end-to-end gate the batch had to pass, and what it
found. Driven through the real app by `src-tauri/examples/cowork_smoke.rs` in
lane mode:

```bash
COWORK_SMOKE_REAL_BASE_URL=http://llm-host:8555/v1 COWORK_SMOKE_REAL_MODEL=pxa-27b \
  target/debug/examples/cowork-smoke.exe
```

## What the lane does

- Seeds an isolated profile (own data folder, own WebView2 profile, provider
  keys in the data folder's encrypted file, never the OS keyring) with a
  custom provider `llm-host-lane` at the real base URL, a placeholder model, and a
  key made in-process from 32 random bytes. The key is never printed, never
  in process arguments or the environment, and lives only in that profile.
- Resolves names for real through the app's transport and records every name
  it was asked for; nothing is redirected.
- Scenarios, all through the UI:
  1. discovery — the provider page's Refresh lists `pxa-27b` from `/v1/models`;
  2. streaming — the model computes a sum the prompt does not contain, and the
     reply shows its token speed;
  3. Local grouping — the endpoint is listed under the Settings sidebar's
     Local heading once a request has gone through the transport;
  4. memory — a remembered fact is in the request the model receives
     (`audit/prompts.jsonl` carries `# Remembered` and the fact) and the model
     answers from it;
  5. Cowork — tools enabled on the model through its edit dialog, one real
     model -> `ls` -> model loop, provider usage recorded against the dispatch,
     the context window reported;
  6. containment — every file of the profile scanned for the key (allowed only
     in the provider store), every connection the app logged and every name it
     resolved checked: only `llm-host:8555` and loopback, never port 8080.

## Defects it found

- **Local grouping never settled** (`c6eac57`). The sidebar asked the
  resolver about `llm-host` once, before anything had connected, cached the
  `null`, and never asked again; the endpoint sat in neither Local nor Remote
  for the session. It now re-reads the resolver's cache every 3 s while
  unsettled (no network request).
- **Stale ACL from a shared target directory** — see
  `test-isolation-batch3.md`; memory retrieval and tool readiness were denied
  in the built app until the harness was built in its own target directory
  (`11cbc11` also makes the build script watch plugin permission files).
- **OS keyring used by an isolated profile** — `use_file_secrets_only()`.

- **The harness cloned itself on every sandboxed tool call.** The
  agent-tools plugin re-executes the current binary as its Windows sandbox
  helper; the harness never handed off (`run_sandbox_helper_if_requested`),
  so each Cowork tool call started a second full harness with its own
  WebView, fixture server and scenario run. That is what wedged the WebView
  in the Cowork and later scenarios. Fixed in the harness `main`.

## Results (latest harness, isolated target, each set in a fresh process)

| check | result |
|---|---|
| discovery (`/v1/models` via Refresh) | pass |
| streaming a computed nonce, token speed shown | pass (LANE-296, 292 tokens/sec) |
| endpoint under Local once resolved | pass (after `c6eac57`) |
| memory in the request and in the answer | pass |
| key containment | pass: no plaintext copy anywhere in the profile |
| peers | pass: connections `llm-host:8555` only; resolved `llm-host:8555` only; nothing on 8080 |
| Cowork model -> `ls` -> model, provider usage recorded | pass (context-window row present; its value readout was tightened afterwards) |
