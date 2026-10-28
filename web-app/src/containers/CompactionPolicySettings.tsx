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
  clampCompactAtPercent,
  type CompactionLayer,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'

/** Choices for "compact at": 50% to 95% of the window in steps of 5. */
const COMPACT_AT_CHOICES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95]
import { Select } from '@/components/ui/select'
import { useLeanToolsConfig } from '@/hooks/useLeanToolsConfig'
import type { SmallContextMode } from '@/lib/smallContext'

/**
 * The shared compaction policy (AH-076), edited at user scope. What is shown is
 * the effective policy; a value a project overrides says so, because editing
 * the user's value would not change what that project does.
 */
export function CompactionPolicySettings() {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<CompactionPolicy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const leanSmallWindows = useLeanToolsConfig((s) => s.leanSmallWindows)
  const setLeanSmallWindows = useLeanToolsConfig((s) => s.setLeanSmallWindows)
  const smallContextMode = useLeanToolsConfig((s) => s.smallContextMode)
  const setSmallContextMode = useLeanToolsConfig((s) => s.setSmallContextMode)

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
    <Card anchor="settings-agent-tools-compaction" title={t('settings:compaction.title')}>
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
            title={t('settings:compaction.compactAt')}
            description={t('settings:compaction.compactAtDescription') + note('compactAtPercent')}
            actions={
              <Select
                aria-label={t('settings:compaction.compactAt')}
                data-testid="compact-at-percent"
                className="min-w-[140px]"
                value={String(clampCompactAtPercent(policy.compactAtPercent ?? 0))}
                onChange={(e) =>
                  void save({ compactAtPercent: clampCompactAtPercent(Number(e.target.value)) })
                }
              >
                <option value="0">{t('settings:compaction.compactAtAuto')}</option>
                {COMPACT_AT_CHOICES.map((p) => (
                  <option key={p} value={String(p)}>
                    {p}%
                  </option>
                ))}
              </Select>
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
      <CardItem
        title={t('settings:compaction.smallContext')}
        description={t('settings:compaction.smallContextDescription')}
        actions={
          <Select
            aria-label={t('settings:compaction.smallContext')}
            data-testid="small-context-mode"
            className="min-w-[140px]"
            value={smallContextMode}
            onChange={(e) => setSmallContextMode(e.target.value as SmallContextMode)}
          >
            <option value="auto">{t('settings:compaction.smallContextAuto')}</option>
            <option value="always">{t('settings:compaction.smallContextAlways')}</option>
            <option value="never">{t('settings:compaction.smallContextNever')}</option>
          </Select>
        }
      />
      <CardItem
        title={t('settings:compaction.leanTools')}
        description={t('settings:compaction.leanToolsDescription')}
        actions={
          <Switch
            aria-label={t('settings:compaction.leanTools')}
            data-testid="lean-small-window-tools"
            checked={leanSmallWindows}
            onCheckedChange={setLeanSmallWindows}
          />
        }
      />
    </Card>
  )
}
