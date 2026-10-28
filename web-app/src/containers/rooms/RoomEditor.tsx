/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useMemo, useReducer, useState } from 'react'
import { ChevronDown, Info, Lock, Pencil, Plus, Settings2, Trash2, Users } from 'lucide-react'
import type {
  ModeratorConfig,
  ParticipantReasoning,
  Room,
  RoomLimits,
  SpeakingMode,
  ToolAccess,
} from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS, type CompareRun } from '@/lib/rooms/types'
import {
  LIMIT_KEYS,
  MINUTE_MS,
  BUDGET_KEYS,
  budgetFromDraft,
  draftFromRoom,
  parsePricing,
  roomDraftReducer,
  type BudgetKey,
  type DraftField,
  type DraftParticipant,
  type LimitDraft,
  type RoomDraft,
} from '@/lib/rooms/roomDraft'
import { AUTOSAVE_MS, useRoomAutosave } from '@/hooks/useRoomAutosave'
import { AddParticipantForm } from './AddParticipantForm'
import { ParticipantPersonaFields } from './ParticipantPersonaFields'
import { FieldError, norm, type Errors } from './roomEditorShared'
import { MAX_EXTRA_FOLDERS } from '@/lib/rooms/controller'
import { ParticipantToolsField } from './ParticipantToolsField'
import { knownWindowFor } from '@/lib/rooms/availability'
import { noteIsolation, useIsolationNotes } from '@/lib/rooms/isolation'
import { ROOM_TOOL_BUDGET_CEILINGS, resolveToolBudget } from '@/lib/rooms/toolBudget'
import { folderTrustStatus, trustFolder } from '@/lib/folderTrust'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import {
  activeParticipants,
  clampLimit,
  isEditable,
  limitCeiling,
  limitMin,
  participantColor,
} from './roomUi'
import { findModel, modelSupportsTools, RoomModelSelect } from './RoomModelSelect'
import { RoomAvatar } from './RoomAvatar'
import {
  applicableParticipantReasoning,
  participantReasoningControls,
} from '@/lib/rooms/participantReasoning'
import {
  DEFAULT_THINKING_BUDGET_LEVEL,
  THINKING_BUDGET_LEVELS,
  thinkingBudgetLabel,
  type ThinkingBudgetLevelKey,
} from '@/lib/thinkingBudget'
import { effortLabel, isEffortLevel } from '@/lib/modelEffort'

type T = (key: string, options?: Record<string, unknown>) => string

const MODES: SpeakingMode[] = ['round-robin', 'user-selected', 'moderator-selected', 'compare']
const COMPARE_RUNS: CompareRun[] = ['together', 'one-by-one']
/** Providers that run on this machine, where two models at once compete for memory. */
const LOCAL_PROVIDERS = ['llamacpp', 'mlx']

// Re-exported: tests and the limits fields import it from here.
export { LIMIT_KEYS }

const MINUTE = MINUTE_MS

/** Displayed ceiling for a limit, in the unit the field is edited in. */
function displayCeiling(key: keyof RoomLimits): number | null {
  const max = limitCeiling(key)
  if (max === null) return null
  return key === 'maxDurationMs' ? max / MINUTE : max
}

/** The minimum shown to the user, in the same unit as the input. */
function displayMin(key: keyof RoomLimits): number {
  const min = limitMin(key)
  return key === 'maxDurationMs' ? min / MINUTE : min
}

function parseLimit(
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

function limitsFromDraft(draft: LimitDraft): RoomLimits {
  const out = {} as Record<keyof RoomLimits, number | null>
  for (const key of LIMIT_KEYS) out[key] = parseLimit(key, draft[key]).value
  return out as unknown as RoomLimits
}

const showLimit = (key: keyof RoomLimits, value: number | null) =>
  value === null ? '' : key === 'maxDurationMs' ? String(Math.round(value / MINUTE)) : String(value)

/**
 * A participant's Reasoning control: the same choices, labels and defaults as
 * chat's composer (Auto / On / Off, Reasoning effort, and a Thinking Budget for
 * llama.cpp), limited to what this participant's provider and model act on.
 */
function ParticipantReasoningField({
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
function ParticipantSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <h5 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h5>
      {children}
    </section>
  )
}

function validate(
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

type SettingsTab = 'general' | 'discussion' | 'limits'

const TOOL_PILL: Record<ToolAccess, string> = {
  none: 'bg-accent text-muted-foreground',
  read: 'bg-info-tint text-info',
  edit: 'bg-warning-tint text-warning',
  full: 'bg-warning-tint text-warning',
}

const toolKey = (v: ToolAccess) =>
  v === 'none'
    ? 'rooms:editor.toolNone'
    : v === 'read'
      ? 'rooms:editor.toolRead'
      : v === 'edit'
        ? 'rooms:editor.toolEdit'
        : 'rooms:editor.toolFull'

/** What an empty budget field means: steps depend on access, so both are named. */
const budgetDefault = (k: BudgetKey): string =>
  k === 'maxSteps'
    ? `${resolveToolBudget(undefined, 'edit').maxSteps}/${resolveToolBudget(undefined, 'full').maxSteps}`
    : String(resolveToolBudget(undefined, 'edit')[k])

/**
 * Compare rooms with two or more writers: whether each gets its own isolated
 * workspace, or why not (the writers then only read).
 */
function useFolderTrusted(folder: string | null, wanted: boolean) {
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
function CompareIsolationNote({
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

// Re-exported: tests use it to advance fake timers.
export { AUTOSAVE_MS }

export function RoomEditor({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const serviceHub = useServiceHub()
  const { pendingAction, liveTurn } = useRoomsState()
  const providers = useModelProvider((s) => s.providers)
  const lookup = useMemo(
    () => (name: string) => providers.find((pr) => pr.provider === name),
    [providers]
  )
  const uid = useId()
  const locked = !isEditable(room.status)

  const [draft, dispatch] = useReducer(roomDraftReducer, room, (r) =>
    draftFromRoom(r, activeParticipants(r))
  )
  const { title, objective, mode, compareRun, moderator, limits, budget, participants } = draft
  const field =
    <K extends DraftField>(key: K) =>
    (value: RoomDraft[K]) =>
      dispatch({ type: 'edit', field: key, value })
  const setTitle = field('title')
  const setObjective = field('objective')
  const setMode = field('mode')
  const setCompareRun = field('compareRun')
  const setModerator = field('moderator')
  const setLimits = field('limits')
  const setBudget = field('budget')
  const [showErrors, setShowErrors] = useState(false)
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [tab, setTab] = useState<SettingsTab>('general')
  // Participant rows fold to one line; these are the ones opened for editing.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  // A room without enough participants opens straight onto the add form.
  const [addOpen, setAddOpen] = useState(() => activeParticipants(room).length < 2)
  const autosave = useRoomAutosave(room.id)
  const { dirty, draftRoomId, editGen, saving, setSaving, saved, setSaved, markEdited, saveRef } = autosave

  // A new revision from the engine: reset when nothing is being edited,
  // otherwise only pick up added and removed participants.
  useEffect(() => {
    // A different room: the draft belongs to the previous one, drop it.
    const switched = draftRoomId.current !== room.id
    if (switched) {
      draftRoomId.current = room.id
      dirty.current = false
    }
    if (!dirty.current) {
      dispatch({ type: 'reset', room, participants: activeParticipants(room) })
      return
    }
    dispatch({ type: 'syncParticipants', participants: activeParticipants(room) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, room.rev])

  const edit = <V,>(setter: (v: V) => void) => (v: V) => {
    markEdited()
    setter(v)
  }

  const errors = useMemo(
    () => validate(participants, moderator, mode, t),
    [participants, moderator, mode, t]
  )
  const visibleErrors: Errors = showErrors ? errors : {}
  const busy = saving || pendingAction !== null
  const disabled = locked || busy
  const atMax = participants.length >= ROOM_LIMIT_CEILINGS.maxParticipants
  const missingPricing = participants.some((p) => !parsePricing(p))
  const speakingId =
    liveTurn?.roomId === room.id && liveTurn.author.kind === 'participant'
      ? liveTurn.author.participantId
      : null

  const setOpen = (id: string, open: boolean) =>
    setOpenIds((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })

  const updateParticipant = (id: string, patch: Partial<DraftParticipant>) => {
    markEdited()
    dispatch({ type: 'updateParticipant', id, patch })
  }

  const save = async (auto = false) => {
    // Never write one room's draft onto another room.
    if (room.id !== draftRoomId.current) return
    if (auto && (!dirty.current || locked)) return
    setShowErrors(true)
    const keys = Object.keys(errors)
    if (keys.length > 0) {
      // An autosave only shows the problems; it does not move the view.
      if (auto) return
      // Bring every problem into view: open the participants that have one and
      // switch to the settings tab that holds the first settings error.
      const bad = participants.filter((p) => keys.some((k) => k.startsWith(`${p.id}:`)))
      if (bad.length) setOpenIds((prev) => new Set([...prev, ...bad.map((p) => p.id)]))
      if (keys.some((k) => k === 'mode' || k.startsWith('moderator:'))) setTab('discussion')
      return
    }
    setSaving(true)
    setError(null)
    const gen = editGen.current
    try {
      const nextParticipants = room.participants.map((p) => {
        const d = participants.find((x) => x.id === p.id)
        if (!d) return p
        // Send the chosen access as-is; the controller drops it to 'none' only
        // when the model resolves and truly lacks tools. Forcing 'none' here
        // when the provider's model list has not loaded (findModel undefined)
        // would silently and permanently strip access the user set.
        return {
          ...p,
          name: d.name.trim(),
          role: d.role.trim(),
          model: d.model,
          toolAccess: d.toolAccess,
          assistantId: d.assistantId ?? null,
          workProfile: d.workProfile ?? null,
          disabledTools: d.disabledTools,
          pricing: parsePricing(d),
          // Only what the chosen model acts on is kept; `null` returns the
          // participant to the model's default.
          reasoning:
            applicableParticipantReasoning(
              d.model.provider,
              findModel(providers, d.model),
              d.reasoning
            ) ?? null,
        }
      })
      await api.updateRoomSettings(room, {
        title: title.trim(),
        objective: objective.trim(),
        mode,
        ...(mode === 'compare' ? { compareRun } : {}),
        moderator: { ...moderator, name: moderator.name.trim() },
        limits: limitsFromDraft(limits),
        toolBudget: budgetFromDraft(budget),
        participants: nextParticipants,
      })
      if (editGen.current === gen) dirty.current = false
      setShowErrors(false)
      setSaved(true)
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setSaving(false)
    }
  }

  // The latest save, for the timer and the unmount flush.
  saveRef.current = save

  const saveStatus = saving ? (
    <span role="status" data-testid="room-save-status" className="text-xs text-muted-foreground">
      {t('rooms:editor.saving')}
    </span>
  ) : saved ? (
    <span role="status" data-testid="room-save-status" className="text-xs text-muted-foreground">
      {t('rooms:editor.saved')}
    </span>
  ) : null

  const remove = async (id: string) => {
    setError(null)
    try {
      await api.removeParticipant(room, id)
    } catch (err) {
      setError(normalizeError(err))
    }
  }

  const attachFolder = async () => {
    setError(null)
    try {
      const picked = await serviceHub.dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      await api.updateRoomSettings(room, { folder: path })
    } catch (err) {
      setError(normalizeError(err))
    }
  }
  const detachFolder = async () => {
    setError(null)
    try {
      // The next folder, if there is one, becomes the main one.
      const [next, ...rest] = room.extraFolders ?? []
      await api.updateRoomSettings(room, { folder: next ?? null, extraFolders: rest })
    } catch (err) {
      setError(normalizeError(err))
    }
  }
  const addExtraFolder = async () => {
    setError(null)
    try {
      const picked = await serviceHub.dialog().open({ directory: true })
      const path = Array.isArray(picked) ? picked[0] : picked
      if (!path) return
      const current = room.extraFolders ?? []
      if (path === room.folder || current.includes(path)) return
      await api.updateRoomSettings(room, { extraFolders: [...current, path] })
    } catch (err) {
      setError(normalizeError(err))
    }
  }
  const removeExtraFolder = async (path: string) => {
    setError(null)
    try {
      await api.updateRoomSettings(room, {
        extraFolders: (room.extraFolders ?? []).filter((f) => f !== path),
      })
    } catch (err) {
      setError(normalizeError(err))
    }
  }

  const pause = async () => {
    setError(null)
    try {
      await api.controller.pause(room.id)
    } catch (err) {
      setError(normalizeError(err))
    }
  }

  return (
    <form
      aria-label={t('rooms:editor.heading')}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Frame className="motion-safe:animate-rise-in [animation-delay:100ms]">
        <FrameHeader
          icon={<Users />}
          title={`${t('rooms:editor.participants')} · ${participants.length}`}
          actions={
            <span className="flex items-center gap-2">
            {saveStatus}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={addOpen}
              aria-controls={`${uid}-add`}
              disabled={disabled || atMax}
              onClick={() => setAddOpen((v) => !v)}
            >
              <Plus aria-hidden />
              {t('rooms:editor.addShort')}
            </Button>
            </span>
          }
        />
        <FrameBody className="gap-0 p-2">
          <fieldset disabled={disabled} className="room-participants flex min-w-0 flex-col gap-0.5">
            {participants.length === 0 && (
              <p className="px-1.5 py-2 text-xs text-muted-foreground">
                {t('rooms:editor.noParticipants')}
              </p>
            )}
            {participants.map((p) => {
              const pid = `${uid}-p-${p.id}`
              const model = findModel(providers, p.model)
              const tools = modelSupportsTools(model)
              // Until the provider's model list resolves, show the access that was
              // chosen rather than claiming the model has none.
              const access = model && !tools ? 'none' : p.toolAccess
              const availability = p.source.availability
              const open = openIds.has(p.id)
              const speaking = speakingId === p.id
              const hasError = Object.keys(visibleErrors).some((k) => k.startsWith(`${p.id}:`))
              return (
                <details
                  key={p.id}
                  data-testid="room-participant"
                  data-speaking={speaking || undefined}
                  open={open}
                  onToggle={(e) => setOpen(p.id, e.currentTarget.open)}
                  className={cn(
                    'group/prt min-w-0 rounded-[10px] transition-colors duration-150',
                    open && 'bg-muted/60 shadow-[inset_0_0_0_0.8px_var(--border)]',
                    speaking &&
                      'bg-[color-mix(in_oklab,var(--primary)_7%,transparent)] shadow-[inset_2px_0_0_var(--primary)]'
                  )}
                >
                  <summary
                    className={cn(
                      'flex cursor-pointer list-none items-center gap-2.5 rounded-[10px] px-1.5 py-2 outline-hidden hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden',
                      open && 'hover:bg-transparent'
                    )}
                  >
                    <RoomAvatar
                      model={p.model}
                      name={p.name}
                      color={participantColor(p.id)}
                      size={30}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <b
                        className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold"
                        style={{ color: participantColor(p.id) }}
                      >
                        {p.name || t('rooms:editor.unnamed')}
                      </b>
                      <small className="truncate text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">
                        {[p.role.trim(), model?.displayName || model?.name || p.model.id]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                    {(availability.state === 'unavailable' || hasError) && (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
                    )}
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-[7px] py-0.5 text-[length:calc(var(--ui-font-base)*0.65625)] whitespace-nowrap',
                        TOOL_PILL[access]
                      )}
                    >
                      {t(toolKey(access))}
                    </span>
                    <span
                      aria-hidden
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground group-hover/prt:text-foreground [&_svg]:size-3.5"
                    >
                      {open ? <ChevronDown /> : <Pencil />}
                    </span>
                  </summary>

                  {/* Three groups -- who, which model, what tools -- then a quiet
                      footer. Columns follow the panel's own width (@container),
                      not the window's, so a 360px side panel stays one column. */}
                  <div className="@container flex min-w-0 flex-col gap-4 px-2.5 pt-1 pb-2.5">
                    <ParticipantSection title={t('rooms:editor.sectionIdentity')}>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor={`${pid}-name`}>{t('rooms:editor.participantName')}</Label>
                        <Input
                          id={`${pid}-name`}
                          value={p.name}
                          aria-invalid={Boolean(visibleErrors[`${p.id}:name`]) || undefined}
                          aria-describedby={`${pid}-name-error`}
                          onChange={(e) => updateParticipant(p.id, { name: e.target.value })}
                        />
                        <FieldError id={`${pid}-name-error`} message={visibleErrors[`${p.id}:name`]} />
                      </div>
                      <ParticipantPersonaFields
                        idPrefix={pid}
                        role={p.role}
                        assistantId={p.assistantId}
                        workProfile={p.workProfile}
                        disabled={disabled}
                        onChange={(patch) => updateParticipant(p.id, patch)}
                      />
                    </ParticipantSection>

                    <ParticipantSection title={t('rooms:editor.sectionModel')}>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor={`${pid}-model`}>{t('rooms:editor.participantModel')}</Label>
                        <RoomModelSelect
                          id={`${pid}-model`}
                          value={p.model}
                          disabled={disabled}
                          invalid={Boolean(visibleErrors[`${p.id}:model`])}
                          describedBy={`${pid}-model-error ${pid}-availability`}
                          onChange={(ref) => updateParticipant(p.id, { model: ref })}
                        />
                        <FieldError id={`${pid}-model-error`} message={visibleErrors[`${p.id}:model`]} />
                        {availability.state === 'unavailable' && (
                          <p
                            id={`${pid}-availability`}
                            data-testid="participant-availability"
                            className="text-xs text-destructive"
                          >
                            {t(`rooms:availability.${availability.reason}`)}
                            {availability.message ? ` — ${availability.message}` : ''}
                          </p>
                        )}
                      </div>
                      <ParticipantReasoningField
                        pid={pid}
                        t={t}
                        disabled={disabled}
                        controls={participantReasoningControls(p.model.provider, model)}
                        value={p.reasoning}
                        onChange={(reasoning) => updateParticipant(p.id, { reasoning })}
                      />
                    </ParticipantSection>

                    <ParticipantSection title={t('rooms:editor.sectionTools')}>
                      <div className="flex flex-col gap-1.5">
                        <span id={`${pid}-tools`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
                          {t('rooms:editor.toolAccess')}
                        </span>
                        <Segmented<ToolAccess>
                          size="sm"
                          wrap
                          aria-label={t('rooms:editor.toolAccess')}
                          value={tools ? p.toolAccess : 'none'}
                          onValueChange={(v) => !disabled && tools && updateParticipant(p.id, { toolAccess: v })}
                          options={(['none', 'read', 'edit', 'full'] as const).map((v) => ({
                            value: v,
                            label: t(toolKey(v)),
                            disabled: disabled || !tools,
                            testId: `${pid}-tools-${v}`,
                          }))}
                        />
                        {!tools ? (
                          <p
                            id={`${pid}-tools-hint`}
                            className="flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground"
                          >
                            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                            <span className="min-w-0">{t('rooms:editor.toolUnsupported')}</span>
                          </p>
                        ) : (
                          <p id={`${pid}-tools-hint`} className="text-xs text-muted-foreground">
                            {p.toolAccess === 'full'
                              ? t('rooms:editor.toolFullHint')
                              : p.toolAccess === 'edit'
                                ? t('rooms:editor.toolEditHint')
                                : t('rooms:editor.toolReadHint')}
                          </p>
                        )}
                      </div>
                      {tools && mode === 'compare' && (access === 'edit' || access === 'full') && (
                        <CompareIsolationNote
                          roomId={room.id}
                          folder={room.folder ?? null}
                          writers={1}
                          t={t}
                          testId="participant-isolation"
                        />
                      )}
                      {tools && (
                        <ParticipantToolsField
                          pid={pid}
                          t={t}
                          folder={room.folder ?? null}
                          access={access}
                          window={knownWindowFor(p.model, lookup)}
                          disabledTools={p.disabledTools}
                          disabled={disabled}
                          onChange={(next) => updateParticipant(p.id, { disabledTools: next })}
                        />
                      )}
                    </ParticipantSection>

                    <footer className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2 border-t border-border pt-2.5">
                      <details className="group/price min-w-0 flex-1 basis-48 text-sm">
                        <summary className="flex h-6 cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <ChevronDown
                            aria-hidden
                            className="size-3 -rotate-90 transition-transform duration-200 group-open/price:rotate-0"
                          />
                          {t('rooms:editor.pricing')}
                        </summary>
                        <p className="mt-1 text-xs text-muted-foreground">{t('rooms:editor.pricingHint')}</p>
                        <div className="mt-2 grid gap-2 @[26rem]:grid-cols-2">
                          <div className="flex min-w-0 flex-col gap-1.5">
                            <Label htmlFor={`${pid}-price-in`}>{t('rooms:editor.priceInput')}</Label>
                            <Input
                              id={`${pid}-price-in`}
                              type="number"
                              min={0}
                              step="0.01"
                              value={p.priceIn}
                              onChange={(e) => updateParticipant(p.id, { priceIn: e.target.value })}
                            />
                          </div>
                          <div className="flex min-w-0 flex-col gap-1.5">
                            <Label htmlFor={`${pid}-price-out`}>{t('rooms:editor.priceOutput')}</Label>
                            <Input
                              id={`${pid}-price-out`}
                              type="number"
                              min={0}
                              step="0.01"
                              value={p.priceOut}
                              onChange={(e) => updateParticipant(p.id, { priceOut: e.target.value })}
                            />
                          </div>
                        </div>
                      </details>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={t('rooms:editor.removeLabel', { name: p.name })}
                        onClick={() => void remove(p.id)}
                      >
                        <Trash2 aria-hidden />
                        {t('rooms:editor.remove')}
                      </Button>
                    </footer>
                  </div>
                </details>
              )
            })}

            <AddParticipantForm
              room={room}
              uid={uid}
              hidden={!addOpen}
              participants={participants}
              moderator={moderator}
              disabled={disabled}
              atMax={atMax}
              onCancel={() => setAddOpen(false)}
              onError={setError}
            />
          </fieldset>
        </FrameBody>
      </Frame>

      <Frame className="motion-safe:animate-rise-in [animation-delay:150ms]">
        <FrameHeader
          icon={<Settings2 />}
          title={t('rooms:editor.heading')}
          actions={
            locked ? (
              <Chip>
                <Lock aria-hidden />
                {t('rooms:editor.locked')}
              </Chip>
            ) : undefined
          }
        />
        <FrameBody className="gap-3 p-3.5">
          <Segmented<SettingsTab>
            aria-label={t('rooms:editor.sections')}
            value={tab}
            onValueChange={setTab}
            options={[
              { value: 'general', label: t('rooms:editor.tabGeneral') },
              { value: 'discussion', label: t('rooms:editor.tabDiscussion') },
              { value: 'limits', label: t('rooms:editor.tabLimits') },
            ]}
          />

          {/* Why everything below is read-only, before the fields, not under them. */}
          {locked && (
            <div
              role="note"
              className="flex items-center gap-2 rounded-[10px] bg-muted px-2.5 py-2 text-xs text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)]"
            >
              <Lock aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{t('rooms:editor.lockedWhileRunning')}</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pendingAction !== null}
                onClick={() => void pause()}
              >
                {t('rooms:controls.pause')}
              </Button>
            </div>
          )}

          <fieldset
            disabled={disabled}
            className={cn(
              'flex min-w-0 flex-col gap-2.5',
              // Locked reads as read-only, not as gone: labels and values stay
              // at muted-foreground contrast (>=4.5:1) instead of fading to ~2:1.
              locked &&
                '[&_[data-slot=label]]:opacity-100! [&_[data-slot=label]]:text-muted-foreground [&_input:disabled]:opacity-100! [&_input:disabled]:bg-muted [&_input:disabled]:text-muted-foreground [&_textarea:disabled]:opacity-100! [&_textarea:disabled]:text-muted-foreground'
            )}
          >
            <div hidden={tab !== 'general'} className="flex min-w-0 flex-col gap-2.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-title`}>{t('rooms:editor.title')}</Label>
                <Input id={`${uid}-title`} value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-objective`}>{t('rooms:editor.objective')}</Label>
                <Textarea
                  id={`${uid}-objective`}
                  rows={2}
                  value={objective}
                  onChange={(e) => edit(setObjective)(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('rooms:editor.workingFolder')}</Label>
                {room.folder ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)]">
                      {room.folder}
                    </code>
                    <Button type="button" size="xs" variant="outline" onClick={() => void attachFolder()}>
                      {t('rooms:editor.changeFolder')}
                    </Button>
                    <Button type="button" size="xs" variant="ghost" onClick={() => void detachFolder()}>
                      {t('rooms:editor.detachFolder')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={() => void attachFolder()}
                  >
                    {t('rooms:editor.attachFolder')}
                  </Button>
                )}
                {(room.extraFolders ?? []).map((f) => (
                  <div key={f} className="flex flex-wrap items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)]">
                      {f}
                    </code>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void removeExtraFolder(f)}
                    >
                      {t('rooms:editor.detachFolder')}
                    </Button>
                  </div>
                ))}
                {room.folder && (room.extraFolders ?? []).length < MAX_EXTRA_FOLDERS && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() => void addExtraFolder()}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t('rooms:editor.addFolder')}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">{t('rooms:editor.workingFolderHint')}</p>
              </div>
            </div>

            <div hidden={tab !== 'discussion'} className="flex min-w-0 flex-col gap-2.5">
              <span id={`${uid}-mode`} className="text-[length:calc(var(--ui-font-base)*0.78125)] font-medium">
                {t('rooms:editor.speakingMode')}
              </span>
              <RadioGroup
                aria-labelledby={`${uid}-mode`}
                aria-describedby={visibleErrors.mode ? `${uid}-mode-error` : undefined}
                value={mode}
                disabled={disabled}
                onValueChange={(v) => edit(setMode)(v as SpeakingMode)}
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
                    onValueChange={(v) => edit(setCompareRun)(v as CompareRun)}
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
                  onCheckedChange={(enabled) => edit(setModerator)({ ...moderator, enabled })}
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
                      onChange={(e) => edit(setModerator)({ ...moderator, name: e.target.value })}
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
                      onChange={(model) => edit(setModerator)({ ...moderator, model })}
                    />
                    <FieldError id={`${uid}-mod-model-error`} message={visibleErrors['moderator:model']} />
                  </div>
                </div>
              )}
            </div>

            <div hidden={tab !== 'limits'} className="flex min-w-0 flex-col gap-2.5">
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
                        onChange={(e) => edit(setLimits)({ ...limits, [key]: e.target.value })}
                        onBlur={() => edit(setLimits)({ ...limits, [key]: showLimit(key, parsed.value) })}
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
                          onChange={(e) => edit(setBudget)({ ...budget, [key]: e.target.value })}
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
          </fieldset>

          {locked ? null : (
            <div className="flex flex-col items-stretch gap-2">
              <Button type="submit" className="w-full" disabled={busy}>
                {t('rooms:editor.save')}
              </Button>
              {saveStatus && <span className="text-center">{saveStatus}</span>}
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error.message}
            </p>
          )}
        </FrameBody>
      </Frame>
    </form>
  )
}
