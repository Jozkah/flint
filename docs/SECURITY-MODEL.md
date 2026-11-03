# Security model: which webviews are trusted

This page says what Flint assumes about its own windows, so a reporter or a contributor can tell whether a renderer-supplied value is a bug. [SECURITY.md](../SECURITY.md) says how to report one.

## The rule

The main renderer is **untrusted for anything that touches paths, secrets, processes or the network**. The Rust side owns those decisions: a command opens its own dialog, derives its own roots, decides whether a destination is trusted, and never takes the user's consent from an argument. A renderer that is compromised (an XSS in rendered model output, a malicious extension, a poisoned dependency) must not gain more than the commands it can call would let any caller do.

The renderer is *trusted* only to show the UI and to pass the user's intent: which model, which thread, which button was pressed. It is the same webview that holds the user's open chats, so what a compromised renderer can reach through the UI itself (read or edit chat contents, send messages as the user) is not a boundary Flint defends.

## What loads where

| Surface | Label or scheme | Gets Tauri commands | What it shows |
| --- | --- | --- | --- |
| Main window | `main` | Yes, the `default` capability (plus `mlx`, and `mobile` on mobile) | The app. |
| Detached chat windows | `chat-window-*` | Yes, the `default` capability | The same app UI for one chat. |
| App log window | `logs-app-window` | Its own small capability | The app log viewer. |
| Local API server log window | `logs-window-local-api-server` | Its own small capability | The server log viewer. |
| System Monitor window | `system-monitor-window` | Its own small capability | Hardware and process figures. |
| Web preview rail | `web-preview-*` child webview | No: no capability names this label | Any http(s) page the user opens. Own browsing data directory; `file:`, app schemes and the dev origin are blocked (see `src-tauri/src/core/web_preview.rs`). |
| HTML artifact and widget previews | `flintpreview:` scheme inside a sandboxed `<iframe>` | No: an iframe in the main webview, with its own CSP | Model-written HTML. Scripts run only when the user allows them, and the iframe sandbox gives it an opaque origin. |

The capability files are in `src-tauri/capabilities/`. A new window or webview label that no capability lists gets no commands; that is the default to keep.

## What a compromised main renderer can do

It can call every command the `default` capability lists. Those commands are written to survive a hostile caller:

- Commands that write or export files open the save dialog themselves. The renderer does not name the destination (`export_redacted_logs`).
- Commands that act on a session's files derive the root from the session, not from an argument (`open_session_path`).
- Agent tool calls pass through the permission gate and, where the platform supports it, the OS sandbox.
- Secrets live in the OS keyring. `get_secret` and the provider-key commands are reachable by the renderer, because the UI has to send the key to the provider; a compromised renderer can therefore read the keys the app can read. Keys are not exposed to the preview webview or to previewed HTML.

It cannot, by design, reach the preview rail's page storage, and a previewed page cannot run Tauri commands, because no capability names the preview's label.

## What is out of scope

- A user who approves a command, a file change or an MCP server approves it. The agent sandbox limits what an approved command can do; it is not a defense against the user.
- Another process running as the same OS user: it can read the app's data folder, and the OS keyring on platforms where the keyring is not per-app.
- A malicious extension the user installs. Extensions run in the main renderer with its privileges.
- The local API server when the user binds it to a non-loopback address. The settings page refuses to start it on `0.0.0.0` without an API key, but the server then trusts whoever holds the key.

## Review checklist for a new command

1. Does it take a path, URL, command line, secret or "the user already agreed" flag from the renderer? If it must, validate it in Rust against a root or allowlist the Rust side owns.
2. Does it write somewhere the user did not just pick? Open the dialog inside the command.
3. Does it start a process or open a socket? Route it through the existing gate and sandbox rather than a new path.
4. Does it return a secret? Return only what the UI needs to show or send, and never log it.
5. Is it listed in a capability for a window that shows untrusted content? It should not be.

A command that fails these is a bug even if no exploit is shown, and reports against it are in scope. The history behind this page is in `docs/UPls/8067-filesystem-command-scope.md`.
