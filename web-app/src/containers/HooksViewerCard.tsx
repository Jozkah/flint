import { useEffect, useState } from 'react'
import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hasDesktopBackend } from '@/lib/desktopBackend'
import { listTrustedFolders } from '@/lib/folderTrust'
import { hooksReport, type HooksReport } from '@/lib/hooksReport'

const EMPTY =
  'py-3 text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground'

/**
 * Read-only list of the hooks each trusted folder declares, with the file they
 * come from and what each is set to do. Editing stays in `hooks.toml`.
 */
export function HooksViewerCard() {
  const { t } = useTranslation()
  const desktop = hasDesktopBackend()
  const [reports, setReports] = useState<HooksReport[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let live = true
    void (async () => {
      try {
        const folders = await listTrustedFolders()
        const all = await Promise.all(folders.map((f) => hooksReport(f)))
        if (live)
          setReports(all.filter((r): r is HooksReport => !!r && r.exists))
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [desktop])

  return (
    <Card
      anchor="settings-permissions-hooks"
      title={t('permissions:hooksViewer.title')}
      description={t('permissions:hooksViewer.description')}
      data-testid="hooks-viewer-card"
    >
      {!desktop ? (
        <p className={EMPTY}>{t('permissions:desktopOnly')}</p>
      ) : failed ? (
        <p className={EMPTY}>{t('permissions:hooksViewer.loadFailed')}</p>
      ) : !reports || reports.length === 0 ? (
        <p className={EMPTY} data-testid="hooks-viewer-empty">
          {t('permissions:hooksViewer.empty')}
        </p>
      ) : (
        reports.map((r) => (
          <div
            key={r.source}
            className="space-y-1 py-2"
            data-testid="hooks-viewer-file"
          >
            <p className="select-text break-all font-mono text-xs text-foreground">
              {r.source}
            </p>
            {r.error && (
              <p role="alert" className="text-xs text-destructive">
                {t('permissions:hooksViewer.error')}: {r.error}
              </p>
            )}
            {r.hooks.length === 0 && !r.error && (
              <p className={EMPTY}>{t('permissions:hooksViewer.none')}</p>
            )}
            <ul className="flex flex-col gap-1">
              {r.hooks.map((h, i) => (
                <li key={i} className="font-mono text-xs text-muted-foreground">
                  <span className="text-foreground">{h.event}</span> [
                  {h.onFailure}] {h.timeoutSecs}s {h.command}
                  {h.if ? ` if=${h.if}` : ''}
                  {h.tools.length ? ` tools=${h.tools.join(',')}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Card>
  )
}
