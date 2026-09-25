import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const named = options?.tool ?? options?.server
      return named ? `${key}:${named}` : key
    },
  }),
}))

const approvalState: {
  pending: Record<string, unknown>
  allowedOnceCommands: Record<string, string[]>
} = { pending: {}, allowedOnceCommands: {} }
const resolveApproval = vi.fn()
vi.mock('@/hooks/useToolApprovalRequests', async () => {
  const { repeatCommandKey } = await import('@/lib/repeatedCommand')
  return {
    wasCommandAllowedOnce: (
      s: { allowedOnceCommands: Record<string, string[]> },
      threadId: string,
      toolName: string,
      input: unknown
    ) => {
      const key = repeatCommandKey(toolName, input)
      return key !== null && !!s.allowedOnceCommands[threadId]?.includes(key)
    },
    useToolApprovalRequests: (selector: (s: unknown) => unknown) =>
      selector({ ...approvalState, resolveApproval }),
    usePendingApprovalCount: (threadId?: string) =>
      Object.values(approvalState.pending).filter(
        (e) => (e as { threadId?: string }).threadId === threadId
      ).length,
  }
})

vi.mock('../code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => (
    <pre data-testid="code-block">{code}</pre>
  ),
}))

vi.mock('@/containers/CopyButton', () => ({
  CopyButton: ({ text }: { text: string }) => (
    <button data-testid="copy" data-text={text} />
  ),
}))

import {
  Tool,
  ToolApprovalActions,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '../tool'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'

const resolver = (input: string) => Promise.resolve(input)

// The approval mock is module state; leaving a pending entry behind would make
// every later header render as awaiting approval.
beforeEach(() => {
  approvalState.pending = {}
  approvalState.allowedOnceCommands = {}
  resolveApproval.mockClear()
})

const renderHeader = (props: Partial<React.ComponentProps<typeof ToolHeader>> = {}) =>
  render(
    <Tool state="output-available" toolCallId="tc1" messageId="m1">
      <ToolHeader
        title="read_file"
        type="tool-read_file"
        state="output-available"
        {...props}
      />
    </Tool>
  )

const renderApproval = (pending: Record<string, unknown>) => {
  approvalState.pending = pending
  return render(
    <Tool state="input-available" toolCallId="tc1" messageId="m1" defaultOpen>
      <ToolApprovalActions />
    </Tool>
  )
}

describe('ToolApprovalActions', () => {
  beforeEach(() => {
    resolveApproval.mockClear()
    approvalState.pending = {}
  })

  it('renders nothing when no approval is pending', () => {
    renderApproval({})
    expect(
      screen.queryByText('permissions:scope.deny')
    ).not.toBeInTheDocument()
  })

  // Trusting a server tool-by-tool is the same decision repeated, so "always"
  // offers the server rather than the single tool.
  it('offers to trust the whole server by name', () => {
    renderApproval({
      tc1: {
        toolCallId: 'tc1',
        toolName: 'create_issue',
        serverName: 'github',
        threadId: 't1',
      },
    })
    expect(
      screen.getByText('permissions:scope.allowAlwaysServer:github')
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/permissions:scope.allowAlwaysTool/)
    ).not.toBeInTheDocument()
  })

  // AH-146: the change is on screen before anyone allows it.
  it('shows the change a file-changing call would make, before it is allowed', () => {
    renderApproval({
      tc1: {
        toolCallId: 'tc1',
        toolName: 'write',
        preview: '@@ overwrote file @@\n+    1 | hello',
      },
    })
    const shown = screen.getByTestId('approval-preview')
    expect(shown).toHaveTextContent('hello')
    expect(shown).toHaveAttribute(
      'aria-label',
      'tools:toolApproval.proposedChange'
    )
  })

  // A bash command the user already allowed once here comes back: the card
  // says so and fills and focuses "Allow in this conversation". It does not
  // answer the request itself.
  it('marks a repeated command and prefers allowing it for the conversation', () => {
    approvalState.allowedOnceCommands = { t1: ['bash\u0000ls -la'] }
    renderApproval({
      tc1: {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        input: { command: '  ls -la\n' },
      },
    })
    expect(screen.getByTestId('approval-repeat-notice')).toHaveTextContent(
      'permissions:repeat.allowedOnceBefore'
    )
    const thread = screen
      .getByText('permissions:scope.allowThread')
      .closest('button')!
    const once = screen.getByText('permissions:scope.allowOnce').closest('button')!
    expect(thread).toHaveAttribute('data-primary', 'true')
    expect(once).not.toHaveAttribute('data-primary')
    expect(thread).toHaveFocus()
    expect(resolveApproval).not.toHaveBeenCalled()
  })

  it('does not mark a different command, or the same one in another thread', () => {
    approvalState.allowedOnceCommands = { t1: ['bash\u0000ls -la'], t2: ['bash\u0000rm x'] }
    renderApproval({
      tc1: {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        input: { command: 'rm x' },
      },
    })
    expect(screen.queryByTestId('approval-repeat-notice')).not.toBeInTheDocument()
    expect(
      screen.getByText('permissions:scope.allowOnce').closest('button')
    ).toHaveAttribute('data-primary', 'true')
    expect(screen.getByText('permissions:scope.deny').closest('button')).toHaveFocus()
  })

  it('shows no diff for a call that has none', () => {
    renderApproval({ tc1: { toolCallId: 'tc1', toolName: 'bash' } })
    expect(screen.queryByTestId('approval-preview')).not.toBeInTheDocument()
  })

  it('falls back to the tool name when it has no server', () => {
    renderApproval({
      tc1: { toolCallId: 'tc1', toolName: 'do_thing', threadId: 't1' },
    })
    expect(
      screen.getByText('permissions:scope.allowAlwaysTool:do_thing')
    ).toBeInTheDocument()
  })

  it('grants each scope the reader picked', () => {
    renderApproval({
      tc1: {
        toolCallId: 'tc1',
        toolName: 'create_issue',
        serverName: 'github',
        threadId: 't1',
      },
    })
    fireEvent.click(screen.getByText('permissions:scope.allowOnce'))
    fireEvent.click(screen.getByText('permissions:scope.allowThread'))
    fireEvent.click(
      screen.getByText('permissions:scope.allowAlwaysServer:github')
    )
    fireEvent.click(screen.getByText('permissions:scope.deny'))
    expect(resolveApproval.mock.calls.map((c) => c[1])).toEqual([
      'allow-once',
      'allow-thread',
      'allow-always',
      'deny',
    ])
  })

  // A reflexive Enter must never widen a permission.
  it('starts focus on Deny, not on the broadest grant', () => {
    renderApproval({
      tc1: { toolCallId: 'tc1', toolName: 'bash', threadId: 't1' },
    })
    expect(document.activeElement).toHaveTextContent('permissions:scope.deny')
  })

  it('describes the call from its input and marks the broader scope', () => {
    renderApproval({
      tc1: {
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        input: { command: 'npm test' },
      },
    })
    expect(screen.getByText('permissions:action.runCommand')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('permissions:scope.broader')).toBeInTheDocument()
  })

  it('announces how many requests wait in the thread, once', () => {
    renderApproval({
      tc1: { toolCallId: 'tc1', toolName: 'bash', threadId: 't1' },
      tc2: { toolCallId: 'tc2', toolName: 'write', threadId: 't1' },
      tc3: { toolCallId: 'tc3', toolName: 'write', threadId: 't2' },
    })
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('permissions:pending.many')
  })
})

describe('ToolOutput refusal explanation', () => {
  it('explains a refusal with its next step', () => {
    renderOutput({
      output: undefined,
      errorText: "tool 'bash' is denied by policy",
    })
    const note = screen.getByTestId('permission-outcome')
    expect(note).toHaveTextContent('permissions:outcome.policy')
    expect(note).toHaveTextContent('permissions:outcome.policyNext')
  })

  it('adds nothing to an ordinary error', () => {
    renderOutput({ output: undefined, errorText: 'boom' })
    expect(screen.queryByTestId('permission-outcome')).not.toBeInTheDocument()
  })
})

describe('ToolHeader runtime state', () => {
  beforeEach(() => {
    useToolCallRuntime.getState().reset()
  })

  // A queued call and a running one are both `input-available`, so without the
  // queue the header claims every pending call is already running.
  it('says a call is queued until the executor reaches it', () => {
    useToolCallRuntime.getState().enqueue(['tc1'])
    renderHeader({ state: 'input-available' })
    expect(screen.getByText(/tools:toolCall.queued/)).toBeInTheDocument()
    expect(screen.queryByText(/tools:toolCall.running/)).not.toBeInTheDocument()
  })

  it('counts the calls waiting ahead of it', () => {
    useToolCallRuntime.getState().enqueue(['a', 'b', 'tc1'])
    renderHeader({ state: 'input-available' })
    expect(screen.getByText('tools:toolCall.queuedPosition')).toBeInTheDocument()
  })

  it('omits the position for the call that runs next', () => {
    useToolCallRuntime.getState().enqueue(['tc1', 'b'])
    renderHeader({ state: 'input-available' })
    expect(
      screen.queryByText('tools:toolCall.queuedPosition')
    ).not.toBeInTheDocument()
  })

  it('switches to running once the executor starts it', () => {
    useToolCallRuntime.getState().enqueue(['tc1'])
    useToolCallRuntime.getState().markRunning('tc1')
    renderHeader({ state: 'input-available' })
    expect(screen.getByText(/tools:toolCall.running/)).toBeInTheDocument()
  })

  it('shows how long a finished call took', () => {
    const runtime = useToolCallRuntime.getState()
    runtime.enqueue(['tc1'])
    runtime.markRunning('tc1')
    vi.setSystemTime(Date.now() + 5000)
    runtime.markSettled('tc1')
    renderHeader({ state: 'output-available' })
    expect(screen.getByText('common:duration.seconds')).toBeInTheDocument()
  })
})

describe('ToolHeader', () => {
  it('shows where the call came from', () => {
    renderHeader({ origin: 'filesystem' })
    expect(screen.getByText('filesystem')).toBeInTheDocument()
  })

  it('previews the arguments inline', () => {
    renderHeader({ input: { path: 'src/app.ts' } })
    expect(screen.getByText('path: src/app.ts')).toBeInTheDocument()
  })

  it('previews arguments that are still mid-stream', () => {
    renderHeader({ input: { path: 'src/ap' } })
    expect(screen.getByText('path: src/ap')).toBeInTheDocument()
  })

  it('renders no preview when there are no arguments', () => {
    renderHeader({ input: {} })
    expect(screen.getByText(/tools:toolCall.used/)).toBeInTheDocument()
  })
})

const renderInput = (input: unknown) =>
  render(
    <Tool state="input-available" toolCallId="tc1" messageId="m1" defaultOpen>
      <ToolContent>
        <ToolInput input={input} />
      </ToolContent>
    </Tool>
  )

describe('ToolInput', () => {
  it('renders object arguments as key/value rows', () => {
    renderInput({ path: 'src/app.ts', limit: 5 })
    expect(screen.getByText('path')).toBeInTheDocument()
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  it('toggles to raw JSON and back', () => {
    renderInput({ path: 'src/app.ts' })
    fireEvent.click(screen.getByText('tools:toolCall.viewRaw'))
    expect(screen.getByTestId('code-block')).toHaveTextContent('"path"')
    fireEvent.click(screen.getByText('tools:toolCall.viewTable'))
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  it('copies the pretty-printed arguments', () => {
    renderInput({ path: 'a.ts' })
    expect(screen.getByTestId('copy')).toHaveAttribute(
      'data-text',
      '{\n  "path": "a.ts"\n}'
    )
  })

  it('falls back to the raw block for non-object arguments', () => {
    renderInput('not json at all')
    expect(screen.getByTestId('code-block')).toHaveTextContent('not json at all')
    expect(screen.queryByText('tools:toolCall.viewRaw')).not.toBeInTheDocument()
  })
})

const renderOutput = (
  props: Partial<React.ComponentProps<typeof ToolOutput>> = {}
) =>
  render(
    <Tool state="output-available" toolCallId="tc1" messageId="m1" defaultOpen>
      <ToolContent>
        <ToolOutput
          output="short result"
          errorText={undefined}
          resolver={resolver}
          {...props}
        />
      </ToolContent>
    </Tool>
  )

describe('ToolOutput', () => {
  it('offers no expand control for a short payload', () => {
    renderOutput()
    expect(screen.queryByText('tools:toolCall.showMore')).not.toBeInTheDocument()
  })

  it('expands and collapses a long payload', () => {
    renderOutput({ output: 'x'.repeat(2000) })
    fireEvent.click(screen.getByText('tools:toolCall.viewRaw'))
    fireEvent.click(screen.getByText('tools:toolCall.showMore'))
    expect(screen.getByText('tools:toolCall.showLess')).toBeInTheDocument()
    fireEvent.click(screen.getByText('tools:toolCall.showLess'))
    expect(screen.getByText('tools:toolCall.showMore')).toBeInTheDocument()
  })

  // Native web search / RAG results render as citation cards, which live
  // outside the scroll box, so an expand toggle would be inert.
  it('offers no expand control for citation output', () => {
    renderOutput({
      output: {
        kind: 'web',
        query: 'q',
        results: Array.from({ length: 12 }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: `Result ${i}`,
          text: 'x'.repeat(120),
        })),
      },
    })
    expect(screen.queryByText('tools:toolCall.showMore')).not.toBeInTheDocument()
  })

  it('leads with a summary and hides the raw payload', () => {
    renderOutput({
      output: { content: [{ type: 'text', text: 'first line\nrest' }] },
    })
    expect(screen.getByText('tools:toolCall.summaryText')).toBeInTheDocument()
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  it('reveals the raw payload on demand', () => {
    renderOutput({
      output: { content: [{ type: 'text', text: 'first line' }] },
    })
    fireEvent.click(screen.getByText('tools:toolCall.viewRaw'))
    expect(screen.getByTestId('code-block')).toBeInTheDocument()
    fireEvent.click(screen.getByText('tools:toolCall.hideRaw'))
    expect(screen.queryByTestId('code-block')).not.toBeInTheDocument()
  })

  // Expanding is meaningless while the payload is summarised away.
  it('offers expansion only once the raw payload is shown', () => {
    renderOutput({ output: 'x'.repeat(2000) })
    expect(screen.queryByText('tools:toolCall.showMore')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('tools:toolCall.viewRaw'))
    expect(screen.getByText('tools:toolCall.showMore')).toBeInTheDocument()
  })

  it('copies the error text when the call failed', () => {
    renderOutput({ output: undefined, errorText: 'boom' })
    expect(screen.getByTestId('copy')).toHaveAttribute('data-text', 'boom')
  })

  it('renders nothing without output or error', () => {
    const { container } = render(
      <Tool state="input-available" toolCallId="tc1" messageId="m1" defaultOpen>
        <ToolContent>
          <ToolOutput
            output={undefined}
            errorText={undefined}
            resolver={resolver}
          />
        </ToolContent>
      </Tool>
    )
    expect(container).not.toHaveTextContent('tools:toolCall.result')
  })
})
