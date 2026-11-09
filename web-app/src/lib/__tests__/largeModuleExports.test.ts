import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Characterization of the largest web modules' public surface, captured
// before their helpers moved into smaller files: every name a caller imports
// from them must still be exported, with the same kind.
const surface = (mod: object) =>
  Object.fromEntries(
    Object.entries(mod)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v])
  )

describe('large module exports', () => {
  it('custom-chat-transport', async () => {
    expect(surface(await import('../custom-chat-transport'))).toMatchSnapshot()
  })

  it('coworkRunner', async () => {
    expect(surface(await import('../coworkRunner'))).toMatchSnapshot()
  })

  it('ChatInput', async () => {
    expect(surface(await import('@/containers/ChatInput'))).toMatchSnapshot()
  })
})
