import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { errorText } from '@/lib/errorText'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { StopReport } from '@/containers/EmergencyStop'

/**
 * One Stop control, with a choice of how far it reaches.
 *
 * There used to be two: the composer's stop button, which ended the response
 * being streamed, and a separate emergency stop beside it, which ended
 * everything. Two buttons a few pixels apart, one of them destructive, is a
 * bad way to ask "how much do you want to stop" -- so it is asked once, in a
 * small popup anchored to the one button.
 *
 * Neither choice is a new cancellation path. "Stop current task" is the run's
 * own abort plus the scoped stop for that run; "Stop all activity" is the
 * application-wide emergency stop. Both end at the same backend.
 */
export type CoworkStopMenuProps = {
  /** Whether anything is running. The popup closes when this goes false. */
  running: boolean
  sessionId?: string
  runId?: string
  /** Aborts the run in this process (the streaming request and its loop). */
  onStopCurrent: () => void
  /** Aborts every run in this process. Required for "stop all" to actually
   * stop the renderer-side loops the Rust emergency-stop cannot reach. */
  onStopAll: () => void
  /** Injectable for tests; defaults to the real IPC command. */
  onStop?: (args: {
    session?: string
    run?: string
    call?: string
  }) => Promise<StopReport>
}

type Choice = 'current' | 'all'

export function CoworkStopMenu({
  running,
  sessionId,
  runId,
  onStopCurrent,
  onStopAll,
  onStop,
}: CoworkStopMenuProps) {
  // The one cancellation backend, at whatever scope was chosen. Neither choice
  // in this menu has a path of its own.
  const stop = useCallback(
    (args: { session?: string; run?: string; call?: string }) =>
      onStop
        ? onStop(args)
        : invoke<StopReport>('agent_emergency_stop', args),
    [onStop]
  )
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState<Choice | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([])
  const statusId = useId()

  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  // Work finishing is an answer to the question the popup asks, so it stops
  // asking rather than leaving a stale choice on screen.
  useEffect(() => {
    if (!running && open) {
      close()
      triggerRef.current?.focus()
    }
  }, [running, open, close])

  const report = useCallback(
    (choice: Choice, result: StopReport) => {
      // One message. The result is either clean or it names what survived --
      // never both, and never a second toast saying the same thing again.
      if (result.complete) {
        toast.success(
          choice === 'all'
            ? t('common:stopMenu.allStopped', { count: result.stopped })
            : t('common:stopMenu.currentStopped')
        )
      } else {
        toast.error(
          t('common:stopMenu.incomplete', { count: result.live_children })
        )
      }
    },
    [t]
  )

  const run = useCallback(
    async (choice: Choice) => {
      if (stopping) return
      setStopping(choice)
      try {
        if (choice === 'current') {
          // The local abort ends the streaming request; the scoped stop ends
          // the tools, MCP calls, permission waits and subagents underneath it.
          onStopCurrent()
          report(choice, await stop({ session: sessionId, run: runId }))
        } else {
          // Abort this chat's renderer loop and stop its backend activity.
          onStopCurrent()
          report(choice, await stop({ session: sessionId }))
        }
        close()
        triggerRef.current?.focus()
      } catch (e) {
        toast.error(errorText(e))
      } finally {
        setStopping(null)
      }
    },
    [close, onStopCurrent, onStopAll, report, runId, sessionId, stop, stopping]
  )

  /** Roving focus across the two choices. */
  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + 2) % 2
      itemsRef.current[next]?.focus()
    }
  }

  if (!running) return null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setConfirming(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('common:stopMenu.trigger')}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="cowork-stop"
          // Fixed size so it cannot grow or shift the token and context
          // indicators beside it while a response streams.
          className="grid size-7 shrink-0 place-items-center rounded-lg border-[0.8px] border-destructive/40 text-destructive outline-none transition-[background-color,transform] duration-150 ease-expo hover:bg-destructive/10 focus-visible:ring-[3px] focus-visible:ring-destructive/30 active:scale-95 data-[state=open]:bg-destructive/10 pointer-coarse:size-11"
        >
          <Square className="size-3 fill-current" aria-hidden />
        </button>
      </PopoverTrigger>
      {/* Anchored and small. No overlay: stopping is not a modal decision, and
          dimming the app to ask it would hide the work being stopped. */}
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className="w-64 p-1.5"
        role="menu"
        aria-label={t('common:stopMenu.trigger')}
        data-testid="cowork-stop-menu"
        onEscapeKeyDown={() => triggerRef.current?.focus()}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          triggerRef.current?.focus()
        }}
      >
        <button
          ref={(el) => {
            itemsRef.current[0] = el
          }}
          type="button"
          role="menuitem"
          disabled={stopping !== null}
          data-testid="stop-current"
          onKeyDown={(e) => onItemKeyDown(e, 0)}
          onClick={() => void run('current')}
          className="flex w-full flex-col items-start gap-[3px] rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-50 motion-safe:animate-mi-in"
        >
          <span className="text-[13px] leading-5 font-medium">
            {t('common:stopMenu.current')}
          </span>
          <span className="text-xs leading-[1.4] text-muted-foreground">
            {t('common:stopMenu.currentDescription')}
          </span>
        </button>

        {!confirming ? (
          <button
            ref={(el) => {
              itemsRef.current[1] = el
            }}
            type="button"
            role="menuitem"
            disabled={stopping !== null}
            data-testid="stop-all"
            onKeyDown={(e) => onItemKeyDown(e, 1)}
            onClick={() => setConfirming(true)}
            className="flex w-full flex-col items-start gap-[3px] rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-50 motion-safe:animate-mi-in"
          >
            <span className="text-[13px] leading-5 font-medium text-destructive">
              {t('common:stopMenu.all')}
            </span>
            <span className="text-xs leading-[1.4] text-muted-foreground">
              {t('common:stopMenu.allDescription')}
            </span>
          </button>
        ) : (
          // Inline, in the space the choice occupied: a confirmation that
          // opened a second window over the first would be a third thing to
          // dismiss.
          <div
            className={cn(
              'flex flex-col gap-2 px-2.5 py-2',
              'motion-safe:animate-fade-in'
            )}
            data-testid="stop-all-confirm"
          >
            <span className="text-[13px] leading-5 font-semibold">
              {t('common:stopMenu.confirm')}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="surface"
                size="sm"
                className="h-7"
                data-testid="stop-all-cancel"
                onClick={() => {
                  setConfirming(false)
                  itemsRef.current[1]?.focus()
                }}
              >
                {t('common:cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7"
                autoFocus
                disabled={stopping !== null}
                data-testid="stop-all-confirmed"
                onClick={() => void run('all')}
              >
                {t('common:stopMenu.allConfirm')}
              </Button>
            </div>
          </div>
        )}

        <p className="sr-only" role="status" id={statusId}>
          {stopping ? t('common:stopMenu.stopping') : ''}
        </p>
      </PopoverContent>
    </Popover>
  )
}

export default CoworkStopMenu
