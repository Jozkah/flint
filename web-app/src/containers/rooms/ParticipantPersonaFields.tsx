import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useAssistant } from '@/hooks/useAssistant'
import { Label } from '@/components/ui/label'
import AddEditAssistant from '@/containers/dialogs/AddEditAssistant'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { WORK_PROFILES, isWorkProfileId, type WorkProfileId } from '@/lib/workProfiles'
import { PickerDropdown } from './PickerDropdown'
import { ICONS as PROFILE_ICONS } from '@/containers/CoworkWorkProfilePicker'
import { AvatarEmoji } from '@/containers/AvatarEmoji'

const OTHER = '__other'

/**
 * What sets a participant apart besides its model: its work role (one of the
 * work profiles, or "Other" with a role written by hand) and whose personality
 * it speaks with (an assistant, including one made right here). Both are
 * optional; left alone the model speaks as it is.
 *
 * Choosing a work profile also writes its name as the role the other
 * participants see, so the two never disagree.
 */
export function ParticipantPersonaFields({
  idPrefix,
  role,
  assistantId,
  workProfile,
  disabled,
  onChange,
}: {
  idPrefix: string
  role: string
  assistantId?: string
  workProfile?: WorkProfileId
  disabled?: boolean
  onChange: (patch: {
    role?: string
    assistantId?: string
    workProfile?: WorkProfileId
  }) => void
}) {
  const { t } = useTranslation()
  const assistants = useAssistant((s) => s.assistants)
  const [otherChosen, setOtherChosen] = useState(false)
  const [creating, setCreating] = useState(false)

  // A role with no profile behind it is one written by hand.
  const isOther = !workProfile && (otherChosen || role.trim() !== '')
  const roleValue = workProfile ?? (isOther ? OTHER : null)
  const knownAssistant = assistantId ? assistants.some((a) => a.id === assistantId) : true

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-role`}>{t('rooms:editor.participantRole')}</Label>
        <PickerDropdown
          id={`${idPrefix}-role`}
          value={roleValue}
          placeholder={t('rooms:editor.participantRoleNone')}
          menuLabel={t('common:jev.profilesTitle')}
          // The role written by hand is the button's label once there is one.
          shownLabel={isOther && role.trim() ? role.trim() : undefined}
          inlineInput={{
            forValue: OTHER,
            value: role,
            placeholder: t('rooms:editor.participantRolePlaceholder'),
            onChange: (text) => onChange({ workProfile: undefined, role: text }),
          }}
          disabled={disabled}
          groups={[
            {
              items: [
                { value: '', label: t('rooms:editor.participantRoleNone') },
                ...WORK_PROFILES.map((p) => {
                  const Icon = PROFILE_ICONS[p.id]
                  return {
                    value: p.id,
                    label: p.label,
                    hint: p.description,
                    icon: <Icon aria-hidden className="size-4 text-secondary-foreground" />,
                  }
                }),
                { value: OTHER, label: t('rooms:editor.participantRoleOther'), keepOpen: true },
              ],
            },
          ]}
          onChange={(v) => {
            if (v === OTHER) {
              setOtherChosen(true)
              onChange({ workProfile: undefined, role: workProfile ? '' : role })
            } else if (isWorkProfileId(v)) {
              setOtherChosen(false)
              onChange({
                workProfile: v,
                role: WORK_PROFILES.find((p) => p.id === v)?.label ?? '',
              })
            } else {
              setOtherChosen(false)
              onChange({ workProfile: undefined, role: '' })
            }
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-assistant`}>{t('rooms:editor.participantAssistant')}</Label>
        <PickerDropdown
          id={`${idPrefix}-assistant`}
          value={assistantId ?? ''}
          placeholder={t('rooms:editor.participantAssistantNone')}
          menuLabel={t('rooms:editor.participantAssistant')}
          // An assistant that was deleted still reads as chosen, so it can be replaced.
          shownLabel={!knownAssistant && assistantId ? assistantId : undefined}
          disabled={disabled}
          groups={[
            {
              items: [
                { value: '', label: t('rooms:editor.participantAssistantNone') },
                ...assistants.map((a) => ({
                  value: a.id,
                  label: a.name,
                  icon: a.avatar ? (
                    <AvatarEmoji
                      avatar={a.avatar}
                      imageClassName="size-4 object-contain"
                      textClassName="text-sm"
                    />
                  ) : undefined,
                })),
              ],
            },
          ]}
          onChange={(v) => onChange({ assistantId: v || undefined })}
          footer={[
            {
              label: t('rooms:editor.participantAssistantNew'),
              icon: <Plus className="size-4" />,
              onSelect: () => setCreating(true),
            },
          ]}
        />
      </div>
      {creating && (
        <AddEditAssistant
          open
          onOpenChange={setCreating}
          editingKey={null}
          onSave={(assistant) => {
            useAssistant.getState().addAssistant(assistant)
            onChange({ assistantId: assistant.id })
          }}
        />
      )}
    </div>
  )
}
