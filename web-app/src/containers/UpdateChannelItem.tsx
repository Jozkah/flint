import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CardItem } from '@/containers/Card'
import { useBuildUpdate } from '@/hooks/useBuildUpdate'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { directionOf, type Channel, type ChannelRelease } from '@/lib/buildUpdate'

/** How many versions of the chosen channel to list. */
const SHOWN = 8

/**
 * Settings, General: which release line to follow, and the recent versions on
 * it. Flint installs nothing itself; Install and Downgrade open the release
 * page. The list fills only from a check the person turned on or asked for.
 */
export function UpdateChannelItem() {
  const { t } = useTranslation()
  const channel = useBuildUpdate((s) => s.channel)
  const setChannel = useBuildUpdate((s) => s.setChannel)
  const releases = useBuildUpdate((s) => s.releases)
  const [downgrade, setDowngrade] = useState<ChannelRelease | null>(null)

  const open = (url: string) => void getServiceHub().opener().openUrl(url)
  const hasBeta = releases?.some((r) => r.channel === 'beta') ?? false
  const shown = releases?.filter((r) => r.channel === channel).slice(0, SHOWN) ?? null

  return (
    <>
      <CardItem
        anchor="settings-general-update-channel"
        title={t('settings:general.updateChannel')}
        description={t('settings:general.updateChannelDesc')}
        actions={
          <Select
            aria-label={t('settings:general.updateChannel')}
            className="min-w-[140px]"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
          >
            <option value="release">{t('settings:general.channelRelease')}</option>
            {(hasBeta || channel === 'beta') && (
              <option value="beta">{t('settings:general.channelBeta')}</option>
            )}
            <option value="nightly">{t('settings:general.channelNightly')}</option>
          </Select>
        }
      />
      <CardItem
        title={t('settings:general.channelVersions')}
        description={
          !shown ? (
            t('settings:general.channelEmpty')
          ) : !shown.length ? (
            t('settings:general.channelNone')
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {shown.map((r) => {
                const direction = directionOf(r, releases ?? [], VERSION, BUILD_COMMIT)
                return (
                  <li key={r.tag} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs text-foreground">
                      {r.version}
                      {r.publishedAt > 0 && (
                        <span className="ml-2 text-muted-foreground">
                          {new Date(r.publishedAt).toLocaleDateString()}
                        </span>
                      )}
                    </span>
                    {direction === 'installed' ? (
                      <span className="text-xs text-muted-foreground">
                        {t('settings:general.channelInstalled')}
                      </span>
                    ) : direction === 'older' ? (
                      <Button size="sm" variant="outline" onClick={() => setDowngrade(r)}>
                        {t('settings:general.channelDowngrade')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={direction === 'newer' ? 'default' : 'outline'}
                        onClick={() => open(r.url)}
                      >
                        {direction === 'newer'
                          ? t('settings:general.channelInstall')
                          : t('settings:general.channelOpen')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )
        }
      />
      <Dialog open={!!downgrade} onOpenChange={(o) => !o && setDowngrade(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings:general.downgradeTitle', { version: downgrade?.version ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('settings:general.downgradeDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDowngrade(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (downgrade) open(downgrade.url)
                setDowngrade(null)
              }}
            >
              {t('settings:general.downgradeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
