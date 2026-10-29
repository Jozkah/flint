import { useState } from 'react'
import { replaceMissingRoomModels, roomModelRefs } from '@/lib/rooms/ensureModels'
import { unavailableModels } from '@/lib/modelReplace'
import { ensureKnownWindows } from '@/lib/rooms/unknownWindows'
import { MessagesSquare } from 'lucide-react'
import type { Room } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import {
  activeParticipants,
  availableParticipants,
  controlAvailability,
} from './roomUi'
import { findModel } from './RoomModelSelect'
import { useModelProvider } from '@/hooks/useModelProvider'
import { RoomStatusBadge } from './RoomStatusBadge'
import { CompareRunPanel } from './CompareRunPanel'
import { ACTIVE_STATUSES, speakingQueue, stageFor } from './roomStage'
import { StageCard } from './controls/StageCard'
import { TransportRow } from './controls/TransportRow'
import { SpeakingQueue } from './controls/SpeakingQueue'
import { SteerPanel } from './controls/SteerPanel'
import './rooms.css'

export function RoomControls({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const providers = useModelProvider((s) => s.providers)
  const { liveTurn, liveTurns, pendingAction, lastError, journal } = useRoomsState()
  const [localError, setLocalError] = useState<RoomsUiError | null>(null)
  const [stopOpen, setStopOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const avail = controlAvailability(room, liveTurn)
  const busy = running || pendingAction !== null
  const c = api.controller
  const error = localError ?? lastError
  const live = liveTurn?.roomId === room.id ? liveTurn : null
  const active = ACTIVE_STATUSES.includes(room.status)

  const run = async (fn: () => Promise<void>) => {
    setLocalError(null)
    setRunning(true)
    try {
      await fn()
    } catch (err) {
      setLocalError(normalizeError(err))
    } finally {
      setRunning(false)
    }
  }

  // A model that has gone away is replaced before the room runs, with the
  // user's say, rather than the room starting and suspending that participant.
  const startAfterModelCheck = async (go: () => Promise<void>) => {
    const lookup = (name: string) => providers.find((p) => p.provider === name)
    let current = room
    if (unavailableModels(roomModelRefs(room), lookup as never).length > 0) {
      const patch = await replaceMissingRoomModels(room, lookup as never)
      if (patch === null) return
      if (patch.participants || patch.moderator) {
        await api.updateRoomSettings(room, {
          ...(patch.participants ? { participants: patch.participants } : {}),
          ...(patch.moderator ? { moderator: patch.moderator } : {}),
        })
        current = {
          ...room,
          ...(patch.participants ? { participants: patch.participants } : {}),
          ...(patch.moderator ? { moderator: patch.moderator } : {}),
        }
      }
    }
    // A model with no known window is settled with the user, not guessed at.
    if (!(await ensureKnownWindows(current))) return
    await go()
  }

  const stage = stageFor(
    room,
    live,
    t,
    (p) => {
      const m = findModel(providers, p.model)
      return m?.displayName || m?.name || p.model.id
    },
    (liveTurns ?? []).filter((l) => l.roomId === room.id).length || (live ? 1 : 0)
  )
  // A compare room answers everyone at once: there is no order and no "next".
  const compare = room.mode === 'compare'
  const queue = compare
    ? activeParticipants(room)
    : speakingQueue(
        room,
        live?.author.kind === 'participant' ? live.author.participantId : null
      ).slice(0, 4)
  const onStage = room.status === 'running' && live !== null
  const selectNext = (id: string) => run(() => c.selectNext(room.id, id))

  return (
    <section
      aria-label={t('rooms:controls.label')}
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-4"
    >
      <Frame className="motion-safe:animate-rise-in">
        <FrameHeader
          icon={<MessagesSquare />}
          title={t('rooms:controls.discussion')}
          actions={<RoomStatusBadge status={room.status} />}
        />
        <FrameBody className="gap-0 p-3.5">
          <StageCard room={room} stage={stage} onStage={onStage} />

          <TransportRow
            room={room}
            avail={avail}
            busy={busy}
            speakers={availableParticipants(room)}
            onPause={() => run(() => c.pause(room.id))}
            onResume={() => run(() => startAfterModelCheck(() => c.resume(room.id)))}
            onStart={() => run(() => startAfterModelCheck(() => c.start(room.id)))}
            onSelectNext={selectNext}
            onStop={() => setStopOpen(true)}
          />

          <SpeakingQueue
            queue={queue}
            compare={compare}
            active={active}
            canSelect={avail.selectNext && !busy}
            onPick={selectNext}
          />

          {!avail.start && room.status === 'draft' && activeParticipants(room).length < 2 && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              {t('rooms:controls.needParticipants')}
            </p>
          )}
        </FrameBody>
      </Frame>

      {compare && (
        <CompareRunPanel
          room={room}
          journal={journal}
          liveTurns={liveTurns ?? (live ? [live] : [])}
          busy={busy}
          run={(fn) => void run(fn)}
          onToggle={(p, include) =>
            api.updateRoomSettings(room, { participants: [{ ...p, compareSkip: !include }] })
          }
          onRun={(ids, scope) => startAfterModelCheck(() => c.compareRun(room.id, ids, scope))}
        />
      )}

      <SteerPanel
        roomId={room.id}
        avail={avail}
        busy={busy}
        active={active}
        error={error}
        onCallVote={(text) => c.callVote(room.id, text)}
        onFinalPositions={() => run(() => c.requestFinalPositions(room.id))}
        onSynthesize={() => run(() => c.synthesize(room.id))}
        onCancelTurn={() => run(() => c.cancelTurn(room.id))}
        run={(fn) => void run(fn)}
      />

      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rooms:controls.stopTitle')}</DialogTitle>
            <DialogDescription>{t('rooms:controls.stopDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="surface" onClick={() => setStopOpen(false)}>
              {t('rooms:controls.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setStopOpen(false)
                run(() => c.stop(room.id))
              }}
            >
              {t('rooms:controls.stopConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
