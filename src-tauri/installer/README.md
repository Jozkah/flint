# Installer look

Flint's installers follow the app rather than the stock platform wizard where
the packaging format allows it. Colours, Inter, spacing, switches and button
surfaces come from the same design tokens used by the app.

![Windows installer and uninstaller, light and dark](preview.png)

| Target | What is styled | Where |
| --- | --- | --- |
| Windows NSIS | Full interactive wizard: welcome, installation options, existing-install maintenance, progress, completion, uninstall confirmation/progress/completion. Follows Windows light/dark app mode and scales to 100/125/150/200% DPI. | `windows/flint-ui.nsh`, wired through `../tauri.bundle.windows.nsis.template` |
| Windows MSI | WiX banner and welcome/finish backdrop. WiX draws the remaining native controls. | `wix/`, set in `../tauri.windows.conf.json` |
| macOS DMG | Finder backdrop and icon positions. | `dmg/`, set in `../tauri.macos.conf.json` |
| Linux | AppImage, deb and Flatpak have no installer wizard UI. | |

## Windows NSIS

The window keeps the native Windows title bar but the content is Flint-owned.
The title-bar icon and the large brand mark are loaded from the installer's own
resource 103, which is built from `src-tauri/icons/icon.ico`; there is no
separate or approximated installer logo.

The checked-in `tauri.bundle.windows.nsis.base.template` is the maintainable
Tauri-derived install logic. `scripts/prepare-windows-installer.mjs` applies a
small set of guarded transformations before a Windows bundle is produced:
stock welcome/directory/finish pages become Flint pages, maintenance is skinned,
interactive installs are no longer forced passive, and the matching uninstall
completion page is inserted. Each transformation must match exactly once, so an
upstream template change fails loudly instead of silently falling back to a
half-styled installer.

Release workflows currently substitute version/product/workspace placeholders
in `tauri.bundle.windows.nsis.template` before `make build`. The preparation
script deliberately preserves those substitutions when regenerating the custom
page flow.

Primary and secondary controls are drawn at runtime from Flint's tokens and use
the bundled Inter font, so their labels stay sharp at every DPI. The switch and
destructive-uninstall artwork remains pre-rendered because native Win32 controls
cannot reproduce those shapes reliably.

After changing the relevant app tokens, regenerate the committed artwork:

```sh
pip install pillow
python3 src-tauri/installer/generate.py
```

The normal Windows Tauri build runs the template preparation automatically via
`beforeBuildCommand`. `node --test scripts/*.test.mjs` also checks the wiring,
page transformation, real-icon usage and every required theme/DPI asset.
