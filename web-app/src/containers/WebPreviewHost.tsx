import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  SquareArrowOutUpRight,
  PictureInPicture2,
  PanelRight,
  ExternalLink,
  ScanEye,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups'

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
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const currentUrl = useWebPreview.getState().url()
  const mode = useNativeWebPreview({
    enabled: open && !!currentUrl,
    url: currentUrl,
    reloadNonce: nonce,
    container: viewport,
  })

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
        data-testid="wp-open-external"
        aria-label={t('common:webPreview.openExternal')}
        onClick={() => void serviceHub.opener().openUrl(url)}
      >
        <ExternalLink className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        data-testid="wp-pop-out"
        aria-label={t('common:webPreview.popOut')}
        onClick={popOut}
      >
        <SquareArrowOutUpRight className="size-4" aria-hidden />
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
    <div className="flex h-full min-h-0 flex-col">
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
          <iframe
            key={`${url}#${nonce}`}
            title={url}
            src={url}
            sandbox={SANDBOX}
            className="min-h-0 w-full flex-1 border-0 bg-card"
          />
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
    return <WebPreviewPip title={url}>{body}</WebPreviewPip>
  }
  return (
    <div className="absolute inset-y-0 right-0 z-50 flex">
      <CoworkSidePanel
        title={t('common:webPreview.title')}
        onClose={() => useWebPreview.getState().close()}
      >
        {body}
      </CoworkSidePanel>
    </div>
  )
}
