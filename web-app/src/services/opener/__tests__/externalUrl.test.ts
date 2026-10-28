import { describe, it, expect, vi } from 'vitest'

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl, openPath: vi.fn(), revealItemInDir: vi.fn() }))

import { isExternalUrl } from '../externalUrl'
import { TauriOpenerService } from '../tauri'

describe('isExternalUrl', () => {
  it.each(['http://a.com', 'https://a.com/x?y', 'mailto:a@b.com', 'HTTPS://A.COM'])(
    'allows %s',
    (u) => expect(isExternalUrl(u)).toBe(true)
  )
  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/Windows/System32/calc.exe',
    'jan://settings',
    'ms-settings:',
    '/relative/path',
    '//evil.com/x',
    '',
  ])('refuses %s', (u) => expect(isExternalUrl(u)).toBe(false))
})

describe('TauriOpenerService.openUrl scheme gate', () => {
  it('refuses a non-web url without calling the plugin', async () => {
    openUrl.mockClear()
    await expect(new TauriOpenerService().openUrl('file:///etc/passwd')).rejects.toThrow()
    await expect(new TauriOpenerService().openUrl('jan://x')).rejects.toThrow()
    expect(openUrl).not.toHaveBeenCalled()
  })
  it('opens mailto', async () => {
    await new TauriOpenerService().openUrl('mailto:a@b.com')
    expect(openUrl).toHaveBeenCalledWith('mailto:a@b.com')
  })
})
