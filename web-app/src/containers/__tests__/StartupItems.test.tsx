import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import settings from '@/locales/en/settings.json'
import common from '@/locales/en/common.json'
import { StartupItems } from '../StartupItems'
import type { AutostartStatus } from '@/lib/autostart'

const bundles: Record<string, unknown> = { settings, common }
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
vi.mock('@/containers/Card', () => ({
  CardItem: ({
    title,
    description,
    actions,
  }: {
    title: string
    description?: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      <div>{actions}</div>
    </div>
  ),
}))

const off: AutostartStatus = {
  platform: 'windows',
  platformLabel: 'Windows startup (registry Run key)',
  enabled: false,
  minimized: false,
  preview: ['Registry key: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Value name: Flint'],
  detail: null,
}
const on: AutostartStatus = { ...off, enabled: true }

const get = vi.fn()
const set = vi.fn()
vi.mock('@/lib/autostart', () => ({
  autostartGet: (m?: boolean) => get(m),
  autostartSet: (e: boolean, m?: boolean) => set(e, m),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('StartupItems', () => {
  beforeEach(() => {
    get.mockReset()
    set.mockReset()
  })

  it('shows the exact entry and writes nothing until confirmed', async () => {
    const user = userEvent.setup()
    get.mockResolvedValue(off)
    set.mockResolvedValue(on)
    render(<StartupItems />)
    const sw = await screen.findByRole('switch', { name: 'Start with the computer' })
    expect(sw).not.toBeChecked()

    await user.click(sw)
    expect(await screen.findByTestId('startup-preview')).toHaveTextContent(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    )
    expect(set).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Add entry' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith(true, false))
  })

  it('cancelling the dialog writes nothing', async () => {
    const user = userEvent.setup()
    get.mockResolvedValue(off)
    render(<StartupItems />)
    await user.click(await screen.findByRole('switch', { name: 'Start with the computer' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(set).not.toHaveBeenCalled()
  })

  it('turning it off applies at once with no dialog', async () => {
    const user = userEvent.setup()
    get.mockResolvedValue(on)
    set.mockResolvedValue(off)
    render(<StartupItems />)
    await user.click(await screen.findByRole('switch', { name: 'Start with the computer' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith(false, false))
    expect(screen.queryByTestId('startup-preview')).not.toBeInTheDocument()
  })

  it('renders nothing outside the desktop app', async () => {
    get.mockRejectedValue(new Error('no tauri'))
    const { container } = render(<StartupItems />)
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
