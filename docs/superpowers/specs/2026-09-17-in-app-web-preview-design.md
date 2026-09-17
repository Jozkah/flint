# In-App Web Preview — Design

Date: 2026-09-17
Status: Approved (design review delegated to and approved by Fable)

## Goal

Let any external link clicked inside the app open in an in-app web preview
instead of the system browser. The preview can sit docked in a side rail or
float as a picture-in-picture (PIP) overlay, and can be popped out into its own
OS window. This mirrors the browser pane offered by Claude Code / Codex.

## Scope

- **In this round (A + C):**
  - iframe-based preview rendered in a side rail or a floating PIP.
  - Pop-out into a native Tauri `WebviewWindow`.
  - App-wide link interception with a settings toggle.
- **Deferred (B):** a native webview embedded *inside* the main window (Tauri
  `unstable` multiwebview). The host API is designed so B can later replace the
  iframe surface without touching the store, interception, or toolbar.

## Decisions (from product owner)

1. Phase the work: A + C now, B later.
2. App-wide — any external link anywhere, not tied to Cowork.
3. Intercept all in-app external link clicks by default (with an off switch).
4. Default surface is the side rail; PIP is available on demand.

## Approach

Chosen: a single global store drives one host component that renders either the
side surface or the PIP surface, both showing a sandboxed iframe. Pop-out uses a
stable `WebviewWindow`.

Rejected alternatives:

- Extending the Cowork Inspector to be app-global — entangles Cowork's
  route-specific docked/drawer/full layout with an app-wide concern.
- Pop-out-only (every preview is a `WebviewWindow`) — stable and unblocked by
  X-Frame-Options, but provides no in-app side/PIP, failing the requirement. It
  survives only as the fallback tier (the pop-out button) inside the chosen
  approach.

## Components

### `web-app/src/hooks/useWebPreview.ts` (new)

A zustand store, global (not persisted beyond the interception setting, which
lives in its own settings store — see below).

State:

- `open: boolean`
- `url: string` — the currently shown URL.
- `surface: 'side' | 'pip'` — default `'side'`.
- `history: string[]` and `historyIndex: number` — for back/forward.

Actions:

- `openUrl(url: string)` — validates http(s); sets `open`, pushes history,
  keeps the current `surface`.
- `close()`
- `setSurface(surface)` — toggles between side and PIP without reloading.
- `navigate(url)` — user-typed URL bar entry; validated, pushes history.
- `back()` / `forward()` — move through `history` via `historyIndex`;
  `canGoBack` / `canGoForward` are derived selectors.

The store holds no DOM refs. Surface geometry (PIP position/size, rail width)
lives in the surface components.

### `web-app/src/lib/webPreview.ts` (new)

Pure helpers, fully unit-testable:

- `isPreviewableUrl(raw): boolean` — true only for `http:`/`https:`.
- `shouldIntercept(event, anchor): boolean` — true when the anchor is an
  external http(s) link, the target is not an in-app router route, and no
  force-external modifier (Ctrl/Cmd/Shift or `target="_blank"` with an
  explicit external intent) is pressed. Returns false otherwise so the normal
  handler runs.
- `clampPipRect(rect, viewport): Rect` — keeps the PIP inside the viewport.

### `web-app/src/containers/WebPreviewHost.tsx` (new)

Mounted once at the app root (`__root`). Reads the store; renders nothing when
closed. When open, renders the side surface or the PIP surface per
`surface`. Owns the shared **toolbar**:

- URL bar (editable; Enter → `navigate`).
- Back / Forward (disabled per derived selectors).
- Reload (re-key the iframe).
- Open externally (`serviceHub.opener().openUrl`).
- Pop out (`WebviewWindow`, see below).
- Dock ↔ PIP toggle (`setSurface`).
- Close.

Render surface: `<iframe src={url} sandbox="allow-scripts allow-same-origin
allow-forms allow-popups">` with a network/allow posture consistent with the
existing `CoworkPreviewPanel`. A persistent, dismissible banner offers
"This site may block embedding — open externally / pop out", because a
cross-origin `X-Frame-Options` / CSP `frame-ancestors` block cannot be reliably
detected from the parent frame; the escape hatch is therefore always present.

Side surface reuses `CoworkSidePanel` in standalone mode (it already supports
self-owned width, resize handle, expand, and close outside the Cowork inspector
context).

### `web-app/src/containers/WebPreviewPip.tsx` (new)

A `position: fixed` floating card above app chrome. A drag handle moves it; a
resize corner sizes it; both clamp to the viewport via `clampPipRect`. Holds the
same toolbar and iframe. Remembers its last position/size in component state for
the session.

### Pop-out (C)

A serviceHub wrapper creates a Tauri `WebviewWindow` at the URL with
`incognito: true` so the popped-out browser has an isolated cookie/session store
separate from the app. Requires a capability entry in the Tauri config allowing
webview-window creation; this is added as part of the change.

### Link interception

A root-level, capture-phase `click` listener (installed by `WebPreviewHost` or a
small `useLinkInterception` hook it mounts). On a qualifying anchor
(`shouldIntercept`), it calls `preventDefault()` and `openUrl(href)`. In-app
router navigation and non-http schemes fall through untouched. A modifier-click
forces the system browser. Interception is governed by a setting.

### Settings

A new boolean setting `interceptLinksInPreview` (default `true`) in the
appropriate existing settings store, surfaced as one row in settings UI, so the
user can turn interception off and have every link open externally as before.

### i18n

New keys for the toolbar labels, the blocked-embedding banner, the PIP drag/
resize a11y labels, and the settings row.

## Data flow

External anchor click → capture listener → `shouldIntercept` → `openUrl(href)`
→ store `open=true` → `WebPreviewHost` renders the current `surface` with a
sandboxed iframe at `url`. Toolbar actions mutate the store (`navigate`, `back`,
`forward`, `setSurface`, `close`) or call out (open external, pop out). Reload
re-keys the iframe. Surface geometry stays local to the surface component.

## Error handling

- Non-http(s) or malformed URLs are never intercepted; the normal handler runs.
- Embedding blocks cannot be reliably detected cross-origin, so instead of a
  fragile detector the design always exposes "open externally" and "pop out".
- A network/allow toggle mirrors `CoworkPreviewPanel` for content posture.
- Pop-out failures surface through the existing error/toast path.

## Security

- http(s) schemes only; no `file:`/`javascript:`/custom schemes are intercepted
  or navigated.
- The in-app iframe is sandboxed.
- The pop-out window is incognito (isolated cookies/session).
- Interception is a single toggle away from off; the external default is always
  reachable.
- Residual risk: intercept-all opens model/tool-provided URLs into the sandboxed
  iframe automatically (the product owner chose intercept-all). Mitigated by the
  sandbox, the http(s)-only rule, no automatic non-http navigation, and the easy
  off switch. Documented, not silently accepted.

## Testing

- **Unit** (`lib/webPreview.ts`): `isPreviewableUrl`, `shouldIntercept`
  (external vs in-app route vs modifier vs non-http), `clampPipRect`.
- **Unit** (`useWebPreview`): `openUrl` / `navigate` / `back` / `forward`
  history transitions and derived `canGoBack` / `canGoForward`; `setSurface`
  does not touch history.
- **Component**: host surface switch (side ↔ PIP), toolbar actions, banner
  presence; pop-out call mocked through serviceHub.

## Out of scope

- B: native embedded webview (Tauri `unstable`). The host/store/interception
  seams are built so B can be added later by replacing only the iframe surface.
- Tab management, bookmarks, or a full browsing history UI beyond back/forward.
