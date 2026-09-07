import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmergencyStop, type StopReport } from '@/containers/EmergencyStop'

const clean = (over: Partial<StopReport> = {}): StopReport => ({
  stopped: 2,
  already_stopped: 0,
  live_children: 0,
  complete: true,
  session: 's1',
  run: 'r1',
  call: '',
  ...over,
})

describe('EmergencyStop', () => {
  it('does not stop anything until it is confirmed', async () => {
    const onStop = vi.fn().mockResolvedValue(clean())
    const user = userEvent.setup()
    render(<EmergencyStop sessionId="s1" runId="r1" onStop={onStop} />)

    await user.click(screen.getByTestId('emergency-stop-trigger'))

    // The dialog is open and nothing has been stopped yet: an emergency stop
    // that fires on a mis-click is its own incident.
    expect(screen.getByTestId('emergency-stop-dialog')).toBeInTheDocument()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('says in words exactly what each scope will stop', async () => {
    const user = userEvent.setup()
    render(
      <EmergencyStop
        sessionId="s1"
        runId="r1"
        callId="c1"
        onStop={vi.fn().mockResolvedValue(clean())}
      />
    )
    await user.click(screen.getByTestId('emergency-stop-trigger'))

    expect(screen.getByTestId('emergency-stop-scope-call')).toHaveTextContent(
      /Everything else in the run keeps going/i
    )
    expect(screen.getByTestId('emergency-stop-scope-run')).toHaveTextContent(
      /Other runs are untouched/i
    )
    expect(screen.getByTestId('emergency-stop-scope-session')).toHaveTextContent(
      /Other sessions are untouched/i
    )
    expect(
      screen.getByTestId('emergency-stop-scope-application')
    ).toHaveTextContent(/every session/i)
  })

  it('sends only the fields the chosen scope covers', async () => {
    const onStop = vi.fn().mockResolvedValue(clean())
    const user = userEvent.setup()
    render(
      <EmergencyStop sessionId="s1" runId="r1" callId="c1" onStop={onStop} />
    )
    await user.click(screen.getByTestId('emergency-stop-trigger'))

    // A run stop names the run but not the call...
    await user.click(
      screen.getByTestId('emergency-stop-scope-run').querySelector('input')!
    )
    await user.click(screen.getByTestId('emergency-stop-confirm'))
    await waitFor(() => expect(onStop).toHaveBeenCalled())
    expect(onStop).toHaveBeenCalledWith({ session: 's1', run: 'r1' })

    // ...and an application stop names nothing, which is what "everything"
    // means to the backend.
    await user.click(
      screen
        .getByTestId('emergency-stop-scope-application')
        .querySelector('input')!
    )
    await user.click(screen.getByTestId('emergency-stop-confirm'))
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(2))
    expect(onStop).toHaveBeenLastCalledWith({})
  })

  it('reports a clean stop', async () => {
    const user = userEvent.setup()
    render(
      <EmergencyStop
        sessionId="s1"
        runId="r1"
        onStop={vi.fn().mockResolvedValue(clean({ stopped: 3 }))}
      />
    )
    await user.click(screen.getByTestId('emergency-stop-trigger'))
    await user.click(screen.getByTestId('emergency-stop-confirm'))

    const report = await screen.findByTestId('emergency-stop-report')
    expect(report).toHaveTextContent(/3 stopped/)
    expect(report).toHaveTextContent(/nothing left running/i)
  })

  it('refuses to claim success when a process survived', async () => {
    // The whole point of the honest report: telling someone the emergency stop
    // worked while a process is still running is worse than telling them it
    // did not.
    const user = userEvent.setup()
    render(
      <EmergencyStop
        sessionId="s1"
        runId="r1"
        onStop={vi
          .fn()
          .mockResolvedValue(
            clean({ stopped: 1, live_children: 2, complete: false })
          )}
      />
    )
    await user.click(screen.getByTestId('emergency-stop-trigger'))
    await user.click(screen.getByTestId('emergency-stop-confirm'))

    const report = await screen.findByTestId('emergency-stop-report')
    expect(report).toHaveTextContent(/2 process\(es\) are still running/i)
    expect(report).toHaveTextContent(/did not finish/i)
    expect(report).not.toHaveTextContent(/nothing left running/i)
  })

  it('cannot be pressed twice while it is stopping', async () => {
    let release: (r: StopReport) => void = () => {}
    const onStop = vi.fn(
      () => new Promise<StopReport>((resolve) => (release = resolve))
    )
    const user = userEvent.setup()
    render(<EmergencyStop sessionId="s1" runId="r1" onStop={onStop} />)
    await user.click(screen.getByTestId('emergency-stop-trigger'))

    await user.click(screen.getByTestId('emergency-stop-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('emergency-stop-confirm')).toBeDisabled()
    )
    // A second press mid-cleanup would report against a half-swept scope.
    await user.click(screen.getByTestId('emergency-stop-confirm'))
    expect(onStop).toHaveBeenCalledTimes(1)

    release(clean())
    await screen.findByTestId('emergency-stop-report')
  })

  it('announces progress and the outcome in one live region', async () => {
    let release: (r: StopReport) => void = () => {}
    const onStop = vi.fn(
      () => new Promise<StopReport>((resolve) => (release = resolve))
    )
    const user = userEvent.setup()
    render(<EmergencyStop sessionId="s1" runId="r1" onStop={onStop} />)
    await user.click(screen.getByTestId('emergency-stop-trigger'))

    const status = screen.getByTestId('emergency-stop-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')

    await user.click(screen.getByTestId('emergency-stop-confirm'))
    await waitFor(() => expect(status).toHaveTextContent(/Stopping/i))

    release(clean())
    await waitFor(() =>
      expect(status).toHaveTextContent(/nothing left running/i)
    )
  })

  it('renders a failure instead of a raw object', async () => {
    const user = userEvent.setup()
    render(
      <EmergencyStop
        sessionId="s1"
        runId="r1"
        onStop={vi.fn().mockRejectedValue({ code: 'EPERM' })}
      />
    )
    await user.click(screen.getByTestId('emergency-stop-trigger'))
    await user.click(screen.getByTestId('emergency-stop-confirm'))

    const error = await screen.findByTestId('emergency-stop-error')
    expect(error).toHaveTextContent(/EPERM/)
    expect(error).not.toHaveTextContent(/\[object Object\]/)
  })

  it('is reachable and operable from the keyboard', async () => {
    const onStop = vi.fn().mockResolvedValue(clean())
    const user = userEvent.setup()
    render(<EmergencyStop sessionId="s1" runId="r1" onStop={onStop} />)

    const trigger = screen.getByTestId('emergency-stop-trigger')
    expect(trigger).toHaveAccessibleName('Emergency stop')

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('emergency-stop-dialog')).toBeInTheDocument()
  })

  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup()
    render(
      <EmergencyStop
        sessionId="s1"
        runId="r1"
        onStop={vi.fn().mockResolvedValue(clean())}
      />
    )
    const trigger = screen.getByTestId('emergency-stop-trigger')
    await user.click(trigger)
    await user.keyboard('{Escape}')

    // A keyboard user must not be dropped at the top of the document.
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('offers only the scopes that exist', async () => {
    const user = userEvent.setup()
    render(<EmergencyStop onStop={vi.fn().mockResolvedValue(clean())} />)
    await user.click(screen.getByTestId('emergency-stop-trigger'))

    // With no session or run, application is the only honest choice.
    expect(screen.queryByTestId('emergency-stop-scope-run')).toBeNull()
    expect(screen.queryByTestId('emergency-stop-scope-session')).toBeNull()
    expect(
      screen.getByTestId('emergency-stop-scope-application')
    ).toBeInTheDocument()
  })
})
