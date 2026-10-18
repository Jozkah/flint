import { describe, it, expect, beforeEach } from 'vitest'
import { useModelLibrary } from '../useModelLibrary'

describe('useModelLibrary', () => {
  beforeEach(() =>
    useModelLibrary.setState({ folders: [], filterQuery: {}, expandedGroups: {} })
  )

  it('adds a folder once and removes it', () => {
    const s = useModelLibrary.getState()
    s.addFolder('D:\\models')
    s.addFolder('D:\\models')
    s.addFolder('  ')
    expect(useModelLibrary.getState().folders).toEqual(['D:\\models'])
    useModelLibrary.getState().removeFolder('D:\\models')
    expect(useModelLibrary.getState().folders).toEqual([])
  })

  it('keeps the filter per provider and drops it when cleared', () => {
    const s = useModelLibrary.getState()
    s.setFilterQuery('llamacpp', 'qwen')
    s.setFilterQuery('openai', 'gpt')
    expect(useModelLibrary.getState().filterQuery).toEqual({
      llamacpp: 'qwen',
      openai: 'gpt',
    })
    useModelLibrary.getState().setFilterQuery('llamacpp', '')
    expect(useModelLibrary.getState().filterQuery).toEqual({ openai: 'gpt' })
  })

  it('toggles a group open and closed', () => {
    const s = useModelLibrary.getState()
    s.toggleGroup('llamacpp', 'qwen')
    expect(useModelLibrary.getState().expandedGroups.llamacpp).toEqual(['qwen'])
    useModelLibrary.getState().toggleGroup('llamacpp', 'qwen')
    expect(useModelLibrary.getState().expandedGroups.llamacpp).toEqual([])
  })
})
