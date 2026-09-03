import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import {
  MAX_EVENTS_PER_CONVERSATION,
  useFileActivity,
} from '../useFileActivity'
import type { FileActivityEvent } from '@/lib/fileActivity'

const store = () => useFileActivity.getState()

const event = (id: string, over: Partial<FileActivityEvent> = {}): FileActivityEvent => ({
  id,
  path: 'src/a.ts',
  operation: 'read',
  seq: 0,
  at: 0,
  ok: true,
  origin: 'project',
  ...over,
})

beforeEach(() => useFileActivity.setState({ byConversation: {} }))

describe('recording activity', () => {
  it('keeps events per conversation', () => {
    store().record('a', [event('1')])
    store().record('b', [event('2', { path: 'other.ts' })])

    expect(store().eventsFor('a')).toHaveLength(1)
    expect(store().eventsFor('b')[0].path).toBe('other.ts')
  })

  it('never lets one conversation see another’s paths', () => {
    store().record('a', [event('1', { path: 'secret/a.ts' })])
    expect(store().eventsFor('b')).toEqual([])
    expect(store().eventsFor(null)).toEqual([])
  })

  it('does not record the same call twice', () => {
    store().record('a', [event('1')])
    store().record('a', [event('1')])
    expect(store().eventsFor('a')).toHaveLength(1)
  })

  it('ignores an empty batch rather than touching state', () => {
    store().record('a', [event('1')])
    const before = store().eventsFor('a')
    store().record('a', [])
    expect(store().eventsFor('a')).toBe(before)
  })

  it('trims the oldest once the list is long', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_CONVERSATION + 5 }, (_, i) =>
      event(String(i), { seq: i })
    )
    store().record('a', many)
    const kept = store().eventsFor('a')
    expect(kept).toHaveLength(MAX_EVENTS_PER_CONVERSATION)
    expect(kept[0].id).toBe('5')
  })
})

describe('forgetting a conversation', () => {
  it('drops its paths so they do not outlive it', () => {
    store().record('a', [event('1')])
    store().forget('a')
    expect(store().eventsFor('a')).toEqual([])
  })

  it('leaves other conversations alone', () => {
    store().record('a', [event('1')])
    store().record('b', [event('2')])
    store().forget('a')
    expect(store().eventsFor('b')).toHaveLength(1)
  })
})

describe('what is persisted', () => {
  it('stores references, and survives a restart', () => {
    const options = useFileActivity.persist.getOptions()
    const partialize = options.partialize as (s: unknown) => Record<string, unknown>
    store().record('a', [event('1')])
    expect(Object.keys(partialize(store()))).toEqual(['byConversation'])
    expect(options.skipHydration).toBe(true)
  })

  it('keeps no file contents, only what points at them', () => {
    store().record('a', [event('1', { hasDiff: true })])
    const serialized = JSON.stringify(store().eventsFor('a'))
    expect(serialized).not.toMatch(/content|body|text/)
    expect(serialized).toMatch(/hasDiff/)
  })
})
