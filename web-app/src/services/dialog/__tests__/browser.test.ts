import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/services/uploads/browser', () => ({ uploadFile: vi.fn() }))

import { BrowserDialogService } from '../browser'
import { useServerFolderPicker } from '@/lib/serverFolderPicker'

beforeEach(() => {
  useServerFolderPicker.setState({ open: false, resolve: null })
})

describe('BrowserDialogService folder picks', () => {
  it('opens the server folder chooser and returns the folder picked there', async () => {
    const picked = new BrowserDialogService().open({ directory: true })
    expect(useServerFolderPicker.getState().open).toBe(true)
    useServerFolderPicker.getState().settle('/srv/models')
    expect(await picked).toBe('/srv/models')
  })

  it('returns a list when several were asked for, and null when dismissed', async () => {
    const many = new BrowserDialogService().open({ directory: true, multiple: true })
    useServerFolderPicker.getState().settle('/srv/a')
    expect(await many).toEqual(['/srv/a'])
    const none = new BrowserDialogService().open({ directory: true })
    useServerFolderPicker.getState().settle(null)
    expect(await none).toBeNull()
  })
})
