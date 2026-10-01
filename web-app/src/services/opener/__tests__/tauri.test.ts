import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  openUrl: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { TauriOpenerService } from '../tauri'
import { DefaultOpenerService } from '../default'

describe('TauriOpenerService', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(revealItemInDir).mockReset()
    vi.mocked(openPath).mockReset()
  })

  it('extends DefaultOpenerService', () => {
    expect(new TauriOpenerService()).toBeInstanceOf(DefaultOpenerService)
  })

  it('revealItemInDir goes through the contained backend command, not the plugin', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await new TauriOpenerService().revealItemInDir('/tmp/x', ['/tmp'])
    expect(invoke).toHaveBeenCalledWith('open_session_path', {
      roots: ['/tmp'],
      path: '/tmp/x',
      mode: 'reveal',
    })
    expect(revealItemInDir).not.toHaveBeenCalled()
  })

  it('openPath goes through the backend with no roots by default', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await new TauriOpenerService().openPath('/tmp/x')
    expect(invoke).toHaveBeenCalledWith('open_session_path', {
      roots: [],
      path: '/tmp/x',
      mode: 'open',
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('logs and rethrows when the backend refuses', async () => {
    const err = 'path is outside the session folders'
    vi.mocked(invoke).mockRejectedValueOnce(err)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(new TauriOpenerService().openPath('/etc')).rejects.toBe(err)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('DefaultOpenerService', () => {
  it('revealItemInDir is a no-op that resolves', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const svc = new DefaultOpenerService()
    await expect(svc.revealItemInDir('/any/path')).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(
      'revealItemInDir called with path:',
      '/any/path'
    )
    spy.mockRestore()
  })
})
