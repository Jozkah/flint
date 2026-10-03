import { useEffect } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'

/** Listen for the agent's browser notices while the caller is mounted. */
export function useBrowserToolMirrorListening(): void {
  useEffect(() => {
    let detach: (() => void) | undefined
    let cancelled = false
    void useBrowserToolMirror
      .getState()
      .attach()
      .then((d) => {
        if (cancelled) d()
        else detach = d
      })
    return () => {
      cancelled = true
      detach?.()
    }
  }, [])
}

/**
 * Watch what the agent's `browser` tool is doing, in the preview panel.
 *
 * Read-only by construction: it shows the address, title and last action the
 * backend reports, and the latest small picture of the page. The page itself is
 * never loaded here -- the agent works in its own throwaway browser, and this
 * panel only ever renders an image -- so watching gives the page no way into
 * Flint's preview webview or profile.
 *
 * It listens only while mounted (the backend takes no pictures otherwise) and
 * renders nothing until the agent has used the browser. The agent's browser
 * closing, or going idle, clears it.
 */
export function BrowserToolMirror({
  sessionId,
}: {
  sessionId: string | null | undefined
}) {
  const { t } = useTranslation()
  const view = useBrowserToolMirror((s) => (sessionId ? s.byId[sessionId] : undefined))

  useBrowserToolMirrorListening()
  // This panel is showing the browser: the backend takes the pictures for it.
  useEffect(() => useBrowserToolMirror.getState().watch(), [])

  if (!view) return null
  return (
    <section
      data-testid="browser-tool-mirror"
      aria-label={t('common:browserToolMirror.title')}
      className="flex flex-col gap-1.5 border-b border-border px-3 py-3 text-xs"
    >
      <h3 className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
        {t('common:browserToolMirror.title')}
      </h3>
      <p className="text-subtle-foreground">{t('common:browserToolMirror.note')}</p>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span data-testid="btm-url" className="truncate font-mono" title={view.url}>
          {view.url || '—'}
        </span>
        {view.title ? (
          <span data-testid="btm-title" className="truncate text-muted-foreground" title={view.title}>
            {view.title}
          </span>
        ) : null}
        <span data-testid="btm-action" className="truncate text-muted-foreground" title={view.action}>
          {t('common:browserToolMirror.lastAction', { action: view.action })}
        </span>
      </div>
      {view.screenshot ? (
        <img
          data-testid="btm-screenshot"
          alt={t('common:browserToolMirror.screenshotAlt')}
          src={view.screenshot}
          className="max-h-64 w-full rounded border border-border object-contain object-top"
        />
      ) : null}
    </section>
  )
}
