import { describe, expect, it, vi } from 'vitest'
import { useBrowserAgentPrompt } from '../useBrowserAgentPrompt'

const ALLOW = { decision: 'allow', scope: 'once', subdomains: false } as const

describe('useBrowserAgentPrompt', () => {
  it('detaches its abort listener once the question is answered', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = useBrowserAgentPrompt.getState().request({
      url: 'https://example.com',
      host: 'example.com',
      tool: 'browser_open',
      signal: controller.signal,
    })
    const id = useBrowserAgentPrompt.getState().queue[0].id
    useBrowserAgentPrompt.getState().answer(id, ALLOW)
    await expect(pending).resolves.toEqual(ALLOW)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
