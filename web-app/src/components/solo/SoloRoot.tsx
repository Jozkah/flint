import { useEffect, useRef } from 'react'
import { Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { DataProvider } from '@/providers/DataProvider'
import { TranslationProvider } from '@/i18n/TranslationContext'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useAppViewport } from '@/hooks/useAppViewport'
import { useMessageZoom } from '@/hooks/useMessageZoom'
import { useWindowTitle } from '@/hooks/useWindowTitle'
import { ShellNavProvider } from '@/components/shell/nav-kit'
import { HeaderSlotProvider } from '@/components/shell/HeaderSlot'
import { WindowControls } from '@/components/WindowControls'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import { WebPreviewHost } from '@/containers/WebPreviewHost'
import { BrowserDomainDialog } from '@/containers/BrowserDomainDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import BypassConfirmDialog from '@/containers/dialogs/BypassConfirmDialog'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AccessRequestDialog from '@/containers/dialogs/AccessRequestDialog'
import { ModelReplaceDialog } from '@/containers/ModelReplaceDialog'
import { detectWindowChrome } from '@/lib/titlebar'
import {
  SOLO_EVENT,
  SOLO_IDLE_PATH,
  applyChatWindowSession,
  isAllowedSoloPath,
  isSoloSpare,
  soloPath,
  useSoloTarget,
  type SoloAssignment,
} from '@/lib/chatWindow'
import { SoloTitleBar } from '@/components/solo/SoloTitleBar'
import { bootMark } from '@/lib/bootMarks'

/**
 * The root of a "New window": one conversation and nothing else.
 *
 * It is a root of its own, not the app shell with parts hidden, so the
 * sidebar, the header's actions, the search and command dialogs, the global
 * shortcuts and the main window's one-time work are never mounted at all.
 * Navigation is closed: the only page this window can show is its own
 * conversation (see `isAllowedSoloPath`).
 */

/** The spare handshake: tell the main window we are idle, take an assignment. */
function useSpareHandshake() {
  const router = useRouter()

  useEffect(() => {
    if (!IS_TAURI || !isSoloSpare()) return
    const win = getCurrentWebviewWindow()
    let unlisten: (() => void) | undefined
    let disposed = false

    // Have the conversation pages' code loaded before one is assigned.
    const warm = async () => {
      for (const to of ['/threads/$threadId', '/cowork', '/rooms/$roomId']) {
        try {
          await router.preloadRoute({ to: to as never, params: {} as never })
        } catch {
          /* a route that needs params cannot always be preloaded blind */
        }
      }
    }

    void listen<SoloAssignment>(SOLO_EVENT.assign, async (e) => {
      const { target, label } = e.payload
      // Events reach every window; only the one named, and only while idle.
      if (label !== win.label || useSoloTarget.getState().target) return
      useSoloTarget.getState().setTarget(target)
      if (target.kind === 'cowork') applyChatWindowSession(target.refId)
      try {
        await router.navigate({ to: soloPath(target) as never, replace: true })
      } catch (err) {
        console.warn('Solo window could not open its conversation:', err)
      }
      try {
        await win.show()
        await win.setFocus()
      } catch (err) {
        console.warn('Solo window could not show itself:', err)
        await emitTo('main', SOLO_EVENT.failed, win.label).catch(() => {})
        return
      }
      await emitTo('main', SOLO_EVENT.shown, { label: win.label })
    }).then((u) => {
      if (disposed) u()
      else unlisten = u
    })

    void warm().then(() =>
      emitTo('main', SOLO_EVENT.ready, win.label).catch(() => {})
    )

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [router])
}

export function SoloShell() {
  const router = useRouter()
  const pathname = useLocation({ select: (l) => l.pathname })
  const target = useSoloTarget((s) => s.target)
  const title = useWindowTitle()
  useAppViewport()
  // The one global shortcut a conversation keeps: zooming its text.
  useMessageZoom()
  useSpareHandshake()

  const allowed = isAllowedSoloPath(pathname, target)

  // Closed navigation: a link, a menu item or a shortcut that goes anywhere
  // else is sent straight back.
  useEffect(() => {
    if (allowed) return
    const to = target ? soloPath(target) : SOLO_IDLE_PATH
    void router.navigate({ to: to as never, replace: true })
  }, [allowed, target, router])

  const reported = useRef(false)
  useEffect(() => {
    if (!allowed || !target || reported.current) return
    reported.current = true
    bootMark('solo:conversation-mounted')
    console.info(
      `[solo] conversation mounted ${Math.round(performance.now())}ms after the window began loading`
    )
  }, [allowed, target])

  const chrome = detectWindowChrome()

  return (
    <ShellNavProvider>
      {/* A provider with no slot element: pages' header contributions
          (HeaderPage) have nowhere to go, so none are drawn. */}
      <HeaderSlotProvider>
        <div
          data-testid="solo-shell"
          className="app-zoom relative flex h-(--app-vvh,100dvh) w-full flex-col overflow-hidden bg-background"
        >
          <SoloTitleBar title={title} />
          <main
            data-testid="solo-main"
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card px-3 shadow-[inset_0_0_0_0.8px_var(--border)]"
          >
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {allowed && target ? <Outlet /> : null}
            </div>
          </main>
          {chrome === 'custom' && <WindowControls />}
          {chrome === 'custom' && <WindowResizeGrips />}
          <WebPreviewHost />
          <BrowserDomainDialog />
        </div>
      </HeaderSlotProvider>
    </ShellNavProvider>
  )
}

export default function SoloRoot() {
  const reduceMotion = useInterfaceSettings((s) => s.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <SoloShell />
          </ExtensionProvider>
          <AttachmentIngestionDialog />
          <ErrorDialog />
          <OutOfContextPromiseModal />
          <BypassConfirmDialog />
          <AccessRequestDialog />
          <ModelReplaceDialog />
        </TranslationProvider>
      </ServiceHubProvider>
    </MotionConfig>
  )
}
