import { useEffect } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { isPlatformTauri } from '@/lib/platform/utils'
import { listen } from '@tauri-apps/api/event'
import { invokeCommand } from '@/lib/backend'

/**
 * Any CSS colour (rgb, oklch, ...) as 0xRRGGBB, by painting it on a 1x1
 * canvas; computed styles keep oklch as written. Null without a 2D context.
 */
export function rgbOf(css: string): number | null {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return (r << 16) | (g << 8) | b
}

export function ThemeProvider() {
  const isDark = useTheme((s) => s.isDark)
  const setIsDark = useTheme((s) => s.setIsDark)
  const activeTheme = useTheme((s) => s.activeTheme)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', isDark)
    // index.html paints the first frame with inline values; from here the
    // stylesheet's html background and .dark color-scheme take over.
    root.style.removeProperty('background')
    root.style.removeProperty('color-scheme')
    if (IS_WINDOWS && isPlatformTauri()) {
      // Paint the native title bar with the app's own background once the
      // new theme's styles apply, so the caption blends into the window.
      requestAnimationFrame(() => {
        const bg = rgbOf(getComputedStyle(root).backgroundColor)
        const fg = rgbOf(getComputedStyle(root).color)
        if (bg === null || fg === null) return
        invokeCommand('set_titlebar_colors', { background: bg, text: fg })
          .catch((err) => console.error('set_titlebar_colors failed:', err))
      })
    }
    if (IS_LINUX && isPlatformTauri()) {
      invokeCommand('set_gtk_prefer_dark', { dark: isDark })
        .catch((err) => console.error('set_gtk_prefer_dark failed:', err))
    }
  }, [isDark])

  useEffect(() => {
    let cancelled = false
    let unlistenTauri: (() => void) | undefined

    // Always check the latest activeTheme at event time — calling
    // window.setTheme() from the switcher fires portal/WindowEvent events that
    // would otherwise race the zustand commit and pin isDark to the system
    // value even when the user picked an explicit light/dark override.
    const applyIfAuto = (next: boolean) => {
      if (useTheme.getState().activeTheme === 'auto') setIsDark(next)
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = (e: MediaQueryListEvent) => applyIfAuto(e.matches)
    mediaQuery.addEventListener('change', handleMediaChange)

    if (isPlatformTauri()) {
      // On Linux, WebKitGTK's prefers-color-scheme does not reliably track the
      // XDG Desktop Portal. Source-of-truth is the Rust-side portal read +
      // SettingChanged signal, re-emitted as the `theme-changed` event.
      Promise.resolve({ listen })
        .then(async ({ listen }) => {
          const unlisten = await listen<string>('theme-changed', (event) => {
            applyIfAuto(event.payload === 'dark')
          })
          if (cancelled) {
            unlisten()
            return
          }
          unlistenTauri = unlisten

          try {
            const initial = await invokeCommand<string>('get_system_theme')
            if (!cancelled) applyIfAuto(initial === 'dark')
          } catch (err) {
            console.error('get_system_theme failed:', err)
          }
        })
        .catch((err) => {
          console.error('Failed to setup Tauri theme listener:', err)
        })
    } else {
      applyIfAuto(mediaQuery.matches)
    }

    return () => {
      cancelled = true
      mediaQuery.removeEventListener('change', handleMediaChange)
      unlistenTauri?.()
    }
    // Re-query the portal on activeTheme change: matchMedia stays pinned to the
    // prior explicit theme after window.setTheme(), so 'auto' needs a fresh read.
  }, [setIsDark, activeTheme])

  return null
}
