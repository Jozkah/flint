/* eslint-disable react-refresh/only-export-components */
// Module-level pieces of the room editor (limit parsing, validation, the
// isolation note, the participant reasoning field). Moved out of RoomEditor.tsx
// unchanged.
import { useEffect, useState } from 'react'
import type { ModeratorConfig, ParticipantReasoning, RoomLimits, SpeakingMode, ToolAccess } from '@/lib/rooms/types'
import { type CompareRun } from '@/lib/rooms/types'
import { LIMIT_KEYS, MINUTE_MS, type BudgetKey, type DraftParticipant, type LimitDraft } from '@/lib/rooms/roomDraft'
import { norm, type Errors } from './roomEditorShared'
import { noteIsolation, useIsolationNotes } from '@/lib/rooms/isolation'
import { resolveToolBudget } from '@/lib/rooms/toolBudget'
import { folderTrustStatus, trustFolder } from '@/lib/folderTrust'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { clampLimit, limitCeiling, limitMin } from './roomUi'
import { participantReasoningControls } from '@/lib/rooms/participantReasoning'
import { DEFAULT_THINKING_BUDGET_LEVEL, THINKING_BUDGET_LEVELS, thinkingBudgetLabel, type ThinkingBudgetLevelKey } from '@/lib/thinkingBudget'
import { effortLabel, isEffortLevel } from '@/lib/modelEffort'

export type T = (key: string, options?: Record<string, unknown>) => string

export const MODES: SpeakingMode[] = ['round-robin', 'user-selected', 'moderator-selected', 'compare']
export const COMPARE_RUNS: CompareRun[] = ['together', 'one-by-one']
/** Providers that run on this machine, where two models at once compete for memory. */
export const LOCAL_PROVIDERS = ['llamacpp', 'mlx']

export const MINUTE = MINUTE_MS

/** Displayed ceiling for a limit, in the unit the field is edited in. */
export function displayCeiling(key: keyof RoomLimits): number | null {
  const max = limitCeiling(key)
  if (max === null) return null
  return key === 'maxDurationMs' ? max / MINUTE : max
}

/** The minimum shown to the user, in the same unit as the input. */
export function displayMin(key: keyof RoomLimits): number {
  const min = limitMin(key)
  return key === 'maxDurationMs' ? min / MINUTE : min
}

export function parseLimit(
  key: keyof RoomLimits,
  raw: string
): { value: number | null; capped: boolean; raised: boolean } {
  if (key === 'maxCostUsd') {
    if (raw.trim() === '') return { value: null, capped: false, raised: false }
    const n = Number(raw)
    const valid = Number.isFinite(n) && n >= 0
    return { value: valid ? n : 0, capped: false, raised: Number.isFinite(n) && n < 0 }
  }
  const n = Number(raw)
  const base = key === 'maxDurationMs' ? n * MINUTE : n
  return clampLimit(key, base)
}

export function limitsFromDraft(draft: LimitDraft): RoomLimits {
  const out = {} as Record<keyof RoomLimits, number | null>
  for (const key of LIMIT_KEYS) out[key] = parseLimit(key, draft[key]).value
  return out as unknown as RoomLimits
}

export const showLimit = (key: keyof RoomLimits, value: number | null) =>
  value === null ? '' : key === 'maxDurationMs' ? String(Math.round(value / MINUTE)) : String(value)

/**
 * A participant's Reasoning control: the same choices, labels and defaults as
 * chat's composer (Auto / On / Off, Reasoning effort, and a Thinking Budget for
 * llama.cpp), limited to what this participant's provider and model act on.
 */
export function ParticipantReasoningField({
  pid,
  t,
  disabled,
  controls,
  value,
  onChange,
}: {
  pid: string
  t: T
  disabled: boolean
  controls: ReturnType<typeof participantReasoningControls>
  value: ParticipantReasoning | undefined
  onChange: (value: ParticipantReasoning | undefined) => void
}) {
  const { modes, thinkingBudget, effortLevels } = controls
  if (!modes && !thinkingBudget && effortLevels.length === 0) return null
  const set = (patch: Partial<ParticipantReasoning>) => {
    const next = { ...(value ?? {}), ...patch }
    if (!next.mode) delete next.mode
    if (!next.level) delete next.level
    onChange(next.mode || next.level ? next : undefined)
  }
  const level = value?.level
  return (
    <div className="flex flex-col gap-2" data-testid="room-participant-reasoning">
      {modes && (
        <div className="flex flex-col gap-1.5">
          <span id={`${pid}-reasoning`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
            {t('rooms:editor.reasoning')}
          </span>
          <Segmented<'auto' | 'on' | 'off'>
            size="sm"
            aria-label={t('rooms:editor.reasoning')}
            value={value?.mode ?? 'auto'}
            onValueChange={(mode) => !disabled && set({ mode })}
            options={[
              { value: 'auto', label: t('rooms:editor.reasoningAuto') },
              { value: 'on', label: t('rooms:editor.reasoningOn') },
              { value: 'off', label: t('rooms:editor.reasoningOff') },
            ]}
          />
        </div>
      )}
      {thinkingBudget && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
            {t('rooms:editor.thinkingBudget')}
          </span>
          {/* Wraps: five labels in a 360px panel must not be cut to "Unli…". */}
          <Segmented<ThinkingBudgetLevelKey>
            size="sm"
            wrap
            aria-label={t('rooms:editor.thinkingBudget')}
            value={level ?? DEFAULT_THINKING_BUDGET_LEVEL}
            onValueChange={(next) => !disabled && set({ level: next })}
            options={THINKING_BUDGET_LEVELS.map((l) => ({
              value: l.key,
              label: thinkingBudgetLabel(l.key),
            }))}
          />
          <p className="text-xs text-muted-foreground">
            {t('rooms:editor.thinkingBudgetHint')}
          </p>
        </div>
      )}
      {effortLevels.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
            {t('rooms:editor.reasoningEffort')}
          </span>
          <Segmented<string>
            size="sm"
            wrap
            aria-label={t('rooms:editor.reasoningEffort')}
            value={level && effortLevels.includes(level) ? level : 'default'}
            onValueChange={(next) =>
              !disabled &&
              set({
                level: next === 'default' ? undefined : (next as ThinkingBudgetLevelKey),
              })
            }
            options={[
              { value: 'default', label: t('rooms:editor.reasoningEffortDefault') },
              ...effortLevels.map((l) => ({
                value: l,
                label: isEffortLevel(l) ? effortLabel(l) : l,
              })),
            ]}
          />
        </div>
      )}
    </div>
  )
}

/** One group of an opened participant card: a small heading over its fields. */
export function ParticipantSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <h5 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h5>
      {children}
    </section>
  )
}

export function validate(
  participants: DraftParticipant[],
  moderator: ModeratorConfig,
  mode: SpeakingMode,
  t: T
): Errors {
  const errors: Errors = {}
  const counts = new Map<string, number>()
  for (const p of participants) counts.set(norm(p.name), (counts.get(norm(p.name)) ?? 0) + 1)
  for (const p of participants) {
    if (!p.name.trim()) errors[`${p.id}:name`] = t('rooms:editor.errors.nameRequired')
    else if ((counts.get(norm(p.name)) ?? 0) > 1)
      errors[`${p.id}:name`] = t('rooms:editor.errors.nameDuplicate', { name: p.name.trim() })
    else if (moderator.enabled && norm(p.name) === norm(moderator.name))
      errors[`${p.id}:name`] = t('rooms:editor.errors.nameModerator')
    if (!p.model?.id) errors[`${p.id}:model`] = t('rooms:editor.errors.modelRequired')
  }
  if (moderator.enabled) {
    if (!moderator.name.trim()) errors['moderator:name'] = t('rooms:editor.errors.nameRequired')
    if (!moderator.model) errors['moderator:model'] = t('rooms:editor.errors.moderatorModelRequired')
  }
  if (mode === 'moderator-selected' && !moderator.enabled)
    errors.mode = t('rooms:editor.errors.moderatorRequired')
  return errors
}

export type SettingsTab = 'general' | 'discussion' | 'limits'

export const TOOL_PILL: Record<ToolAccess, string> = {
  none: 'bg-accent text-muted-foreground',
  read: 'bg-info-tint text-info',
  edit: 'bg-warning-tint text-warning',
  full: 'bg-warning-tint text-warning',
}

export const toolKey = (v: ToolAccess) =>
  v === 'none'
    ? 'rooms:editor.toolNone'
    : v === 'read'
      ? 'rooms:editor.toolRead'
      : v === 'edit'
        ? 'rooms:editor.toolEdit'
        : 'rooms:editor.toolFull'

/** What an empty budget field means: steps depend on access, so both are named. */
export const budgetDefault = (k: BudgetKey): string =>
  k === 'maxSteps'
    ? `${resolveToolBudget(undefined, 'edit').maxSteps}/${resolveToolBudget(undefined, 'full').maxSteps}`
    : String(resolveToolBudget(undefined, 'edit')[k])

/**
 * Compare rooms with two or more writers: whether each gets its own isolated
 * workspace, or why not (the writers then only read).
 */
export function useFolderTrusted(folder: string | null, wanted: boolean) {
  const [trust, setTrust] = useState<boolean | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!folder || !wanted) return
    let live = true
    void folderTrustStatus(folder).then((st) => {
      if (live) setTrust(st ? st.trusted : null)
    })
    return () => {
      live = false
    }
  }, [folder, wanted, tick])
  return [trust, () => setTick((n) => n + 1)] as const
}

/**
 * Compare rooms with a writer: whether writers get their own isolated
 * workspace, or why not (they then only read). An untrusted folder can be
 * trusted from here (R-040).
 */
export function CompareIsolationNote({
  roomId,
  folder,
  writers,
  t,
  testId = 'compare-isolation',
}: {
  roomId: string
  folder: string | null
  writers: number
  t: ReturnType<typeof useTranslation>['t']
  testId?: string
}) {
  const runNote = useIsolationNotes((s) => s.notes[roomId])
  const [trust, recheck] = useFolderTrusted(folder, writers > 0)
  const [trustError, setTrustError] = useState<string | null>(null)
  if (!folder || writers < 1) return null
  const untrusted = trust === false
  const reason = untrusted ? t('rooms:editor.isolation.untrusted') : runNote
  const grant = async () => {
    setTrustError(null)
    try {
      await trustFolder(folder)
      noteIsolation(roomId, null)
      recheck()
    } catch (e) {
      setTrustError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div data-testid={testId} role="note" className="flex flex-col items-start gap-1.5">
      <p className={cn('text-xs', reason ? 'text-warning' : 'text-muted-foreground')}>
        {reason
          ? t('rooms:editor.isolation.unavailable', { reason })
          : t('rooms:editor.isolation.active')}
      </p>
      {untrusted && (
        <Button type="button" size="xs" variant="outline" onClick={() => void grant()}>
          {t('rooms:editor.isolation.trust')}
        </Button>
      )}
      {trustError && <p className="text-xs text-destructive">{trustError}</p>}
    </div>
  )
}
