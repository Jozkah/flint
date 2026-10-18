import { describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isServedByFlint: () => true,
}))

import { searchMessages } from '@/lib/messageSearch'

describe('message search in the browser served by flint serve', () => {
  it('asks the server instead of returning nothing', async () => {
    const hit = { threadId: 't', threadTitle: 'T', messageId: 'm', role: 'assistant', snippet: 'PELICAN', updated: 1 }
    invoke.mockResolvedValueOnce([hit])
    expect(await searchMessages('pelican')).toEqual([hit])
    expect(invoke).toHaveBeenCalledWith('search_messages', { query: 'pelican', limit: 30 })
  })
})
