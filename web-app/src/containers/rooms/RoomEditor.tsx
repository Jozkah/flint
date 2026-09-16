import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import { activeParticipants, clampLimit, isEditable, limitCeiling } from './roomUi'
import { findModel, modelSupportsTools, RoomModelSelect } from './RoomModelSelect'
import { RoomSection } from './RoomSection'

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

function parseLimit(key: keyof RoomLimits, raw: string): { value: number | null; capped: boolean } {
  if (key === 'maxCostUsd') {
    if (raw.trim() === '') return { value: null, capped: false }
    const n = Number(raw)
    return { value: Number.isFinite(n) && n >= 0 ? n : 0, capped: false }
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

export function RoomEditor({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const serviceHub = useServiceHub()
  const { pendingAction } = useRoomsState()
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
      const kept = prev.filter((d) => fresh.some((f) => f.id === d.id))
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

  const updateParticipant = (id: string, patch: Partial<DraftParticipant>) => {
    dirty.current = true
    setSaved(false)
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const save = async () => {
    setShowErrors(true)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    setError(null)
    try {
      const nextParticipants = room.participants.map((p) => {
        const d = participants.find((x) => x.id === p.id)
        if (!d) return p
        const tools = modelSupportsTools(findModel(providers, d.model))
        return {
          ...p,
          name: d.name.trim(),
          role: d.role.trim(),
          model: d.model,
          toolAccess: tools ? d.toolAccess : ('none' as const),
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
        toolAccess: 'none',
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

  return (
    <form
      aria-labelledby={`${uid}-heading`}
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="px-1">
        <h2 id={`${uid}-heading`} className="text-sm font-semibold text-foreground">
          {t('rooms:editor.heading')}
        </h2>
      </div>
      {locked && (
        <p
          role="note"
          className="rounded-lg border border-border bg-muted/60 p-2.5 text-xs text-muted-foreground"
        >
          {t('rooms:editor.lockedWhileRunning')}
        </p>
      )}

      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
        <RoomSection>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-title`}>{t('rooms:editor.title')}</Label>
            <Input id={`${uid}-title`} value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-objective`}>{t('rooms:editor.objective')}</Label>
            <Textarea
              id={`${uid}-objective`}
              rows={3}
              value={objective}
              onChange={(e) => edit(setObjective)(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('rooms:editor.workingFolder')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('rooms:editor.workingFolderHint')}
            </p>
            {room.folder ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1 text-xs">
                  {room.folder}
                </code>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void attachFolder()}
                >
                  {t('rooms:editor.changeFolder')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void detachFolder()}
                >
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
          </div>
        </RoomSection>

        <RoomSection>
        <div className="flex flex-col gap-2">
          <span id={`${uid}-mode`} className="text-sm font-medium">
            {t('rooms:editor.speakingMode')}
          </span>
          <RadioGroup
            aria-labelledby={`${uid}-mode`}
            aria-describedby={visibleErrors.mode ? `${uid}-mode-error` : undefined}
            value={mode}
            disabled={disabled}
            onValueChange={(v) => edit(setMode)(v as SpeakingMode)}
            className="gap-2"
          >
            {MODES.map((m) => (
              <div key={m} className="flex items-start gap-2">
                <RadioGroupItem id={`${uid}-mode-${m}`} value={m} className="mt-0.5" />
                <div className="min-w-0">
                  <Label htmlFor={`${uid}-mode-${m}`}>{t(`rooms:mode.${m}`)}</Label>
                  <p className="text-xs text-muted-foreground">{t(`rooms:mode.${m}Hint`)}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          <FieldError id={`${uid}-mode-error`} message={visibleErrors.mode} />
        </div>

        <section
          className="flex flex-col gap-2 border-t border-border pt-4"
          aria-labelledby={`${uid}-mod-heading`}
        >
          <h3 id={`${uid}-mod-heading`} className="text-sm font-medium">
            {t('rooms:editor.moderator')}
          </h3>
          <div className="flex items-center gap-2">
            <Switch
              id={`${uid}-mod-enabled`}
              checked={moderator.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => edit(setModerator)({ ...moderator, enabled })}
            />
            <Label htmlFor={`${uid}-mod-enabled`}>{t('rooms:editor.moderatorEnable')}</Label>
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
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t('rooms:editor.moderatorNoTools')}
              </p>
            </div>
          )}
        </section>
        </RoomSection>

        <RoomSection contentClassName="gap-2">
        <section className="flex flex-col gap-2" aria-labelledby={`${uid}-p-heading`}>
          <h3 id={`${uid}-p-heading`} className="text-sm font-medium">
            {t('rooms:editor.participants')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('rooms:editor.participantsHint', { max: ROOM_LIMIT_CEILINGS.maxParticipants })}
          </p>
          {participants.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('rooms:editor.noParticipants')}</p>
          )}
          <ul className="flex flex-col gap-3">
            {participants.map((p) => {
              const pid = `${uid}-p-${p.id}`
              const model = findModel(providers, p.model)
              const tools = modelSupportsTools(model)
              const availability = p.source.availability
              return (
                <li
                  key={p.id}
                  data-testid="room-participant"
                  className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-3"
                >
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
                    <span id={`${pid}-tools`} className="text-sm font-medium">
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
                          <Label htmlFor={`${pid}-tools-${v}`}>
                            {t(
                              v === 'none'
                                ? 'rooms:editor.toolNone'
                                : v === 'read'
                                  ? 'rooms:editor.toolRead'
                                  : 'rooms:editor.toolEdit'
                            )}
                          </Label>
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

                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
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
                      size="sm"
                      variant="ghost"
                      aria-label={t('rooms:editor.removeLabel', { name: p.name })}
                      onClick={() => void remove(p.id)}
                    >
                      {t('rooms:editor.remove')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-border bg-background/60 p-3">
            <h4 className="text-xs font-medium text-muted-foreground">{t('rooms:editor.addHeading')}</h4>
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
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void add()}>
                    {t('rooms:editor.add')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </section>

        </RoomSection>

        <RoomSection>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
            <span className="text-sm font-medium">{t('rooms:editor.limits')}</span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">{t('rooms:editor.limitsHint')}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {LIMIT_KEYS.map((key) => {
              const lid = `${uid}-limit-${key}`
              const ceiling = displayCeiling(key)
              const raw = limits[key]
              const parsed = parseLimit(key, raw)
              return (
                <div key={key} className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={lid}>{t(`rooms:limits.${key}`)}</Label>
                  <Input
                    id={lid}
                    type="number"
                    min={key === 'maxCostUsd' || key === 'repetitionSimilarity' ? 0 : 1}
                    max={ceiling ?? undefined}
                    step={key === 'repetitionSimilarity' ? '0.05' : key === 'maxCostUsd' ? '0.01' : '1'}
                    value={raw}
                    placeholder={key === 'maxCostUsd' ? t('rooms:editor.costNone') : undefined}
                    aria-describedby={`${lid}-hint`}
                    onChange={(e) => edit(setLimits)({ ...limits, [key]: e.target.value })}
                    onBlur={() => edit(setLimits)({ ...limits, [key]: showLimit(key, parsed.value) })}
                  />
                  <p id={`${lid}-hint`} className="text-xs text-muted-foreground">
                    {parsed.capped && ceiling !== null ? (
                      <span className="text-destructive">{t('rooms:editor.clamped', { max: ceiling })}</span>
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
        </details>
        </RoomSection>

        <div className="flex flex-col items-stretch gap-2 pt-1">
          <Button type="submit" className="w-full">
            {t('rooms:editor.save')}
          </Button>
          {saved && (
            <span role="status" className="text-center text-xs text-muted-foreground">
              {t('rooms:editor.saved')}
            </span>
          )}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}
    </form>
  )
}
