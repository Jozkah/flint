/**
 * Which project's memory an ordinary chat request uses.
 *
 * Asserted at the retrieval call, because the backend enforces the scope it is
 * given and the renderer's job is to give it the right one: the thread's
 * project when the request is assembled, nothing in a temporary chat, and the
 * new project once a chat moves -- without disturbing a request already running.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const { memoryRetrieve, getJanDataFolder } = vi.hoisted(() => ({
  memoryRetrieve: vi.fn(),
  getJanDataFolder: vi.fn(),
}))

vi.mock('@janhq/tauri-plugin-agent-tools-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  memoryRetrieve: (...a: unknown[]) => memoryRetrieve(...a),
}))
vi.mock('@/hooks/useServiceHub', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

import { CustomChatTransport } from '../custom-chat-transport'
import { chatMemoryBinding, workspaceProjectIdentity } from '../memoryBinding'
import { useChatMemoryBinding } from '@/hooks/useChatMemoryBinding'
import { useThreads } from '@/hooks/useThreads'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

type Internals = { refreshMemory(): Promise<void> }
const refresh = (t: CustomChatTransport) =>
  (t as unknown as Internals).refreshMemory()

const selection = (over: Record<string, unknown> = {}) => ({
  block: '# Remembered\n\n- [mem-a] (project) Alpha deploys with make ship.',
  injectedIds: ['mem-a'],
  injectedHashes: ['h'],
  conflictIds: [],
  droppedIds: [],
  charsUsed: 40,
  candidateIds: ['mem-a'],
  projectId: 'jan-project:pA',
  disabled: false,
  ...over,
})

const inProject = (id: string, project?: { id: string; name: string }) =>
  useThreads.setState({
    threads: {
      [id]: { id, title: id, metadata: project ? { project } : {} } as never,
    },
  })

beforeEach(() => {
  memoryRetrieve.mockReset().mockResolvedValue(selection())
  getJanDataFolder.mockReset().mockResolvedValue('/data')
  useThreads.setState({ threads: {} })
})

describe('chatMemoryBinding', () => {
  it('binds a chat in a project to that project, by id', () => {
    expect(
      chatMemoryBinding('t1', { metadata: { project: { id: 'pA', name: 'Alpha' } } })
    ).toEqual({ temporary: false, janProjectId: 'pA', janProjectName: 'Alpha' })
    expect(workspaceProjectIdentity({ janProjectId: 'pA' })).toBe('jan-project:pA')
  })

  it('binds a chat in no project to no project', () => {
    expect(chatMemoryBinding('t1', { metadata: {} })).toEqual({ temporary: false })
  })

  it('binds the temporary chat as temporary and to no project, whatever its metadata says', () => {
    expect(
      chatMemoryBinding(TEMPORARY_CHAT_ID, {
        metadata: { project: { id: 'pA', name: 'Alpha' } },
      })
    ).toEqual({ temporary: true })
  })

  it('lets a folder take precedence over a workspace project', () => {
    expect(
      workspaceProjectIdentity({ janProjectId: 'pA', projectRoot: '/work/api' })
    ).toBeNull()
  })
})

describe('memory binding in the chat transport', () => {
  it('asks for the project the chat was created in', async () => {
    inProject('t1', { id: 'pA', name: 'Alpha' })
    const t = new CustomChatTransport(undefined, 't1')
    await refresh(t)
    expect(memoryRetrieve).toHaveBeenCalledWith(
      { dataFolder: '/data', janProjectId: 'pA', sessionId: 't1' },
      { temporary: false }
    )
    expect(t.memoryBindingForLastRequest()).toMatchObject({
      janProjectId: 'pA',
      janProjectName: 'Alpha',
    })
  })

  /// The bug this closes: the temporary chat was never bound temporary, so it
  /// read the user's memory.
  it('never reads memory into the temporary chat, even when a caller omits the flag', async () => {
    inProject(TEMPORARY_CHAT_ID, { id: 'pA', name: 'Alpha' })
    const t = new CustomChatTransport(undefined, TEMPORARY_CHAT_ID)
    t.setMemoryBinding({})
    await refresh(t)
    expect(memoryRetrieve).toHaveBeenCalledWith(
      { dataFolder: '/data', sessionId: TEMPORARY_CHAT_ID },
      { temporary: true }
    )
  })

  it('uses the new project for the next request after the chat moves', async () => {
    inProject('t1', { id: 'pA', name: 'Alpha' })
    const t = new CustomChatTransport(undefined, 't1')
    await refresh(t)

    inProject('t1', { id: 'pB', name: 'Beta' })
    memoryRetrieve.mockResolvedValue(
      selection({ injectedIds: ['mem-b'], projectId: 'jan-project:pB' })
    )
    await refresh(t)
    expect(memoryRetrieve).toHaveBeenLastCalledWith(
      { dataFolder: '/data', janProjectId: 'pB', sessionId: 't1' },
      { temporary: false }
    )
    expect(t.memoryUsed()?.injectedIds).toEqual(['mem-b'])
  })

  it('stops using project memory once the project is deleted', async () => {
    inProject('t1', { id: 'pA', name: 'Alpha' })
    const t = new CustomChatTransport(undefined, 't1')
    await refresh(t)
    // What deleting a project does to its threads (useThreadManagement).
    inProject('t1', undefined)
    await refresh(t)
    expect(memoryRetrieve).toHaveBeenLastCalledWith(
      { dataFolder: '/data', sessionId: 't1' },
      { temporary: false }
    )
  })

  /// A change during an active conversation affects the next request only.
  it('keeps what a running request retrieved when the chat moves mid-request', async () => {
    inProject('t1', { id: 'pA', name: 'Alpha' })
    const t = new CustomChatTransport(undefined, 't1')
    let finish: (value: unknown) => void = () => {}
    memoryRetrieve.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const running = refresh(t)
    await vi.waitFor(() => expect(memoryRetrieve).toHaveBeenCalledTimes(1))

    inProject('t1', { id: 'pB', name: 'Beta' })
    finish(selection())
    await running

    // The running request keeps project A's selection and binding...
    expect(t.memoryUsed()?.injectedIds).toEqual(['mem-a'])
    expect(t.memoryBindingForLastRequest()?.janProjectId).toBe('pA')
    // ...while the next one is already bound to B.
    expect(t.currentMemoryBinding().janProjectId).toBe('pB')
    await refresh(t)
    expect(memoryRetrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({ janProjectId: 'pB' }),
      { temporary: false }
    )
  })
})

describe('useChatMemoryBinding', () => {
  it('binds on creation and follows moves and project deletion', () => {
    inProject('t1', { id: 'pA', name: 'Alpha' })
    const transport = { setMemoryBinding: vi.fn() }
    renderHook(() => useChatMemoryBinding('t1', transport))
    expect(transport.setMemoryBinding).toHaveBeenLastCalledWith({
      temporary: false,
      janProjectId: 'pA',
      janProjectName: 'Alpha',
    })

    act(() => inProject('t1', { id: 'pB', name: 'Beta' }))
    expect(transport.setMemoryBinding).toHaveBeenLastCalledWith({
      temporary: false,
      janProjectId: 'pB',
      janProjectName: 'Beta',
    })

    act(() => inProject('t1', undefined))
    expect(transport.setMemoryBinding).toHaveBeenLastCalledWith({ temporary: false })
  })

  it('binds the temporary chat as temporary', () => {
    const transport = { setMemoryBinding: vi.fn() }
    renderHook(() => useChatMemoryBinding(TEMPORARY_CHAT_ID, transport))
    expect(transport.setMemoryBinding).toHaveBeenLastCalledWith({ temporary: true })
  })
})
