import { describe, it, expect, vi } from 'vitest'

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl,
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}))

import { TauriOpenerService } from '../tauri'

describe('TauriOpenerService.openUrl', () => {
  it('delegates to the plugin openUrl', async () => {
    await new TauriOpenerService().openUrl('https://a.com')
    expect(openUrl).toHaveBeenCalledWith('https://a.com')
  })
})
