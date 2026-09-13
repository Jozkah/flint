import { useEffect, useState } from 'react'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  getCompactionPolicy,
  setCompactionPolicy,
  type CompactionLayer,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'

/**
 * The shared compaction policy (AH-076), edited at user scope. What is shown is
 * the effective policy; a value a project overrides says so, because editing
 * the user's value would not change what that project does.
 */
export function CompactionPolicySettings() {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<CompactionPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getCompactionPolicy()
      .then(setPolicy)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  const save = async (layer: CompactionLayer) => {
    try {
      setPolicy(await setCompactionPolicy(layer))
      setError(null)
    } catch (e) {
      const text = String(e)
      setError(text)
      toast.error(t('settings:compaction.saveFailed'), { description: text })
    }
  }

  const note = (field: keyof CompactionPolicy['origins']) =>
    policy?.origins[field] === 'project' ? ` ${t('settings:compaction.projectOverride')}` : ''

  const numberField = (
    field: 'reserveTokens' | 'keepRecent' | 'summaryMaxTokens',
    label: string
  ) => (
    <Input
      type="number"
      aria-label={label}
      className="w-28"
      defaultValue={policy?.[field]}
      key={`${field}-${policy?.[field]}`}
      onBlur={(e) => {
        const value = Number(e.currentTarget.value)
        if (Number.isFinite(value) && value !== policy?.[field]) void save({ [field]: value })
      }}
    />
  )

  return (
    <Card
      header={
        <h1 className="text-foreground font-studio font-medium text-base mb-2">
          {t('settings:compaction.title')}
        </h1>
      }
    >
      {error && (
        <p role="alert" className="text-destructive text-sm px-2">
          {error}
        </p>
      )}
      {policy && (
        <>
          <CardItem
            title={t('settings:compaction.auto')}
            description={t('settings:compaction.autoDescription') + note('auto')}
            actions={
              <Switch
                aria-label={t('settings:compaction.auto')}
                checked={policy.auto}
                onCheckedChange={(checked) => void save({ auto: checked })}
              />
            }
          />
          <CardItem
            title={t('settings:compaction.reserveTokens')}
            description={t('settings:compaction.reserveDescription') + note('reserveTokens')}
            actions={numberField('reserveTokens', t('settings:compaction.reserveTokens'))}
          />
          <CardItem
            title={t('settings:compaction.keepRecent')}
            description={t('settings:compaction.keepRecentDescription') + note('keepRecent')}
            actions={numberField('keepRecent', t('settings:compaction.keepRecent'))}
          />
          <CardItem
            title={t('settings:compaction.strategy')}
            description={t('settings:compaction.strategyDescription') + note('strategy')}
            actions={
              <select
                aria-label={t('settings:compaction.strategy')}
                className="bg-background border rounded px-2 py-1 text-sm"
                value={policy.strategy}
                onChange={(e) =>
                  void save({ strategy: e.currentTarget.value as CompactionPolicy['strategy'] })
                }
              >
                <option value="summarize">{t('settings:compaction.summarize')}</option>
                <option value="trim">{t('settings:compaction.trim')}</option>
              </select>
            }
          />
          <CardItem
            title={t('settings:compaction.summaryMaxTokens')}
            description={t('settings:compaction.summaryDescription') + note('summaryMaxTokens')}
            actions={numberField('summaryMaxTokens', t('settings:compaction.summaryMaxTokens'))}
          />
        </>
      )}
    </Card>
  )
}
