/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useMemo, useReducer, useState } from 'react'
import { Lock, Plus, Settings2, Users } from 'lucide-react'
import type { Room } from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
import { LIMIT_KEYS, budgetFromDraft, draftFromRoom, parsePricing, roomDraftReducer, type DraftField, type DraftParticipant, type RoomDraft } from '@/lib/rooms/roomDraft'
import { AUTOSAVE_MS, useRoomAutosave } from '@/hooks/useRoomAutosave'
import { AddParticipantForm } from './AddParticipantForm'
import { limitsFromDraft, validate, type SettingsTab } from './roomEditorHelpers'
import { RoomParticipantCard } from './RoomParticipantCard'
import { RoomGeneralTab } from './RoomGeneralTab'
import { RoomDiscussionTab } from './RoomDiscussionTab'
import { RoomLimitsTab } from './RoomLimitsTab'
import { type Errors } from './roomEditorShared'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Segmented } from '@/components/ui/segmented'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import { activeParticipants, isEditable } from './roomUi'
import { findModel } from './RoomModelSelect'
import { applicableParticipantReasoning } from '@/lib/rooms/participantReasoning'

// Re-exported: tests and the limits fields import it from here.
export { LIMIT_KEYS }

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
  const { title, objective, mode, compareRun, reasoningEffort, moderator, limits, budget, participants } = draft
  const field =
    <K extends DraftField>(key: K) =>
    (value: RoomDraft[K]) =>
      dispatch({ type: 'edit', field: key, value })
  const setTitle = field('title')
  const setObjective = field('objective')
  const setMode = field('mode')
  const setCompareRun = field('compareRun')
  const setReasoningEffort = field('reasoningEffort')
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
        reasoningEffort,
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
            {participants.map((p) => (
              <RoomParticipantCard
                key={p.id}
                p={p}
                uid={uid}
                room={room}
                providers={providers}
                lookup={lookup}
                open={openIds.has(p.id)}
                speaking={speakingId === p.id}
                visibleErrors={visibleErrors}
                mode={mode}
                disabled={disabled}
                onOpenChange={(next) => setOpen(p.id, next)}
                updateParticipant={updateParticipant}
                onRemove={(id) => void remove(id)}
              />
            ))}

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
            <RoomGeneralTab
              hidden={tab !== 'general'}
              uid={uid}
              room={room}
              title={title}
              objective={objective}
              onTitle={edit(setTitle)}
              onObjective={edit(setObjective)}
              attachFolder={attachFolder}
              detachFolder={detachFolder}
              addExtraFolder={addExtraFolder}
              removeExtraFolder={removeExtraFolder}
            />

            <RoomDiscussionTab
              hidden={tab !== 'discussion'}
              uid={uid}
              room={room}
              mode={mode}
              compareRun={compareRun}
              reasoningEffort={reasoningEffort}
              moderator={moderator}
              participants={participants}
              visibleErrors={visibleErrors}
              disabled={disabled}
              onMode={edit(setMode)}
              onCompareRun={edit(setCompareRun)}
              onReasoningEffort={edit(setReasoningEffort)}
              onModerator={edit(setModerator)}
            />

            <RoomLimitsTab
              hidden={tab !== 'limits'}
              uid={uid}
              limits={limits}
              budget={budget}
              missingPricing={missingPricing}
              onLimits={edit(setLimits)}
              onBudget={edit(setBudget)}
            />
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
