import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hasDesktopBackend } from '@/lib/desktopBackend'
import { errorText } from '@/lib/errorText'
import {
  listAccessGrants,
  revokeAccess,
  type AccessGrant,
} from '@/lib/accessRequests'

const ROW =
  'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0 [&>:first-child]:flex-[1_1_10rem]'
const EMPTY = 'py-3 text-[13px] text-muted-foreground'
const REVOKE = 'shrink-0 pointer-coarse:h-11'

type Translate = (key: string, values?: Record<string, unknown>) => string

function lifetime(g: AccessGrant, t: Translate, language?: string): string {
  if (g.persistent || g.expiresAt === null)
    return t('permissions:folderAccess.untilRevoked')
  return t('permissions:folderAccess.untilDate', {
    when: new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(g.expiresAt * 1000)),
  })
}

/**
 * Every folder or file an agent was granted through `request_access`, with a
 * way to take each one back. Revoking takes effect on the next tool call.
 */
export function FolderAccessCard() {
  const { t, i18n } = useTranslation()
  const [grants, setGrants] = useState<AccessGrant[] | null>(null)
  // A page served to a browser has no backend to ask.
  const desktop = hasDesktopBackend()

  const reload = useCallback(async () => {
    if (!desktop) return
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      if (!dataFolder) return setGrants([])
      setGrants(await listAccessGrants(dataFolder))
    } catch (e) {
      toast.error(errorText(e))
      setGrants([])
    }
  }, [desktop])

  useEffect(() => {
    void reload()
  }, [reload])

  const revoke = async (g: AccessGrant) => {
    try {
      const dataFolder = await getServiceHub().app().getJanDataFolder()
      if (dataFolder) await revokeAccess(dataFolder, g.id)
    } catch (e) {
      toast.error(errorText(e))
    }
    await reload()
  }

  return (
    <Card
      anchor="settings-permissions-folder-access"
      title={t('permissions:folderAccess.title')}
      description={t('permissions:folderAccess.description')}
      aside={<span className="tabular-nums">{grants?.length ?? 0}</span>}
      data-testid="folder-access-card"
    >
      {!desktop ? (
        <p className={EMPTY} data-testid="folder-access-desktop-only">
          {t('permissions:desktopOnly')}
        </p>
      ) : !grants || grants.length === 0 ? (
        <p className={EMPTY}>{t('permissions:folderAccess.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {grants.map((g) => (
            <li key={g.id} className={ROW} data-testid="folder-access-row">
              <div className="min-w-0 space-y-0.5">
                <p className="break-all font-mono text-xs text-foreground">
                  {g.display}
                </p>
                <p className="text-xs leading-[1.4] text-muted-foreground">
                  {g.mode === 'write'
                    ? t('permissions:folderAccess.readWrite')
                    : t('permissions:folderAccess.readOnly')}{' '}
                  · {lifetime(g, t, i18n?.language)}
                </p>
                {g.reason && (
                  <p className="break-words text-xs leading-[1.4] text-muted-foreground">
                    “{g.reason}”
                  </p>
                )}
              </div>
              <Button
                variant="destructive"
                className={REVOKE}
                aria-label={t('permissions:folderAccess.revokeLabel', {
                  path: g.display,
                })}
                onClick={() => void revoke(g)}
              >
                {t('permissions:folderAccess.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
