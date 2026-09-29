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
  const { planGitTool } = await import('@/lib/gitTool')
  return {
    canTemporarilyAllowGit: (
      toolName: string,
      input: unknown,
      threadIsEphemeral = false
    ) => {
      if (threadIsEphemeral || toolName !== 'git') return false
      const planned = planGitTool(input)
      return (
        planned.ok &&
        planned.plan.class === 'remote' &&
        planned.plan.destructive === undefined
      )
    },
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
    fireEvent.click(screen.getByTestId('approval-more-options'))
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

  // A bash command the user already allowed once here comes back: the panel
  // says so, opens the broader options and marks "Allow in this
  // conversation". "Allow once" stays the filled answer and nothing is chosen.
  it('marks a repeated command and suggests allowing it for the conversation', () => {
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
    expect(thread).toHaveAttribute('data-suggested', 'true')
    expect(thread).not.toHaveAttribute('data-primary')
    expect(once).toHaveAttribute('data-primary', 'true')
    expect(screen.getByText('permissions:scope.deny').closest('button')).toHaveFocus()
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
    expect(screen.queryByTestId('approval-scope-menu')).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByTestId('approval-more-options'))
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
    fireEvent.click(screen.getByTestId('approval-more-options'))
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

  it('offers temporary all-git approval for a non-destructive remote git call', () => {
    renderApproval({
      tc1: {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'git',
        threadId: 't1',
        alwaysAsk: true,
        input: { args: ['push', 'origin', 'main'] },
      },
    })
    fireEvent.click(screen.getByTestId('approval-more-options'))
    const temporary = screen
      .getByText('permissions:scope.allowGitTemporary')
      .closest('button')!
    expect(temporary).toHaveAttribute('data-scope', 'allow-git-temporary')
    expect(screen.getByText('permissions:scope.allowGitTemporaryExplanation')).toBeInTheDocument()
    fireEvent.click(temporary)
    expect(resolveApproval).toHaveBeenCalledWith(
      'tc1',
      'allow-git-temporary',
      'r1'
    )
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
    expect(screen.getByTestId('approval-subject')).toHaveTextContent('npm test')
    fireEvent.click(screen.getByTestId('approval-more-options'))
    expect(screen.getByText('permissions:scope.broader')).toBeInTheDocument()
  })

  // Style B: one panel naming the tool, the full command and the decision.
  it('renders the pending request as one action panel', () => {
    const long = 'git push -u origin feature/x && gh pr create --fill --title "a very long title"'
    renderApproval({
      tc1: {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        workspaceLabel: '/work/acme-weather',
        input: { command: long },
      },
    })
    const panel = screen.getByTestId('inline-approval-card')
    expect(panel).toHaveAttribute('data-approval-request', 'r1')
    expect(panel).toHaveAccessibleName('permissions:action.runCommandIn')
    expect(screen.getByText('tools:toolApproval.approvalNeeded')).toBeInTheDocument()
    expect(screen.getByTestId('approval-tool')).toHaveTextContent('bash')
    // The command in full, never the truncated resource.
    expect(screen.getByTestId('approval-subject').textContent).toBe(long)
    expect(screen.getByText('permissions:request.consequences')).toBeInTheDocument()
    // Nothing nested: no inner tool card or approval card border.
    expect(panel.querySelector('[data-slot="tool-card"]')).toBeNull()
  })

  it('keeps Allow once primary and lists broader scopes, explained and unchosen', () => {
    renderApproval({
      tc1: { requestId: 'r1', toolCallId: 'tc1', toolName: 'bash', threadId: 't1' },
    })
    const once = screen.getByText('permissions:scope.allowOnce').closest('button')!
    expect(once).toHaveAttribute('data-primary', 'true')
    expect(screen.queryByTestId('approval-scope-menu')).not.toBeInTheDocument()
    const more = screen.getByTestId('approval-more-options')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByTestId('approval-scope-menu')
    const scopes = Array.from(menu.querySelectorAll('button')).map((b) =>
      b.getAttribute('data-scope')
    )
    expect(scopes).toEqual(['allow-thread', 'allow-always'])
    for (const button of Array.from(menu.querySelectorAll('button'))) {
      expect(button).not.toHaveAttribute('data-primary')
      expect(button).not.toHaveAttribute('data-suggested')
      const describedBy = button.getAttribute('aria-describedby')!
      expect(document.getElementById(describedBy)?.textContent).toMatch(
        /permissions:scope\.(thread|alwaysTool)Explanation/
      )
    }
    expect(resolveApproval).not.toHaveBeenCalled()
  })

  it('shows permission details on request', () => {
    renderApproval({
      tc1: {
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        input: { command: 'ls' },
      },
    })
    expect(screen.queryByText('permissions:request.technicalDetails')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('approval-details-toggle'))
    expect(screen.getByText('permissions:request.technicalDetails')).toBeInTheDocument()
  })

  it('keeps More options visible even when only this request can be allowed', () => {
    renderApproval({
      tc1: { toolCallId: 'tc1', toolName: 'bash', threadId: 't1', alwaysAsk: true },
    })
    const more = screen.getByTestId('approval-more-options')
    expect(more).toBeInTheDocument()
    fireEvent.click(more)
    expect(screen.getByTestId('approval-no-broader-options')).toHaveTextContent(
      'permissions:scope.noBroaderOptions'
    )
    fireEvent.click(screen.getByText('permissions:scope.allowOnce'))
    expect(resolveApproval).toHaveBeenCalledWith('tc1', 'allow-once', undefined)
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