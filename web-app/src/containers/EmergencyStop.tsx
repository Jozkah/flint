import { useCallback, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { errorText } from '@/lib/errorText'

/**
 * Stop running work now. AH-051.
 *
 * The backend already stops things; this is the part a person can reach. Three
 * things it deliberately does not do:
 *
 * - It does not stop on the first click. An emergency stop that fires on a
 *   mis-click is its own incident, so the scope is chosen and confirmed, and
 *   the confirmation says in words exactly what is about to stop.
 * - It does not claim success it cannot prove. The backend reports how many
 *   child processes survived the sweep; if any did, this says so instead of
 *   showing a tick.
 * - It does not let you press it twice while it is working. A second stop
 *   landing mid-cleanup would report against a half-swept scope and read as a
 *   contradiction.
 */

/** How wide a stop reaches. Narrower is safer, so the default is the run. */
export type StopScope = 'call' | 'run' | 'session' | 'application'

/** What the Rust `agent_emergency_stop` command returns. */
export type StopReport = {
  stopped: number
  already_stopped: number
  live_children: number
  complete: boolean
  session: string
  run: string
  call: string
}

export type EmergencyStopProps = {
  /** The session in scope, when there is one. */
  sessionId?: string
  /** The run in scope, when one is active. */
  runId?: string
  /** The tool call in scope, when one is selected. */
  callId?: string
  /** Injectable for tests; defaults to the real IPC command. */
  onStop?: (args: {
    session?: string
    run?: string
    call?: string
  }) => Promise<StopReport>
}

/** Scopes the user can actually choose, given what is running. */
function availableScopes(props: EmergencyStopProps): StopScope[] {
  const scopes: StopScope[] = []
  if (props.callId) scopes.push('call')
  if (props.runId) scopes.push('run')
  if (props.sessionId) scopes.push('session')
  scopes.push('application')
  return scopes
}

/** One sentence naming exactly what a scope covers. */
function describeScope(scope: StopScope, props: EmergencyStopProps): string {
  switch (scope) {
    case 'call':
      return `This tool call only (${props.callId}). Everything else in the run keeps going.`
    case 'run':
      return `This run (${props.runId}), including its tool calls, shell commands, MCP calls and subagents. Other runs are untouched.`
    case 'session':
      return `Every run in this session (${props.sessionId}). Other sessions are untouched.`
    case 'application':
      return 'All work everywhere in Jan, in every session. Nothing running is spared.'
  }
}

/** The arguments an empty field turns into: empty means "all at this level". */
function scopeArgs(scope: StopScope, props: EmergencyStopProps) {
  switch (scope) {
    case 'call':
      return { session: props.sessionId, run: props.runId, call: props.callId }
    case 'run':
      return { session: props.sessionId, run: props.runId }
    case 'session':
      return { session: props.sessionId }
    case 'application':
      return {}
  }
}

export function EmergencyStop(props: EmergencyStopProps) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<StopScope>('run')
  const [stopping, setStopping] = useState(false)
  const [report, setReport] = useState<StopReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Focus goes back where it came from when the dialog closes, so keyboard and
  // screen-reader users are not dropped at the top of the document. The ref is
  // on a wrapper rather than the Button: the shared Button is a plain function
  // component and does not forward refs, so a ref placed on it is silently
  // null and the focus restore never happens.
  const triggerWrapRef = useRef<HTMLSpanElement>(null)
  const focusTrigger = useCallback(() => {
    triggerWrapRef.current?.querySelector('button')?.focus()
  }, [])
  const titleId = useId()
  const statusId = useId()

  const scopes = availableScopes(props)
  const chosen = scopes.includes(scope) ? scope : scopes[0]

  const run = useCallback(async () => {
    // Re-entrancy guard: a second stop mid-cleanup would report against a
    // half-swept scope.
    if (stopping) return
    setStopping(true)
    setError(null)
    setReport(null)
    try {
      const call =
        props.onStop ??
        ((args: { session?: string; run?: string; call?: string }) =>
          invoke<StopReport>('agent_emergency_stop', args))
      setReport(await call(scopeArgs(chosen, props)))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setStopping(false)
    }
  }, [chosen, props, stopping])

  const close = useCallback(() => {
    setOpen(false)
    setReport(null)
    setError(null)
    // After the dialog has torn down, so Radix's own focus handling does not
    // move it again afterwards.
    requestAnimationFrame(focusTrigger)
  }, [focusTrigger])

  return (
    <>
      <span ref={triggerWrapRef} className="contents">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          aria-label="Emergency stop"
          data-testid="emergency-stop-trigger"
          onClick={() => setOpen(true)}
        >
          Stop
        </Button>
      </span>

      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <DialogContent
          aria-labelledby={titleId}
          data-testid="emergency-stop-dialog"
        >
          <DialogHeader>
            <DialogTitle id={titleId}>Stop running work</DialogTitle>
            <DialogDescription>
              Choose how far this reaches. This cannot be undone: stopped work is
              not resumed, including after a restart.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex flex-col gap-2" disabled={stopping}>
            <legend className="sr-only">What to stop</legend>
            {scopes.map((option) => (
              <label
                key={option}
                className="flex items-start gap-2 text-sm"
                data-testid={`emergency-stop-scope-${option}`}
              >
                <input
                  type="radio"
                  name="emergency-stop-scope"
                  value={option}
                  checked={chosen === option}
                  onChange={() => setScope(option)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium capitalize">{option}</span>
                  <span className="block text-muted-foreground">
                    {describeScope(option, props)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {/* Progress and outcome share one live region, so a screen reader is
              told what is happening and then what happened, in order. */}
          <div
            id={statusId}
            role="status"
            aria-live="polite"
            data-testid="emergency-stop-status"
            className="min-h-5 text-sm"
          >
            {stopping && 'Stopping. Killing owned processes…'}
            {!stopping && report && (
              <span
                data-testid="emergency-stop-report"
                className={report.complete ? undefined : 'text-destructive'}
              >
                {report.complete
                  ? `Stopped. ${report.stopped} stopped, ${report.already_stopped} already stopped, nothing left running.`
                  : `Stopped ${report.stopped}, but ${report.live_children} process(es) are still running. Cleanup did not finish.`}
              </span>
            )}
            {!stopping && error && (
              <span
                className="text-destructive"
                data-testid="emergency-stop-error"
              >
                Could not stop: {error}
              </span>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="link"
              onClick={close}
              disabled={stopping}
            >
              {report ? 'Close' : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={run}
              disabled={stopping}
              aria-describedby={statusId}
              data-testid="emergency-stop-confirm"
            >
              {stopping ? 'Stopping…' : `Stop ${chosen}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default EmergencyStop
