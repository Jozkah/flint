import { useState } from 'react'
import type { ModeratorConfig, Room, RoomModelRef } from '@/lib/rooms/types'
import { ROOM_LIMIT_CEILINGS } from '@/lib/rooms/types'
import type { WorkProfileId } from '@/lib/workProfiles'
import type { DraftParticipant } from '@/lib/rooms/roomDraft'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ParticipantPersonaFields } from './ParticipantPersonaFields'
import { RoomModelSelect } from './RoomModelSelect'
import { normalizeError, useRoomsApi, type RoomsUiError } from './roomsBindings'
import { FieldError, norm, type Errors } from './roomEditorShared'

/**
 * The "add a participant" panel of the room editor. Its form state (name,
 * role, persona, model, field errors) is its own: the editor only learns
 * about a new participant when the room changes.
 */
export function AddParticipantForm({
  room,
  uid,
  hidden,
  participants,
  moderator,
  disabled,
  atMax,
  onCancel,
  onError,
}: {
  room: Room
  /** Id prefix shared with the editor so field ids stay unique on the page. */
  uid: string
  hidden: boolean
  participants: DraftParticipant[]
  moderator: ModeratorConfig
  disabled: boolean
  atMax: boolean
  onCancel: () => void
  onError: (error: RoomsUiError | null) => void
}) {
  const { t } = useTranslation()
  const api = useRoomsApi()

  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newPersona, setNewPersona] = useState<{ assistantId?: string; workProfile?: WorkProfileId }>({})
  const [newModel, setNewModel] = useState<RoomModelRef | null>(null)
  const [newErrors, setNewErrors] = useState<Errors>({})

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
    onError(null)
    try {
      await api.addParticipant(room, {
        name: newName.trim(),
        role: newRole.trim(),
        assistantId: newPersona.assistantId,
        workProfile: newPersona.workProfile,
        model: newModel,
        // Omitted so the controller applies its default (read-only for a
        // tool-capable model), rather than starting the participant tool-less.
      })
      setNewName('')
      setNewRole('')
      setNewPersona({})
      setNewModel(null)
    } catch (err) {
      onError(normalizeError(err))
    }
  }

  return (
    <div
      id={`${uid}-add`}
      hidden={hidden}
      className="@container mt-1.5 flex min-w-0 flex-col gap-2 rounded-[10px] border border-dashed border-border-strong p-3 motion-safe:animate-dd-in"
    >
      <h4 className="text-xs font-medium text-muted-foreground">{t('rooms:editor.addHeading')}</h4>
      {participants.length < 2 && (
        <p className="text-xs text-muted-foreground">
          {t('rooms:editor.participantsHint', { max: ROOM_LIMIT_CEILINGS.maxParticipants })}
        </p>
      )}
      {atMax ? (
        <p className="text-xs text-muted-foreground">
          {t('rooms:editor.maxReached', { max: ROOM_LIMIT_CEILINGS.maxParticipants })}
        </p>
      ) : (
        <>
          <div className="grid gap-2 @[26rem]:grid-cols-2">
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
          </div>
          <ParticipantPersonaFields
            idPrefix={`${uid}-new`}
            role={newRole}
            assistantId={newPersona.assistantId}
            workProfile={newPersona.workProfile}
            disabled={disabled}
            onChange={({ role, ...patch }) => {
              if (role !== undefined) setNewRole(role)
              setNewPersona((prev) => ({ ...prev, ...patch }))
            }}
          />
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
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {t('rooms:controls.cancel')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
