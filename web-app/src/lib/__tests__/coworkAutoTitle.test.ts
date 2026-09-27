import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTitle = vi.fn()
let sessions: Array<{ id: string; title: string }> = []
let autoGenerateTitle = true

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  engineSlotsIdle: vi.fn(async () => true),
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: { getState: () => ({ sessions, setTitle }) },
}))
vi.mock('@/hooks/useInterfaceSettings', () => ({
  useInterfaceSettings: { getState: () => ({ autoGenerateTitle }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({ selectedProvider: 'anthropic', selectedModel: { id: 'm' } }),
  },
}))
vi.mock('@/lib/thread-title-summarizer', () => ({
  generateThreadTitle: vi.fn(async () => 'Drone camera FOV fix'),
}))

import { autoTitleCoworkSession } from '../coworkAutoTitle'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('autoTitleCoworkSession', () => {
  beforeEach(() => {
    setTitle.mockReset()
    autoGenerateTitle = true
  })

  it('replaces the placeholder with the generated title', async () => {
    sessions = [{ id: 's1', title: 'can you edit bodycam.as so that' }]
    autoTitleCoworkSession('s1', 'can you edit bodycam.as so that…', 'can you edit bodycam.as so that')
    await flush()
    expect(setTitle).toHaveBeenCalledWith('s1', 'Drone camera FOV fix')
  })

  it('leaves a session the user renamed alone', async () => {
    sessions = [{ id: 's1', title: 'My own name' }]
    autoTitleCoworkSession('s1', 'prompt', 'prompt')
    await flush()
    expect(setTitle).not.toHaveBeenCalled()
  })

  it('does nothing when auto titles are off', async () => {
    autoGenerateTitle = false
    sessions = [{ id: 's1', title: 'prompt' }]
    autoTitleCoworkSession('s1', 'prompt', 'prompt')
    await flush()
    expect(setTitle).not.toHaveBeenCalled()
  })
})
