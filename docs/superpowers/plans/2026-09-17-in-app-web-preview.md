# In-App Web Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any external link clicked in the app open a sandboxed web preview shown in a side rail or a floating PIP, with a pop-out to a native window.

**Architecture:** A global zustand store (`useWebPreview`) drives one root-mounted `WebPreviewHost` that renders either the side surface (reusing `CoworkSidePanel`) or a floating `WebPreviewPip`, both showing a sandboxed `<iframe>`. A capture-phase click listener intercepts external http(s) anchors. Pop-out reuses the existing `WindowService.createWebviewWindow`.

**Tech Stack:** React, TypeScript, zustand (+persist for the one setting), vitest, Tauri v2 (`@tauri-apps/plugin-opener`, `@tauri-apps/api/webviewWindow`).

**Spec:** `docs/superpowers/specs/2026-09-17-in-app-web-preview-design.md`

## Global Constraints

- Only `http:` / `https:` URLs are ever intercepted or navigated. Never `file:`, `javascript:`, or custom schemes.
- The in-app iframe is always sandboxed: `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
- Pop-out windows are incognito (isolated session).
- Link interception is governed by a persisted setting `interceptLinksInPreview` (default `true`); when off, links open externally as before.
- Test runner: `yarn test` (vitest `--run`). Typecheck: `yarn tsc -b`. Tests co-located under `__tests__`.
- Follow existing patterns: zustand stores in `src/hooks/`, containers in `src/containers/`, pure helpers in `src/lib/`, service methods behind `serviceHub`.
- The design keeps a clean seam so the deferred native embedded webview (B) can later replace only the iframe surface.

---

## File Structure

- Create `web-app/src/lib/webPreview.ts` — pure helpers (URL check, interception predicate, PIP clamp).
- Create `web-app/src/hooks/useWebPreview.ts` — global preview store (open/url/surface/history).
- Create `web-app/src/hooks/useWebPreviewSettings.ts` — persisted `interceptLinksInPreview`.
- Create `web-app/src/containers/WebPreviewHost.tsx` — root host, toolbar, side + PIP dispatch, interception listener.
- Create `web-app/src/containers/WebPreviewPip.tsx` — floating draggable/resizable PIP frame.
- Modify `web-app/src/services/opener/types.ts`, `default.ts`, `tauri.ts` — add `openUrl(url)`.
- Modify `web-app/src/services/window/types.ts`, `tauri.ts` — add optional `incognito` to `WindowConfig`.
- Modify `web-app/src/routes/__root.tsx` — mount `<WebPreviewHost />`.
- Modify settings UI (a general settings route) — one row for the toggle.
- Modify `web-app/src/locales/en/common.json` — i18n keys.

---

### Task 1: Pure helpers (`lib/webPreview.ts`)

**Files:**
- Create: `web-app/src/lib/webPreview.ts`
- Test: `web-app/src/lib/__tests__/webPreview.test.ts`

**Interfaces:**
- Produces:
  - `isPreviewableUrl(raw: string): boolean`
  - `type PipRect = { x: number; y: number; w: number; h: number }`
  - `type Viewport = { w: number; h: number }`
  - `clampPipRect(rect: PipRect, vp: Viewport, minW?: number, minH?: number): PipRect`
  - `shouldIntercept(e: { defaultPrevented: boolean; button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, anchor: { href: string; target: string; origin: string } | null, appOrigin: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { isPreviewableUrl, clampPipRect, shouldIntercept } from '../webPreview'

const ev = (o: Partial<Parameters<typeof shouldIntercept>[0]> = {}) => ({
  defaultPrevented: false, button: 0,
  ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o,
})

describe('isPreviewableUrl', () => {
  it('accepts http(s) only', () => {
    expect(isPreviewableUrl('https://a.com')).toBe(true)
    expect(isPreviewableUrl('http://a.com')).toBe(true)
    expect(isPreviewableUrl('file:///x')).toBe(false)
    expect(isPreviewableUrl('javascript:alert(1)')).toBe(false)
    expect(isPreviewableUrl('not a url')).toBe(false)
  })
})

describe('clampPipRect', () => {
  it('keeps the rect inside the viewport', () => {
    const r = clampPipRect({ x: -50, y: -50, w: 400, h: 300 }, { w: 1000, h: 800 })
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    const r2 = clampPipRect({ x: 900, y: 700, w: 400, h: 300 }, { w: 1000, h: 800 })
    expect(r2.x).toBe(600) // 1000 - 400
    expect(r2.y).toBe(500) // 800 - 300
  })
  it('caps size to the viewport with min floors', () => {
    const r = clampPipRect({ x: 0, y: 0, w: 5000, h: 5000 }, { w: 1000, h: 800 })
    expect(r.w).toBe(1000)
    expect(r.h).toBe(800)
  })
})

describe('shouldIntercept', () => {
  const app = 'https://app.local'
  const a = (o: Partial<{ href: string; target: string; origin: string }> = {}) => ({
    href: 'https://ext.com/page', target: '', origin: 'https://ext.com', ...o,
  })
  it('intercepts a plain external http(s) click', () => {
    expect(shouldIntercept(ev(), a(), app)).toBe(true)
  })
  it('skips when no anchor', () => {
    expect(shouldIntercept(ev(), null, app)).toBe(false)
  })
  it('skips same-origin (in-app route) links', () => {
    expect(shouldIntercept(ev(), a({ href: `${app}/settings`, origin: app }), app)).toBe(false)
  })
  it('skips non-http schemes', () => {
    expect(shouldIntercept(ev(), a({ href: 'mailto:x@y.com', origin: 'null' }), app)).toBe(false)
  })
  it('force-external on modifier or middle click', () => {
    expect(shouldIntercept(ev({ metaKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ ctrlKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ shiftKey: true }), a(), app)).toBe(false)
    expect(shouldIntercept(ev({ button: 1 }), a(), app)).toBe(false)
  })
  it('skips already-handled events', () => {
    expect(shouldIntercept(ev({ defaultPrevented: true }), a(), app)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/__tests__/webPreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// web-app/src/lib/webPreview.ts
export function isPreviewableUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export type PipRect = { x: number; y: number; w: number; h: number }
export type Viewport = { w: number; h: number }

export function clampPipRect(
  rect: PipRect,
  vp: Viewport,
  minW = 280,
  minH = 200
): PipRect {
  const w = Math.max(minW, Math.min(rect.w, vp.w))
  const h = Math.max(minH, Math.min(rect.h, vp.h))
  const x = Math.max(0, Math.min(rect.x, vp.w - w))
  const y = Math.max(0, Math.min(rect.y, vp.h - h))
  return { x, y, w, h }
}

type ClickLike = {
  defaultPrevented: boolean
  button: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}
type AnchorLike = { href: string; target: string; origin: string }

export function shouldIntercept(
  e: ClickLike,
  anchor: AnchorLike | null,
  appOrigin: string
): boolean {
  if (!anchor) return false
  if (e.defaultPrevented) return false
  // Left click only; middle/modified clicks fall through to the OS/browser.
  if (e.button !== 0) return false
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false
  if (!isPreviewableUrl(anchor.href)) return false
  // Same-origin links are in-app navigation, not external browsing.
  if (anchor.origin === appOrigin) return false
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/__tests__/webPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/lib/webPreview.ts web-app/src/lib/__tests__/webPreview.test.ts
git commit -m "feat(web-preview): add pure helpers for url check, pip clamp, interception"
```

---

### Task 2: Preview store (`useWebPreview`)

**Files:**
- Create: `web-app/src/hooks/useWebPreview.ts`
- Test: `web-app/src/hooks/__tests__/useWebPreview.test.ts`

**Interfaces:**
- Consumes: `isPreviewableUrl` from `@/lib/webPreview`.
- Produces a zustand store with:
  - state `open: boolean`, `surface: 'side' | 'pip'`, `history: string[]`, `index: number`
  - derived getters `url(): string`, `canGoBack(): boolean`, `canGoForward(): boolean`
  - actions `openUrl(url: string): void`, `close(): void`, `setSurface(s: 'side' | 'pip'): void`, `navigate(url: string): void`, `back(): void`, `forward(): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useWebPreview } from '../useWebPreview'

const reset = () =>
  useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })

describe('useWebPreview', () => {
  beforeEach(reset)

  it('openUrl opens on the side and records history', () => {
    useWebPreview.getState().openUrl('https://a.com')
    const s = useWebPreview.getState()
    expect(s.open).toBe(true)
    expect(s.surface).toBe('side')
    expect(s.url()).toBe('https://a.com')
    expect(s.canGoBack()).toBe(false)
  })

  it('ignores non-http urls', () => {
    useWebPreview.getState().openUrl('file:///x')
    expect(useWebPreview.getState().open).toBe(false)
  })

  it('navigate pushes and back/forward move through history', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.navigate('https://b.com')
    expect(useWebPreview.getState().url()).toBe('https://b.com')
    expect(useWebPreview.getState().canGoBack()).toBe(true)
    useWebPreview.getState().back()
    expect(useWebPreview.getState().url()).toBe('https://a.com')
    expect(useWebPreview.getState().canGoForward()).toBe(true)
    useWebPreview.getState().forward()
    expect(useWebPreview.getState().url()).toBe('https://b.com')
  })

  it('navigate after back truncates the forward tail', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.navigate('https://b.com')
    useWebPreview.getState().back()
    useWebPreview.getState().navigate('https://c.com')
    expect(useWebPreview.getState().url()).toBe('https://c.com')
    expect(useWebPreview.getState().canGoForward()).toBe(false)
  })

  it('setSurface changes surface without touching history', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.setSurface('pip')
    expect(useWebPreview.getState().surface).toBe('pip')
    expect(useWebPreview.getState().url()).toBe('https://a.com')
  })

  it('close resets open but keeps surface preference', () => {
    const st = useWebPreview.getState()
    st.openUrl('https://a.com')
    st.setSurface('pip')
    useWebPreview.getState().close()
    expect(useWebPreview.getState().open).toBe(false)
    expect(useWebPreview.getState().surface).toBe('pip')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/hooks/__tests__/useWebPreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// web-app/src/hooks/useWebPreview.ts
import { create } from 'zustand'
import { isPreviewableUrl } from '@/lib/webPreview'

export type PreviewSurface = 'side' | 'pip'

type WebPreviewState = {
  open: boolean
  surface: PreviewSurface
  history: string[]
  index: number
  url: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  openUrl: (url: string) => void
  navigate: (url: string) => void
  close: () => void
  setSurface: (s: PreviewSurface) => void
  back: () => void
  forward: () => void
}

export const useWebPreview = create<WebPreviewState>((set, get) => ({
  open: false,
  surface: 'side',
  history: [],
  index: -1,
  url: () => {
    const { history, index } = get()
    return index >= 0 ? history[index] : ''
  },
  canGoBack: () => get().index > 0,
  canGoForward: () => get().index < get().history.length - 1,
  openUrl: (url) => {
    if (!isPreviewableUrl(url)) return
    set((s) => {
      const history = [...s.history.slice(0, s.index + 1), url]
      return { open: true, history, index: history.length - 1 }
    })
  },
  navigate: (url) => {
    if (!isPreviewableUrl(url)) return
    set((s) => {
      const history = [...s.history.slice(0, s.index + 1), url]
      return { history, index: history.length - 1 }
    })
  },
  close: () => set({ open: false }),
  setSurface: (surface) => set({ surface }),
  back: () => set((s) => ({ index: Math.max(0, s.index - 1) })),
  forward: () =>
    set((s) => ({ index: Math.min(s.history.length - 1, s.index + 1) })),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/hooks/__tests__/useWebPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/hooks/useWebPreview.ts web-app/src/hooks/__tests__/useWebPreview.test.ts
git commit -m "feat(web-preview): add global preview store with history and surface"
```

---

### Task 3: Service additions (`opener.openUrl`, window `incognito`)

**Files:**
- Modify: `web-app/src/services/opener/types.ts`, `web-app/src/services/opener/default.ts`, `web-app/src/services/opener/tauri.ts`
- Modify: `web-app/src/services/window/types.ts`, `web-app/src/services/window/tauri.ts`
- Test: `web-app/src/services/opener/__tests__/openUrl.test.ts`

**Interfaces:**
- Produces: `OpenerService.openUrl(url: string): Promise<void>`; `WindowConfig.incognito?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// web-app/src/services/opener/__tests__/openUrl.test.ts
import { describe, it, expect, vi } from 'vitest'

const openUrl = vi.fn().mockResolvedValue(undefined)
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl,
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}))

import { TauriOpenerService } from '../tauri'

describe('TauriOpenerService.openUrl', () => {
  it('delegates to the plugin openUrl', async () => {
    await new TauriOpenerService().openUrl('https://a.com')
    expect(openUrl).toHaveBeenCalledWith('https://a.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/services/opener/__tests__/openUrl.test.ts`
Expected: FAIL — `openUrl` not a function on the service.

- [ ] **Step 3: Write minimal implementation**

In `web-app/src/services/opener/types.ts`, add to the interface:

```ts
  /** Hand an http(s) URL to the OS default browser. */
  openUrl(url: string): Promise<void>
```

In `web-app/src/services/opener/default.ts`, add a base implementation (match the file's existing class style; if `DefaultOpenerService` throws "not implemented" for the others, mirror that):

```ts
  async openUrl(_url: string): Promise<void> {
    throw new Error('openUrl not implemented in this environment')
  }
```

In `web-app/src/services/opener/tauri.ts`, import and implement:

```ts
import {
  openPath as osOpenPath,
  openUrl as osOpenUrl,
  revealItemInDir as osRevealItemInDir,
} from '@tauri-apps/plugin-opener'
```

```ts
  async openUrl(url: string): Promise<void> {
    try {
      await osOpenUrl(url)
    } catch (error) {
      console.error('Error opening url in Tauri:', error)
      throw error
    }
  }
```

In `web-app/src/services/window/types.ts`, add to `WindowConfig`:

```ts
  /** Isolate the window's cookies/session from the app. */
  incognito?: boolean
```

In `web-app/src/services/window/tauri.ts`, pass it through the `new WebviewWindow(...)` options object:

```ts
        theme: theme,
        incognito: config.incognito,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/services/opener/__tests__/openUrl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/services/opener web-app/src/services/window
git commit -m "feat(services): add opener.openUrl and window incognito option"
```

---

### Task 4: Interception setting store + settings row

**Files:**
- Create: `web-app/src/hooks/useWebPreviewSettings.ts`
- Test: `web-app/src/hooks/__tests__/useWebPreviewSettings.test.ts`
- Modify: a general settings route (find with `grep -rl "SettingsPageBody" web-app/src/routes/settings` and pick the general/appearance page) to add one `CardItem` toggle.
- Modify: `web-app/src/locales/en/common.json` — add keys.

**Interfaces:**
- Consumes: `localStorageKey` from `@/constants/localStorage` (add a `settingWebPreview` key), `backendStorage` from `@/lib/backendStorage` (match `useWebSearchConfig`'s persistence pattern).
- Produces store: `interceptLinks: boolean` (default `true`), `setInterceptLinks(v: boolean): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { useWebPreviewSettings } from '../useWebPreviewSettings'

describe('useWebPreviewSettings', () => {
  it('defaults interception on and toggles', () => {
    expect(useWebPreviewSettings.getState().interceptLinks).toBe(true)
    useWebPreviewSettings.getState().setInterceptLinks(false)
    expect(useWebPreviewSettings.getState().interceptLinks).toBe(false)
    useWebPreviewSettings.getState().setInterceptLinks(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/hooks/__tests__/useWebPreviewSettings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Add to `web-app/src/constants/localStorage.ts` a `settingWebPreview: 'settingWebPreview'` entry in the `localStorageKey` object (match the existing shape).

```ts
// web-app/src/hooks/useWebPreviewSettings.ts
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type WebPreviewSettings = {
  interceptLinks: boolean
  setInterceptLinks: (interceptLinks: boolean) => void
}

export const useWebPreviewSettings = create<WebPreviewSettings>()(
  persist(
    (set) => ({
      interceptLinks: true,
      setInterceptLinks: (interceptLinks) => set({ interceptLinks }),
    }),
    {
      name: localStorageKey.settingWebPreview,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
```

Add i18n keys to `web-app/src/locales/en/common.json` (under a new `webPreview` object):

```json
"webPreview": {
  "title": "Web preview",
  "openInPreview": "Open link in preview",
  "openExternal": "Open in browser",
  "popOut": "Pop out to window",
  "dockSide": "Dock to side",
  "showAsPip": "Show as floating window",
  "reload": "Reload",
  "back": "Back",
  "forward": "Forward",
  "close": "Close preview",
  "urlLabel": "Address",
  "blockedBanner": "This site may block embedding. Open it in your browser or pop it out.",
  "interceptSetting": "Open links in an in-app preview",
  "interceptSettingDesc": "When on, clicking a web link opens it in a preview panel instead of your browser.",
  "pipDrag": "Move preview window",
  "pipResize": "Resize preview window"
}
```

Add the settings row to the chosen general settings page, following the file's existing `CardItem` pattern:

```tsx
<CardItem
  title={t('common:webPreview.interceptSetting')}
  description={t('common:webPreview.interceptSettingDesc')}
  actions={
    <Switch
      checked={useWebPreviewSettings((s) => s.interceptLinks)}
      onCheckedChange={(v) =>
        useWebPreviewSettings.getState().setInterceptLinks(v)
      }
    />
  }
/>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/hooks/__tests__/useWebPreviewSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/hooks/useWebPreviewSettings.ts web-app/src/hooks/__tests__/useWebPreviewSettings.test.ts web-app/src/constants/localStorage.ts web-app/src/locales/en/common.json web-app/src/routes/settings
git commit -m "feat(web-preview): add interception setting and settings row"
```

---

### Task 5: PIP frame (`WebPreviewPip`)

**Files:**
- Create: `web-app/src/containers/WebPreviewPip.tsx`
- Test: `web-app/src/containers/__tests__/WebPreviewPip.test.tsx`

**Interfaces:**
- Consumes: `clampPipRect`, `PipRect` from `@/lib/webPreview`.
- Produces: `WebPreviewPip({ title, children }: { title: React.ReactNode; children: React.ReactNode })` — a fixed, draggable, resizable container. Drag via a header handle (`data-testid="pip-drag"`), resize via a corner (`data-testid="pip-resize"`). Position/size held in local state, initialized to a bottom-right default, clamped on every move and on window resize.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebPreviewPip } from '../WebPreviewPip'

describe('WebPreviewPip', () => {
  it('renders a fixed container with drag and resize handles and children', () => {
    render(
      <WebPreviewPip title="Preview">
        <div>body</div>
      </WebPreviewPip>
    )
    const drag = screen.getByTestId('pip-drag')
    expect(drag).toBeInTheDocument()
    expect(screen.getByTestId('pip-resize')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
    const root = screen.getByTestId('web-preview-pip')
    expect(getComputedStyle(root).position).toBe('fixed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/containers/__tests__/WebPreviewPip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web-app/src/containers/WebPreviewPip.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { clampPipRect, type PipRect } from '@/lib/webPreview'
import { useTranslation } from '@/i18n/react-i18next-compat'

const vp = () => ({ w: window.innerWidth, h: window.innerHeight })
const initialRect = (): PipRect => {
  const v = vp()
  const w = Math.min(480, v.w - 32)
  const h = Math.min(360, v.h - 32)
  return { x: v.w - w - 16, y: v.h - h - 16, w, h }
}

export function WebPreviewPip({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [rect, setRect] = useState<PipRect>(initialRect)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const resize = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null)

  useEffect(() => {
    const onResize = () => setRect((r) => clampPipRect(r, vp()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onDragDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      drag.current = { dx: e.clientX - rect.x, dy: e.clientY - rect.y }
      const move = (ev: PointerEvent) => {
        if (!drag.current) return
        setRect((r) =>
          clampPipRect(
            { ...r, x: ev.clientX - drag.current!.dx, y: ev.clientY - drag.current!.dy },
            vp()
          )
        )
      }
      const up = () => {
        drag.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [rect.x, rect.y]
  )

  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      resize.current = { sx: e.clientX, sy: e.clientY, sw: rect.w, sh: rect.h }
      const move = (ev: PointerEvent) => {
        if (!resize.current) return
        const { sx, sy, sw, sh } = resize.current
        setRect((r) =>
          clampPipRect(
            { ...r, w: sw + (ev.clientX - sx), h: sh + (ev.clientY - sy) },
            vp()
          )
        )
      }
      const up = () => {
        resize.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [rect.w, rect.h]
  )

  return (
    <div
      data-testid="web-preview-pip"
      className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-overlay"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, position: 'fixed' }}
    >
      <div
        data-testid="pip-drag"
        onPointerDown={onDragDown}
        aria-label={t('common:webPreview.pipDrag')}
        className="flex h-9 shrink-0 cursor-move items-center gap-2 border-b border-border px-2 text-sm font-medium"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <div
        data-testid="pip-resize"
        onPointerDown={onResizeDown}
        aria-label={t('common:webPreview.pipResize')}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
      />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/containers/__tests__/WebPreviewPip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/containers/WebPreviewPip.tsx web-app/src/containers/__tests__/WebPreviewPip.test.tsx
git commit -m "feat(web-preview): add draggable resizable PIP frame"
```

---

### Task 6: Host with toolbar, surfaces, iframe, banner (`WebPreviewHost`)

**Files:**
- Create: `web-app/src/containers/WebPreviewHost.tsx`
- Test: `web-app/src/containers/__tests__/WebPreviewHost.test.tsx`

**Interfaces:**
- Consumes: `useWebPreview` (store), `CoworkSidePanel` from `@/containers/CoworkSidePanel`, `WebPreviewPip` from `@/containers/WebPreviewPip`, `useServiceHub` from `@/hooks/useServiceHub`.
- Produces: `WebPreviewHost()` — renders null when `!open`; otherwise the side or PIP surface containing the toolbar and a keyed sandboxed iframe. Toolbar buttons: back, forward, reload, open-external (`serviceHub.opener().openUrl`), pop-out (`serviceHub.window().createWebviewWindow({ label: 'web-preview-<ts>', url, incognito: true, width: 1024, height: 768, resizable: true })`), dock/PIP toggle (`setSurface`), close.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WebPreviewHost } from '../WebPreviewHost'
import { useWebPreview } from '@/hooks/useWebPreview'

const openUrl = vi.fn().mockResolvedValue(undefined)
const createWebviewWindow = vi.fn().mockResolvedValue({ label: 'x' })
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl }),
    window: () => ({ createWebviewWindow }),
  }),
}))

describe('WebPreviewHost', () => {
  beforeEach(() => {
    openUrl.mockClear()
    createWebviewWindow.mockClear()
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
  })

  it('renders nothing when closed', () => {
    const { container } = render(<WebPreviewHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an iframe at the current url when open', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    const frame = screen.getByTitle('https://a.com') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
    expect(frame.src).toContain('https://a.com')
  })

  it('open-external delegates to opener.openUrl', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByRole('button', { name: /open in browser/i }))
    expect(openUrl).toHaveBeenCalledWith('https://a.com')
  })

  it('pop-out creates an incognito webview window', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByRole('button', { name: /pop out/i }))
    expect(createWebviewWindow).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://a.com', incognito: true })
    )
  })

  it('toggles from side to PIP', () => {
    useWebPreview.getState().openUrl('https://a.com')
    render(<WebPreviewHost />)
    fireEvent.click(screen.getByRole('button', { name: /floating window/i }))
    expect(useWebPreview.getState().surface).toBe('pip')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/containers/__tests__/WebPreviewHost.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web-app/src/containers/WebPreviewHost.tsx
import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  SquareArrowOutUpRight,
  PictureInPicture2,
  PanelRight,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { WebPreviewPip } from '@/containers/WebPreviewPip'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups'

export function WebPreviewHost() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const open = useWebPreview((s) => s.open)
  const surface = useWebPreview((s) => s.surface)
  // Subscribe to index/history so url() re-derives on change.
  useWebPreview((s) => s.index)
  const url = useWebPreview.getState().url()
  const canGoBack = useWebPreview((s) => s.canGoBack())
  const canGoForward = useWebPreview((s) => s.canGoForward())
  const [nonce, setNonce] = useState(0)

  if (!open || !url) return null

  const popOut = () =>
    void serviceHub.window().createWebviewWindow({
      label: `web-preview-${Date.now()}`,
      url,
      incognito: true,
      width: 1024,
      height: 768,
      resizable: true,
    })

  const toolbar = (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button variant="ghost" size="icon-xs" disabled={!canGoBack}
        aria-label={t('common:webPreview.back')}
        onClick={() => useWebPreview.getState().back()}>
        <ArrowLeft className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs" disabled={!canGoForward}
        aria-label={t('common:webPreview.forward')}
        onClick={() => useWebPreview.getState().forward()}>
        <ArrowRight className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs"
        aria-label={t('common:webPreview.reload')}
        onClick={() => setNonce((n) => n + 1)}>
        <RotateCw className="size-4" />
      </Button>
      <span className="mx-1 min-w-0 flex-1 truncate rounded bg-sunken px-2 py-1 font-mono text-xs text-ink-2">
        {url}
      </span>
      <Button variant="ghost" size="icon-xs"
        aria-label={t('common:webPreview.openExternal')}
        onClick={() => void serviceHub.opener().openUrl(url)}>
        <ExternalLink className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs"
        aria-label={t('common:webPreview.popOut')}
        onClick={popOut}>
        <SquareArrowOutUpRight className="size-4" />
      </Button>
      {surface === 'side' ? (
        <Button variant="ghost" size="icon-xs"
          aria-label={t('common:webPreview.showAsPip')}
          onClick={() => useWebPreview.getState().setSurface('pip')}>
          <PictureInPicture2 className="size-4" />
        </Button>
      ) : (
        <Button variant="ghost" size="icon-xs"
          aria-label={t('common:webPreview.dockSide')}
          onClick={() => useWebPreview.getState().setSurface('side')}>
          <PanelRight className="size-4" />
        </Button>
      )}
    </div>
  )

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {t('common:webPreview.blockedBanner')}
        </span>
        <button className="underline" onClick={() => void serviceHub.opener().openUrl(url)}>
          {t('common:webPreview.openExternal')}
        </button>
      </div>
      <iframe
        key={`${url}#${nonce}`}
        title={url}
        src={url}
        sandbox={SANDBOX}
        className="min-h-0 w-full flex-1 border-0 bg-card"
      />
    </div>
  )

  if (surface === 'pip') {
    return <WebPreviewPip title={url}>{body}</WebPreviewPip>
  }
  return (
    <div className="absolute inset-y-0 right-0 z-50 flex">
      <CoworkSidePanel title={t('common:webPreview.title')} onClose={() => useWebPreview.getState().close()}>
        {body}
      </CoworkSidePanel>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/containers/__tests__/WebPreviewHost.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/containers/WebPreviewHost.tsx web-app/src/containers/__tests__/WebPreviewHost.test.tsx
git commit -m "feat(web-preview): add host with toolbar, side/PIP surfaces, iframe"
```

---

### Task 7: Link interception + root mount

**Files:**
- Modify: `web-app/src/containers/WebPreviewHost.tsx` (add the interception effect)
- Modify: `web-app/src/routes/__root.tsx` (mount `<WebPreviewHost />`)
- Test: `web-app/src/containers/__tests__/WebPreviewHost.intercept.test.tsx`

**Interfaces:**
- Consumes: `shouldIntercept` from `@/lib/webPreview`, `useWebPreviewSettings` from `@/hooks/useWebPreviewSettings`.
- Produces: a document-level capture-phase click listener installed by `WebPreviewHost` on mount that opens qualifying links in the preview.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { WebPreviewHost } from '../WebPreviewHost'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'

// Reuse the serviceHub mock from WebPreviewHost.test.tsx pattern:
import { vi } from 'vitest'
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ openUrl: vi.fn() }),
    window: () => ({ createWebviewWindow: vi.fn() }),
  }),
}))

describe('WebPreviewHost link interception', () => {
  beforeEach(() => {
    useWebPreview.setState({ open: false, surface: 'side', history: [], index: -1 })
    useWebPreviewSettings.setState({ interceptLinks: true })
  })

  it('opens an external link click in the preview', () => {
    render(
      <WebPreviewHost />
    )
    const a = document.createElement('a')
    a.href = 'https://external.example/page'
    document.body.appendChild(a)
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(useWebPreview.getState().open).toBe(true)
    expect(useWebPreview.getState().url()).toBe('https://external.example/page')
    a.remove()
  })

  it('does not intercept when the setting is off', () => {
    useWebPreviewSettings.setState({ interceptLinks: false })
    render(<WebPreviewHost />)
    const a = document.createElement('a')
    a.href = 'https://external.example/page'
    document.body.appendChild(a)
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(useWebPreview.getState().open).toBe(false)
    a.remove()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/containers/__tests__/WebPreviewHost.intercept.test.tsx`
Expected: FAIL — no interception yet.

- [ ] **Step 3: Write minimal implementation**

Add to `WebPreviewHost` (before the `if (!open ...)` early return so the effect always runs):

```tsx
import { useEffect } from 'react'
import { shouldIntercept } from '@/lib/webPreview'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
```

```tsx
  const interceptLinks = useWebPreviewSettings((s) => s.interceptLinks)

  useEffect(() => {
    if (!interceptLinks) return
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('a[href]') as
        | HTMLAnchorElement
        | null
      const anchor = el
        ? { href: el.href, target: el.target, origin: el.origin }
        : null
      if (
        shouldIntercept(
          {
            defaultPrevented: e.defaultPrevented,
            button: e.button,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
          },
          anchor,
          window.location.origin
        )
      ) {
        e.preventDefault()
        useWebPreview.getState().openUrl(anchor!.href)
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [interceptLinks])
```

Mount in `web-app/src/routes/__root.tsx`, inside the provider tree next to `<Outlet />` (add the import and place `<WebPreviewHost />` as a sibling after `<Outlet />` within the `ServiceHubProvider`/`TranslationProvider` scope so it has both contexts):

```tsx
import { WebPreviewHost } from '@/containers/WebPreviewHost'
```

```tsx
            <Outlet />
            <WebPreviewHost />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/containers/__tests__/WebPreviewHost.intercept.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-app/src/containers/WebPreviewHost.tsx web-app/src/routes/__root.tsx web-app/src/containers/__tests__/WebPreviewHost.intercept.test.tsx
git commit -m "feat(web-preview): intercept external links and mount host at root"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd web-app && yarn tsc -b`
Expected: no new errors in the created/modified files. (Pre-existing `@janhq/*` workspace errors are unrelated; confirm none reference the new files.)

- [ ] **Step 2: Run the web-preview test suite**

Run: `cd web-app && yarn test src/lib/__tests__/webPreview.test.ts src/hooks/__tests__/useWebPreview.test.ts src/hooks/__tests__/useWebPreviewSettings.test.ts src/services/opener/__tests__/openUrl.test.ts src/containers/__tests__/WebPreviewPip.test.tsx src/containers/__tests__/WebPreviewHost.test.tsx src/containers/__tests__/WebPreviewHost.intercept.test.tsx`
Expected: all PASS.

- [ ] **Step 3: Manual smoke (optional, if running the app)**

Use the `run` skill to launch the app; click an external link in chat; confirm it opens in the side rail; toggle to PIP, drag/resize; pop out; toggle the setting off and confirm links open externally.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(web-preview): verify typecheck and full suite"
```

---

## Self-Review

**Spec coverage:**
- iframe side + PIP surfaces → Tasks 5, 6. Pop-out (`WebviewWindow`, incognito) → Tasks 3, 6. App-wide interception + off switch → Tasks 4, 7. Store/history/surface → Task 2. http(s)-only + sandbox + banner → Tasks 1, 6. Settings row + i18n → Task 4. Root mount → Task 7. B deferred — not planned, per spec.
- Every spec section maps to a task. No gaps.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The one lookup left to the implementer (which general settings page hosts the toggle row, Task 4) is given as an exact `grep` plus the exact `CardItem` to insert — not a placeholder.

**Type consistency:** `openUrl`, `createWebviewWindow({url, incognito})`, `setSurface`, `back/forward`, `url()`, `canGoBack/canGoForward`, `shouldIntercept`, `clampPipRect`, `PipRect` are used with the same signatures across Tasks 1–7. `WindowConfig.incognito?` added in Task 3 and consumed in Task 6 match.

---

## Execution Handoff

See the skill's handoff options after review.
