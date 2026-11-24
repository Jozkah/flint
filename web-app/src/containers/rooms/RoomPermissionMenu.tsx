import { useState } from 'react'
import { toast } from 'sonner'
import type { Participant, Room } from '@/lib/rooms/types'
import { effectivePermissionMode } from '@/lib/rooms/permissionMode'
import type { CoworkMode } from '@/lib/coworkMode'
import { CoworkModeSelector } from '@/containers/CoworkModeSelector'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { normalizeError, useRoomsApi } from './roomsBindings'

/**
 * Cowork's "What Flint may do" menu, for a room or one of its participants.
 *
 * The same selector Cowork uses; the choice is saved with the room. A room's
 * settings cannot change while it runs (the engine saves its own copy), so the
 * menu is shown but disabled then, and says to pause first.
 */
export function RoomPermissionMenu({
  room,
  participant,
  variant = 'quiet',
}: {
  room: Room
  /** The participant whose own mode this sets; omitted, the room's. */
  participant?: Participant
  variant?: 'pill' | 'quiet'
}) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const [saving, setSaving] = useState(false)
  const running = room.status === 'running'
  const mode = effectivePermissionMode(room, participant)

  const save = async (next: CoworkMode | null) => {
    setSaving(true)
    try {
      await api.updateRoomSettings(
        room,
        participant
          ? { participants: [{ id: participant.id, permissionMode: next }] }
          : { permissionMode: next }
      )
    } catch (err) {
      toast.error(t('rooms:permissions.failed'), {
        description: normalizeError(err)?.message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      // A disabled button shows no tooltip of its own in every browser.
      title={running ? t('rooms:permissions.pauseFirst') : undefined}
      data-testid={participant ? 'participant-permission' : 'room-permission'}
    >
      <CoworkModeSelector
        mode={mode}
        variant={variant}
        disabled={running || saving}
        disabledReason={running ? t('rooms:permissions.pauseFirst') : undefined}
        onChange={(next) => void save(next)}
      />
      {participant &&
        (participant.permissionMode ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={running || saving}
            data-testid="participant-permission-reset"
            onClick={() => void save(null)}
          >
            {t('rooms:permissions.useRoom')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t('rooms:permissions.inherits')}
          </span>
        ))}
    </span>
  )
}
