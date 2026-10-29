import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
  i18n: { t: (k: string) => k },
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/lib/backend', () => ({ invokeCommand: invoke }))
const settings = vi.hoisted(() => ({
  buildBackup: vi.fn(),
  applyBackup: vi.fn(),
  parseBackup: vi.fn((s: string) => JSON.parse(s)),
}))
vi.mock('@/lib/settings-backup', () => settings)
vi.mock('@/lib/settings-backup-io', () => ({ settingsBackupIo: {} }))

import { DataBackupCard } from '../DataBackupCard'
import { defaultDataBackupName } from '@/lib/data-backup'

const preview = {
  appVersion: '1.2.3',
  createdAt: '2026-10-01T00:00:00Z',
  counts: { threads: 3, messages: 10, assistants: 2 },
  existingThreads: 1,
  existingAssistants: 0,
  settings: { format: 'flint-settings-backup' },
}

describe('DataBackupCard', () => {
  beforeEach(() => {
    invoke.mockReset()
    settings.buildBackup.mockReset()
    settings.applyBackup.mockReset()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn() },
    })
  })

  it('exports the secret-free settings backup with the data', async () => {
    settings.buildBackup.mockResolvedValue({ settings: {} })
    invoke.mockResolvedValue({ path: '/x.json', counts: preview.counts })
    render(<DataBackupCard />)
    await userEvent.click(screen.getByText('settings:dataBackup.exportButton'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(settings.buildBackup).toHaveBeenCalledWith({}, { includeSecrets: false })
    expect(invoke).toHaveBeenCalledWith('data_backup_save', {
      suggestedName: expect.stringMatching(/^flint-data-.*\.json$/),
      settings: { settings: {} },
    })
  })

  it('previews counts and existing items, then merges without settings by default', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'data_backup_load'
        ? preview
        : { threadsAdded: 2, threadsSkipped: 1, assistantsAdded: 2, assistantsSkipped: 0 }
    )
    render(<DataBackupCard />)
    await userEvent.click(screen.getByText('settings:dataBackup.chooseFile'))
    const box = await screen.findByTestId('data-backup-preview')
    expect(box.textContent).toContain('"threads":3')
    expect(box.textContent).toContain('"messages":10')
    expect(screen.getByTestId('data-backup-existing').textContent).toContain('"threads":1')
    await userEvent.click(screen.getByText('settings:dataBackup.apply'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('data_backup_apply'))
    expect(settings.applyBackup).not.toHaveBeenCalled()
  })

  it('restores settings only when ticked, never the permission stores', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'data_backup_load'
        ? preview
        : { threadsAdded: 0, threadsSkipped: 0, assistantsAdded: 0, assistantsSkipped: 0 }
    )
    render(<DataBackupCard />)
    await userEvent.click(screen.getByText('settings:dataBackup.chooseFile'))
    await userEvent.click(await screen.findByTestId('data-backup-restore-settings'))
    await userEvent.click(screen.getByText('settings:dataBackup.apply'))
    await waitFor(() => expect(settings.applyBackup).toHaveBeenCalled())
    expect(settings.applyBackup.mock.calls[0][2]).toEqual({ includePermissions: false })
  })

  it('cancel discards the pending backup', async () => {
    invoke.mockResolvedValue(preview)
    render(<DataBackupCard />)
    await userEvent.click(screen.getByText('settings:dataBackup.chooseFile'))
    await userEvent.click(await screen.findByText('settings:dataBackup.cancel'))
    expect(invoke).toHaveBeenCalledWith('data_backup_discard')
    expect(screen.queryByTestId('data-backup-preview')).toBeNull()
  })

  it('names the file by date', () => {
    expect(defaultDataBackupName(new Date('2026-01-02T00:00:00Z'))).toBe(
      'flint-data-2026-01-02.json'
    )
  })
})
