import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mcp = vi.hoisted(() => ({
  listPrompts: vi.fn(),
  getPrompt: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => {
  const hub = { mcp: () => mcp }
  return { useServiceHub: () => hub, getServiceHub: () => hub }
})

import { useMcpPromptInsert } from '../useMcpPromptInsert'
import { useMcpPrompts } from '@/lib/mcpPrompts'
import type { MCPPromptInfo } from '@/services/mcp/types'

const plain: MCPPromptInfo = { server: 'fs', name: 'summary', arguments: [] }
const review: MCPPromptInfo = {
  server: 'fs',
  name: 'review',
  description: 'Review a file',
  arguments: [{ name: 'path', required: true }],
}

function setup() {
  const setPrompt = vi.fn()
  const addImages = vi.fn()
  const hook = renderHook(() => useMcpPromptInsert({ setPrompt, addImages }))
  return { ...hook, setPrompt, addImages }
}

describe('useMcpPromptInsert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMcpPrompts.setState({ prompts: [] })
    mcp.listPrompts.mockResolvedValue([plain, review])
  })

  it('offers every prompt the running servers list in the / menu', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.mcpBuiltins).toHaveLength(2))
    expect(result.current.mcpBuiltins.map((b) => b.name)).toEqual([
      'mcp:fs:summary',
      'mcp:fs:review',
    ])
    expect(result.current.mcpBuiltins[1].description).toBe('fs: Review a file')
    expect(result.current.mcpBuiltins[1].mcpPrompt).toBe(review)
  })

  it('inserts a prompt without arguments at once', async () => {
    mcp.getPrompt.mockResolvedValue({
      messages: [{ role: 'user', text: 'Summarize the repo.' }],
      omitted: 0,
    })
    const { result, setPrompt } = setup()
    act(() => result.current.beginMcpPromptInsert(plain))
    await waitFor(() => expect(setPrompt).toHaveBeenCalledWith('Summarize the repo.'))
    expect(mcp.getPrompt).toHaveBeenCalledWith('fs', 'summary', {})
    expect(result.current.mcpFill).toBeNull()
  })

  it('asks for the arguments first, then fetches with them', async () => {
    mcp.getPrompt.mockResolvedValue({
      messages: [
        { role: 'user', text: 'Review a.ts' },
        { role: 'user', image: { data: 'QUJD', mimeType: 'image/png' } },
      ],
      omitted: 1,
    })
    const { result, setPrompt, addImages } = setup()
    act(() => result.current.beginMcpPromptInsert(review))
    expect(result.current.mcpFill).toBe(review)
    expect(mcp.getPrompt).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.submitMcpFill({ path: 'a.ts' })
    })
    expect(mcp.getPrompt).toHaveBeenCalledWith('fs', 'review', { path: 'a.ts' })
    expect(setPrompt).toHaveBeenCalledWith('Review a.ts')
    expect(addImages).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
    ])
    expect(toast.info).toHaveBeenCalledWith('common:mcpPrompts.omitted')
    expect(result.current.mcpFill).toBeNull()
  })

  it('keeps the form open and says why when the server refuses', async () => {
    mcp.getPrompt.mockRejectedValue(new Error('unknown argument'))
    const { result, setPrompt } = setup()
    act(() => result.current.beginMcpPromptInsert(review))
    await act(async () => {
      await result.current.submitMcpFill({ path: 'a.ts' })
    })
    expect(setPrompt).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('common:mcpPrompts.failed', {
      description: 'unknown argument',
    })
    expect(result.current.mcpFill).toBe(review)
  })

  it('offers nothing when listing fails', async () => {
    mcp.listPrompts.mockRejectedValue(new Error('no servers'))
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { result } = setup()
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.mcpBuiltins).toEqual([])
    warn.mockRestore()
  })
})
