/* eslint-disable react-refresh/only-export-components */
import type { ModeratorConfig, Room, SpeakingMode } from '@/lib/rooms/types'
import { type CompareRun } from '@/lib/rooms/types'
import { type DraftParticipant } from '@/lib/rooms/roomDraft'
import { FieldError, type Errors } from './roomEditorShared'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { RoomModelSelect } from './RoomModelSelect'
import { Segmented } from '@/components/ui/segmented'
import { EFFORT_LEVELS, effortLabel, type EffortLevel } from '@/lib/modelEffort'
import { MODES, COMPARE_RUNS, LOCAL_PROVIDERS, CompareIsolationNote } from './roomEditorHelpers'

export function RoomDiscussionTab({
  hidden, uid, room, mode, compareRun, reasoningEffort = null, moderator, participants, visibleErrors, disabled, onMode, onCompareRun,
  onReasoningEffort, onModerator,
}: {
  hidden: boolean
  uid: string
  room: Room
  mode: SpeakingMode
  compareRun: CompareRun
  /** The room-wide effort ("same for all"); null: each model's default. */
  reasoningEffort?: EffortLevel | null
  moderator: ModeratorConfig
  participants: DraftParticipant[]
  visibleErrors: Errors
  disabled: boolean
  onMode: (v: SpeakingMode) => void
  onCompareRun: (v: CompareRun) => void
  onReasoningEffort?: (v: EffortLevel | null) => void
  onModerator: (v: ModeratorConfig) => void
}) {
  const { t } = useTranslation()
  return (
      <div hidden={hidden} className="flex min-w-0 flex-col gap-2.5">
        <span id={`${uid}-mode`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
          {t('rooms:editor.speakingMode')}
        </span>
        <RadioGroup
          aria-labelledby={`${uid}-mode`}
          aria-describedby={visibleErrors.mode ? `${uid}-mode-error` : undefined}
          value={mode}
          disabled={disabled}
          onValueChange={(v) => onMode(v as SpeakingMode)}
          className="gap-1"
        >
          {MODES.map((m) => (
            <label
              key={m}
              htmlFor={`${uid}-mode-${m}`}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-[10px] border-[0.8px] border-transparent p-2 transition-colors hover:bg-hover-row',
                mode === m && 'border-border bg-card shadow-lift'
              )}
            >
              <RadioGroupItem
                id={`${uid}-mode-${m}`}
                value={m}
                aria-label={t(`rooms:mode.${m}`)}
                aria-describedby={`${uid}-mode-${m}-hint`}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span id={`${uid}-mode-${m}-name`} className="block text-[length:calc(var(--ui-font-base)*0.8125)] font-medium">
                  {t(`rooms:mode.${m}`)}
                </span>
                <span id={`${uid}-mode-${m}-hint`} className="block text-xs text-muted-foreground">
                  {t(`rooms:mode.${m}Hint`)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <FieldError id={`${uid}-mode-error`} message={visibleErrors.mode} />
        {mode === 'compare' && (
          <CompareIsolationNote
            roomId={room.id}
            folder={room.folder ?? null}
            writers={participants.filter((p) => p.toolAccess === 'edit' || p.toolAccess === 'full').length}
            t={t}
          />
        )}
        {mode === 'compare' && (
          <div data-testid="compare-run-setting" className="flex min-w-0 flex-col gap-1.5 pt-1">
            <span id={`${uid}-run`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
              {t('rooms:editor.compareRun')}
            </span>
            <p className="text-xs text-muted-foreground">{t('rooms:editor.compareRunHint')}</p>
            <RadioGroup
              aria-labelledby={`${uid}-run`}
              value={compareRun}
              disabled={disabled}
              onValueChange={(v) => onCompareRun(v as CompareRun)}
              className="gap-1"
            >
              {COMPARE_RUNS.map((r) => (
                <label
                  key={r}
                  htmlFor={`${uid}-run-${r}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-[10px] border-[0.8px] border-transparent p-2 text-[length:calc(var(--ui-font-base)*0.8125)] transition-colors hover:bg-hover-row',
                    compareRun === r && 'border-border bg-card shadow-lift'
                  )}
                >
                  <RadioGroupItem id={`${uid}-run-${r}`} value={r} />
                  {t(`rooms:editor.compareRunOption.${r}`)}
                </label>
              ))}
            </RadioGroup>
            {compareRun === 'together' &&
              participants.filter((p) => LOCAL_PROVIDERS.includes(p.model.provider)).length >= 2 && (
                <p data-testid="compare-run-suggest" className="text-xs text-warning">
                  {t('rooms:editor.compareRunSuggest')}
                </p>
              )}
          </div>
        )}

        {onReasoningEffort && (
          <div data-testid="room-reasoning-effort" className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-2.5">
            <span className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
              {t('rooms:editor.roomEffort')}
            </span>
            <p className="text-xs text-muted-foreground">{t('rooms:editor.roomEffortHint')}</p>
            <Segmented<string>
              size="sm"
              wrap
              aria-label={t('rooms:editor.roomEffort')}
              value={reasoningEffort ?? 'default'}
              onValueChange={(next) =>
                !disabled && onReasoningEffort(next === 'default' ? null : (next as EffortLevel))
              }
              options={[
                { value: 'default', label: t('rooms:editor.reasoningEffortDefault') },
                ...EFFORT_LEVELS.map((l) => ({ value: l, label: effortLabel(l) })),
              ]}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
          <div className="min-w-0">
            <Label htmlFor={`${uid}-mod-enabled`}>{t('rooms:editor.moderatorEnable')}</Label>
            <p className="text-xs text-muted-foreground">{t('rooms:editor.moderatorNoTools')}</p>
          </div>
          <Switch
            id={`${uid}-mod-enabled`}
            aria-label={t('rooms:editor.moderatorEnable')}
            checked={moderator.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => onModerator({ ...moderator, enabled })}
          />
        </div>
        {moderator.enabled && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`${uid}-mod-name`}>{t('rooms:editor.moderatorName')}</Label>
              <Input
                id={`${uid}-mod-name`}
                value={moderator.name}
                aria-invalid={Boolean(visibleErrors['moderator:name']) || undefined}
                aria-describedby={`${uid}-mod-name-error`}
                onChange={(e) => onModerator({ ...moderator, name: e.target.value })}
              />
              <FieldError id={`${uid}-mod-name-error`} message={visibleErrors['moderator:name']} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`${uid}-mod-model`}>{t('rooms:editor.moderatorModel')}</Label>
              <RoomModelSelect
                id={`${uid}-mod-model`}
                value={moderator.model}
                disabled={disabled}
                invalid={Boolean(visibleErrors['moderator:model'])}
                describedBy={`${uid}-mod-model-error`}
                onChange={(model) => onModerator({ ...moderator, model })}
              />
              <FieldError id={`${uid}-mod-model-error`} message={visibleErrors['moderator:model']} />
            </div>
          </div>
        )}
      </div>
  )
}
