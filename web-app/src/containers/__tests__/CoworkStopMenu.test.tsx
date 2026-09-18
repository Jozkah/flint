import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { CoworkStopMenu } from '@/containers/CoworkStopMenu'
import type { StopReport } from '@/containers/EmergencyStop'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${key}:${vars.count}` : key,
  }),
}))

const report = (over: Partial<StopReport> = {}): StopReport => ({
  stopped: 3,
  already_stopped: 0,
  live_children: 0,
  complete: true,
  session: '',
  run: '',
  call: '',
  ...over,
})

let onStop: ReturnType<typeof vi.fn>
let onStopCurrent: ReturnType<typeof vi.fn>
let onStopAll: ReturnType<typeof vi.fn>

const mount = (props: Partial<React.ComponentProps<typeof CoworkStopMenu>> = {}) =>
  render(
    <CoworkStopMenu
      running
      sessionId="s1"
      runId="r1"
      onStopCurrent={onStopCurrent}
      onStopAll={onStopAll}
      onStop={onStop}
      {...props}
    />
  )

beforeEach(() => {
  onStop = vi.fn().mockResolvedValue(report())
  onStopCurrent = vi.fn()
  onStopAll = vi.fn()
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe('CoworkStopMenu', () => {
  it('shows exactly one stop control while work is running', () => {
    mount()
    expect(screen.getAllByTestId('cowork-stop')).toHaveLength(1)
    // And nothing at all when there is nothing to stop.
    expect(screen.queryByTestId('cowork-stop-menu')).toBeNull()
  })

  it('renders nothing when no work is running', () => {
    mount({ running: false })
    expect(screen.queryByTestId('cowork-stop')).toBeNull()
  })

  it('opens an anchored menu offering both scopes', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    const menu = await screen.findByTestId('cowork-stop-menu')
    expect(menu).toHaveAttribute('role', 'menu')
    // Both are offered even though only this run is known to be active:
    // background work elsewhere is exactly what the user cannot see.
    expect(screen.getByTestId('stop-current')).toBeInTheDocument()
    expect(screen.getByTestId('stop-all')).toBeInTheDocument()
  })

  it('stops only the current run, through the run-scoped command', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await user.click(await screen.findByTestId('stop-current'))

    await waitFor(() => expect(onStop).toHaveBeenCalled())
    // The run's own abort, plus the scoped stop for what runs underneath it.
    expect(onStopCurrent).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith({ session: 's1', run: 'r1' })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('asks before stopping everything, and cancelling stops nothing', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await user.click(await screen.findByTestId('stop-all'))

    expect(await screen.findByTestId('stop-all-confirm')).toBeInTheDocument()
    expect(onStop).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('stop-all-cancel'))
    expect(screen.queryByTestId('stop-all-confirm')).toBeNull()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('stops everything with no scope once confirmed', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await user.click(await screen.findByTestId('stop-all'))
    await user.click(await screen.findByTestId('stop-all-confirmed'))

    await waitFor(() => expect(onStop).toHaveBeenCalledWith({}))
    // Application scope is the absence of a scope, not a second command.
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStopCurrent).not.toHaveBeenCalled()
    // The renderer-side loops must be aborted too: the backend {} sweep only
    // reaps subprocess Tokens and cannot reach the JS AbortControllers.
    expect(onStopAll).toHaveBeenCalledTimes(1)
  })

  it('reports surviving processes instead of claiming success', async () => {
    onStop = vi.fn().mockResolvedValue(report({ complete: false, live_children: 2 }))
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await user.click(await screen.findByTestId('stop-current'))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toContain('2')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('surfaces a backend failure rather than a success message', async () => {
    onStop = vi.fn().mockRejectedValue('the stop command failed')
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await user.click(await screen.findByTestId('stop-current'))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toContain('the stop command failed')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('moves between the choices with the arrow keys', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    const current = await screen.findByTestId('stop-current')
    current.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('stop-all')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(current).toHaveFocus()
  })

  it('closes on Escape and puts focus back on the button', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await screen.findByTestId('cowork-stop-menu')
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByTestId('cowork-stop-menu')).toBeNull()
    )
    expect(screen.getByTestId('cowork-stop')).toHaveFocus()
  })

  it('closes itself when the work finishes on its own', async () => {
    const user = userEvent.setup()
    const { rerender } = mount()
    await user.click(screen.getByTestId('cowork-stop'))
    await screen.findByTestId('cowork-stop-menu')

    rerender(
      <CoworkStopMenu
        running={false}
        sessionId="s1"
        runId="r1"
        onStopCurrent={onStopCurrent}
        onStopAll={onStopAll}
        onStop={onStop}
      />
    )
    // Nothing left to stop, so nothing left to ask about.
    await waitFor(() =>
      expect(screen.queryByTestId('cowork-stop-menu')).toBeNull()
    )
  })

  it('does not fire twice when activated repeatedly', async () => {
    let resolve: (r: StopReport) => void = () => {}
    onStop = vi.fn().mockImplementation(
      () => new Promise<StopReport>((r) => (resolve = r))
    )
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('cowork-stop'))
    const item = await screen.findByTestId('stop-current')
    await user.click(item)
    await user.click(item)
    expect(onStop).toHaveBeenCalledTimes(1)
    resolve(report())
  })
})
