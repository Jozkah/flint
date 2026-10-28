import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const m = vi.hoisted(() => ({
  folder: vi.fn(async (): Promise<string | undefined> => '/data'),
  conversations: {
    sessions: [{ id: 's1', title: 'One', kind: 'chat' }],
    projects: ['/p1'],
  } as { sessions: { id: string; title: string; kind: string }[]; projects: string[] },
  folders: [{ id: 'proj-a', name: 'A' }] as { id: string; name: string }[],
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: m.folder }) }),
}))
vi.mock('@/hooks/useMemoryConversations', () => ({
  useMemoryConversations: () => m.conversations,
}))
vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: (sel: (s: { folders: typeof m.folders }) => unknown) =>
    sel({ folders: m.folders }),
}))

import { useMemoryTarget } from '../useMemoryTarget'

describe('useMemoryTarget', () => {
  beforeEach(() => {
    m.folder.mockClear()
    m.folder.mockResolvedValue('/data')
    m.folders = [{ id: 'proj-a', name: 'A' }]
  })

  it('has no location until the data folder is known, then builds one', async () => {
    const { result } = renderHook(() => useMemoryTarget())
    expect(result.current.dataFolder).toBeNull()
    expect(result.current.location).toBeNull()
    await waitFor(() => expect(result.current.dataFolder).toBe('/data'))
    expect(result.current.location).not.toBeNull()
  })

  it('treats an unreadable data folder as empty, not as pending', async () => {
    m.folder.mockRejectedValue(new Error('no'))
    const { result } = renderHook(() => useMemoryTarget())
    await waitFor(() => expect(result.current.dataFolder).toBe(''))
  })

  it('defaults to the first conversation and project folder', async () => {
    const { result } = renderHook(() => useMemoryTarget())
    await waitFor(() => expect(result.current.sessionId).toBe('s1'))
    expect(result.current.projectRoot).toBe('/p1')
  })

  it('selects a Flint project and drops the choice when it is deleted', async () => {
    const { result, rerender } = renderHook(() => useMemoryTarget())
    act(() => result.current.setProjectId('proj-a'))
    expect(result.current.selectedProject?.name).toBe('A')
    m.folders = []
    rerender()
    await waitFor(() => expect(result.current.projectId).toBe(''))
    expect(result.current.selectedProject).toBeUndefined()
  })
})
