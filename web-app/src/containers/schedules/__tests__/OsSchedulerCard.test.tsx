import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import schedules from '@/locales/en/schedules.json'
import common from '@/locales/en/common.json'
import { OsSchedulerCard } from '../OsSchedulerCard'
import type { OsSchedulerStatus } from '@/lib/schedules'

const bundles: Record<string, unknown> = { schedules, common }
function t(key: string, options: Record<string, unknown> = {}): string {
  const [ns, path] = key.includes(':') ? key.split(':') : ['common', key]
  const value = path
    .split('.')
    .reduce<unknown>(
      (cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined),
      bundles[ns]
    )
  if (typeof value !== 'string') return key
  return value.replace(/\{\{(\w+)\}\}/g, (m, v) => (options[v] !== undefined ? String(options[v]) : m))
}
vi.mock('@/i18n/react-i18next-compat', () => ({ useTranslation: () => ({ t }) }))

const off: OsSchedulerStatus = {
  platform: 'linux',
  platformLabel: 'systemd (user)',
  installed: false,
  intervalMinutes: 5,
  preview: ['write /home/u/.config/systemd/user/flint-schedule.timer', 'systemctl --user enable --now flint-schedule.timer'],
  tickCommand: 'flint cli schedule tick --data /d',
}
const on: OsSchedulerStatus = { ...off, installed: true }

const status = vi.fn()
const enable = vi.fn()
const disable = vi.fn()
vi.mock('@/lib/schedules', () => ({
  scheduleOsStatus: () => status(),
  scheduleOsEnable: () => enable(),
  scheduleOsDisable: () => disable(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('OsSchedulerCard', () => {
  beforeEach(() => {
    status.mockReset()
    enable.mockReset()
    disable.mockReset()
  })

  it('says it is off, and shows the exact command it would install', async () => {
    status.mockResolvedValue(off)
    render(<OsSchedulerCard />)
    expect(await screen.findByTestId('os-status')).toHaveTextContent('Off. Tasks run only while Flint is open')
    expect(screen.getByTestId('os-status')).toHaveTextContent('flint cli schedule tick --data /d')
    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('shows the preview first and installs only after confirming', async () => {
    const user = userEvent.setup()
    status.mockResolvedValue(off)
    enable.mockResolvedValue(on)
    render(<OsSchedulerCard />)
    await user.click(await screen.findByRole('switch'))
    expect(enable).not.toHaveBeenCalled()
    expect(screen.getByTestId('os-preview')).toHaveTextContent('systemctl --user enable --now flint-schedule.timer')
    await user.click(screen.getByRole('button', { name: 'Add entry' }))
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('os-status')).toHaveTextContent('On. systemd (user) checks every 5 minutes')
  })

  it('cancelling the preview installs nothing', async () => {
    const user = userEvent.setup()
    status.mockResolvedValue(off)
    render(<OsSchedulerCard />)
    await user.click(await screen.findByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(enable).not.toHaveBeenCalled()
  })

  it('turning it off uninstalls at once', async () => {
    const user = userEvent.setup()
    status.mockResolvedValue(on)
    disable.mockResolvedValue(off)
    render(<OsSchedulerCard />)
    await user.click(await screen.findByRole('switch'))
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('os-status')).toHaveTextContent('Off.')
  })

  it('shows why an install failed instead of claiming success', async () => {
    const user = userEvent.setup()
    status.mockResolvedValue(off)
    enable.mockResolvedValue({ ...off, detail: 'schtasks failed: access denied' })
    render(<OsSchedulerCard />)
    await user.click(await screen.findByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Add entry' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('access denied')
    expect(screen.getByRole('switch')).not.toBeChecked()
  })

  it('renders nothing outside the desktop app', async () => {
    status.mockRejectedValue(new Error('no tauri'))
    const { container } = render(<OsSchedulerCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
