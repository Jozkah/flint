import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import {
  CoworkSubagentTranscript,
  TRANSCRIPT_BLOCK_CHARS,
  keyArgs,
} from '../CoworkSubagentTranscript'
import type { ActivityTask } from '@/lib/coworkActivity'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key} ${Object.entries(opts)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`
        : key,
  }),
}))

const task = (over: Partial<ActivityTask> = {}): ActivityTask => ({
  id: 't1',
  callId: 'c1',
  sessionId: 's',
  workflowId: 'w',
  kind: 'agent',
  title: 'explorer',
  status: 'done',
  startedAt: 0,
  endedAt: 1000,
  ...over,
})

describe('CoworkSubagentTranscript', () => {
  it('says so when the subagent has produced nothing', () => {
    render(<CoworkSubagentTranscript task={task({ status: 'running', endedAt: undefined })} />)
    expect(screen.getByText('common:tasks.starting')).toBeInTheDocument()
  })

  it('shows the brief, what it said, and each tool call collapsed', () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          description: 'find the config loader',
          transcript: [
            { role: 'assistant', content: 'searching now' },
            {
              role: 'tool',
              name: 'grep',
              content: '',
              args: { pattern: 'loadConfig' },
              result: 'src/config.ts:12',
              toolState: 'succeeded',
            },
          ],
        })}
      />
    )
    expect(screen.getByTestId('transcript-brief')).toHaveTextContent('find the config loader')
    expect(screen.getByText('searching now')).toBeInTheDocument()
    const call = screen.getByRole('button', { name: /step.searched/ })
    expect(call).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/loadConfig/)).toBeInTheDocument()
    // The result is not in the page until the call is opened.
    expect(screen.queryByTestId('transcript-tool-result')).toBeNull()
  })

  it('opens a call with Enter and shows its arguments and result', async () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          transcript: [
            {
              role: 'tool',
              name: 'read',
              content: '',
              args: { path: 'a.ts' },
              result: 'file body',
            },
          ],
        })}
      />
    )
    const call = screen.getByRole('button', { name: /step.read/ })
    call.focus()
    await userEvent.keyboard('{Enter}')
    expect(call).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('transcript-tool-args')).toHaveTextContent('a.ts')
    expect(screen.getByTestId('transcript-tool-result')).toHaveTextContent('file body')
  })

  it('bounds a huge tool result and offers Show more', async () => {
    const huge = 'x'.repeat(TRANSCRIPT_BLOCK_CHARS * 10)
    render(
      <CoworkSubagentTranscript
        task={task({
          transcript: [{ role: 'tool', name: 'bash', content: '', args: { command: 'ls' }, result: huge }],
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /step.ran/ }))
    const result = screen.getByTestId('transcript-tool-result')
    expect(result.textContent!.length).toBe(TRANSCRIPT_BLOCK_CHARS)
    await userEvent.click(screen.getByRole('button', { name: /showMore/ }))
    expect(screen.getByTestId('transcript-tool-result').textContent!.length).toBe(huge.length)
    await userEvent.click(screen.getByRole('button', { name: /showLess/ }))
    expect(screen.getByTestId('transcript-tool-result').textContent!.length).toBe(
      TRANSCRIPT_BLOCK_CHARS
    )
  })

  it('redacts secrets in everything it draws', async () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          description: 'use sk-abcdefghijklmnopqrstuvwxyz123456 to call',
          transcript: [
            {
              role: 'tool',
              name: 'bash',
              content: '',
              args: { command: 'echo' },
              result: 'token sk-abcdefghijklmnopqrstuvwxyz123456',
            },
          ],
        })}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /step.ran/ }))
    expect(document.body.textContent).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('updates live as turns arrive', () => {
    const running = task({ status: 'running', endedAt: undefined, transcript: [] })
    const { rerender } = render(<CoworkSubagentTranscript task={running} />)
    expect(screen.queryByTestId('transcript-assistant')).toBeNull()
    rerender(
      <CoworkSubagentTranscript
        task={{ ...running, transcript: [{ role: 'assistant', content: 'first thought' }] }}
      />
    )
    expect(screen.getByText('first thought')).toBeInTheDocument()
  })

  it('shows the per-tool breakdown with failures', () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          transcript: [
            { role: 'tool', name: 'read', content: '', toolState: 'succeeded' },
            { role: 'tool', name: 'read', content: '', toolState: 'failed' },
            { role: 'tool', name: 'grep', content: '', toolState: 'succeeded' },
          ],
        })}
      />
    )
    const chips = screen.getByTestId('subagent-tools')
    expect(chips).toHaveTextContent('toolChipFailed name=read count=2 failed=1')
    expect(chips).toHaveTextContent('toolChip name=grep count=1')
    expect(screen.getByTestId('subagent-tools-status')).toHaveTextContent('stepsFailed count=1')
    expect(chips.querySelector('[data-tool=read]')).toHaveAttribute('data-failed', 'true')
  })

  it('shows the final result with the truncation note, or the failure', () => {
    const { rerender } = render(
      <CoworkSubagentTranscript task={task({ output: 'the answer', resultCapped: true })} />
    )
    expect(screen.getByTestId('transcript-final')).toHaveTextContent('the answer')
    expect(screen.getByTestId('transcript-capped')).toHaveTextContent('common:tasks.resultCapped')
    rerender(<CoworkSubagentTranscript task={task({ status: 'error', output: 'boom' })} />)
    expect(screen.getByTestId('transcript-final')).toHaveTextContent('transcriptFailed error=boom')
    expect(screen.queryByTestId('transcript-capped')).toBeNull()
  })

  it('leaves the final result to its host when asked', () => {
    render(<CoworkSubagentTranscript task={task({ output: 'the answer' })} showFinal={false} />)
    expect(screen.queryByTestId('transcript-final')).toBeNull()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<CoworkSubagentTranscript task={task()} onClose={onClose} />)
    fireEvent.keyDown(screen.getByTestId('subagent-transcript'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pauses following when the reader scrolls up', () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          status: 'running',
          endedAt: undefined,
          transcript: [{ role: 'assistant', content: 'a' }],
        })}
      />
    )
    const scroller = screen.getByLabelText('common:tasks.transcript')
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(screen.getByText('common:tasks.followPaused')).toBeInTheDocument()
  })
})

describe('keyArgs', () => {
  it('picks the argument that says what the call did, and shortens a long one', () => {
    expect(keyArgs({ path: 'a.ts', other: 1 })).toBe('a.ts')
    expect(keyArgs({ command: 'x'.repeat(200) })).toHaveLength(81)
    expect(keyArgs(null)).toBe('')
    expect(keyArgs({ nothing: true })).toBe('')
  })
})

describe('CoworkSubagentTranscript as a conversation', () => {
  it('shows a queued row as waiting, with its position, and no zero stats', () => {
    render(<CoworkSubagentTranscript task={task({ status: 'queued', endedAt: undefined, waiting: 2 })} />)
    expect(screen.getByTestId('transcript-empty')).toHaveTextContent('waitingPosition position=2')
    expect(screen.queryByTestId('transcript-stats')).toBeNull()
  })

  it('collapses the brief behind Show brief', async () => {
    render(<CoworkSubagentTranscript task={task({ description: 'look around' })} />)
    expect(screen.getByTestId('transcript-brief').className).toContain('line-clamp-2')
    await userEvent.click(screen.getByRole('button', { name: 'common:tasks.showBrief' }))
    expect(screen.getByTestId('transcript-brief').className).not.toContain('line-clamp-2')
  })

  it('groups consecutive reads and expands them', async () => {
    render(
      <CoworkSubagentTranscript
        task={task({
          transcript: [
            { role: 'tool', name: 'read', content: '', args: { path: 'a/one.ts' }, toolState: 'succeeded' },
            { role: 'tool', name: 'read', content: '', args: { path: 'a/two.ts' }, toolState: 'succeeded' },
            { role: 'tool', name: 'read', content: '', args: { path: 'a/three.ts' }, toolState: 'succeeded' },
          ],
        })}
      />
    )
    const group = screen.getByTestId('transcript-group')
    expect(group).toHaveTextContent('groupRead count=3')
    expect(screen.queryAllByTestId('transcript-step')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: /groupRead/ }))
    expect(screen.getAllByTestId('transcript-step')).toHaveLength(3)
  })

  it('keeps the filename visible and the whole path in a tooltip', () => {
    const path = 'internal/radar/some/very/deep/folder/structure/client.go'
    render(
      <CoworkSubagentTranscript
        task={task({ transcript: [{ role: 'tool', name: 'read', content: '', args: { path }, toolState: 'succeeded' }] })}
      />
    )
    const el = screen.getByTestId('middle-ellipsis')
    expect(el).toHaveAttribute('title', path)
    expect(el.textContent).toBe(path)
    expect(el.lastElementChild!.textContent).toMatch(/client\.go$/)
  })

  it('marks a failed step', () => {
    render(
      <CoworkSubagentTranscript
        task={task({ transcript: [{ role: 'tool', name: 'bash', content: '', args: { command: 'npm test' }, toolState: 'failed' }] })}
      />
    )
    expect(screen.getByTestId('transcript-step')).toHaveAttribute('data-state', 'failed')
  })
})
