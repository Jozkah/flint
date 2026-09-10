import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAssistant, defaultAssistant } from '../useAssistant'

// Mock the services
vi.mock('@/services/assistants', () => ({
  createAssistant: vi.fn(() => Promise.resolve()),
  deleteAssistant: vi.fn(() => Promise.resolve()),
}))

describe('useAssistant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset Zustand store to default state
    act(() => {
      useAssistant.setState({
        assistants: [defaultAssistant],
        currentAssistant: defaultAssistant,
      })
    })
  })

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useAssistant())

    expect(result.current.assistants).toEqual([defaultAssistant])
    expect(result.current.currentAssistant).toEqual(defaultAssistant)
  })

  it('should add assistant', () => {
    const { result } = renderHook(() => useAssistant())

    const newAssistant = {
      id: 'assistant-2',
      name: 'New Assistant',
      avatar: '🤖',
      description: 'A new assistant',
      instructions: 'Help the user',
      created_at: Date.now(),
      parameters: {},
    }

    act(() => {
      result.current.addAssistant(newAssistant)
    })

    expect(result.current.assistants).toHaveLength(2)
    expect(result.current.assistants).toContain(newAssistant)
  })

  // janhq/jan#8524: a thread keeps a snapshot of its assistant, and the chat
  // route builds the system prompt from that snapshot. Editing the assistant
  // updated the assistant list and nothing else, so an open conversation kept
  // answering to the old instructions.
  it('carries an edited assistant into the threads that use it', async () => {
    const { useThreads } = await import('../useThreads')
    const bound = {
      id: 'thread-bound',
      title: 'Bound',
      model: { id: 'qwen3-8b', provider: 'llamacpp' },
      assistants: [{ ...defaultAssistant, instructions: 'Answer in Spanish.' }],
      updated: 1,
    }
    const other = {
      id: 'thread-other',
      title: 'Other',
      model: { id: 'gemma-3', provider: 'llamacpp' },
      assistants: [{ ...defaultAssistant, id: 'someone-else', instructions: 'Be terse.' }],
      updated: 1,
    }
    act(() => {
      useThreads.setState({
        threads: { [bound.id]: bound, [other.id]: other } as any,
      })
    })

    act(() => {
      useAssistant
        .getState()
        .updateAssistant({ ...defaultAssistant, instructions: 'You are a pirate.' })
    })

    const threads = useThreads.getState().threads as any
    expect(threads['thread-bound'].assistants[0].instructions).toBe('You are a pirate.')
    // The thread's own model binding survives the refresh.
    expect(threads['thread-bound'].assistants[0].model).toEqual(bound.model)
    // A thread on another assistant is not touched.
    expect(threads['thread-other'].assistants[0].instructions).toBe('Be terse.')
  })

  it('should update assistant', () => {
    const { result } = renderHook(() => useAssistant())

    const updatedAssistant = {
      ...defaultAssistant,
      name: 'Updated Jan',
      description: 'Updated description',
    }

    act(() => {
      result.current.updateAssistant(updatedAssistant)
    })

    expect(result.current.assistants[0].name).toBe('Updated Jan')
    expect(result.current.assistants[0].description).toBe('Updated description')
  })

  it('should delete assistant', () => {
    const { result } = renderHook(() => useAssistant())

    const assistant2 = {
      id: 'assistant-2',
      name: 'Assistant 2',
      avatar: '🤖',
      description: 'Second assistant',
      instructions: 'Help the user',
      created_at: Date.now(),
      parameters: {},
    }

    act(() => {
      result.current.addAssistant(assistant2)
    })

    expect(result.current.assistants).toHaveLength(2)

    act(() => {
      result.current.deleteAssistant('assistant-2')
    })

    expect(result.current.assistants).toHaveLength(1)
    expect(result.current.assistants[0].id).toBe('jan')
  })

  it('should set current assistant', () => {
    const { result } = renderHook(() => useAssistant())

    const newAssistant = {
      id: 'assistant-2',
      name: 'New Current Assistant',
      avatar: '🤖',
      description: 'New current assistant',
      instructions: 'Help the user',
      created_at: Date.now(),
      parameters: {},
    }

    act(() => {
      result.current.setCurrentAssistant(newAssistant)
    })

    expect(result.current.currentAssistant).toEqual(newAssistant)
  })

  it('should set assistants', () => {
    const { result } = renderHook(() => useAssistant())

    const assistants = [
      {
        id: 'assistant-1',
        name: 'Assistant 1',
        avatar: '🤖',
        description: 'First assistant',
        instructions: 'Help the user',
        created_at: Date.now(),
        parameters: {},
      },
      {
        id: 'assistant-2',
        name: 'Assistant 2',
        avatar: '🔧',
        description: 'Second assistant',
        instructions: 'Help with tasks',
        created_at: Date.now(),
        parameters: {},
      },
    ]

    expect(result.current.loading).toBe(true)

    act(() => {
      result.current.setAssistants(assistants)
    })

    expect(result.current.loading).toBe(false)

    expect(result.current.assistants).toEqual(assistants)
    expect(result.current.assistants).toHaveLength(2)
  })

  it('should maintain assistant structure', () => {
    const { result } = renderHook(() => useAssistant())

    expect(result.current.currentAssistant.id).toBe('jan')
    expect(result.current.currentAssistant.name).toBe('Jan')
    expect(result.current.currentAssistant.avatar).toBe('👋')
    expect(result.current.currentAssistant.instructions).toContain(
      'Before engaging any tools, articulate your complete thought process in natural language'
    )
    expect(typeof result.current.currentAssistant.created_at).toBe('number')
    expect(typeof result.current.currentAssistant.parameters).toBe('object')
  })

  it('should handle empty assistants list', () => {
    const { result } = renderHook(() => useAssistant())

    act(() => {
      result.current.setAssistants([])
    })

    expect(result.current.assistants).toEqual([])
  })

  it('should update assistant in current assistant if it matches', () => {
    const { result } = renderHook(() => useAssistant())

    const updatedDefaultAssistant = {
      ...defaultAssistant,
      name: 'Updated Jan Name',
    }

    act(() => {
      result.current.updateAssistant(updatedDefaultAssistant)
    })

    expect(result.current.currentAssistant.name).toBe('Updated Jan Name')
  })
})
