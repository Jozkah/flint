import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import { hasDesktopBackend } from '@/lib/desktopBackend'
import {
  listTrustedFolders,
  revokeFolderTrust,
  trustFolder,
} from '@/lib/folderTrust'

const ROW =
  'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0 [&>:first-child]:flex-[1_1_10rem]'
const EMPTY = 'py-3 text-[13px] text-muted-foreground'
const ACTION = 'shrink-0 pointer-coarse:h-11'

/**
 * Every folder the person trusted to run its own hooks and agent definitions,
 * with a way to take each back and to trust one ahead of being asked.
 */
export function TrustedFoldersCard() {
  const { t } = useTranslation()
  const [folders, setFolders] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // A page served to a browser has no backend to ask.
  const desktop = hasDesktopBackend()

  const reload = useCallback(async () => {
    if (!desktop) return
    try {
      setFolders(await listTrustedFolders())
    } catch (e) {
      toast.error(
        `${t('permissions:trustedFolders.loadFailed')}: ${errorText(e)}`
      )
      setFolders([])
    }
  }, [t, desktop])

  useEffect(() => {
    void reload()
  }, [reload])

  const stop = async (folder: string) => {
    try {
      await revokeFolderTrust(folder)
      setConfirming(null)
    } catch (e) {
      toast.error(
        `${t('permissions:trustedFolders.revokeFailed')}: ${errorText(e)}`
      )
    }
    await reload()
  }

  const add = async () => {
    try {
      const picked = await getServiceHub().dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (typeof path !== 'string' || !path) return
      await trustFolder(path)
    } catch (e) {
      toast.error(
        `${t('permissions:trustedFolders.grantFailed')}: ${errorText(e)}`
      )
    }
    await reload()
  }

  return (
    <Card
      anchor="settings-permissions-trusted-folders"
      title={t('permissions:trustedFolders.title')}
      description={t('permissions:trustedFolders.description')}
      aside={<span className="tabular-nums">{folders?.length ?? 0}</span>}
      data-testid="trusted-folders-card"
    >
      {!desktop ? (
        <p className={EMPTY} data-testid="trusted-folders-desktop-only">
          {t('permissions:desktopOnly')}
        </p>
      ) : !folders || folders.length === 0 ? (
        <p className={EMPTY} data-testid="trusted-folders-empty">
          {t('permissions:trustedFolders.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {folders.map((folder) => (
            <li key={folder} className={ROW} data-testid="trusted-folder-row">
              <div className="min-w-0 space-y-1">
                <p className="select-text break-all font-mono text-xs text-foreground">
                  {folder}
                </p>
                {confirming === folder && (
                  <p
                    role="alert"
                    className="break-words text-xs leading-[1.4] text-muted-foreground"
                  >
                    {t('permissions:trustedFolders.confirm', { folder })}
                  </p>
                )}
              </div>
              {confirming === folder ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    className={ACTION}
                    onClick={() => setConfirming(null)}
                  >
                    {t('permissions:trustedFolders.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    className={ACTION}
                    onClick={() => void stop(folder)}
                  >
                    {t('permissions:trustedFolders.confirmYes')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  className={ACTION}
                  aria-label={t('permissions:trustedFolders.stopLabel', {
                    folder,
                  })}
                  onClick={() => setConfirming(folder)}
                >
                  {t('permissions:trustedFolders.stop')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {desktop && (
        <div className="pt-3">
          <Button variant="outline" onClick={() => void add()}>
            {t('permissions:trustedFolders.add')}
          </Button>
        </div>
      )}
    </Card>
  )
}
