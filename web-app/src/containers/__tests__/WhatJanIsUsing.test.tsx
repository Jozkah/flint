import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Mock-backed: the vector index, memory lookup and chat transport are fakes.
// These tests prove what the panel claims from those sources, not the sources.

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const listAttachments = vi.fn()
vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({ get: () => ({ listAttachments }) }),
  },
}))

const memoryRecordGet = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  memoryRecordGet: (...args: unknown[]) => memoryRecordGet(...args),
}))

const hub = { app: () => ({ getJanDataFolder: async () => '/data' }) }
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isLocalProvider: (name: string) => name === 'llamacpp',
}))

import { WhatJanIsUsing } from '../WhatJanIsUsing'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useChatSessions } from '@/stores/chat-session-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'

const userMessage = (text: string) =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }) as never

function seed() {
  useModelProvider.setState({
    selectedProvider: 'llamacpp',
    selectedModel: { id: 'qwen3-8b', capabilities: ['tools'] } as never,
    providers: [{ provider: 'llamacpp', active: true, models: [], settings: [] }] as never,
  })
  useThreads.setState({
    threads: {
      t1: { id: 't1', assistants: [{ name: 'Jan', instructions: 'Be brief.' }] } as never,
    },
  })
  useAppState.setState({
    tools: [{ name: 'read_issue', server: 'github', description: '', inputSchema: {} }],
  })
  useToolAvailable.setState({ disabledTools: [] })
  useChatAttachments.setState({
    attachmentsByThread: {
      t1: [{ name: 'draft.md', type: 'document', parseMode: 'inline' }],
    },
  })
  useChatSessions.setState({
    sessions: {
      t1: {
        transport: {
          memoryUsed: () => ({
            block: 'x',
            injectedIds: ['m1'],
            injectedHashes: ['h'],
            conflictIds: [],
            droppedIds: [],
            charsUsed: 10,
          }),
        },
      } as never,
    },
  })
  listAttachments.mockResolvedValue([{ id: 'f2', name: 'handbook.pdf', chunk_count: 40 }])
  memoryRecordGet.mockImplementation(async (_loc, scope) => {
    if (scope !== 'user') throw new Error('not here')
    return { id: 'm1', scope: 'user', preview: 'Prefers metric units' }
  })
}

const openPanel = async () => {
  fireEvent.click(screen.getByTestId('what-jan-is-using'))
  await waitFor(() => expect(listAttachments).toHaveBeenCalledWith('t1'))
}

describe('WhatJanIsUsing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('shows sent, pending and indexed files with different claims', async () => {
    render(
      <WhatJanIsUsing
        threadId="t1"
        messages={[
          userMessage(
            'Summarise\n\n[ATTACHED_FILES]\n- file_id: f1, name: notes.txt, mode: inline\n[/ATTACHED_FILES]'
          ),
        ]}
      />
    )
    await openPanel()
    const attachments = screen.getByTestId('context-section-attachments')
    expect(await within(attachments).findByText('handbook.pdf')).toBeInTheDocument()
    expect(within(attachments).getByText('draft.md')).toBeInTheDocument()
    expect(within(attachments).getByText('notes.txt')).toBeInTheDocument()
    expect(within(attachments).getByText(/context:state\.included-with-message/)).toBeInTheDocument()
    expect(within(attachments).getByText(/context:state\.pending-next-message/)).toBeInTheDocument()
    expect(within(attachments).getByText(/context:state\.available-on-search/)).toBeInTheDocument()
  })

  it('removes a pending attachment before it is sent', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const attachments = screen.getByTestId('context-section-attachments')
    fireEvent.click(
      within(attachments).getByRole('button', { name: 'context:action.remove-pending-attachment' })
    )
    expect(useChatAttachments.getState().attachmentsByThread.t1).toEqual([])
  })

  it('names the memory sent with the last message and its scope, resolving the record', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const memory = screen.getByTestId('context-section-memory')
    expect(await within(memory).findByText('Prefers metric units')).toBeInTheDocument()
    expect(within(memory).getByText(/context:scope.across-chats/)).toBeInTheDocument()
    expect(memoryRecordGet).toHaveBeenCalledWith({ dataFolder: '/data', sessionId: 't1' }, 'user', 'm1')
  })

  it('lists enabled tools as available rather than used, and states local processing', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const tools = screen.getByTestId('context-section-tools')
    expect(within(tools).getByText('read_issue')).toBeInTheDocument()
    expect(within(tools).getByText(/context:state\.available/)).toBeInTheDocument()
    expect(
      within(screen.getByTestId('context-section-model')).getByText('context:reason.location.local')
    ).toBeInTheDocument()
  })

  it('is explicit that the exact chat request is not recorded', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    expect(
      within(screen.getByTestId('context-section-payload')).getByText(
        'context:reason.chatPayloadNotRecorded'
      )
    ).toBeInTheDocument()
  })
})
