import { useId, useState, type ReactNode } from 'react'
import { CircleCheck, FileText, Flag, Sparkles, X } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import type { RoomsUiError } from '../roomsBindings'
import type { controlAvailability } from '../roomUi'

/** A "steer the discussion" tile: icon, name and one line on what it does. */
function ActionTile({
  icon,
  label,
  hint,
  ...props
}: Omit<React.ComponentProps<'button'>, 'children'> & {
  icon: ReactNode
  label: string
  hint: string
}) {
  const id = useId()
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={`${id}-hint`}
      className="flex cursor-pointer flex-col items-start gap-1 rounded-[10px] border-[0.8px] border-border bg-card p-2.5 text-left outline-hidden transition-[transform,box-shadow,border-color] duration-250 ease-expo hover:-translate-y-px hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-expanded:border-border-strong disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none"
      {...props}
    >
      <span className="mb-0.5 grid size-[26px] place-items-center rounded-lg bg-muted text-secondary-foreground shadow-[inset_0_0_0_0.8px_var(--border)] [&_svg]:size-3.5">
        {icon}
      </span>
      <b className="text-[length:calc(var(--ui-font-base)*0.78125)] font-semibold text-foreground">{label}</b>
      <small id={`${id}-hint`} className="text-[length:calc(var(--ui-font-base)*0.71875)] leading-[1.35] text-muted-foreground">
        {hint}
      </small>
    </button>
  )
}

type Props = {
  roomId: string
  avail: ReturnType<typeof controlAvailability>
  busy: boolean
  /** The room is under way; steering is locked otherwise. */
  active: boolean
  error: RoomsUiError | null
  /** Submit a proposal; resolves once the vote is called. */
  onCallVote: (proposal: string) => Promise<void>
  onFinalPositions: () => void
  onSynthesize: () => void
  onCancelTurn: () => void
  /** Run a controller call with the panel's busy/error handling. */
  run: (fn: () => Promise<void>) => void
}

/** Steering between turns: vote, final positions, synthesis, cancel. */
export function SteerPanel({
  roomId,
  avail,
  busy,
  active,
  error,
  onCallVote,
  onFinalPositions,
  onSynthesize,
  onCancelTurn,
  run,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const [voteOpen, setVoteOpen] = useState(false)
  const [proposal, setProposal] = useState('')
  return (
    <Frame className="motion-safe:animate-rise-in [animation-delay:50ms]">
      <FrameHeader icon={<Sparkles />} title={t('rooms:controls.steer')} />
      <FrameBody className="gap-0 p-3.5">
        <div className="grid grid-cols-2 gap-2">
          <ActionTile
            icon={<CircleCheck />}
            label={t('rooms:controls.callVote')}
            hint={t('rooms:controls.callVoteHint')}
            disabled={!avail.callVote || busy}
            aria-expanded={voteOpen}
            onClick={() => setVoteOpen((v) => !v)}
          />
          <ActionTile
            icon={<Flag />}
            label={t('rooms:controls.finalPositions')}
            hint={t('rooms:controls.finalPositionsHint')}
            disabled={!avail.requestFinalPositions || busy}
            onClick={onFinalPositions}
          />
          <ActionTile
            icon={<FileText />}
            label={t('rooms:controls.synthesize')}
            hint={t('rooms:controls.synthesizeHint')}
            disabled={!avail.synthesize || busy}
            onClick={onSynthesize}
          />
          <ActionTile
            icon={<X />}
            label={t('rooms:controls.cancelTurn')}
            hint={t('rooms:controls.cancelTurnHint')}
            disabled={!avail.cancelTurn || busy}
            onClick={onCancelTurn}
          />
        </div>

        {voteOpen && avail.callVote && (
          <form
            className="mt-2.5 flex flex-col gap-1.5 motion-safe:animate-dd-in"
            onSubmit={(e) => {
              e.preventDefault()
              const text = proposal.trim()
              if (!text) return
              run(async () => {
                await onCallVote(text)
                setProposal('')
                setVoteOpen(false)
              })
            }}
          >
            <label htmlFor={`vote-${roomId}`} className="sr-only">
              {t('rooms:controls.proposal')}
            </label>
            <Input
              id={`vote-${roomId}`}
              autoFocus
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

        {!active && (
          <p className="mt-2.5 text-xs text-muted-foreground">{t('rooms:controls.steerLocked')}</p>
        )}
        {busy && (
          <p role="status" className="mt-2.5 text-xs text-muted-foreground">
            {t('rooms:controls.busy')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2.5 text-xs text-destructive">
            {error.message}
          </p>
        )}
      </FrameBody>
    </Frame>
  )
}
