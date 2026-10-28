import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { MemoryRecordRow } from '../MemoryRecordRow'
import { MemoryPager } from '../MemoryPager'

const memory = {
  id: 'mem-1',
  scope: 'user',
  content: 'I like tea',
  preview: 'I like tea',
  pinned: false,
  status: 'active',
  origin: 'explicit',
  creator: 'user',
  useCount: 3,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 2,
  redacted: false,
  sourceSessionId: null,
  sourceRunId: null,
  sourceProjectId: null,
  uses: [],
  history: [],
} as never

describe('MemoryRecordRow', () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const cb = { onTogglePin: vi.fn(), onEdit: vi.fn(), onForget: vi.fn() }
    render(
      <ul>
        <MemoryRecordRow memory={memory} busy={false} {...cb} {...(over as object)} />
      </ul>
    )
    return cb
  }

  it('shows the text, pinned flag and provenance details', () => {
    setup()
    const row = screen.getByTestId('memory-row')
    expect(row.getAttribute('data-memory-id')).toBe('mem-1')
    expect(row.getAttribute('data-pinned')).toBe('false')
    expect(screen.getAllByText('I like tea').length).toBeGreaterThan(0)
    expect(screen.getByTestId('memory-provenance-version')).toBeTruthy()
    expect(screen.getByTestId('memory-provenance-uses')).toBeTruthy()
  })

  it('hands the record to pin, edit and forget', async () => {
    const cb = setup()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    await userEvent.click(buttons[0])
    await userEvent.click(buttons[1])
    await userEvent.click(buttons[2])
    expect(cb.onTogglePin).toHaveBeenCalledWith(memory)
    expect(cb.onEdit).toHaveBeenCalledWith(memory)
    expect(cb.onForget).toHaveBeenCalledWith(memory)
  })

  it('disables the actions while busy', () => {
    setup({ busy: true })
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('MemoryPager', () => {
  it('moves by page size and stops at the ends', async () => {
    const onOffsetChange = vi.fn()
    const { rerender } = render(
      <MemoryPager offset={0} total={120} pageSize={50} onOffsetChange={onOffsetChange} />
    )
    const [prev, next] = screen.getAllByRole('button')
    expect((prev as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(next)
    expect(onOffsetChange).toHaveBeenCalledWith(50)
    rerender(<MemoryPager offset={100} total={120} pageSize={50} onOffsetChange={onOffsetChange} />)
    const [prev2, next2] = screen.getAllByRole('button')
    expect((next2 as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(prev2)
    expect(onOffsetChange).toHaveBeenLastCalledWith(50)
  })
})
