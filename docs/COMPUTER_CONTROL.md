# Keyboard and mouse control

The `computer` agent tool operates the desktop host. A remote mobile request
controls the computer running Flint, rather than the phone. It is available to
Chat and Cowork through the shared tool registry; Plan/Review mode withholds it.
Every input and capture call uses the existing host-tool approval flow, with the
call's own approval card. An explicit agent.toml permission rule still applies.

The tool supports:

- `screenshot`: capture the primary desktop display (the entire X11 root on Linux).
- `move`: move the pointer to `x`, `y`.
- `click`: click `x`, `y` with `left`, `right` or `middle`; `count: 2` double-clicks.
- `type`: click the field at `x`, `y`, then insert literal Unicode `text`.
  `replace: true` selects all in that field before inserting.
- `key`: click a neutral focusable point at `x`, `y`, then send `keys`, for example
  `["ctrl", "a"]` or `["enter"]`. `meta` means Command on macOS and the Windows/Super key elsewhere.
- `scroll`: click a neutral focusable point at `x`, `y`, then send `amount` wheel
  steps. Positive is down, negative is up, bounded to 20 steps per call.

Typing, shortcuts and scrolling restore focus to the target after the approval
UI brings Flint forward. Clicking a target is part of the action and appears in
its approval description. Text is passed as data, never as executable script.
Calls are serialized to prevent simultaneous pointer/keyboard operations. On
Wayland, typing pastes through wl-copy and replaces the clipboard with the typed
text; the approval description says so. Set the ydotool virtual pointer to flat
acceleration for accurate coordinates and account for compositor display scaling.

Capture the screen, identify a target, act, then capture again to check the
result. Screenshots return image content to vision-capable models. A text-only
model can accept coordinates from the user but cannot inspect the screenshot.
No automatic action can identify an input reliably from a description alone.

## Platform requirements

| Platform | Input | Capture | Requirements |
| --- | --- | --- | --- |
| Windows | user32 SendInput / SetCursorPos | System.Drawing | Built-in Windows PowerShell. Elevated apps and the secure desktop can refuse input. |
| macOS | CoreGraphics | screencapture | Allow Flint in Accessibility for input and Screen Recording for screenshots. Screenshot results report the conversion from image pixels to logical screen coordinates. Shortcut letter key codes use US keyboard positions. |
| Linux X11 | xdotool | ImageMagick import | Install `xdotool` and ImageMagick; a graphical DISPLAY must be available. On Arch: `sudo pacman -S xdotool imagemagick`. |
| Linux Wayland | ydotool 1.x | XDG desktop screenshot portal | Install and configure ydotoold with uinput access and an accessible YDOTOOL_SOCKET; install wl-clipboard for Unicode text paste, plus xdg-desktop-portal and the backend for the compositor. Flint starts no privileged daemon. |

Windows and macOS screenshots cover the primary display; Linux covers the X11
root. Dragging, held input, selecting secondary displays and window discovery
are not exposed in this first implementation. A cancelled or failed input may
have sent a partial action; inspect the screen before retrying.

## Validation

Rust tests cover argument bounds, key validation, literal argument passing,
replacement ordering, scroll direction and host approval classification. The
frontend host-tool tests cover call-card correlation and approval requirements.
Run these on a development machine with the Rust and web dependencies installed,
then verify capture → click → type/replace → shortcut → scroll → capture against
a disposable editor on each supported desktop platform.
