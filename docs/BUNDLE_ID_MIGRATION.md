# Bundle identifier and URL scheme: migration plan

Status: plan only. Nothing here is implemented, and the identifier is unchanged on purpose until a release is ready to carry the migration below.

## Where things stand

| What | Value | Where |
|---|---|---|
| Bundle identifier (desktop, Android) | `jan.ai.app` | `src-tauri/tauri.conf.json`, `tauri.android.conf.json`, `core/app/constants.rs::TAURI_BUNDLE_IDENTIFIER` |
| Bundle identifier (iOS) | `jan.ai.app.ios` | `src-tauri/tauri.ios.conf.json` |
| Deep-link schemes | `flint`, `jan` | `tauri.conf.json` `plugins.deep-link.desktop.schemes` |
| Canonical app support folder | `<data_dir>/Jan` (from the crate name `Jan`) | `core/app/commands.rs::resolve_human_readable_app_data_dir`, `default_cli_data_folder` |
| Legacy app support folder | `<data_dir>/jan.ai.app` (from the identifier) | `resolve_bundle_app_data_dir`, recovered by `migrate_legacy_app_configuration` |
| Asset protocol scope | `$APPDATA/jan.ai.app/**`, `$APPDATA/Flint/**`, `$APPDATA/Jan/**` | `tauri.conf.json` |

Why it was kept: Flint is a fork of Jan, and keeping the identifier lets an existing Jan install upgrade in place (same app support folder, same settings, same data folder, same macOS keychain entries and Windows registry keys). The cost (RTE-019): if the official Jan app is installed on the same machine, both apps share the macOS bundle id, the Windows AppUserModelID and uninstall key, and the `jan://` handler, so links meant for Jan can open Flint, and an installer of one can treat the other as an older version of itself.

## What changes with a new identifier

Tauri derives these from the identifier, so each moves when it changes:

1. `app_data_dir`, `app_config_dir`, `app_cache_dir`, `app_log_dir` (`<data_dir>/<identifier>`), including the WebView2 / WKWebView profile, so localStorage and IndexedDB (zustand stores persisted in the webview) start empty.
2. macOS: bundle id, keychain service names, `~/Library/Preferences/<id>.plist`, notification permission, TCC grants (screen recording, accessibility, files and folders). Grants are per bundle id and must be granted again.
3. Windows: AppUserModelID (taskbar pinning, toast notifications), NSIS/MSI upgrade code and uninstall key. A new identifier installs side by side with the old one instead of upgrading it.
4. Linux: desktop file name and the `.deb`/`.rpm` package identity.
5. Android and iOS: a new identifier is a new app in the stores and on the device; there is no in-place upgrade.
6. Updater: the update feed must be served to both identities for one release.

Not affected: the user's data folder (`<data_dir>/Jan/data` by default, or wherever the user moved it), because it is resolved from `settings.json`, not from the identifier.

## Proposed sequence

Release N (preparation, identifier unchanged):

- Add an explicit list of "previous identifiers" (`jan.ai.app`) next to `TAURI_BUNDLE_IDENTIFIER`.
- Move webview-persisted state that matters (settings stores that are not already backed by Rust) behind the settings backup (`settings_backup_save`) so it can be carried across a profile change.
- Make the `jan` deep-link scheme opt-in: register only `flint` by default and add a setting that registers `jan` for users who rely on old links. Log a deprecation notice when a `jan://` link arrives.

Release N+1 (switch):

- Change the identifier to a Flint-owned value (for example `app.flint.desktop`, and `app.flint.desktop.ios` on iOS) in all three `tauri*.conf.json` files and the constant.
- On first start, when the new app support folder has no `settings.json` and a previous identifier's folder has one, run a one-shot migration: copy `settings.json` (which carries the data folder path), import the settings backup taken by release N, and write a marker so it never runs twice. Copy, never move, so the old install keeps working until it is removed.
- Keep `$APPDATA/jan.ai.app/**` and `$APPDATA/Jan/**` in the asset scope for that release so attachments referenced by old threads still load.
- Windows installer: detect the old uninstall key and offer to remove the old install after the migration succeeded.
- macOS: show a one-time notice listing the permissions that must be granted again.
- Mobile: ship as a new app; the phone app (PWA) is unaffected because it is served by the desktop.

Release N+2 (cleanup):

- Drop the legacy asset scope entries and the `jan` scheme, unless the opt-in setting is on.

## Tests to add with the switch

- Migration copies `settings.json` from the previous identifier folder only when the new one has none, and only once.
- The data folder path resolved after migration equals the one before.
- A `jan://` link is ignored unless the opt-in setting is on.
- The asset scope still serves an attachment stored under the legacy folder.

## Open questions for the switch

- The new identifier string (reverse-DNS the project controls).
- Whether the crate name `Jan`, which fixes the `<data_dir>/Jan` folder name, is renamed in the same release (it moves the canonical folder too, so it needs the same copy-on-first-start step).
