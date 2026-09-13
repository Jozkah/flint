import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToolApproval } from '../useToolApproval'

// Mock constants
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: {
    toolApproval: 'tool-approval-settings',
  },
}))

// Mock zustand persist
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

const GH = 'sha256:github-v1'
const FS = 'sha256:filesystem-v1'

describe('useToolApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state to defaults
    useToolApproval.setState({
      approvedTools: {},
      approvedMcpTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      invalidatedServers: [],
      allowAllMCPPermissions: false,
    })
  })

  it('should initialize with default values', () => {
    const { result } = renderHook(() => useToolApproval())

    expect(result.current.approvedTools).toEqual({})
    expect(result.current.approvedMcpTools).toEqual({})
    expect(result.current.approvedServers).toEqual([])
    expect(result.current.approvedToolsGlobal).toEqual([])
    expect(result.current.invalidatedServers).toEqual([])
    expect(result.current.allowAllMCPPermissions).toBe(false)
    expect(typeof result.current.approveToolForThread).toBe('function')
    expect(typeof result.current.approveServer).toBe('function')
    expect(typeof result.current.revokeServer).toBe('function')
    expect(typeof result.current.isServerApproved).toBe('function')
    expect(typeof result.current.approveToolEverywhere).toBe('function')
    expect(typeof result.current.isToolApproved).toBe('function')
    expect(typeof result.current.setAllowAllMCPPermissions).toBe('function')
  })

  describe('setAllowAllMCPPermissions', () => {
    it('should set allowAllMCPPermissions to true', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.setAllowAllMCPPermissions(true)
      })

      expect(result.current.allowAllMCPPermissions).toBe(true)
    })

    it('should set allowAllMCPPermissions to false', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.setAllowAllMCPPermissions(true)
      })

      expect(result.current.allowAllMCPPermissions).toBe(true)

      act(() => {
        result.current.setAllowAllMCPPermissions(false)
      })

      expect(result.current.allowAllMCPPermissions).toBe(false)
    })
  })

  describe('approveToolForThread', () => {
    it('should approve a tool for a thread', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
      })

      expect(result.current.approvedTools['thread-1']).toContain('tool-a')
    })

    it('should approve multiple tools for the same thread', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
        result.current.approveToolForThread('thread-1', 'tool-b')
        result.current.approveToolForThread('thread-1', 'tool-c')
      })

      expect(result.current.approvedTools['thread-1']).toEqual(['tool-a', 'tool-b', 'tool-c'])
    })

    it('should approve tools for different threads independently', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
        result.current.approveToolForThread('thread-2', 'tool-b')
        result.current.approveToolForThread('thread-3', 'tool-c')
      })

      expect(result.current.approvedTools['thread-1']).toEqual(['tool-a'])
      expect(result.current.approvedTools['thread-2']).toEqual(['tool-b'])
      expect(result.current.approvedTools['thread-3']).toEqual(['tool-c'])
    })

    it('should not duplicate tools when approving the same tool multiple times', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
        result.current.approveToolForThread('thread-1', 'tool-a')
        result.current.approveToolForThread('thread-1', 'tool-a')
      })

      expect(result.current.approvedTools['thread-1']).toEqual(['tool-a'])
    })
  })

  describe('isToolApproved', () => {
    it('should return false for non-approved tools', () => {
      const { result } = renderHook(() => useToolApproval())

      const isApproved = result.current.isToolApproved('thread-1', 'tool-a')
      expect(isApproved).toBe(false)
    })

    it('should return true for approved tools', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
      })

      const isApproved = result.current.isToolApproved('thread-1', 'tool-a')
      expect(isApproved).toBe(true)
    })

    it('should return false for tools approved for different threads', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'tool-a')
      })

      const isApproved = result.current.isToolApproved('thread-2', 'tool-a')
      expect(isApproved).toBe(false)
    })

    // A tool name is chosen by whoever publishes it, so a name-only grant
    // must never answer for a server's tool.
    it('does not let a name-only grant cover a server tool of the same name', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolForThread('thread-1', 'fetch')
        result.current.approveToolEverywhere('fetch')
      })

      expect(result.current.isToolApproved('thread-1', 'fetch', 'github', GH)).toBe(
        false
      )
    })

    it('binds a conversation grant for a server tool to that server and definition', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveMcpToolForThread('thread-1', 'github', 'create_issue', GH)
      })

      expect(
        result.current.isToolApproved('thread-1', 'create_issue', 'github', GH)
      ).toBe(true)
      expect(
        result.current.isToolApproved('thread-1', 'create_issue', 'impostor', GH)
      ).toBe(false)
      expect(
        result.current.isToolApproved('thread-1', 'create_issue', 'github', 'sha256:other')
      ).toBe(false)
      expect(
        result.current.isToolApproved('thread-2', 'create_issue', 'github', GH)
      ).toBe(false)
      expect(result.current.isToolApproved('thread-1', 'create_issue', 'github')).toBe(
        false
      )
    })
  })

  describe('approveServer', () => {
    it('approves every tool from that server, in any thread', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', GH)
      })

      expect(
        result.current.isToolApproved('thread-1', 'create_issue', 'github', GH)
      ).toBe(true)
      expect(
        result.current.isToolApproved('thread-9', 'list_repos', 'github', GH)
      ).toBe(true)
    })

    it('leaves other servers alone', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', GH)
      })

      expect(
        result.current.isToolApproved('thread-1', 'read_file', 'filesystem', FS)
      ).toBe(false)
    })

    it('does not duplicate a server approved twice', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', GH)
        result.current.approveServer('github', GH)
      })

      expect(result.current.approvedServers).toEqual([
        { name: 'github', fingerprint: GH },
      ])
    })

    it('records nothing without a fingerprint', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', '')
      })

      expect(result.current.approvedServers).toEqual([])
    })
  })

  describe('revokeServer', () => {
    it('un-trusts a server so its tools prompt again', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', GH)
      })
      expect(result.current.isServerApproved('github', GH)).toBe(true)

      act(() => {
        result.current.revokeServer('github')
      })

      expect(result.current.isServerApproved('github', GH)).toBe(false)
      expect(
        result.current.isToolApproved('thread-1', 'create_issue', 'github', GH)
      ).toBe(false)
    })

    it('leaves other approved servers intact', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveServer('github', GH)
        result.current.approveServer('filesystem', FS)
        result.current.revokeServer('github')
      })

      expect(result.current.approvedServers).toEqual([
        { name: 'filesystem', fingerprint: FS },
      ])
    })
  })

  describe('approveToolEverywhere', () => {
    it('approves the tool in every thread', () => {
      const { result } = renderHook(() => useToolApproval())

      act(() => {
        result.current.approveToolEverywhere('tool-a')
      })

      expect(result.current.isToolApproved('thread-1', 'tool-a')).toBe(true)
      expect(result.current.isToolApproved('thread-2', 'tool-a')).toBe(true)
      expect(result.current.isToolApproved('thread-1', 'tool-b')).toBe(false)
    })
  })

  describe('state management', () => {
    it('should maintain state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useToolApproval())
      const { result: result2 } = renderHook(() => useToolApproval())

      act(() => {
        result1.current.approveToolForThread('thread-1', 'tool-a')
        result1.current.setAllowAllMCPPermissions(true)
      })

      expect(result2.current.approvedTools['thread-1']).toContain('tool-a')
      expect(result2.current.allowAllMCPPermissions).toBe(true)
    })
  })
})
