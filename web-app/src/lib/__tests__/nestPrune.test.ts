import { beforeEach, describe, expect, it } from 'vitest'
import { removedIds } from '../nestPrune'
import { useNestExpanded } from '@/stores/nest-expanded-store'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'

const session = (id: string) =>
  ({ id, title: id, folder: null, turns: [], messages: [], updated: 0 }) as CoworkSession

describe('removedIds', () => {
  it('lists only ids that left', () => {
    expect(removedIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(removedIds([], ['a'])).toEqual([])
  })
})

describe('nest-expanded store pruning', () => {
  beforeEach(() => {
    useNestExpanded.setState({ expanded: { 'cowork:a': true, 'cowork:b': true, 'chats:a': true } })
    useCoworkSessions.setState({ sessions: [session('a'), session('b')], currentId: null })
  })

  it('forget drops only the named parents of that scope', () => {
    useNestExpanded.getState().forget('cowork', ['a'])
    expect(useNestExpanded.getState().expanded).toEqual({ 'cowork:b': true, 'chats:a': true })
  })

  it('a deleted session forgets its unfolded flag', () => {
    useCoworkSessions.setState({ sessions: [session('b')] })
    expect(useNestExpanded.getState().expanded['cowork:a']).toBeUndefined()
    expect(useNestExpanded.getState().expanded['cowork:b']).toBe(true)
  })

  it('a list that merely loads from empty wipes nothing', () => {
    useCoworkSessions.setState({ sessions: [], currentId: null })
    useNestExpanded.setState({ expanded: { 'cowork:a': true } })
    useCoworkSessions.setState({ sessions: [session('a'), session('b')] })
    expect(useNestExpanded.getState().expanded['cowork:a']).toBe(true)
  })
})
