# Installer look

The installers are styled after the app: its colours, Inter type, padding,
buttons and switch (`web-app/src/index.css`, `components/ui/button.tsx`,
`components/ui/switch.tsx`).

![Windows installer and uninstaller, light and dark](preview.png)

| Target | What is styled | Where |
| --- | --- | --- |
| Windows NSIS | The one-click progress window, the uninstaller's confirm and progress pages, and the failure state. Follows the Windows light/dark app mode and scales to the monitor DPI (100/125/150/200%). | `windows/flint-ui.nsh`, included by `../tauri.bundle.windows.nsis.template` |
| Windows MSI | The WiX banner and welcome/finish backdrop. WiX draws the rest itself. | `wix/`, set in `../tauri.windows.conf.json` |
| macOS DMG | The Finder window backdrop and icon positions. | `dmg/`, set in `../tauri.macos.conf.json` |
| Linux | Nothing: AppImage, deb and Flatpak have no installer UI. | |

Win32 cannot draw the app's rounded buttons or switch, so those, the WiX
images and the DMG backdrop are rendered by `generate.py` from the app's
tokens and committed. After changing a token, update it in `generate.py`
(and the colour defines at the top of `windows/flint-ui.nsh`), then run:

```sh
pip install pillow && python3 src-tauri/installer/generate.py
```

The Windows UI hides the MUI header and buttons, so it only works with the
pages it draws. The installer always runs passive (see `.onInit` in the
template); showing the other wizard pages again would need them restyled too.
