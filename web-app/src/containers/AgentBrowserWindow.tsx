import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isLive,
  useBrowserToolMirror,
  useBrowserToolMirrorListening,
  useBrowserToolWatching,
} from '@/hooks/useBrowserToolMirror'

/**
 * The agent's own browser, shown in a window that looks like the in-app
 * preview (an address row, a viewport) and is read-only by construction.
 *
 * It is not a browser: it shows what the backend reports about the agent's
 * separate, confined browser -- address, title, tabs, the last action -- and
 * the live picture of its page (a throttled screencast, plus a sharp picture
 * after each action). The page is never loaded here, nothing is scripted and no
 * input goes back, so watching gives the page no way into Flint's own preview
 * webview or profile.
 *
 * Listens whenever it is mounted, renders nothing until the agent has used its
 * browser, and asks the backend for pictures only while it is showing one.
 */
export function AgentBrowserWindow({
  sessionId,
  onHide,
  className,
}: {
  sessionId: string | null | undefined
  /** Hide the window (the agent's next use brings it back). */
  onHide?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const view = useBrowserToolMirror((s) => (sessionId ? s.byId[sessionId] : undefined))
  useBrowserToolMirrorListening()
  useBrowserToolWatching(!!view)

  // "Live" is read off the clock, so it has to be re-read as time passes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!view) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [view])

  if (!view) return null
  const live = isLive(view, now)
  return (
    <section
      data-testid="agent-browser-window"
      aria-label={t('common:browserToolMirror.title')}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-xs',
        className
      )}
    >
      {/* The preview's own chrome: navigation and the address, here for show --
          the agent drives, the user watches. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button variant="ghost" size="icon-xs" disabled aria-label={t('common:webPreview.back')}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-xs" disabled aria-label={t('common:webPreview.forward')}>
          <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-xs" disabled aria-label={t('common:webPreview.reload')}>
          <RotateCw className="size-4" aria-hidden />
        </Button>
        <span
          data-testid="abw-url"
          className="mx-1 min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs text-fg-2"
          title={view.url}
        >
          {view.url || '—'}
        </span>
        <span
          data-testid="abw-live"
          data-live={live ? 'true' : 'false'}
          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
        >
          <span
            aria-hidden
            className={cn('size-1.5 rounded-full', live ? 'bg-success motion-safe:animate-pulse' : 'bg-muted-foreground/50')}
          />
          {live ? t('common:browserToolMirror.live') : t('common:browserToolMirror.idle')}
        </span>
        {onHide ? (
          <Button
            variant="ghost"
            size="icon-xs"
            data-testid="abw-hide"
            aria-label={t('common:browserToolMirror.hide')}
            title={t('common:browserToolMirror.hide')}
            onClick={onHide}
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      {view.tabs.length > 1 ? (
        <div
          role="tablist"
          aria-label={t('common:browserToolMirror.tabs')}
          data-testid="abw-tabs"
          className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-2 py-1"
        >
          {view.tabs.map((tab) => (
            <span
              key={tab.id}
              role="tab"
              aria-selected={tab.active}
              title={tab.title || tab.id}
              className={cn(
                'max-w-[9rem] shrink-0 truncate rounded-md px-2 py-0.5',
                tab.active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {tab.title || tab.id}
            </span>
          ))}
        </div>
      ) : null}
      {/* The viewport: the page as a picture, never the page. */}
      <div data-testid="abw-viewport" className="relative min-h-0 flex-1 bg-card">
        {view.screenshot ? (
          <img
            data-testid="abw-frame"
            alt={t('common:browserToolMirror.screenshotAlt')}
            src={view.screenshot}
            className="absolute inset-0 size-full object-contain object-top"
          />
        ) : (
          <div className="grid size-full place-items-center p-4 text-center text-muted-foreground">
            {t('common:browserToolMirror.waiting')}
          </div>
        )}
      </div>
      <div className="flex min-w-0 shrink-0 flex-col gap-0.5 border-t border-border px-3 py-2">
        {view.title ? (
          <span data-testid="abw-title" className="truncate font-medium" title={view.title}>
            {view.title}
          </span>
        ) : null}
        <span data-testid="abw-action" className="truncate text-muted-foreground" title={view.action}>
          {t('common:browserToolMirror.lastAction', { action: view.action })}
        </span>
      </div>
    </section>
  )
}
