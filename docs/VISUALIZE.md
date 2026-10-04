# Visual widgets

The assistant can draw an interactive HTML/SVG widget inline in a conversation
(a diagram, a UI mockup, a chart, a small calculator) with two tools. Code:
`web-app/src/lib/visualize/`, cards in `web-app/src/containers/message/Widget*.tsx`.

## Tools

| Tool | Arguments | Result the model sees |
| --- | --- | --- |
| `visualize_read_me` | `modules`: any of `diagram`, `mockup`, `chart`, `interactive`, `art` | The design guide (core plus the requested modules) |
| `show_widget` | `title`, `widget_code` (HTML fragment), `loading_messages` (0 to 4 short lines) | `Widget rendered: <title>, N chars.` |

Both are renderer-side tools. They are offered in plain chat, in Cowork and in
Rooms (the card is drawn in the Rooms transcript) when Settings > Agent tools >
Behaviour > Visual widgets is on (default on), whether or not the agent tools
are on.

The guide must be read once per conversation. If the model forgets,
`show_widget` still draws, and its short result reminds the model to read it.
The guide teaches the injected CSS variables, flat design, SVG with a
`viewBox`, responsive width, no network, vanilla JS, accessibility, and when not
to use a widget.

The model's `widget_code` stays in the stored message, so the card redraws it
identically after a reload. Requests sent to the model replace the code of
widgets older than the newest two user turns with a one-line note
(`truncateStaleWidgetCode`); the stored message is not changed.

## Threat model

The widget's code is written by the model, possibly steered by untrusted text
the model read. Treat it as hostile code that the user did not review.

- **Isolation.** The widget runs in an iframe with `sandbox="allow-scripts"` and
  never `allow-same-origin`: an opaque origin, so it cannot read the app's DOM,
  `localStorage`, cookies or Tauri IPC. No popups, forms, downloads or top
  navigation (the sandbox gives none).
- **Document source.** In the desktop app the constant shell document is served
  from the `flintpreview:` scheme (own response CSP; an `about:srcdoc` frame
  would inherit the app CSP and its inline scripts would not run, see
  `core/preview.rs`). Web builds use `srcdoc`. The shell carries the same policy
  as a `<meta>` tag before any other content; the browser applies both and the
  narrower wins.
- **CSP.** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none';
  form-action 'none'; base-uri 'none'`. With the optional setting "Let widgets
  load libraries from cdnjs and jsdelivr" (default off) `script-src` gains
  `https://cdnjs.cloudflare.com` and `https://cdn.jsdelivr.net` and nothing else
  (the desktop registers the shell with network allowed so the response header
  does not block them; the meta policy still limits scripts to those two hosts
  and keeps `connect-src 'none'`).
- **Bridge.** `window.flint.sendPrompt(text)` and `flint.openLink(url)` post a
  message to the app. The app, not the widget, decides: the message must come
  from that card's own frame (`event.source`), the page must have transient user
  activation (a real click or key press inside the frame gives the parent window
  activation; a script cannot fake it), a prompt is at most 2000 characters, one
  per 4 seconds and 6 per mounted widget, and it is sent as the user's next
  message only when no reply is running. A link must be http(s) without
  credentials and waits for an explicit Open in an inline confirm. Anchor
  clicks inside a widget are routed through the same link path. Nothing else
  reaches the app.
- **Errors.** A script error or a blocked request is shown as a banner. The model
  hears about it only if the user presses "Ask Flint to fix", which sends a
  canned prompt as a user message.
- **Limits.** `widget_code` at most 200,000 characters (refused with an error the
  model can act on); at most 4 widgets per conversation per two minutes; at most
  4 loading messages; an inline widget grows to the configured height
  (default 640 px, 240 to 1600) then scrolls; off-screen widgets are unmounted
  after a pause and show a placeholder with Re-run.
- **Streaming.** While arguments stream (chat and Cowork), only complete markup is
  painted (at most every 300 ms) as inert HTML. Scripts run once, when the call
  is complete.
- **Freeze watchdog.** The shell sends a heartbeat. A frame silent for 10 seconds
  (a script stuck in a loop) is replaced by a "Widget stopped responding"
  placeholder with Re-run.
- **Document-level tags.** `<html>`, `<head>`, `<body>`, `<meta>`, `<base>` and
  `<link>` are stripped from the fragment (a meta refresh would navigate the frame).

### Known limits

- A widget can still navigate its own frame (`location = ...`): CSP has no
  reliable navigation directive and a sandboxed frame may navigate itself. It
  could leak to an attacker URL only what the widget itself holds (what the model
  wrote or the user typed into it). Blocking it needs a frame-navigation hook in
  the Rust shell (not done).
- The widget cannot be proven to be benign: it can show misleading UI. It cannot
  act for the user except through a user-gesture `sendPrompt`, which lands as a
  visible message the user can see and stop.
- CPU: a widget can spin a script loop. It is confined to its frame's renderer;
  the freeze watchdog removes the frame after 10 seconds but cannot stop the
  loop sooner.

## Settings

Settings > Agent tools > Behaviour > Visual widgets: on/off, CDN libraries
(default off), maximum height.
