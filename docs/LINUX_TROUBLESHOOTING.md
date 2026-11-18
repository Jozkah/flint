# Linux troubleshooting: slow or laggy UI

Flint's window is WebKitGTK. On Linux it starts with two WebKit switches set,
because without them some machines show a blank or grey window or freeze after
minimize/restore:

| Variable | Flint's default | Why |
| --- | --- | --- |
| `WEBKIT_DISABLE_DMABUF_RENDERER` | `1` | Blank window or Wayland "Error 71" on some NVIDIA setups; freezes on some KDE/AMD/Intel setups. |
| `WEBKIT_DISABLE_COMPOSITING_MODE` | `1` | Flat grey window or stalls on Wayland, NVIDIA especially. |

Any value you set yourself wins; Flint only fills in a variable you left unset.

The second default has a cost: with compositing off, WebKit paints every layer
on the CPU. On a machine whose GPU stack works that can make typing, scrolling
and large repaints feel slow. This has not been measured on every setup, so
treat it as a first thing to try rather than a known cause.

## Try this first: turn hardware compositing back on

```sh
FLINT_WEBKIT_COMPOSITING=hardware flint
```

`FLINT_WEBKIT_COMPOSITING=hardware` stops Flint setting
`WEBKIT_DISABLE_COMPOSITING_MODE`, so WebKit composes on the GPU. Any other
value (or none) keeps the default above. To make it permanent, export it in your
shell profile or add `Environment=FLINT_WEBKIT_COMPOSITING=hardware` to the
desktop entry's launcher.

If the window then goes blank or grey, go back to the default, or try the
DMABUF switch as well:

```sh
FLINT_WEBKIT_COMPOSITING=hardware WEBKIT_DISABLE_DMABUF_RENDERER=0 flint
```

Setting `WEBKIT_DISABLE_COMPOSITING_MODE=0` or `=1` yourself overrides
Flint in either direction.

## What to send when reporting lag

- Distribution and version (for example Nobara 43, Fedora 43), and the desktop
  (KDE Plasma or GNOME).
- Session type: `echo $XDG_SESSION_TYPE` (`wayland` or `x11`).
- GPU and driver: `lspci -k | grep -A3 -E "VGA|3D"`, and for NVIDIA
  `nvidia-smi` (driver version; the open or proprietary module).
- Display: resolution and scale factor (HiDPI multiplies the CPU painting cost).
- `env | grep -E "WEBKIT|GDK|GTK|LIBGL|__GL|MESA"` from the shell that
  starts Flint.
- How it is installed (AppImage, deb, rpm, Flatpak) and the WebKitGTK version
  (`rpm -q webkit2gtk4.1` or `dpkg -l | grep webkit2gtk`).
- The result of each of these runs, one at a time:
  1. `flint` (default)
  2. `FLINT_WEBKIT_COMPOSITING=hardware flint`
  3. `FLINT_WEBKIT_COMPOSITING=hardware WEBKIT_DISABLE_DMABUF_RENDERER=0 flint`
  4. `GDK_BACKEND=x11 flint` (on a Wayland session; runs through XWayland)
- Whether it lags with an empty chat, or only in a long conversation. If only a
  long one, say how many messages; that points at the page, not the renderer.
- Whether the lag is in the message box only, or also when scrolling and
  opening menus. Menus and scrolling that lag too point at rendering; lag only
  while typing points at the page.
- CPU use of the `flint` and `WebKitWebProcess` processes while typing
  (`top`).
