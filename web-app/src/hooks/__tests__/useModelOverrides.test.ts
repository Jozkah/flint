import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useModelOverrides } from '../useModelOverrides'
import { effectiveValue, resolveModel } from '@/lib/modelOverrides'

const CHAT_A = 'thread-a'
const CHAT_B = 'thread-b'
const KEY = 'thinking_budget_tokens'

const store = () => useModelOverrides.getState()

const model = (settings: Record<string, unknown> = {}): Model =>
  ({
    id: 'gpt-5',
    settings: Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [
        key,
        {
          key,
          title: key,
          description: '',
          controller_type: 'dropdown',
          controller_props: { value },
        },
      ])
    ),
  }) as unknown as Model

describe('useModelOverrides', () => {
  beforeEach(() => {
    useModelOverrides.setState({ byThread: {} })
  })

  describe('chat isolation', () => {
    it('keeps two chats’ choices apart', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_B, KEY, 'xhigh')

      expect(store().forThread(CHAT_A)[KEY]).toBe('low')
      expect(store().forThread(CHAT_B)[KEY]).toBe('xhigh')
    })

    it('leaves the other chat alone when one resets', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_B, KEY, 'xhigh')

      store().resetThread(CHAT_A)

      expect(store().forThread(CHAT_A)[KEY]).toBeUndefined()
      expect(store().forThread(CHAT_B)[KEY]).toBe('xhigh')
    })

    it('gives a chat that has chosen nothing the global value', () => {
      const global = model({ [KEY]: 'medium' })
      store().setForThread(CHAT_A, KEY, 'low')

      expect(effectiveValue(global, store().forThread(CHAT_B), KEY)).toBe(
        'medium'
      )
      expect(effectiveValue(global, store().forThread(CHAT_A), KEY)).toBe('low')
    })

    it('resolves each chat’s model independently from one global', () => {
      const global = model({ [KEY]: 'medium', temperature: 0.7 })
      store().setForThread(CHAT_A, KEY, 'xhigh')

      const forA = resolveModel(global, store().forThread(CHAT_A))
      const forB = resolveModel(global, store().forThread(CHAT_B))

      expect(forA.settings?.[KEY]?.controller_props?.value).toBe('xhigh')
      // Untouched: the same object the global holds.
      expect(forB).toBe(global)
    })

    it('has no opinion for a chat that does not exist yet', () => {
      expect(store().forThread(CHAT_A)).toEqual({})
      expect(store().forThread(null)).toEqual({})
      expect(store().forThread(undefined)).toEqual({})
    })
  })

  describe('reset to global defaults', () => {
    it('removes the chat’s entry rather than leaving an empty one', () => {
      // A chat that has been reset must be indistinguishable from one that
      // never chose anything.
      store().setForThread(CHAT_A, KEY, 'low')
      store().resetThread(CHAT_A)
      expect(CHAT_A in store().byThread).toBe(false)
    })

    it('removes the entry when the last single override is cleared', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().clearForThread(CHAT_A, KEY)
      expect(CHAT_A in store().byThread).toBe(false)
    })

    it('keeps the entry while other overrides remain', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_A, 'temperature', 0.1)
      store().clearForThread(CHAT_A, KEY)
      expect(store().forThread(CHAT_A)).toEqual({ temperature: 0.1 })
    })

    it('is harmless on a chat that overrode nothing', () => {
      expect(() => store().resetThread(CHAT_A)).not.toThrow()
      expect(() => store().clearForThread(CHAT_A, KEY)).not.toThrow()
      expect(store().byThread).toEqual({})
    })
  })

  describe('when the model changes underneath a chat', () => {
    it('drops the effort override when the new model cannot act on it', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_A, 'temperature', 0.1)

      store().pruneForThread(CHAT_A, 'mistral', model({ temperature: 0.7 }))

      expect(store().forThread(CHAT_A)).toEqual({ temperature: 0.1 })
    })

    it('removes the entry when nothing survives', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().pruneForThread(CHAT_A, 'mistral', model({ temperature: 0.7 }))
      expect(CHAT_A in store().byThread).toBe(false)
    })

    it('keeps everything when the new model still supports it', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      const before = store().forThread(CHAT_A)
      store().pruneForThread(CHAT_A, 'openai', model({ [KEY]: 'medium' }))
      expect(store().forThread(CHAT_A)).toBe(before)
    })
  })

  describe('forgetting a chat', () => {
    it('drops a deleted chat’s overrides', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_B, KEY, 'high')
      store().dropThread(CHAT_A)
      expect(Object.keys(store().byThread)).toEqual([CHAT_B])
    })
  })

  describe('what is written to disk', () => {
    it('persists only the sparse record, never resolved settings', () => {
      const options = useModelOverrides.persist.getOptions()
      const partialize = options.partialize as (
        state: unknown
      ) => Record<string, unknown>

      store().setForThread(CHAT_A, KEY, 'low')
      const persisted = partialize(store())

      expect(Object.keys(persisted)).toEqual(['byThread'])
      // One value, not a copy of the model's setting definition.
      expect(persisted.byThread).toEqual({ [CHAT_A]: { [KEY]: 'low' } })
    })

    it('waits to be hydrated explicitly, like the other backend stores', () => {
      expect(useModelOverrides.persist.getOptions().skipHydration).toBe(true)
    })
  })

  describe('surviving a restart', () => {
    /** What comes back off disk: the record, with the actions rebuilt. */
    const restart = () => {
      const options = useModelOverrides.persist.getOptions()
      const partialize = options.partialize as (s: unknown) => { byThread: unknown }
      const onDisk = JSON.parse(JSON.stringify(partialize(store())))
      useModelOverrides.setState({ byThread: {} })
      useModelOverrides.setState(onDisk)
    }

    it('brings each chat’s overrides back, still separate', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      store().setForThread(CHAT_B, KEY, 'xhigh')

      restart()

      expect(store().forThread(CHAT_A)[KEY]).toBe('low')
      expect(store().forThread(CHAT_B)[KEY]).toBe('xhigh')
    })

    it('brings back nothing for a chat that had chosen nothing', () => {
      store().setForThread(CHAT_A, KEY, 'low')
      restart()
      expect(store().forThread(CHAT_B)).toEqual({})
      expect(CHAT_B in store().byThread).toBe(false)
    })

    it('still resolves against whatever the global default has become', () => {
      // The point of persisting values rather than resolved settings: after a
      // restart the untouched settings follow the *current* global config.
      store().setForThread(CHAT_A, KEY, 'low')
      restart()

      const moved = model({ [KEY]: 'xhigh', temperature: 0.2 })
      expect(effectiveValue(moved, store().forThread(CHAT_A), KEY)).toBe('low')
      expect(effectiveValue(moved, store().forThread(CHAT_A), 'temperature')).toBe(
        0.2
      )
    })
  })

  describe('a chat that predates this feature', () => {
    it('has no entry, and simply uses the global configuration', () => {
      // Nothing to migrate: an absent entry *is* "inherits everything", so an
      // existing thread needs no record written for it.
      const global = model({ [KEY]: 'medium', temperature: 0.7 })
      const existing = 'thread-from-before'

      expect(existing in store().byThread).toBe(false)
      expect(resolveModel(global, store().forThread(existing))).toBe(global)
      expect(effectiveValue(global, store().forThread(existing), KEY)).toBe(
        'medium'
      )
    })

    it('starts overriding only once the user chooses something', () => {
      const existing = 'thread-from-before'
      store().setForThread(existing, KEY, 'high')
      expect(store().byThread[existing]).toEqual({ [KEY]: 'high' })
    })
  })
})
