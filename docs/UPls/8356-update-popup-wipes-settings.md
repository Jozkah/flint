# janhq/jan#8356 — 0.8.2 → 0.8.3 update popup wipes config and settings

- Upstream: https://github.com/janhq/jan/issues/8356
- Kind: issue, open upstream (unconfirmed)
- Priority: P0 as reported (data loss, unwanted download)
- Status in this fork: **not applicable**

## Why

Both triggers in the report are absent from this fork:

- **Update popup.** The fork ships no updater: no `@tauri-apps/plugin-updater`,
  no `plugins.updater` in `tauri.conf.json`, no `src-tauri/src/core/updater`.
  `web-app/src/__tests__/localOnly.test.ts` pins all three ("ships no updater
  plugin", "has no updater module left").
- **Automatic Jan-v3.5 download.** No startup or onboarding path downloads a
  model; a search of production source for the model id and for auto-download
  entry points finds nothing.

The settings-loss half of the report may share a cause with a migration bug
rather than the popup itself, but nothing in the report isolates one, and the
fork's settings persistence is covered separately. Recorded so the item is not
picked up again.
