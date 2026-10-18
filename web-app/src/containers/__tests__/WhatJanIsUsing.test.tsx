import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Mock-backed: the vector index, memory lookup, snapshot read and chat
// transport are fakes. These tests prove what the panel claims from those
// sources, not the sources.

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const listAttachments = vi.fn()
vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => ({ listAttachments }),
      // The context-window meter asks for a local engine; there is none here.
      getByName: () => undefined,
    }),
  },
}))

const memoryRecordGet = vi.fn()
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  memoryRecordGet: (...args: unknown[]) => memoryRecordGet(...args),
}))

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {},
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

import { WhatJanIsUsing, WhatJanIsUsingToggle } from '../WhatJanIsUsing'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useChatSessions } from '@/stores/chat-session-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import type { RequestAttribution } from '@/lib/requestAttribution'

const userMessage = (text: string) =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }) as never

const selection = (over: Record<string, unknown> = {}) => ({
  block: 'x',
  injectedIds: ['m1'],
  injectedHashes: ['h'],
  conflictIds: [],
  droppedIds: [],
  charsUsed: 10,
  ...over,
})

const attribution = (over: Partial<RequestAttribution> = {}): RequestAttribution => ({
  v: 1,
  requestId: 'req-1',
  snapshotId: 'snap-1',
  snapshotHash: 'fnv:1',
  invocationId: 'inv-1',
  snapshotStatus: 'captured',
  assembledAt: '2026-09-13T10:00:00.000Z',
  memory: {
    injectedIds: ['m1'],
    injectedHashes: ['h'],
    conflictIds: [],
    droppedIds: [],
    candidateIds: ['m1', 'm9'],
    projectId: null,
    projectName: null,
    disabled: false,
    temporary: false,
    unavailable: false,
  },
  tools: ['read_issue'],
  attachments: { inline: [], availableViaSearch: [] },
  provider: 'llamacpp',
  model: 'qwen3-8b',
  sendState: 'response-started',
  usageReported: false,
  ...over,
})

function withTransport(transport: Record<string, unknown>) {
  useChatSessions.setState({ sessions: { t1: { transport } as never } })
}

function seed() {
  useModelProvider.setState({
    selectedProvider: 'llamacpp',
    selectedModel: { id: 'qwen3-8b', capabilities: ['tools'] } as never,
    providers: [{ provider: 'llamacpp', active: true, models: [], settings: [] }] as never,
  })
  useThreads.setState({
    threads: {
      t1: { id: 't1', assistants: [{ name: 'Flint', instructions: 'Be brief.' }] } as never,
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
  withTransport({ memoryUsed: () => selection() })
  listAttachments.mockResolvedValue([{ id: 'f2', name: 'handbook.pdf', chunk_count: 40 }])
  memoryRecordGet.mockImplementation(async (_loc, scope, id) => {
    if (id === 'm1' && scope === 'user') {
      return { id: 'm1', scope: 'user', preview: 'Prefers metric units' }
    }
    if (id === 'm9' && scope === 'project') {
      return { id: 'm9', scope: 'project', preview: 'Deploys with make ship' }
    }
    throw new Error('not here')
  })
  invoke.mockResolvedValue([])
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
    expect(within(attachments).getByText(/context:state\.attached-to-message/)).toBeInTheDocument()
    expect(within(attachments).getByText(/context:state\.pending-next-message/)).toBeInTheDocument()
    expect(within(attachments).getByText(/context:state\.available-on-search/)).toBeInTheDocument()
  })

  it('removes a pending attachment before it is sent', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    // Files have their own tab in the inspector.
    fireEvent.click(screen.getByTestId('context-tab-files'))
    const attachments = screen.getByTestId('context-section-attachments')
    fireEvent.click(
      within(attachments).getByRole('button', { name: 'context:action.remove-pending-attachment' })
    )
    expect(useChatAttachments.getState().attachmentsByThread.t1).toEqual([])
  })

  it('names the memory chosen for the last message and its scope, without claiming inclusion', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const memory = screen.getByTestId('context-section-memory')
    expect(await within(memory).findByText('Prefers metric units')).toBeInTheDocument()
    expect(within(memory).getByText(/context:scope.across-chats/)).toBeInTheDocument()
    expect(screen.getByTestId('context-item-memory:m1')).toHaveAttribute(
      'data-state',
      'selected-last-request'
    )
    expect(memoryRecordGet).toHaveBeenCalledWith({ dataFolder: '/data', sessionId: 't1' }, 'user', 'm1')
  })

  it('verifies memory and tools against the sanitized snapshot, and offers to inspect it', async () => {
    withTransport({
      memoryUsed: () =>
        selection({ candidateIds: ['m1', 'm9'], projectId: 'jan-project:pA' }),
      lastAttribution: () =>
        attribution({
          memory: { ...attribution().memory, projectId: 'jan-project:pA', projectName: 'Alpha' },
        }),
    })
    useThreads.setState({
      threads: {
        t1: {
          id: 't1',
          assistants: [],
          metadata: { project: { id: 'pA', name: 'Alpha', updated_at: 0 } },
        } as never,
      },
    })
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_prompt_snapshots'
        ? [
            {
              payload: {
                messages: [
                  { role: 'system', content: '# Remembered\n- [m1] (user) Prefers metric units' },
                ],
                tools: [{ type: 'function', function: { name: 'read_issue' } }],
              },
            },
          ]
        : []
    )

    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()

    await waitFor(() =>
      expect(screen.getByTestId('context-item-memory:m1')).toHaveAttribute(
        'data-state',
        'included-last-request'
      )
    )
    expect(invoke).toHaveBeenCalledWith('agent_prompt_snapshots', {
      snapshotId: 'snap-1',
      session: 't1',
    })
    expect(screen.getByTestId('context-item-memory:m9')).toHaveAttribute('data-state', 'retrieved')
    expect(screen.getByTestId('context-item-tool:github::read_issue')).toHaveAttribute(
      'data-state',
      'included-last-request'
    )
    // Project memories resolve in the project the request used.
    await waitFor(() =>
      expect(memoryRecordGet).toHaveBeenCalledWith(
        { dataFolder: '/data', janProjectId: 'pA', sessionId: 't1' },
        'project',
        'm9'
      )
    )
    expect(await screen.findByText(/Alpha/)).toBeInTheDocument()
    const inspect = screen.getByTestId('context-inspect-request')
    expect(within(inspect).getByTestId('prompt-snapshot')).toBeInTheDocument()
    // The caveat on "verified" is there, behind its disclosure.
    expect(screen.getByTestId('context-notice-adapterBoundary')).toBeInTheDocument()
    expect(screen.getByTestId('context-notice-adapterBoundary').closest('details')).not.toHaveAttribute('open')
  })

  it('shows the request once as status and the token usage as a line of fact, not a second chip', async () => {
    withTransport({
      memoryUsed: () => selection(),
      lastAttribution: () => attribution({ usageReported: true }),
    })
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const payload = screen.getByTestId('context-section-payload')
    expect(within(payload).getAllByText('context:state.response-started')).toHaveLength(1)
    const usage = within(payload).getByTestId('context-item-payload:usage')
    expect(usage).toHaveTextContent('context:label.usage')
    expect(usage).toHaveTextContent('context:reason.usageRecorded')
    // The request's own reason is status: in view without a click.
    const request = within(payload).getByTestId('context-item-payload:request')
    expect(within(request).getByText(/context:reason\./)).toBeVisible()
    expect(within(request).queryByTestId(/context-why-/)).toBeNull()
  })

  it('keeps the reason behind an item one click away', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const model = screen.getByTestId('context-section-model')
    const reason = within(model).getByText('context:reason.location.local')
    expect(reason).not.toBeVisible()
    const why = within(model).getByTestId(/context-why-/)
    expect(why).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(why)
    expect(why).toHaveAttribute('aria-expanded', 'true')
    expect(reason).toBeVisible()
  })

  it('says why the Files tab is empty and offers to try again', async () => {
    useChatAttachments.setState({ attachmentsByThread: {} })
    listAttachments.mockRejectedValue(new Error('index starting'))
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    fireEvent.click(screen.getByTestId('context-tab-files'))
    const empty = await screen.findByTestId('context-empty-indexUnavailable')
    expect(empty).toHaveTextContent('context:empty.indexUnavailable')
    expect(empty).toHaveTextContent('context:empty.indexUnavailableHint')
    listAttachments.mockResolvedValue([{ id: 'f2', name: 'handbook.pdf', chunk_count: 40 }])
    fireEvent.click(screen.getByTestId('context-files-retry'))
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument()
    expect(listAttachments).toHaveBeenCalledTimes(2)
  })

  it('does not claim inclusion when no snapshot was captured', async () => {
    withTransport({
      memoryUsed: () => selection(),
      lastAttribution: () =>
        attribution({ snapshotId: null, snapshotHash: null, snapshotStatus: 'not-captured' }),
    })
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    expect(screen.getByTestId('context-item-memory:m1')).toHaveAttribute(
      'data-state',
      'selected-last-request'
    )
    expect(
      within(screen.getByTestId('context-section-payload')).getByText(
        'context:reason.snapshotUnavailable.not-captured'
      )
    ).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('agent_prompt_snapshots', expect.anything())
    expect(screen.queryByTestId('context-inspect-request')).toBeNull()
  })

  it('says the last request used the previous project after the chat moved', async () => {
    withTransport({
      memoryUsed: () => selection({ projectId: 'jan-project:pA' }),
      lastAttribution: () =>
        attribution({
          memory: { ...attribution().memory, projectId: 'jan-project:pA', projectName: 'Alpha' },
        }),
    })
    useThreads.setState({
      threads: {
        t1: {
          id: 't1',
          assistants: [],
          metadata: { project: { id: 'pB', name: 'Beta', updated_at: 0 } },
        } as never,
      },
    })
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    expect(screen.getByTestId('context-notice-projectChanged')).toBeInTheDocument()
  })

  it('says memory is turned off', async () => {
    withTransport({ memoryUsed: () => selection({ injectedIds: [], disabled: true }) })
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    expect(
      within(screen.getByTestId('context-section-memory')).getByText('context:label.memoryDisabled')
    ).toBeInTheDocument()
  })

  it('says memory is off in the temporary chat', async () => {
    useChatAttachments.setState({ attachmentsByThread: {} })
    useChatSessions.setState({ sessions: {} })
    render(<WhatJanIsUsing threadId="temporary-chat" messages={[]} />)
    fireEvent.click(screen.getByTestId('what-jan-is-using'))
    expect(
      await within(screen.getByTestId('context-section-memory')).findByText(
        'context:reason.temporaryChat'
      )
    ).toBeInTheDocument()
  })

  it('reads a persisted attribution after a reload, when no live request exists', async () => {
    useChatSessions.setState({ sessions: {} })
    render(
      <WhatJanIsUsing
        threadId="t1"
        messages={[
          {
            id: 'a1',
            role: 'assistant',
            parts: [],
            metadata: { attribution: attribution({ snapshotId: null, snapshotStatus: 'not-captured' }) },
          } as never,
        ]}
      />
    )
    await openPanel()
    expect(screen.getByTestId('context-item-payload:request')).toHaveAttribute(
      'data-state',
      'response-started'
    )
    expect(screen.getByTestId('context-item-memory:m1')).toHaveAttribute(
      'data-state',
      'selected-last-request'
    )
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

  it('says when no request has been sent yet', async () => {
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    expect(
      within(screen.getByTestId('context-section-payload')).getByText('context:reason.noRequestYet')
    ).toBeInTheDocument()
  })

  it("fills the empty space under Activity with the agent's browser, once it has one", async () => {
    useBrowserToolMirror.setState({ byId: {} })
    render(<WhatJanIsUsing threadId="t1" messages={[]} />)
    await openPanel()
    const panel = screen.getByTestId('what-jan-is-using-panel')
    expect(within(panel).queryByTestId('agent-browser-window')).toBeNull()
    act(() =>
      useBrowserToolMirror.getState().apply({
        sessionId: 't1',
        runId: 't1',
        kind: 'open',
        action: 'open http://127.0.0.1:5173/',
        url: 'http://127.0.0.1:5173/',
        title: 'Demo',
        screenshot: 'data:image/jpeg;base64,AAAA',
      })
    )
    const window = within(panel).getByTestId('agent-browser-window')
    // After the other cards, taking the rest of the column.
    const cards = [...panel.children]
    expect(cards[cards.length - 1]).toBe(window)
    expect(window.className).toMatch(/flex-1/)
    expect(within(window).getByTestId('abw-url').textContent).toBe('http://127.0.0.1:5173/')
    // Hiding it leaves the rest of the panel alone.
    fireEvent.click(within(window).getByTestId('abw-hide'))
    expect(within(panel).queryByTestId('agent-browser-window')).toBeNull()
    expect(panel.children.length).toBeGreaterThan(1)
  })
})

// C068: at 800px the Details label was cut in half by the header slot.
describe('WhatJanIsUsingToggle', () => {
  it('drops its label to screen readers in a narrow header', () => {
    render(<WhatJanIsUsingToggle open={false} onToggle={() => {}} />)
    const label = screen.getByText('context:details')
    expect(label.className).toContain('@max-[24rem]/hslot:sr-only')
  })
})
