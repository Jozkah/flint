import { useEffect, useState } from 'react'
import { OctagonAlert } from 'lucide-react'
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
import { Select } from '@/components/ui/select'

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
      className="w-[110px] text-right tabular-nums"
      defaultValue={policy?.[field]}
      key={`${field}-${policy?.[field]}`}
      onBlur={(e) => {
        const value = Number(e.currentTarget.value)
        if (Number.isFinite(value) && value !== policy?.[field]) void save({ [field]: value })
      }}
    />
  )

  return (
    <Card title={t('settings:compaction.title')}>
      {error && (
        <p
          role="alert"
          className="my-2 flex items-start gap-2 rounded-md bg-destructive-tint px-3 py-2 text-sm text-destructive"
        >
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{error}</span>
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
              <Select
                aria-label={t('settings:compaction.strategy')}
                className="min-w-[140px]"
                value={policy.strategy}
                onChange={(e) =>
                  void save({ strategy: e.target.value as CompactionPolicy['strategy'] })
                }
              >
                <option value="summarize">{t('settings:compaction.summarize')}</option>
                <option value="trim">{t('settings:compaction.trim')}</option>
              </Select>
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
