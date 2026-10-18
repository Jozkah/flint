import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import {
  pruneLocalStorageByFlags,
  type WebdataResetFlags,
} from '@/services/app/reset-localstorage'
import { installConsoleLogForwarding } from '@/services/app/console-logger'
import { bootMark } from '@/lib/bootMarks'
import { noteBootError, startBootWatchdog } from '@/lib/bootWatchdog'

// Inter is bundled under public/fonts (styles/font.css), so nothing is fetched at runtime.
import './index.css'

// Mobile-specific viewport and styling setup
const setupMobileViewport = () => {
  // Check if running on mobile platform (iOS/Android via Tauri)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
                   window.matchMedia('(max-width: 768px)').matches

  if (isMobile) {
    // Update viewport meta tag to disable zoom
    const viewportMeta = document.querySelector('meta[name="viewport"]')
    if (viewportMeta) {
      viewportMeta.setAttribute('content',
        'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
      )
    }

    // Add mobile-specific styles for status bar
    const style = document.createElement('style')
    style.textContent = `
      body {
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }

      #root {
        min-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
      }

      /* Prevent zoom on input focus */
      input, textarea, select {
        font-size: 16px !important;
      }
    `
    document.head.appendChild(style)
  }
}

// Prevent browser from opening dropped files
const preventDefaultFileDrop = () => {
  document.addEventListener('dragover', (e) => {
    e.preventDefault()
  })
  document.addEventListener('drop', (e) => {
    e.preventDefault()
  })
}

// Suppress the default browser/webview context menu globally so only custom
// React-driven menus appear.  Individual components opt in by calling
// e.preventDefault() + opening their own menu (the pattern in ThreadList,
// NavCowork, etc.); everywhere else the right-click simply does nothing.
const suppressDefaultContextMenu = () => {
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault()
  })
}

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}

// Consume a pending factory-reset sentinel and prune persisted UI state BEFORE
// any store module loads (Zustand persist hydrates synchronously at import).
// This is the only race-free, cross-platform way to clear webview localStorage.
const consumePendingWebdataReset = async () => {
  try {
    const flags = await invoke<WebdataResetFlags | null>(
      'take_pending_webdata_reset'
    )
    if (flags) pruneLocalStorageByFlags(flags)
  } catch {
    // Non-Tauri (web) build or no sentinel — nothing to do.
  }
}

const boot = async () => {
  bootMark('boot:start')
  startBootWatchdog()
  installConsoleLogForwarding()
  setupMobileViewport()
  preventDefaultFileDrop()
  suppressDefaultContextMenu()

  await consumePendingWebdataReset()

  // Dynamic imports keep store hydration AFTER the localStorage prune above.
  bootMark('boot:reset-consumed')
  // Fetch everything the first screen needs at once rather than one chunk
  // after another: the route tree, the strings, this window's shell and the
  // services (which ServiceHubProvider picks up instead of starting again).
  const routeTreeLoad = import('./routeTree.gen')
  const i18nLoad = import('./i18n')
  i18nLoad.catch(() => {}) // awaited below; this only keeps an early failure from being "unhandled"
  void import('./providers/ServiceHubProvider')
    .then((m) => m.prestartServiceHub())
    .catch(() => {})
  void import('./lib/soloFlag').then((m) =>
    m.isChatWindow()
      ? import('./components/solo/SoloRoot')
      : import('./shell/MainRoot')
  ).catch(() => {
    // Only a head start; the route loads it again and reports any failure.
  })
  const { routeTree } = await routeTreeLoad
  bootMark('boot:routetree')
  const { default: i18n } = await i18nLoad
  try {
    await i18n.ready
  } catch (e) {
    // The saved language failed to download: start in English rather than
    // stall the whole window on it. It can be picked again in Settings.
    noteBootError(e)
    i18n.language = i18n.fallbackLng
  }
  bootMark('boot:i18n')

  const router = createRouter({ routeTree })
  // The app opens on the Overview once the first-run setup is done; until
  // then the new-chat page carries the setup guide. Only the main window's
  // start: a deep link or a logs window keeps its own path.
  try {
    if (
      window.location.pathname === '/' &&
      localStorage.getItem('setup-completed') &&
      !sessionStorage.getItem('flint-started')
    ) {
      window.history.replaceState(null, '', '/overview')
    }
    sessionStorage.setItem('flint-started', '1')
  } catch {
    // Storage unavailable: stay on the default page.
  }

  // Development only: `?preview` fills the stores with example content so the
  // interface can be looked at in a plain browser (see dev/previewSeed.ts).
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) {
    const { seedPreview } = await import('./dev/previewSeed')
    // Again after start-up hydration, which replaces the stores' contents.
    seedPreview()
    for (const ms of [1500, 4000, 8000]) window.setTimeout(seedPreview, ms)
  }

  const rootElement = document.getElementById('root')!
  if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement)
    bootMark('boot:render')
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    )
    // After the Toaster has mounted, so the toast is not dropped.
    window.setTimeout(() => {
      void import('@/lib/settingsRecoveryNotice').then((m) =>
        m.showSettingsRecoveryNotice()
      )
    }, 1500)
  }
}

boot().catch((e) => console.error('Failed to boot app:', e))
