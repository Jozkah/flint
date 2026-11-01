/* eslint-disable react-refresh/only-export-components */
import { LIMIT_KEYS, BUDGET_KEYS, type LimitDraft, type RoomDraft } from '@/lib/rooms/roomDraft'
import { ROOM_TOOL_BUDGET_CEILINGS } from '@/lib/rooms/toolBudget'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { displayCeiling, displayMin, parseLimit, showLimit, budgetDefault } from './roomEditorHelpers'

export function RoomLimitsTab({
  hidden, uid, limits, budget, missingPricing, onLimits, onBudget,
}: {
  hidden: boolean
  uid: string
  limits: LimitDraft
  budget: RoomDraft['budget']
  missingPricing: boolean
  onLimits: (v: LimitDraft) => void
  onBudget: (v: RoomDraft['budget']) => void
}) {
  const { t } = useTranslation()
  return (
      <div hidden={hidden} className="flex min-w-0 flex-col gap-2.5">
        <p className="text-xs text-muted-foreground">{t('rooms:editor.limitsHint')}</p>
        <div className="grid gap-x-2.5 gap-y-3 sm:grid-cols-2">
          {LIMIT_KEYS.map((key) => {
            const lid = `${uid}-limit-${key}`
            const ceiling = displayCeiling(key)
            const raw = limits[key]
            const parsed = parseLimit(key, raw)
            return (
              <div
                key={key}
                className={cn('flex min-w-0 flex-col gap-1.5', key === 'maxCostUsd' && 'sm:col-span-2')}
              >
                <Label htmlFor={lid}>{t(`rooms:limits.${key}`)}</Label>
                <Input
                  id={lid}
                  type="number"
                  className="tabular-nums"
                  min={key === 'maxCostUsd' || key === 'repetitionSimilarity' ? 0 : 1}
                  max={ceiling ?? undefined}
                  step={key === 'repetitionSimilarity' ? '0.05' : key === 'maxCostUsd' ? '0.01' : '1'}
                  value={raw}
                  placeholder={key === 'maxCostUsd' ? t('rooms:editor.costNone') : undefined}
                  aria-describedby={`${lid}-hint`}
                  onChange={(e) => onLimits({ ...limits, [key]: e.target.value })}
                  onBlur={() => {
                    // Only a real change marks the draft dirty (F8-020).
                    const shown = showLimit(key, parsed.value)
                    if (shown !== limits[key]) onLimits({ ...limits, [key]: shown })
                  }}
                />
                <p id={`${lid}-hint`} className="text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                  {parsed.capped && ceiling !== null ? (
                    <span className="text-destructive">{t('rooms:editor.clamped', { max: ceiling })}</span>
                  ) : parsed.raised ? (
                    <span className="text-destructive">
                      {t('rooms:editor.raisedToMin', { min: displayMin(key) })}
                    </span>
                  ) : key === 'maxCostUsd' ? (
                    t('rooms:editor.costHint')
                  ) : (
                    ceiling !== null && t('rooms:editor.ceiling', { max: ceiling })
                  )}
                </p>
                {key === 'maxCostUsd' && missingPricing && (
                  <p className="text-xs text-destructive" data-testid="cost-missing-pricing">
                    {t('rooms:editor.costMissingPricing')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <div data-testid="tool-budget" className="flex min-w-0 flex-col gap-2 pt-2">
          <span className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">{t('rooms:editor.budget.heading')}</span>
          <p className="text-xs text-muted-foreground">{t('rooms:editor.budget.hint')}</p>
          <div className="grid gap-x-2.5 gap-y-3 sm:grid-cols-3">
            {BUDGET_KEYS.map((key) => {
              const bid = `${uid}-budget-${key}`
              return (
                <div key={key} className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={bid}>{t(`rooms:editor.budget.${key}`)}</Label>
                  <Input
                    id={bid}
                    type="number"
                    className="tabular-nums"
                    min={1}
                    max={ROOM_TOOL_BUDGET_CEILINGS[key]}
                    value={budget[key]}
                    placeholder={t('rooms:editor.budget.default', { value: budgetDefault(key) })}
                    onChange={(e) => onBudget({ ...budget, [key]: e.target.value })}
                  />
                  <p className="text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                    {t('rooms:editor.ceiling', { max: ROOM_TOOL_BUDGET_CEILINGS[key] })}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </div>
  )
}
