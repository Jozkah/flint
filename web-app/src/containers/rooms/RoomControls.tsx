import { useState } from 'react'
import type { Room } from '@/lib/rooms/types'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { normalizeError, useRoomsApi, useRoomsState, type RoomsUiError } from './roomsBindings'
import { activeParticipants, availableParticipants, controlAvailability } from './roomUi'
import { RoomSection } from './RoomSection'

export function RoomControls({ room }: { room: Room }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const { liveTurn, pendingAction, lastError } = useRoomsState()
  const [localError, setLocalError] = useState<RoomsUiError | null>(null)
  const [voteOpen, setVoteOpen] = useState(false)
  const [proposal, setProposal] = useState('')
  const [stopOpen, setStopOpen] = useState(false)
  const [running, setRunning] = useState(false)

  const avail = controlAvailability(room, liveTurn)
  const busy = running || pendingAction !== null
  const c = api.controller
  const error = localError ?? lastError

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

  const speakers = availableParticipants(room)

  return (
    <RoomSection
      aria-label={t('rooms:controls.label')}
      aria-busy={busy}
      title={t('rooms:controls.label')}
      contentClassName="gap-3"
    >
      {/* The primary action gets the full width so the main thing to do is
          unmistakable; the routine turn actions sit in an even grid below. */}
      {room.status === 'paused' ? (
        <Button
          className="w-full"
          disabled={!avail.resume || busy}
          onClick={() => run(() => c.resume(room.id))}
        >
          {t('rooms:controls.resume')}
        </Button>
      ) : (
        <Button
          className="w-full"
          disabled={!avail.start || busy}
          onClick={() => run(() => c.start(room.id))}
        >
          {t('rooms:controls.start')}
        </Button>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!avail.pause || busy}
          onClick={() => run(() => c.pause(room.id))}
        >
          {t('rooms:controls.pause')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!avail.cancelTurn || busy}
          onClick={() => run(() => c.cancelTurn(room.id))}
        >
          {t('rooms:controls.cancelTurn')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!avail.selectNext || busy}
            >
              {t('rooms:controls.selectNext')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {speakers.length === 0 ? (
              <DropdownMenuItem disabled>{t('rooms:controls.noSpeakers')}</DropdownMenuItem>
            ) : (
              speakers.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => run(() => c.selectNext(room.id, p.id))}>
                  {p.role ? `${p.name} · ${p.role}` : p.name}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          disabled={!avail.callVote || busy}
          aria-expanded={voteOpen}
          onClick={() => setVoteOpen((v) => !v)}
        >
          {t('rooms:controls.callVote')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!avail.requestFinalPositions || busy}
          onClick={() => run(() => c.requestFinalPositions(room.id))}
        >
          {t('rooms:controls.finalPositions')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!avail.synthesize || busy}
          onClick={() => run(() => c.synthesize(room.id))}
        >
          {t('rooms:controls.synthesize')}
        </Button>
      </div>

      {/* Stop ends the run: kept on its own, away from the routine actions. */}
      <Button
        size="sm"
        variant="destructive"
        className="w-full"
        disabled={!avail.stop || busy}
        onClick={() => setStopOpen(true)}
      >
        {t('rooms:controls.stop')}
      </Button>

      {voteOpen && avail.callVote && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            const text = proposal.trim()
            if (!text) return
            run(async () => {
              await c.callVote(room.id, text)
              setProposal('')
              setVoteOpen(false)
            })
          }}
        >
          <label htmlFor={`vote-${room.id}`} className="sr-only">
            {t('rooms:controls.proposal')}
          </label>
          <Input
            id={`vote-${room.id}`}
            value={proposal}
            placeholder={t('rooms:controls.proposalPlaceholder')}
            onChange={(e) => setProposal(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!proposal.trim() || busy}>
              {t('rooms:controls.submitVote')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setVoteOpen(false)}>
              {t('rooms:controls.cancel')}
            </Button>
          </div>
        </form>
      )}

      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('rooms:controls.busy')}
        </p>
      )}
      {!avail.start && room.status === 'draft' && activeParticipants(room).length < 2 && (
        <p className="text-xs text-muted-foreground">{t('rooms:controls.needParticipants')}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}

      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rooms:controls.stopTitle')}</DialogTitle>
            <DialogDescription>{t('rooms:controls.stopDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStopOpen(false)}>
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
    </RoomSection>
  )
}
