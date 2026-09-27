import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useWebPreview } from '@/hooks/useWebPreview'
import {
  NativeWebPreviewController,
  hasBlockingOverlay,
  toPhysicalBounds,
  type InvokeFn,
} from '@/lib/nativeWebPreview'

export type NativePreviewMode = 'pending' | 'native' | 'iframe'

export const NATIVE_PREVIEW_ID = 'rail'
const NAVIGATED_EVENT = 'web-preview://navigated'

type NavigatedPayload = {
  id: string
  url?: string | null
  title?: string | null
  loading?: boolean | null
}

const isTauri = () => typeof IS_TAURI !== 'undefined' && !!IS_TAURI

/**
 * Drives a native child webview laid over `container` (the preview panel's
 * content box). Returns the render mode: `native` while the child view is up,
 * `iframe` when it is unavailable (web build, creation failed) so the caller
 * falls back to the sandboxed iframe, `pending` while it is being created.
 */
export function useNativeWebPreview({
  enabled,
  url,
  reloadNonce,
  container,
  invokeFn = invoke as InvokeFn,
}: {
  enabled: boolean
  url: string
  reloadNonce: number
  container: HTMLElement | null
  invokeFn?: InvokeFn
}): NativePreviewMode {
  const [mode, setMode] = useState<NativePreviewMode>(() =>
    isTauri() ? 'pending' : 'iframe'
  )
  const ctrlRef = useRef<NativeWebPreviewController | null>(null)
  const lastNativeUrl = useRef<string>('')
  const ownNav = useRef(false)
  const inFlight = useRef(false)
  const urlRef = useRef(url)
  urlRef.current = url

  // Lifetime: one controller per open session; closed on disable/unmount.
  useEffect(() => {
    if (!enabled || mode === 'iframe') return
    const ctrl = new NativeWebPreviewController(NATIVE_PREVIEW_ID, invokeFn)
    ctrlRef.current = ctrl
    return () => {
      ctrl.dispose()
      if (ctrlRef.current === ctrl) ctrlRef.current = null
      setMode((m) => (m === 'native' ? 'pending' : m))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, mode === 'iframe', invokeFn])

  // Create once a container is measurable.
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!enabled || !container || !ctrl || ctrl.isCreated || mode !== 'pending') return
    const bounds = toPhysicalBounds(container.getBoundingClientRect(), window.devicePixelRatio || 1)
    const initialUrl = urlRef.current
    lastNativeUrl.current = initialUrl
    ownNav.current = true
    let cancelled = false
    ctrl
      .create(initialUrl, bounds)
      .then(() => {
        if (!cancelled && ctrl.isCreated) setMode('native')
      })
      .catch((err) => {
        console.warn('Native web preview unavailable, using iframe:', err)
        if (!cancelled) setMode('iframe')
      })
    return () => {
      cancelled = true
    }
  }, [enabled, container, mode])

  // Store-driven navigation (address changes, back/forward in the toolbar).
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (mode !== 'native' || !ctrl || !url || url === lastNativeUrl.current) return
    lastNativeUrl.current = url
    ownNav.current = true
    void ctrl.navigate(url).catch(() => {})
  }, [url, mode])

  useEffect(() => {
    if (reloadNonce === 0 || mode !== 'native') return
    void ctrlRef.current?.reload().catch(() => {})
  }, [reloadNonce, mode])

  // Page loads inside the native view update the address bar/history.
  useEffect(() => {
    if (mode !== 'native') return
    let unlisten: (() => void) | undefined
    let active = true
    listen<NavigatedPayload>(NAVIGATED_EVENT, ({ payload }) => {
      if (payload.id !== NATIVE_PREVIEW_ID || !payload.url) return
      applyNavigated(payload.url, payload.loading !== false)
    })
      .then((u) => {
        if (active) unlisten = u
        else u()
      })
      .catch(() => {})
    return () => {
      active = false
      unlisten?.()
    }
  }, [mode])

  function applyNavigated(navUrl: string, started: boolean) {
    const store = useWebPreview.getState()
    lastNativeUrl.current = navUrl
    if (started) {
      if (ownNav.current) store.replaceUrl(navUrl)
      else if (navUrl !== store.url()) store.navigate(navUrl)
      inFlight.current = true
    } else {
      if (inFlight.current || ownNav.current) store.replaceUrl(navUrl)
      inFlight.current = false
      ownNav.current = false
    }
  }

  // Keep bounds/visibility in sync: sample the box once per animation frame
  // (covers resize, split-pane drags, PIP moves, rail collapse, zoom/DPI via
  // devicePixelRatio) and watch the DOM for overlays.
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (mode !== 'native' || !ctrl) return
    if (!container) {
      ctrl.setVisible(false)
      return
    }
    let overlay = false
    let lastRect: DOMRect | null = null
    const recheckOverlay = () => {
      overlay = hasBlockingOverlay(document, container, lastRect)
    }
    const mo = new MutationObserver(recheckOverlay)
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'role'],
    })
    let frame = 0
    const tick = () => {
      const rect = container.getBoundingClientRect()
      lastRect = rect
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        container.isConnected &&
        document.visibilityState !== 'hidden' &&
        !overlay
      ctrl.setVisible(visible)
      if (visible) ctrl.setBounds(toPhysicalBounds(rect, window.devicePixelRatio || 1))
      frame = requestAnimationFrame(tick)
    }
    recheckOverlay()
    tick()
    return () => {
      cancelAnimationFrame(frame)
      mo.disconnect()
      ctrl.setVisible(false)
    }
  }, [mode, container])

  return mode
}
