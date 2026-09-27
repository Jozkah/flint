import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { count?: number }) =>
      o?.count !== undefined ? `${key}:${o.count}` : key,
  }),
}))

const pending: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: (selector: (s: unknown) => unknown) =>
    selector({ pending: pending.current }),
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <span>{children}</span>,
}))

vi.mock('@/components/ai-elements/tool', () => ({
  Tool: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tool">{children}</div>
  ),
  ToolContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToolHeader: ({ title }: { title: string }) => (
    <div data-testid="tool-header">{title}</div>
  ),
  ToolInput: () => null,
  ToolOutput: () => null,
  ToolApprovalActions: () => <div data-testid="approval-actions" />,
}))

import { ChainOfThoughtGroup } from '../ChainOfThoughtGroup'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { partitionTrace, type TranscriptView } from '@/lib/transcriptView'

const PARTS = [
  { type: 'reasoning', text: 'Plan the change carefully.' },
  { type: 'tool-read', state: 'output-available', toolCallId: 'a', input: {}, output: 'ok' },
  { type: 'tool-grep', state: 'output-available', toolCallId: 'b', input: {}, output: 'ok' },
  { type: 'tool-bash', state: 'output-error', toolCallId: 'c', input: {}, errorText: 'boom' },
  { type: 'tool-write', state: 'input-available', toolCallId: 'd', input: {} },
]

const renderAs = (view: TranscriptView) => {
  useInterfaceSettings.setState({ transcriptView: view })
  return render(
    <ChainOfThoughtGroup
      entries={PARTS.map((part, index) => ({ part, index }))}
      messageId="m1"
      totalParts={PARTS.length + 1}
      isStreaming={false}
      hasFollowingContent={false}
      awaitingApproval={Boolean(pending.current.d)}
      citationOffsets={new Map()}
    />
  )
}

const headers = () => screen.queryAllByTestId('tool-header').map((h) => h.textContent)

beforeEach(() => {
  pending.current = { d: { toolName: 'write' } }
  useToolCallRuntime.getState().reset()
})

describe('partitionTrace', () => {
  const entries = PARTS.map((part, index) => ({ part, index }))
  const isPending = (id: string) => id === 'd'

  it('normal drops reasoning and pins only calls awaiting approval', () => {
    const out = partitionTrace('normal', entries, isPending)
    expect(out.reasoning).toEqual([])
    expect(out.pinned.map((e) => e.part.toolCallId)).toEqual(['d'])
    expect(out.steps.map((e) => e.part.toolCallId)).toEqual(['a', 'b', 'c'])
  })

  it('thinking keeps reasoning and folds the same tools', () => {
    const out = partitionTrace('thinking', entries, isPending)
    expect(out.reasoning).toHaveLength(1)
    expect(out.pinned.map((e) => e.part.toolCallId)).toEqual(['c', 'd'])
    expect(out.steps).toHaveLength(2)
  })
})

describe('Transcript view', () => {
  it('normal: no reasoning, approval visible, every other call behind N steps', () => {
    renderAs('normal')
    expect(screen.queryByText('Plan the change carefully.')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('approval-actions').length).toBeGreaterThan(0)
    expect(headers()).toEqual([])
    const toggle = screen.getByTestId('transcript-steps-toggle')
    expect(toggle).toHaveTextContent('chat:transcriptView.steps:3')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(headers()).toEqual(['read', 'grep', 'bash'])
  })

  it('thinking: reasoning shown, tools still folded, approval visible', () => {
    renderAs('thinking')
    expect(screen.getByText('Plan the change carefully.')).toBeInTheDocument()
    expect(screen.getAllByTestId('approval-actions').length).toBeGreaterThan(0)
    // The failed call is a row of its own.
    expect(headers()).toEqual(['bash'])
    expect(screen.getByTestId('transcript-steps-toggle')).toBeInTheDocument()
  })

  it('verbose: reasoning and every tool call, no disclosure', () => {
    renderAs('verbose')
    expect(screen.getByText('Plan the change carefully.')).toBeInTheDocument()
    expect(screen.getAllByTestId('approval-actions').length).toBeGreaterThan(0)
    expect(headers()).toEqual(['read', 'grep', 'bash'])
    expect(screen.queryByTestId('transcript-steps-toggle')).not.toBeInTheDocument()
  })

  it.each(['normal', 'thinking', 'verbose'] as const)(
    '%s: a pending approval is always on screen',
    (view) => {
      renderAs(view)
      for (const el of screen.getAllByTestId('approval-actions')) expect(el).toBeVisible()
    }
  )
})
