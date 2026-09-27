import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.tool ? `${key}:${options.tool}` : key,
  }),
}))

const approvalState: { pending: Record<string, unknown> } = { pending: {} }
const resolveApproval = vi.fn()
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  wasCommandAllowedOnce: () => false,
  useToolApprovalRequests: (selector: (s: unknown) => unknown) =>
    selector({ ...approvalState, allowedOnceCommands: {}, resolveApproval }),
  usePendingApprovalCount: (threadId?: string) =>
    Object.values(approvalState.pending).filter(
      (e) => (e as { threadId?: string }).threadId === threadId
    ).length,
}))

const originOf = vi.hoisted(() => ({ current: { kind: 'agent' } as unknown }))
vi.mock('@/hooks/useToolOrigin', () => ({
  useToolOrigin: () => originOf.current,
}))

import { ToolCallCard } from '../ToolCallCard'
import { StepRow, TIMELINE_RAIL } from '@/components/ai-elements/reasoning-timeline'
import type { MessagePartLike } from '../types'

const bashPart = (over: Partial<MessagePartLike>): MessagePartLike =>
  ({
    type: 'tool-bash',
    toolCallId: 'tc1',
    input: { command: 'git push -u origin main && gh pr create --fill' },
    ...over,
  }) as MessagePartLike

const onTimeline = (part: MessagePartLike) =>
  render(
    <ol className={TIMELINE_RAIL}>
      <StepRow>
        <ToolCallCard part={part} messageId="m1" />
      </StepRow>
    </ol>
  )

beforeEach(() => {
  originOf.current = { kind: 'agent' }
  approvalState.pending = {}
  resolveApproval.mockClear()
})

describe('ToolCallCard on the timeline (Style B)', () => {
  it('pending: one action panel, no tool header or nested card', () => {
    approvalState.pending = {
      tc1: {
        requestId: 'r1',
        toolCallId: 'tc1',
        toolName: 'bash',
        threadId: 't1',
        workspaceLabel: '/w/acme-weather',
        input: { command: 'git push -u origin main && gh pr create --fill' },
      },
    }
    const { container } = onTimeline(bashPart({ state: 'input-available' }))
    const cards = container.querySelectorAll('[data-slot="tool-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveClass('tool-action-panel')
    expect(cards[0]).toHaveAttribute('data-tool-kind', 'appr')
    expect(container.querySelector('[data-slot="tool-header"]')).toBeNull()
    expect(screen.getByTestId('approval-subject')).toHaveTextContent(
      'git push -u origin main && gh pr create --fill'
    )
    // A new request is announced and takes focus on its safe answer.
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('permissions:scope.deny').closest('button')).toHaveFocus()
    fireEvent.click(screen.getByText('permissions:scope.allowOnce'))
    expect(resolveApproval).toHaveBeenCalledWith('tc1', 'allow-once', 'r1')
  })

  it('a subagent request under the same id does not turn the card into a panel', () => {
    approvalState.pending = {
      tc1: { toolCallId: 'tc1', toolName: 'bash', threadId: 't1', origin: 'child' },
    }
    const { container } = onTimeline(bashPart({ state: 'input-available' }))
    expect(container.querySelector('.tool-action-panel')).toBeNull()
    expect(screen.queryByTestId('inline-approval-card')).toBeNull()
  })

  it('approved and running: a compact row, no approval panel', () => {
    const { container } = onTimeline(bashPart({ state: 'input-available' }))
    expect(container.querySelector('.tool-action-panel')).toBeNull()
    expect(screen.getByText('tools:toolCall.running:bash')).toBeInTheDocument()
  })

  it('completed: a compact "Used" row that still expands for details', () => {
    const { container } = onTimeline(
      bashPart({ state: 'output-available', output: 'ok\n[exit 0]' })
    )
    const card = container.querySelector('[data-slot="tool-card"]')!
    expect(card).not.toHaveClass('tool-action-panel')
    expect(card).toHaveAttribute('data-state', 'closed')
    const header = container.querySelector('[data-slot="tool-header"]')!
    expect(header).toHaveTextContent('tools:toolCall.used:bash')
    fireEvent.click(header)
    expect(card).toHaveAttribute('data-state', 'open')
    expect(container.querySelector('[data-slot="tool-content"]')).not.toBeNull()
  })

  it('a compact row expands to the same full details as before', () => {
    const { container } = onTimeline(
      bashPart({ state: 'output-available', output: 'hello\n[exit 0]' })
    )
    const header = container.querySelector('[data-slot="tool-header"]')!
    expect(header.tagName).toBe('BUTTON')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('tools:toolCall.parameters')).toBeNull()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    // Parameters table with its Table/Raw switch, then the result section.
    expect(screen.getByText('tools:toolCall.parameters')).toBeInTheDocument()
    expect(screen.getByText('tools:toolCall.viewRaw')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="tool-result"]')).not.toBeNull()
    expect(screen.getByText('tools:toolCall.result')).toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('failed: reads and colours as a failure', () => {
    const { container } = onTimeline(
      bashPart({ state: 'output-error', errorText: 'boom' })
    )
    expect(container.querySelector('[data-slot="tool-card"]')).toHaveAttribute(
      'data-tool-kind',
      'fail'
    )
    expect(screen.getByText('tools:toolCall.failed:bash')).toBeInTheDocument()
  })

  it('denied: reads as failed, with no approval controls left', () => {
    const { container } = onTimeline(
      bashPart({ state: 'output-denied' as MessagePartLike['state'] })
    )
    expect(container.querySelector('[data-slot="tool-card"]')).toHaveAttribute(
      'data-tool-kind',
      'fail'
    )
    expect(screen.getByText('tools:toolCall.failed:bash')).toBeInTheDocument()
    expect(screen.queryByText('permissions:scope.deny')).toBeNull()
  })
  // Every renderer opens into the same thin outline, never a nested card.
  it.each([
    ['read', { kind: 'agent' }, { path: 'a.go' }, 'package a'],
    ['edit', { kind: 'agent' }, { path: 'a.go', old: 'x', new: 'y' }, 'ok'],
    ['write', { kind: 'agent' }, { path: 'b.go', content: 'x' }, 'ok'],
    ['grep', { kind: 'agent' }, { pattern: 'retry' }, 'a.go:1: retry'],
    ['ls', { kind: 'agent' }, { path: '.' }, 'a.go'],
    ['bash', { kind: 'agent' }, { command: 'ls' }, 'a.go\n[exit 0]'],
    ['todo_write', { kind: 'agent' }, { todos: [] }, 'ok'],
    ['web_search', { kind: 'web-search', detail: 'Exa' }, { query: 'q' }, 'r'],
    ['web_fetch', { kind: 'web-fetch' }, { url: 'https://example.com' }, 'r'],
    ['create_issue', { kind: 'mcp', detail: 'github' }, { title: 'Bug' }, 'done'],
    ['task', undefined, { prompt: 'sub' }, 'done'],
  ])('%s expands into the shared thin outline', (name, origin, input, output) => {
    originOf.current = origin
    const { container } = onTimeline({
      type: `tool-${name}`,
      toolCallId: `tc-${name}`,
      state: 'output-available',
      input,
      output,
    } as MessagePartLike)
    const header = container.querySelector('[data-slot="tool-header"]')!
    if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header)
    const cards = container.querySelectorAll('[data-slot="tool-card"]')
    expect(cards).toHaveLength(1)
    const content = cards[0].querySelector(':scope > [data-slot="tool-content"]')!
    expect(content).toHaveClass('tool-expanded')
    expect(content).toHaveAttribute('data-expanded-style', 'thin')
  })
})
