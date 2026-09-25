import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Lock, Pencil, Plus, Settings2, Users } from 'lucide-react'
import type {
  ModeratorConfig,
  Participant,
  Room,
  RoomLimits,
  RoomModelRef,
  SpeakingMode,
  ToolAccess,
} from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
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

type T = (key: string, options?: Record<string, unknown>) => string

const MODES: SpeakingMode[] = ['round-robin', 'user-selected', 'moderator-selected']

export const LIMIT_KEYS: (keyof RoomLimits)[] = [
  'maxRounds',
  'maxTurns',
  'maxConsecutivePerParticipant',
  'maxTotalTokens',
  'maxOutputTokensPerTurn',
  'maxDurationMs',
  'maxRepetitiveTurns',
  'repetitionSimilarity',
  'maxCostUsd',
]

const MINUTE = 60_000

type LimitDraft = Record<keyof RoomLimits, string>

/** Limits are edited as text; duration is shown in minutes. */
function toLimitDraft(l: RoomLimits): LimitDraft {
  const out = {} as LimitDraft
  for (const key of LIMIT_KEYS) {
    const v = l[key]
    out[key] =
      v === null ? '' : key === 'maxDurationMs' ? String(Math.round((v as number) / MINUTE)) : String(v)
  }
  return out
}

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

type DraftParticipant = {
  id: string
  name: string
  role: string
  model: RoomModelRef
  toolAccess: ToolAccess
  priceIn: string
  priceOut: string
  source: Participant
}

const toDraftParticipant = (p: Participant): DraftParticipant => ({
  id: p.id,
  name: p.name,
  role: p.role,
  model: p.model,
  toolAccess: p.toolAccess,
  priceIn: p.pricing ? String(p.pricing.inputPerMTokUsd) : '',
  priceOut: p.pricing ? String(p.pricing.outputPerMTokUsd) : '',
  source: p,
})

function parsePricing(d: Pick<DraftParticipant, 'priceIn' | 'priceOut'>) {
  const i = Number(d.priceIn)
  const o = Number(d.priceOut)
  if (d.priceIn.trim() === '' || d.priceOut.trim() === '') return undefined
  if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return undefined
  return { inputPerMTokUsd: i, outputPerMTokUsd: o }
}

const norm = (s: string) => s.trim().toLowerCase()

type Errors = Record<string, string>

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

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  )
}


type SettingsTab = 'general' | 'discussion' | 'limits'

const TOOL_PILL: Record<ToolAccess, string> = {
  none: 'bg-accent text-muted-foreground',
  read: 'bg-info-tint text-info',
  edit: 'bg-warning-tint text-warning',
}

const toolKey = (v: ToolAccess) =>
  v === 'none' ? 'rooms:editor.toolNone' : v === 'read' ? 'rooms:editor.toolRead' : 'rooms:editor.toolEdit'

export function RoomEditor({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const serviceHub = useServiceHub()
  const { pendingAction, liveTurn } = useRoomsState()
  const providers = useModelProvider((s) => s.providers)
  const uid = useId()
  const locked = !isEditable(room.status)

  const [title, setTitle] = useState(room.title)
  const [objective, setObjective] = useState(room.objective)
  const [mode, setMode] = useState<SpeakingMode>(room.mode)
  const [moderator, setModerator] = useState<ModeratorConfig>(room.moderator)
  const [limits, setLimits] = useState<LimitDraft>(() => toLimitDraft(room.limits))
  const [participants, setParticipants] = useState<DraftParticipant[]>(() =>
    activeParticipants(room).map(toDraftParticipant)
  )
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [tab, setTab] = useState<SettingsTab>('general')
  // Participant rows fold to one line; these are the ones opened for editing.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  // A room without enough participants opens straight onto the add form.
  const [addOpen, setAddOpen] = useState(() => activeParticipants(room).length < 2)
  const dirty = useRef(false)

  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newModel, setNewModel] = useState<RoomModelRef | null>(null)
  const [newErrors, setNewErrors] = useState<Errors>({})

  // A new revision from the engine: reset when nothing is being edited,
  // otherwise only pick up added and removed participants.
  useEffect(() => {
    const fresh = activeParticipants(room).map(toDraftParticipant)
    if (!dirty.current) {
      setTitle(room.title)
      setObjective(room.objective)
      setMode(room.mode)
      setModerator(room.moderator)
      setLimits(toLimitDraft(room.limits))
      setParticipants(fresh)
      return
    }
    setParticipants((prev) => {
      // Kept drafts keep the user's edits but take the new revision's
      // participant as their source, so availability stays current (#165).
      const kept = prev.flatMap((d) => {
        const f = fresh.find((x) => x.id === d.id)
        return f ? [{ ...d, source: f.source }] : []
      })
      const added = fresh.filter((f) => !prev.some((d) => d.id === f.id))
      return [...kept, ...added]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, room.rev])

  const edit = <V,>(setter: (v: V) => void) => (v: V) => {
    dirty.current = true
    setSaved(false)
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
    dirty.current = true
    setSaved(false)
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const save = async () => {
    setShowErrors(true)
    const keys = Object.keys(errors)
    if (keys.length > 0) {
      // Bring every problem into view: open the participants that have one and
      // switch to the settings tab that holds the first settings error.
      const bad = participants.filter((p) => keys.some((k) => k.startsWith(`${p.id}:`)))
      if (bad.length) setOpenIds((prev) => new Set([...prev, ...bad.map((p) => p.id)]))
      if (keys.some((k) => k === 'mode' || k.startsWith('moderator:'))) setTab('discussion')
      return
    }
    setSaving(true)
    setError(null)
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
          pricing: parsePricing(d),
        }
      })
      await api.updateRoomSettings(room, {
        title: title.trim(),
        objective: objective.trim(),
        mode,
        moderator: { ...moderator, name: moderator.name.trim() },
        limits: limitsFromDraft(limits),
        participants: nextParticipants,
      })
      dirty.current = false
      setShowErrors(false)
      setSaved(true)
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setSaving(false)
    }
  }

  const add = async () => {
    const errs: Errors = {}
    const taken = participants.some((p) => norm(p.name) === norm(newName))
    if (!newName.trim()) errs.name = t('rooms:editor.errors.nameRequired')
    else if (taken) errs.name = t('rooms:editor.errors.nameDuplicate', { name: newName.trim() })
    else if (moderator.enabled && norm(newName) === norm(moderator.name))
      errs.name = t('rooms:editor.errors.nameModerator')
    if (!newModel) errs.model = t('rooms:editor.errors.modelRequired')
    setNewErrors(errs)
    if (Object.keys(errs).length > 0 || !newModel) return
    setError(null)
    try {
      await api.addParticipant(room, {
        name: newName.trim(),
        role: newRole.trim(),
        model: newModel,
        // Omitted so the controller applies its default (read-only for a
        // tool-capable model), rather than starting the participant tool-less.
      })
      setNewName('')
      setNewRole('')
      setNewModel(null)
    } catch (err) {
      setError(normalizeError(err))
    }
  }

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
      await api.updateRoomSettings(room, { folder: null })
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
          }
        />
        <FrameBody className="gap-0 p-2">
          <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-0.5">
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
                        className="truncate text-[13px] font-semibold"
                        style={{ color: participantColor(p.id) }}
                      >
                        {p.name || t('rooms:editor.unnamed')}
                      </b>
                      <small className="truncate text-[11.5px] text-muted-foreground">
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
                        'shrink-0 rounded-full px-[7px] py-0.5 text-[10.5px] whitespace-nowrap',
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

                  <div className="flex min-w-0 flex-col gap-3 px-2 pt-1 pb-3">
                    <div className="grid gap-2 sm:grid-cols-2">
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
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor={`${pid}-role`}>{t('rooms:editor.participantRole')}</Label>
                        <Input
                          id={`${pid}-role`}
                          value={p.role}
                          placeholder={t('rooms:editor.participantRolePlaceholder')}
                          onChange={(e) => updateParticipant(p.id, { role: e.target.value })}
                        />
                      </div>
                    </div>
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

                    <div className="flex flex-col gap-1.5">
                      <span id={`${pid}-tools`} className="text-[12.5px] font-medium">
                        {t('rooms:editor.toolAccess')}
                      </span>
                      <RadioGroup
                        aria-labelledby={`${pid}-tools`}
                        aria-describedby={`${pid}-tools-hint`}
                        value={tools ? p.toolAccess : 'none'}
                        disabled={disabled || !tools}
                        onValueChange={(v) => updateParticipant(p.id, { toolAccess: v as ToolAccess })}
                        className="flex flex-wrap gap-4"
                      >
                        {(['none', 'read', 'edit'] as const).map((v) => (
                          <div key={v} className="flex items-center gap-2">
                            <RadioGroupItem id={`${pid}-tools-${v}`} value={v} />
                            <Label htmlFor={`${pid}-tools-${v}`}>{t(toolKey(v))}</Label>
                          </div>
                        ))}
                      </RadioGroup>
                      <p id={`${pid}-tools-hint`} className="text-xs text-muted-foreground">
                        {!tools
                          ? t('rooms:editor.toolUnsupported')
                          : p.toolAccess === 'edit'
                            ? t('rooms:editor.toolEditHint')
                            : t('rooms:editor.toolReadHint')}
                      </p>
                    </div>

                    <details className="group/price text-sm">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <ChevronDown
                          aria-hidden
                          className="size-3 -rotate-90 transition-transform duration-200 group-open/price:rotate-0"
                        />
                        {t('rooms:editor.pricing')}
                      </summary>
                      <p className="mt-1 text-xs text-muted-foreground">{t('rooms:editor.pricingHint')}</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
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

                    <div>
                      <Button
                        type="button"
                        size="xs"
                        variant="destructive"
                        aria-label={t('rooms:editor.removeLabel', { name: p.name })}
                        onClick={() => void remove(p.id)}
                      >
                        {t('rooms:editor.remove')}
                      </Button>
                    </div>
                  </div>
                </details>
              )
            })}

            <div
              id={`${uid}-add`}
              hidden={!addOpen}
              className="mt-1.5 flex min-w-0 flex-col gap-2 rounded-[10px] border border-dashed border-border-strong p-3 motion-safe:animate-dd-in"
            >
              <h4 className="text-xs font-medium text-muted-foreground">{t('rooms:editor.addHeading')}</h4>
              <p className="text-xs text-muted-foreground">
                {t('rooms:editor.participantsHint', { max: ROOM_LIMIT_CEILINGS.maxParticipants })}
              </p>
              {atMax ? (
                <p className="text-xs text-muted-foreground">
                  {t('rooms:editor.maxReached', { max: ROOM_LIMIT_CEILINGS.maxParticipants })}
                </p>
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${uid}-new-name`}>{t('rooms:editor.participantName')}</Label>
                      <Input
                        id={`${uid}-new-name`}
                        value={newName}
                        aria-invalid={Boolean(newErrors.name) || undefined}
                        aria-describedby={`${uid}-new-name-error`}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                      <FieldError id={`${uid}-new-name-error`} message={newErrors.name} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${uid}-new-role`}>{t('rooms:editor.participantRole')}</Label>
                      <Input
                        id={`${uid}-new-role`}
                        value={newRole}
                        placeholder={t('rooms:editor.participantRolePlaceholder')}
                        onChange={(e) => setNewRole(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`${uid}-new-model`}>{t('rooms:editor.participantModel')}</Label>
                    <RoomModelSelect
                      id={`${uid}-new-model`}
                      value={newModel}
                      disabled={disabled}
                      invalid={Boolean(newErrors.model)}
                      describedBy={`${uid}-new-model-error`}
                      onChange={setNewModel}
                    />
                    <FieldError id={`${uid}-new-model-error`} message={newErrors.model} />
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => void add()}>
                      {t('rooms:editor.add')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                      {t('rooms:controls.cancel')}
                    </Button>
                  </div>
                </>
              )}
            </div>
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

          <fieldset
            disabled={disabled}
            className={cn(
              'flex min-w-0 flex-col gap-2.5 transition-opacity',
              locked && 'opacity-55'
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
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-[11.5px]">
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
                <p className="text-xs text-muted-foreground">{t('rooms:editor.workingFolderHint')}</p>
              </div>
            </div>

            <div hidden={tab !== 'discussion'} className="flex min-w-0 flex-col gap-2.5">
              <span id={`${uid}-mode`} className="text-[12.5px] font-medium">
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
                      aria-labelledby={`${uid}-mode-${m}-name`}
                      aria-describedby={`${uid}-mode-${m}-hint`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span id={`${uid}-mode-${m}-name`} className="block text-[13px] font-medium">
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

              <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
                <div className="min-w-0">
                  <Label htmlFor={`${uid}-mod-enabled`}>{t('rooms:editor.moderatorEnable')}</Label>
                  <p className="text-xs text-muted-foreground">{t('rooms:editor.moderatorNoTools')}</p>
                </div>
                <Switch
                  id={`${uid}-mod-enabled`}
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
                      <p id={`${lid}-hint`} className="text-[11.5px] text-muted-foreground">
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
            </div>
          </fieldset>

          {locked ? (
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
          ) : (
            <div className="flex flex-col items-stretch gap-2">
              <Button type="submit" className="w-full" disabled={busy}>
                {t('rooms:editor.save')}
              </Button>
              {saved && (
                <span role="status" className="text-center text-xs text-muted-foreground">
                  {t('rooms:editor.saved')}
                </span>
              )}
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
