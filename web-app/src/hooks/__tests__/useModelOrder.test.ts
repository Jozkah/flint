import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { MAX_TRACKED_MODELS, useModelOrder } from '../useModelOrder'
import { DEFAULT_MODEL_SORT, sortModels, type SortableModel } from '@/lib/modelSort'

const store = () => useModelOrder.getState()

const item = (providerName: string, id: string): SortableModel => ({
  provider: { provider: providerName },
  model: { id } as Model,
})

describe('useModelOrder', () => {
  beforeEach(() => {
    useModelOrder.setState({ sort: DEFAULT_MODEL_SORT, lastUsed: {} })
  })

  describe('the chosen order', () => {
    it('starts grouped by provider', () => {
      expect(store().sort).toBe('provider')
    })

    it('remembers what the user picked', () => {
      store().setSort('recent')
      expect(store().sort).toBe('recent')
    })
  })

  describe('recording use', () => {
    it('stamps the model that was picked', () => {
      store().markUsed('openai', 'gpt-5', 1000)
      expect(store().lastUsed).toEqual({ 'openai:gpt-5': 1000 })
    })

    it('moves a model forward when it is picked again', () => {
      store().markUsed('openai', 'gpt-5', 1000)
      store().markUsed('anthropic', 'opus', 2000)
      store().markUsed('openai', 'gpt-5', 3000)

      const order = sortModels(
        [item('anthropic', 'opus'), item('openai', 'gpt-5')],
        'recent',
        store().lastUsed
      )
      expect(order.map((i) => i.model.id)).toEqual(['gpt-5', 'opus'])
    })

    it('keeps two providers’ identically named models apart', () => {
      store().markUsed('openai', 'shared', 1000)
      expect(store().lastUsed).toEqual({ 'openai:shared': 1000 })
      expect(store().lastUsed['azure:shared']).toBeUndefined()
    })

    it('forgets the oldest once the history is full', () => {
      // The history exists to order a list, so it need not outgrow one.
      for (let i = 0; i < MAX_TRACKED_MODELS + 10; i++) {
        store().markUsed('p', `model-${i}`, i + 1)
      }
      const kept = store().lastUsed
      expect(Object.keys(kept)).toHaveLength(MAX_TRACKED_MODELS)
      expect(kept['p:model-0']).toBeUndefined()
      expect(kept[`p:model-${MAX_TRACKED_MODELS + 9}`]).toBe(
        MAX_TRACKED_MODELS + 10
      )
    })
  })

  describe('surviving a restart', () => {
    /** What comes back off disk: the persisted slice, actions rebuilt. */
    const restart = () => {
      const options = useModelOrder.persist.getOptions()
      const partialize = options.partialize as (s: unknown) => object
      const onDisk = JSON.parse(JSON.stringify(partialize(store())))
      useModelOrder.setState({ sort: DEFAULT_MODEL_SORT, lastUsed: {} })
      useModelOrder.setState(onDisk)
    }

    it('brings back the chosen order and the usage history', () => {
      store().setSort('name-desc')
      store().markUsed('openai', 'gpt-5', 1000)

      restart()

      expect(store().sort).toBe('name-desc')
      expect(store().lastUsed).toEqual({ 'openai:gpt-5': 1000 })
    })

    it('persists only the preference and the history', () => {
      const options = useModelOrder.persist.getOptions()
      const partialize = options.partialize as (
        s: unknown
      ) => Record<string, unknown>
      expect(Object.keys(partialize(store())).sort()).toEqual([
        'lastUsed',
        'sort',
      ])
    })

    it('waits to be hydrated explicitly, like the other backend stores', () => {
      expect(useModelOrder.persist.getOptions().skipHydration).toBe(true)
    })
  })
})
