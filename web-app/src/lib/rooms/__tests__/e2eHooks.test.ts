import { describe, expect, it } from 'vitest'
import { installRoomsE2EHooks } from '../e2eHooks'

describe('rooms e2e hooks', () => {
  it('are not installed on window when the build flag is unset', async () => {
    // Importing the module ran its side effect with the test build's env.
    expect(import.meta.env.VITE_JAN_E2E_HOOKS).not.toBe('1')
    expect((window as { __janRoomsE2E?: unknown }).__janRoomsE2E).toBeUndefined()
  })

  it('install nothing unless the flag is exactly "1"', async () => {
    for (const flag of [undefined, '', '0', 'true']) {
      const target: { __janRoomsE2E?: unknown } = {}
      await expect(installRoomsE2EHooks(flag, target)).resolves.toBe(false)
      expect(target.__janRoomsE2E).toBeUndefined()
    }
  })

  it('expose the engine when the flag is "1"', async () => {
    const target: { __janRoomsE2E?: Record<string, unknown> } = {}
    await expect(installRoomsE2EHooks('1', target)).resolves.toBe(true)
    for (const key of ['roomController', 'useRoomsStore', 'createRoom', 'useModelProvider']) {
      expect(target.__janRoomsE2E?.[key]).toBeDefined()
    }
    expect(target.__janRoomsE2E?.HARD_CALL_CEILING).toBe(300)
    expect(
      (target.__janRoomsE2E?.ROOM_LIMIT_CEILINGS as { maxTurns: number }).maxTurns
    ).toBe(200)
  })
})
