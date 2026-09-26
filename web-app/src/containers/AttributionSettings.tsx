import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  DEFAULT_ATTRIBUTION_SETTINGS,
  getAttributionSettings,
  setAttributionSettings,
  type AttributionSettings as Settings,
} from '@/lib/gitAttribution'

/**
 * The two attribution switches for the agent's `git` work: Flint as co-author
 * on commits, and "Generated with Flint" on pull requests. Both default to on,
 * are stored in the data folder, and are read by the desktop and the CLI.
 */
export function AttributionSettings() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<Settings>(DEFAULT_ATTRIBUTION_SETTINGS)

  useEffect(() => {
    let live = true
    getAttributionSettings()
      .then((s) => live && setSettings(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const change = (patch: Partial<Settings>) => {
    const previous = settings
    const next = { ...settings, ...patch }
    setSettings(next)
    setAttributionSettings(next).catch((e) => {
      setSettings(previous)
      toast.error(String(e))
    })
  }

  return (
    <>
      <CardItem
        anchor="settings-agent-tools-coauthor"
        title={t('settings:agentTools.attributionCommits')}
        description={t('settings:agentTools.attributionCommitsDesc')}
        align="start"
        actions={
          <Switch
            data-testid="attribution-commits"
            checked={settings.commits}
            onCheckedChange={(commits) => change({ commits })}
          />
        }
      />
      <CardItem
        anchor="settings-agent-tools-pr-footer"
        title={t('settings:agentTools.attributionPullRequests')}
        description={t('settings:agentTools.attributionPullRequestsDesc')}
        align="start"
        actions={
          <Switch
            data-testid="attribution-pull-requests"
            checked={settings.pullRequests}
            onCheckedChange={(pullRequests) => change({ pullRequests })}
          />
        }
      />
    </>
  )
}
