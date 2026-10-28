import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  AppWindow,
  Copy,
  PictureInPicture2,
  PanelRight,
  Globe,
  ScanEye,
  Bot,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { WebPreviewPip } from '@/containers/WebPreviewPip'
import { useWebPreview } from '@/hooks/useWebPreview'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
import { useServiceHub } from '@/hooks/useServiceHub'
import { shouldIntercept } from '@/lib/webPreview'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNativeWebPreview } from '@/hooks/useNativeWebPreview'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkView } from '@/hooks/useCoworkView'
import { isLocalAppUrl } from '@/lib/browserVerify'
import { applyAnswer } from '@/lib/browserAgent'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import {
  resumeBrowserAgent,
  stopBrowserAgent,
  useBrowserAgentEvents,
  useBrowserAgentPane,
} from '@/hooks/useBrowserAgentPane'

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups'

/**
 * `allow-scripts` + `allow-same-origin` lets a framed page remove its own
 * sandbox when it is served from the app's origin, so such a page (or an
 * unparseable url) is never framed.
 */
function isAppOrigin(url: string): boolean {
  try {
    const origin = new URL(url, window.location.href).origin
    return (
      origin === window.location.origin ||
      origin === 'tauri://localhost' ||
      origin === 'http://tauri.localhost' ||
      origin === 'https://tauri.localhost'
    )
  } catch {
    return true
  }
}

/** Browser-tab style label: the site's icon and the page's title. */
function PageTab({ url, title }: { url: string; title: string }) {
  const [iconFailed, setIconFailed] = useState(false)
  let origin = ''
  let host = url
  try {
    const u = new URL(url)
    origin = u.origin
    host = u.host
  } catch {
    // keep the raw url as the label
  }
  useEffect(() => setIconFailed(false), [origin])
  return (
    <>
      {origin && !iconFailed ? (
        <img
          src={`${origin}/favicon.ico`}
          alt=""
          className="size-4 shrink-0"
          onError={() => setIconFailed(true)}
        />
      ) : (
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="truncate">{title || host}</span>
    </>
  )
}

/**
 * App-wide in-app web preview. Mounted once at the root. Installs a
 * capture-phase click listener that opens qualifying external links in the
 * preview, and renders the current URL on the side rail or as a floating PIP.
 * On desktop the page is shown in a native child webview laid over the panel
 * body (so sites that forbid framing still render); the sandboxed iframe is
 * the fallback when that is unavailable. Renders nothing while closed.
 */
export function WebPreviewHost() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const open = useWebPreview((s) => s.open)
  const surface = useWebPreview((s) => s.surface)
  // Subscribe to the history cursor so url() re-derives on navigation.
  useWebPreview((s) => s.index)
  const canGoBack = useWebPreview((s) => s.canGoBack())
  const canGoForward = useWebPreview((s) => s.canGoForward())
  const interceptLinks = useWebPreviewSettings((s) => s.interceptLinks)
  const coworkSessionId = useCoworkSessions((s) => s.currentId)
  const [nonce, setNonce] = useState(0)
  const agentActive = useBrowserAgentPane((s) => s.active)
  const agentPaused = useBrowserAgentPane((s) => s.paused)
  useBrowserAgentEvents(
    ({ url, reason }) =>
      toast.warning(t('browser-agent:pane.blocked', { reason }), {
        description: url,
        id: 'browser-agent-blocked',
      }),
    // A page tried to send the pane to a site nobody approved: it was stopped
    // before anything was requested. Ask; if allowed, go there now.
    ({ url, host }) => {
      void (async () => {
        const answer = await useBrowserAgentPrompt.getState().request({
          url,
          host,
          tool: 'browser_open',
        })
        if (await applyAnswer(host, answer)) {
          useWebPreview.getState().navigate(url)
        }
      })()
    }
  )
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const pageTitle = useWebPreview((s) => s.pageTitle)
  const currentUrl = useWebPreview.getState().url()
  // A question waiting for the user (a tool approval, a site to allow) needs
  // the whole screen: the native view is a window of its own that no DOM
  // overlay can cover, so it steps aside, and so does the panel around it,
  // until the question is answered. The page and its history stay as they are.
  const questionWaiting = useToolApprovalRequests(
    (s) => allApprovalRequests(s).length > 0
  )
  const siteQuestionWaiting = useBrowserAgentPrompt((s) => s.queue.length > 0)
  const suspended = questionWaiting || siteQuestionWaiting
  const mode = useNativeWebPreview({
    enabled: open && !!currentUrl,
    url: currentUrl,
    reloadNonce: nonce,
    container: viewport,
    suspended,
  })

  // Publish the pane's box (side panel width, PIP moves/resizes) so the
  // toaster can step around it. Measured when something that can move it
  // happens, one frame at a time, and written only when it changed; an idle
  // pane costs nothing.
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!paneEl) {
      useWebPreview.getState().setPaneRect(null)
      return
    }
    let frame = 0
    let last = ''
    const measure = () => {
      frame = 0
      const r = paneEl.getBoundingClientRect()
      const next = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      }
      const key = `${next.left},${next.top},${next.right},${next.bottom}`
      if (key === last) return
      last = key
      useWebPreview.getState().setPaneRect(next)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    // The pane resizing, or the layout around it (a sidebar opening, a
    // splitter dragged) resizing the window's content.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule)
    observer?.observe(paneEl)
    observer?.observe(document.body)
    window.addEventListener('resize', schedule)
    // A moved PIP or splitter is a pointer drag; ancestors scrolling or a
    // layout animation ending can shift the box without resizing it.
    document.addEventListener('pointermove', schedule, true)
    document.addEventListener('scroll', schedule, true)
    document.addEventListener('transitionend', schedule, true)
    document.addEventListener('animationend', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('pointermove', schedule, true)
      document.removeEventListener('scroll', schedule, true)
      document.removeEventListener('transitionend', schedule, true)
      document.removeEventListener('animationend', schedule, true)
      useWebPreview.getState().setPaneRect(null)
    }
  }, [paneEl])

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

  const url = useWebPreview.getState().url()
  if (!open || !url) return null

  const popOut = () =>
    void serviceHub.window().createWebviewWindow({
      label: `web-preview-${Date.now()}`,
      url,
      title: 'Flint',
      incognito: true,
      width: 1024,
      height: 768,
      resizable: true,
    })

  const toolbar = (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!canGoBack}
        aria-label={t('common:webPreview.back')}
        onClick={() => useWebPreview.getState().back()}
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!canGoForward}
        aria-label={t('common:webPreview.forward')}
        onClick={() => useWebPreview.getState().forward()}
      >
        <ArrowRight className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:webPreview.reload')}
        onClick={() => setNonce((n) => n + 1)}
      >
        <RotateCw className="size-4" aria-hidden />
      </Button>
      <span className="mx-1 min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-fg-2">
        {url}
      </span>
      {(agentActive || agentPaused) && (
        // While the assistant is driving, the user can take the pane back;
        // its browser calls are refused until they hand it over again.
        <Button
          variant={agentPaused ? 'outline' : 'secondary'}
          size="xs"
          data-testid="wp-agent-toggle"
          aria-label={
            agentPaused
              ? t('browser-agent:pane.handBack')
              : t('browser-agent:pane.takeOver')
          }
          title={
            agentPaused
              ? t('browser-agent:pane.paused')
              : t('browser-agent:pane.driving')
          }
          onClick={() =>
            void (agentPaused ? resumeBrowserAgent() : stopBrowserAgent())
          }
        >
          <Bot className="size-3.5" aria-hidden />
          {agentPaused
            ? t('browser-agent:pane.handBack')
            : t('browser-agent:pane.takeOver')}
        </Button>
      )}
      {isLocalAppUrl(url) && coworkSessionId && (
        // Hands the URL to the Cowork Preview's verifier, which runs it in a
        // separate, confined browser; this preview is left as it is.
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="wp-verify-in-browser"
          aria-label={t('common:browserVerify.title')}
          title={t('common:browserVerify.title')}
          onClick={() => {
            useBrowserVerify.getState().setDraftUrl(url)
            useCoworkView.getState().setRail(coworkSessionId, { kind: 'preview' })
          }}
        >
          <ScanEye className="size-4" aria-hidden />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="wp-copy-url"
        aria-label={t('common:webPreview.copyUrl')}
        title={t('common:webPreview.copyUrl')}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(url)
            .then(() => toast.success(t('common:webPreview.urlCopied')))
            .catch(() => toast.error(t('common:webPreview.copyFailed')))
        }
      >
        <Copy className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="wp-open-external"
        aria-label={t('common:webPreview.openExternal')}
        onClick={() => void serviceHub.opener().openUrl(url)}
      >
        <Globe className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="wp-pop-out"
        aria-label={t('common:webPreview.popOut')}
        onClick={popOut}
      >
        <AppWindow className="size-4" aria-hidden />
      </Button>
      {surface === 'side' ? (
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="wp-surface-toggle"
          aria-label={t('common:webPreview.showAsPip')}
          onClick={() => useWebPreview.getState().setSurface('pip')}
        >
          <PictureInPicture2 className="size-4" aria-hidden />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid="wp-surface-toggle"
          aria-label={t('common:webPreview.dockSide')}
          onClick={() => useWebPreview.getState().setSurface('side')}
        >
          <PanelRight className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  )

  const body = (
    <div ref={setPaneEl} className="flex h-full min-h-0 flex-col">
      {toolbar}
      {mode === 'iframe' ? (
        <>
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {t('common:webPreview.blockedBanner')}
            </span>
            <button
              type="button"
              className="shrink-0 underline"
              onClick={() => void serviceHub.opener().openUrl(url)}
            >
              {t('common:webPreview.openExternal')}
            </button>
          </div>
          {isAppOrigin(url) ? (
            <div data-testid="wp-same-origin" className="min-h-0 w-full flex-1 bg-card" />
          ) : (
            <iframe
              key={`${url}#${nonce}`}
              title={url}
              src={url}
              sandbox={SANDBOX}
              className="min-h-0 w-full flex-1 border-0 bg-card"
            />
          )}
        </>
      ) : (
        // The native webview is positioned over this box.
        <div
          ref={setViewport}
          data-testid="wp-native-viewport"
          className="min-h-0 w-full flex-1 bg-card"
        />
      )}
    </div>
  )

  if (surface === 'pip') {
    return (
      <div
        data-testid="wp-pip-wrap"
        data-suspended={suspended ? '' : undefined}
        className={cn(suspended && 'pointer-events-none invisible')}
      >
        <WebPreviewPip
          title={<PageTab url={url} title={pageTitle} />}
          onClose={() => useWebPreview.getState().close()}
        >
          {body}
        </WebPreviewPip>
      </div>
    )
  }
  return (
    // Below the header row, so the header's approvals chip and menus are never
    // under it; invisible (but alive) while a question waits.
    <div
      data-testid="wp-side-panel"
      data-suspended={suspended ? '' : undefined}
      className={cn(
        'absolute right-0 bottom-0 top-[52px] z-50 flex',
        suspended && 'pointer-events-none invisible'
      )}
    >
      <CoworkSidePanel
        title={t('common:webPreview.title')}
        onClose={() => useWebPreview.getState().close()}
      >
        {body}
      </CoworkSidePanel>
    </div>
  )
}
