import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

// ---- Module mocks ----------------------------------------------------------

vi.mock('@/i18n/react-i18next-compat', async () => ({
  i18n: (await import('@/i18n/setup')).default,
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k} ${Object.values(opts).join(' ')}` : k,
  }),
}))

const selectedModelRef = vi.hoisted(() => ({ current: { id: 'm1' } as any }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({ selectedModel: selectedModelRef.current }),
}))

// Stub heavy children: RenderMarkdown
vi.mock('../RenderMarkdown', () => ({
  RenderMarkdown: ({ content }: any) => (
    <div data-testid="render-markdown">{content}</div>
  ),
}))

// Stub streamdown
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: any) => <div data-testid="streamdown">{children}</div>,
}))

// Stub ChainOfThought
vi.mock('@/components/ai-elements/chain-of-thought', () => ({
  ChainOfThought: ({ children }: any) => <div data-testid="cot">{children}</div>,
  ChainOfThoughtContent: ({ children }: any) => <div>{children}</div>,
  ChainOfThoughtHeader: () => <div>CoT Header</div>,
}))

// Stub Tool
vi.mock('@/components/ai-elements/tool', () => ({
  Tool: ({ children, toolCallId }: any) => (
    <div data-testid="tool" data-tool-call={toolCallId}>
      {children}
    </div>
  ),
  ToolContent: ({ children }: any) => <div>{children}</div>,
  ToolHeader: ({ title }: any) => <div data-testid="tool-header">{title}</div>,
  ToolInput: ({ input }: any) => <div data-testid="tool-input">{String(input)}</div>,
  ToolOutput: ({ output, errorText }: any) => (
    <div data-testid="tool-output">{errorText ?? String(output ?? '')}</div>
  ),
  ToolApprovalActions: () => <div data-testid="approval-panel" />,
}))

// Stub dialogs
const editOnSaveRef = vi.hoisted(() => ({ current: null as any }))
vi.mock('@/containers/dialogs/EditMessageDialog', () => ({
  EditMessageDialog: ({ onSave, message }: any) => {
    editOnSaveRef.current = onSave
    return (
      <button data-testid="edit-btn" onClick={() => onSave('edited: ' + message)}>
        Edit
      </button>
    )
  },
}))

vi.mock('@/containers/dialogs/DeleteMessageDialog', () => ({
  DeleteMessageDialog: ({ onDelete }: any) => (
    <button data-testid="delete-btn" onClick={onDelete}>
      Delete
    </button>
  ),
}))

vi.mock('@/containers/TokenSpeedIndicator', () => ({
  default: ({ streaming }: any) => (
    <div data-testid="token-speed" data-streaming={String(streaming)} />
  ),
}))

vi.mock('../CopyButton', () => ({
  CopyButton: ({ text }: any) => (
    <button data-testid="copy-btn" data-text={text}>
      Copy
    </button>
  ),
}))

vi.mock('@/utils/formatDate', () => ({
  formatDate: () => '2024-01-01',
}))

vi.mock('@/lib/fileMetadata', () => ({
  extractFilesFromPrompt: (text: string) => {
    if (text?.startsWith('[FILE:')) {
      return {
        cleanPrompt: text.replace(/\[FILE:[^\]]+\]/g, '').trim(),
        files: [{ id: 'f1', name: 'doc.txt', injectionMode: 'inline' }],
      }
    }
    return { cleanPrompt: text ?? '', files: [] }
  },
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/PromptProgress', () => ({
  // `hideIdle` is what suppresses the generic "Working…" fallback, and the real
  // component renders nothing when it is set with no model load in flight, so
  // the stand-in has to honour it or every caller looks like it shows a card.
  PromptProgress: ({ hideIdle }: { hideIdle?: boolean }) =>
    hideIdle ? null : <div data-testid="prompt-progress" />,
}))

const pendingApprovalsRef = vi.hoisted(() => ({ current: {} as any }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: (selector: any) =>
    selector({ pending: pendingApprovalsRef.current }),
}))

// Import after mocks
import { MessageItem } from '../MessageItem'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { wrapForModel } from '@/lib/sessionMailbox'

const makeMsg = (overrides: any = {}) => ({
  id: 'msg-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Hello assistant' }],
  metadata: { createdAt: new Date() },
  ...overrides,
})

describe('MessageItem', () => {
  beforeEach(() => {
    // These cases cover the full trace; the compact views have their own tests.
    useInterfaceSettings.setState({ transcriptView: 'verbose' })
    vi.clearAllMocks()
    selectedModelRef.current = { id: 'm1' }
    pendingApprovalsRef.current = {}
  })

  it.each([
    ['a settled message', false, 'ready'],
    ['the last, in-progress message', true, 'streaming'],
  ])('right-click on %s opens the menu anchored at the pointer', async (_n, last, status) => {
    const { container } = render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage={last}
        status={status as any}
      />
    )
    const row = container.querySelector('[data-role="assistant"]') as HTMLElement
    row.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 300, right: 510, bottom: 320, x: 10, y: 20, toJSON() {} }) as DOMRect
    fireEvent.contextMenu(row, { clientX: 110, clientY: 70 })
    const anchor = screen.getByTestId('message-menu-anchor')
    expect(anchor.style.left).toBe('100px')
    expect(anchor.style.top).toBe('50px')
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it('shows only the text of a delivered agent message, not the harness fence', () => {
    useInterfaceSettings.setState({ renderUserMarkdown: false })
    const text = wrapForModel({
      v: 1,
      id: 'msg-1a-0',
      from: { sessionId: 'S1', displayName: 'Alpha' },
      to: { sessionId: 'S2' },
      project: 'p',
      text: 'Hello from Alpha, please count the lines',
      createdAt: 0,
      replyTo: null,
      depth: 0,
      origin: 'agent',
    })
    const { container } = render(
      <MessageItem
        message={makeMsg({
          role: 'user',
          parts: [{ type: 'text', text }],
          metadata: {
            createdAt: new Date(),
            agentMessage: { sessionId: 'S1', displayName: 'Alpha', messageId: 'msg-1a-0' },
          },
        }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const bubble = container.querySelector('[data-slot="user-bubble"]') as HTMLElement
    expect(bubble).toHaveTextContent('Hello from Alpha, please count the lines')
    expect(bubble.textContent).not.toContain('Coordination message')
    expect(bubble.textContent).not.toContain('MAIL-msg-1a-0')
    expect(bubble.textContent).not.toContain('End of coordination message')
  })

  it('leaves a typed message that only looks like the fence alone', () => {
    useInterfaceSettings.setState({ renderUserMarkdown: false })
    const text = '[Coordination message from session "x" typed by hand'
    const { container } = render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(container.querySelector('[data-slot="user-bubble"]')).toHaveTextContent(text)
  })

  it('renders the continue-from-summary seed as Markdown', () => {
    useInterfaceSettings.setState({ renderUserMarkdown: false })
    render(
      <MessageItem
        message={makeMsg({
          role: 'user',
          parts: [{ type: 'text', text: '- **Goal:** ship' }],
          metadata: { createdAt: new Date(), continuedFrom: { threadId: 't0', title: 'Old' } },
        }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('user-markdown')).toBeInTheDocument()
    expect(screen.getByTestId('render-markdown')).toHaveTextContent('- **Goal:** ship')
  })

  it.each([
    [false, false],
    [true, true],
  ])('a plain user message renders Markdown only with the setting on (%s)', (on, md) => {
    useInterfaceSettings.setState({ renderUserMarkdown: on })
    render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text: 'a **b** c' }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(!!screen.queryByTestId('user-markdown')).toBe(md)
    if (!md) expect(screen.getByText('a **b** c')).toBeInTheDocument()
    useInterfaceSettings.setState({ renderUserMarkdown: false })
  })

  it('renders assistant text via RenderMarkdown', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('render-markdown')).toHaveTextContent('Hello assistant')
  })

  it('shows a fallback reply when the run ended after a tool error with no text', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-bash',
                toolCallId: 'c1',
                state: 'output-error',
                input: {},
                errorText: 'sandbox failed',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('empty-run-fallback')).toHaveTextContent(
      'The run ended without a reply. Last tool error (bash): sandbox failed'
    )
  })

  it('shows no fallback while the run is still streaming', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-bash', toolCallId: 'c1', state: 'output-error', input: {}, errorText: 'x' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )
    expect(screen.queryByTestId('empty-run-fallback')).toBeNull()
  })

  it('shows no fallback on a segment the same reply continues below', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: {}, output: 'ok' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage={false}
        midReply
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('empty-run-fallback')).toBeNull()
  })

  it('judges the no-reply fallback on the whole split reply, not the last round', () => {
    const { rerender } = render(
      <MessageItem
        message={makeMsg({ parts: [] }) as any}
        runParts={[{ type: 'text', text: 'Done, here is the answer.' }] as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('empty-run-fallback')).toBeNull()
    rerender(
      <MessageItem
        message={makeMsg({ parts: [] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('empty-run-fallback')).toBeInTheDocument()
  })

  it('renders user message in a bubble (no markdown renderer)', () => {
    render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text: 'Hi there' }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(screen.queryByTestId('render-markdown')).not.toBeInTheDocument()
  })

  it('renders attached files from user text metadata', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            role: 'user',
            parts: [{ type: 'text', text: '[FILE:doc.txt] Please summarize' }],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByText('doc.txt')).toBeInTheDocument()
    expect(screen.getByText('(inline)')).toBeInTheDocument()
  })

  it('sent file chip previews inline text from metadata, no native tooltip', async () => {
    render(
      <MessageItem
        message={
          makeMsg({
            role: 'user',
            parts: [{ type: 'text', text: '[FILE:doc.txt] Please summarize' }],
            metadata: {
              createdAt: new Date(),
              inline_file_contents: [
                { name: 'doc.txt', content: 'first pasted line\nsecond' },
              ],
            },
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const chip = screen.getByTestId('sent-file-chip')
    expect(chip).not.toHaveAttribute('title')
    expect(chip.querySelector('[title]')).toBeNull()
    fireEvent.click(within(chip).getByRole('button'))
    expect(
      await screen.findByText(/first pasted line/, {}, { timeout: 3000 })
    ).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-open-full')).toBeInTheDocument()
  })

  it('fires onRegenerate when regenerate button clicked (assistant, last)', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    const regenBtn = screen.getByLabelText('chat:actions.regenerate')
    fireEvent.click(regenBtn)
    expect(onRegenerate).toHaveBeenCalledWith('msg-1')
  })

  // C092: after the last reply is deleted the user message is last and had no
  // way to get a new reply.
  it('offers Regenerate on a user message left last with no reply', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg({ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }) as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    fireEvent.click(screen.getByLabelText('chat:actions.regenerate'))
    expect(onRegenerate).toHaveBeenCalledWith('msg-1')
  })

  it('does not render regenerate button when not last message', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage={false}
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    expect(screen.queryByLabelText('chat:actions.regenerate')).not.toBeInTheDocument()
  })

  it('shows Continue button on a stopped last assistant message', () => {
    const onContinue = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ metadata: { createdAt: new Date(), stopped: true } }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onContinue={onContinue}
      />
    )
    const btn = screen.getByLabelText('chat:actions.continue')
    fireEvent.click(btn)
    expect(onContinue).toHaveBeenCalledWith('msg-1')
  })

  it('marks a reply cut at the reply limit, with Continue (L-002)', () => {
    const onContinue = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({
            metadata: { createdAt: new Date(), stopped: true, finishReason: 'length', usage: { outputTokens: 12 } },
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onContinue={onContinue}
      />
    )
    const note = screen.getByTestId('reply-cut-off')
    expect(note).toHaveTextContent('common:replyCutOff.withTokens 12')
    fireEvent.click(within(note).getByRole('button', { name: 'common:continue' }))
    expect(onContinue).toHaveBeenCalledWith('msg-1')
  })

  it('has no cut-off note on a reply that ended normally', () => {
    render(<MessageItem message={makeMsg() as any} isFirstMessage isLastMessage status={'ready' as any} />)
    expect(screen.queryByTestId('reply-cut-off')).toBeNull()
  })

  it('hides Continue button when the turn finished normally', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onContinue={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('chat:actions.continue')).not.toBeInTheDocument()
  })

  it('hides Continue button on a stopped message that is not last', () => {
    render(
      <MessageItem
        message={
          makeMsg({ metadata: { createdAt: new Date(), stopped: true } }) as any
        }
        isFirstMessage
        isLastMessage={false}
        status={'ready' as any}
        onContinue={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('chat:actions.continue')).not.toBeInTheDocument()
  })

  it('fires onEdit when edit dialog saves', () => {
    const onEdit = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'original' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onEdit={onEdit}
      />
    )
    fireEvent.click(screen.getByTestId('edit-btn'))
    expect(onEdit).toHaveBeenCalledWith('msg-1', expect.stringContaining('original'))
  })

  it('fires onDelete when delete dialog button clicked', () => {
    const onDelete = vi.fn()
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'x' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onDelete={onDelete}
      />
    )
    fireEvent.click(screen.getByTestId('delete-btn'))
    expect(onDelete).toHaveBeenCalledWith('msg-1')
  })

  it('hides actions when hideActions is set', () => {
    render(
      <MessageItem
        message={
          makeMsg({ role: 'user', parts: [{ type: 'text', text: 'x' }] }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        hideActions
      />
    )
    expect(screen.queryByTestId('edit-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-btn')).not.toBeInTheDocument()
  })

  it('streaming state hides edit/delete and marks token speed streaming', () => {
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.queryByTestId('edit-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('token-speed').getAttribute('data-streaming')).toBe('true')
  })

  it('renders user image attachment', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'image/png',
                url: 'blob:foo',
                filename: 'pic.png',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const img = screen.getByAltText('pic.png') as HTMLImageElement
    expect(img.src).toContain('blob:foo')
  })

  it('renders a CoT block containing reasoning', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'reasoning', text: 'thinking...' },
              { type: 'text', text: 'final' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('cot')).toBeInTheDocument()
    // Reasoning renders as plain text (not markdown) for performance.
    expect(screen.getByText('thinking...')).toBeInTheDocument()
  })

  it('folds a tool part into the CoT working trace', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'output-available', input: { q: 'x' }, output: 'ok' },
              { type: 'text', text: 'done' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('tool')).toBeInTheDocument()
    expect(screen.getByTestId('tool-header')).toHaveTextContent('search')
    expect(screen.getByTestId('cot')).toBeInTheDocument()
  })

  describe('interim reasoning text', () => {
    const interstitialMsg = () =>
      makeMsg({
        parts: [
          { type: 'reasoning', text: 'first thought' },
          { type: 'text', text: 'interim answer' },
          { type: 'reasoning', text: 'second thought' },
          { type: 'text', text: 'final answer' },
        ],
      }) as any

    it('renders interim text as a normal message and splits the trace', () => {
      render(
        <MessageItem
          message={interstitialMsg()}
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      // Trace splits into two groups around the interim answer.
      expect(screen.getAllByTestId('cot')).toHaveLength(2)
      // Both interim and final render in the message body.
      const bodies = screen.getAllByTestId('render-markdown')
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toHaveTextContent('interim answer')
      expect(bodies[1]).toHaveTextContent('final answer')
    })

    it('skips empty interim text parts', () => {
      render(
        <MessageItem
          message={
            makeMsg({
              parts: [
                { type: 'reasoning', text: 'thinking' },
                { type: 'text', text: '   ' },
                { type: 'text', text: 'final' },
              ],
            }) as any
          }
          isFirstMessage
          isLastMessage
          status={'ready' as any}
        />
      )
      // Blank interim text does not flush the trace into a second group.
      expect(screen.getAllByTestId('cot')).toHaveLength(1)
      const bodies = screen.getAllByTestId('render-markdown')
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toHaveTextContent('final')
    })
  })

  it('renders tool error when state is output-error', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-x',
                state: 'output-error',
                errorText: 'boom',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.getByTestId('tool-output')).toHaveTextContent('boom')
  })

  /// The tool's own card names the call and ticks its duration one row above,
  /// so a status row repeating it was the same thing twice.
  it('leaves an executing tool call to its own card', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'input-available', toolCallId: 'tc1', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a persistent badge for a successfully loaded skill', async () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-skill_read',
                state: 'output-available',
                toolCallId: 'skill-1',
                input: { name: 'pptx' },
                output: 'skill instructions',
              },
              { type: 'text', text: 'Done' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )

    // One line saying how many, and the names in a popover on press.
    const used = screen.getByTestId('skills-used')
    expect(used).toHaveTextContent('common:skillsUsedCount')
    fireEvent.click(used)
    expect(
      within(await screen.findByTestId('skills-used-list')).getByText('pptx')
    ).toBeInTheDocument()
    expect(screen.getByText('Used pptx')).toBeInTheDocument()
  })

  it('defers the persistent skills badge until generation finishes', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-skill_read',
                state: 'output-available',
                toolCallId: 'skill-1',
                input: { name: 'pptx' },
                output: 'skill instructions',
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )

    expect(
      screen.queryByLabelText('common:skillsUsedLabel')
    ).not.toBeInTheDocument()
  })

  it('shows child activity while the parent awaits that subagent', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              {
                type: 'tool-await_subagent',
                state: 'input-available',
                toolCallId: 'tc-await',
                input: { run_id: 'sub-robotics-researcher-1' },
              },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        subagents={[
          {
            runId: 'sub-robotics-researcher-1',
            name: 'robotics-researcher',
            status: 'running',
            startedAt: Date.now() - 1_000,
            turns: [],
          },
        ]}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'robotics-researcher: working'
    )
    expect(screen.getByRole('status')).not.toHaveTextContent('Await subagent')
  })

  it('hides progress while a tool call awaits approval', () => {
    pendingApprovalsRef.current = { tc1: {} }
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-search', state: 'input-available', toolCallId: 'tc1', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  it('keeps an earlier tool part visible while it awaits approval (multi-tool turn)', () => {
    // Two tool calls in one streaming turn; the first is awaiting approval.
    // Streaming truncation must not hide it, or its approve/deny controls
    // never mount and the run hangs.
    pendingApprovalsRef.current = { 'tc-alpha': {} }
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-alpha', state: 'input-available', toolCallId: 'tc-alpha', input: {} },
              { type: 'tool-beta', state: 'input-available', toolCallId: 'tc-beta', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )
    // The pending call is its approval panel (no header); the other keeps its row.
    const alpha = screen
      .getAllByTestId('tool')
      .find((el) => el.getAttribute('data-tool-call') === 'tc-alpha')
    expect(alpha).toBeDefined()
    expect(alpha!.querySelector('[data-testid="approval-panel"]')).not.toBeNull()
    const headers = screen.getAllByTestId('tool-header').map((h) => h.textContent)
    expect(headers).toContain('beta')
  })

  it('streams the full timeline in the verbose view', () => {
    // Condensed truncation is covered in ChainOfThoughtGroup's own tests.
    pendingApprovalsRef.current = {}
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'tool-alpha', state: 'input-available', toolCallId: 'tc-alpha', input: {} },
              { type: 'tool-beta', state: 'input-available', toolCallId: 'tc-beta', input: {} },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'streaming' as any}
      />
    )
    const headers = screen.getAllByTestId('tool-header').map((h) => h.textContent)
    expect(headers).toContain('alpha')
    expect(headers).toContain('beta')
  })

  it('passes full text to copy button', () => {
    render(
      <MessageItem
        message={
          makeMsg({
            parts: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          }) as any
        }
        isFirstMessage
        isLastMessage
        status={'ready' as any}
      />
    )
    const copy = screen.getByTestId('copy-btn')
    expect(copy.getAttribute('data-text')).toBe('a\nb')
  })

  it('does not render regenerate button when no selectedModel', () => {
    selectedModelRef.current = null
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={makeMsg() as any}
        isFirstMessage
        isLastMessage
        status={'ready' as any}
        onRegenerate={onRegenerate}
      />
    )
    expect(screen.queryByLabelText('chat:actions.regenerate')).not.toBeInTheDocument()
  })
  describe('message time after a conversation switch', () => {
    const timeSpan = (container: HTMLElement) =>
      container.querySelector('span.tabular-nums[title]') as HTMLElement | null
    const renderUser = (metadata: Record<string, unknown>) =>
      render(
        <MessageItem
          message={
            makeMsg({ role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata }) as any
          }
          isFirstMessage
          isLastMessage={false}
          status={'ready' as any}
        />
      )

    it('shows the stored time whatever shape it came back in', () => {
      const at = new Date(2020, 0, 2, 3, 4).getTime()
      const shown = [new Date(at), at, new Date(at).toISOString()].map((createdAt) => {
        const { container, unmount } = renderUser({ createdAt })
        const text = timeSpan(container)?.textContent
        const title = timeSpan(container)?.title
        unmount()
        return [text, title]
      })
      expect(shown[0][0]).toBeTruthy()
      expect(shown[1]).toEqual(shown[0])
      expect(shown[2]).toEqual(shown[0])
      // An old message reads as a date, never as today's clock.
      expect(shown[0][0]).not.toMatch(/^\d\d:\d\d$/)
    })

    it('shows no time rather than the current one when none was stored', () => {
      const { container } = renderUser({})
      expect(timeSpan(container)).toBeNull()
    })
  })
})
