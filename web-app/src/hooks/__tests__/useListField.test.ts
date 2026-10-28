import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  listAppend,
  listRemoveAt,
  listSetAt,
  useKeyValueListField,
  useListField,
} from '../useListField'

describe('list helpers', () => {
  it('appends an empty row', () => {
    expect(listAppend(['a'])).toEqual(['a', ''])
  })
  it('removing the last row leaves one empty row', () => {
    expect(listRemoveAt(['a', 'b'], 0)).toEqual(['b'])
    expect(listRemoveAt(['a'], 0)).toEqual([''])
  })
  it('sets one row without touching the input', () => {
    const input = ['a', 'b']
    expect(listSetAt(input, 1, 'c')).toEqual(['a', 'c'])
    expect(input).toEqual(['a', 'b'])
  })
})

describe('useListField', () => {
  it('adds, updates, moves, removes and resets', () => {
    const { result } = renderHook(() => useListField())
    expect(result.current.items).toEqual([''])
    act(() => result.current.update(0, 'a'))
    act(() => result.current.add())
    act(() => result.current.update(1, 'b'))
    act(() => result.current.move(1, 0))
    expect(result.current.items).toEqual(['b', 'a'])
    act(() => result.current.remove(0))
    expect(result.current.items).toEqual(['a'])
    act(() => result.current.remove(0))
    expect(result.current.items).toEqual([''])
    act(() => result.current.reset(['x', 'y']))
    expect(result.current.items).toEqual(['x', 'y'])
    act(() => result.current.reset([]))
    expect(result.current.items).toEqual([''])
  })
})

describe('useKeyValueListField', () => {
  it('keeps keys and values aligned', () => {
    const { result } = renderHook(() => useKeyValueListField())
    act(() => result.current.resetFrom({ A: '1', B: '2' }))
    expect(result.current.keys).toEqual(['A', 'B'])
    expect(result.current.values).toEqual(['1', '2'])
    act(() => result.current.remove(0))
    expect(result.current.keys).toEqual(['B'])
    expect(result.current.values).toEqual(['2'])
    act(() => result.current.add())
    act(() => result.current.updateKey(1, 'C'))
    act(() => result.current.updateValue(1, '3'))
    expect(result.current.keys).toEqual(['B', 'C'])
    expect(result.current.values).toEqual(['2', '3'])
    act(() => result.current.resetFrom(undefined))
    expect(result.current.keys).toEqual([''])
    expect(result.current.values).toEqual([''])
  })
})
