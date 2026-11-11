import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@/lib/platform/utils', () => ({ isServedByFlint: () => true }))

import { archiveEnabled } from '../archive'
import { archiveAssistant } from '../archiveAssistants'

describe('archive in the browser build', () => {
  it('is off even when the server says the setting is on, so delete is permanent', async () => {
    // The server answers the setting read but has no route to write the archive.
    invoke.mockResolvedValue({ enabled: true })
    expect(await archiveEnabled()).toBe(false)
    const assistant = { id: 'a1', name: 'Helper' } as unknown as Assistant
    expect(await archiveAssistant(assistant)).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('archive_put', expect.anything())
  })
})
