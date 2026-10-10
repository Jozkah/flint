import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/toastUndo', () => ({ showUndoToast: vi.fn() }))

import { showUndoToast } from '@/lib/toastUndo'
import { undoableDeleteMany, usePendingDeletes } from '../undoableAction'

describe('undoableDeleteMany', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePendingDeletes.setState({ ids: {} })
    vi.mocked(showUndoToast).mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('hides every id at once, runs once after the window, then unhides', async () => {
    const run = vi.fn()
    undoableDeleteMany({ ids: ['a', 'b'], message: 'm', undoLabel: 'u', run, delayMs: 100 })
    expect(Object.keys(usePendingDeletes.getState().ids)).toEqual(['a', 'b'])
    expect(showUndoToast).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(run).toHaveBeenCalledWith(['a', 'b'])
    expect(usePendingDeletes.getState().ids).toEqual({})
  })

  it('undo cancels the delete and shows everything again', async () => {
    const run = vi.fn()
    undoableDeleteMany({ ids: ['a', 'b'], message: 'm', undoLabel: 'u', run, delayMs: 100 })
    vi.mocked(showUndoToast).mock.calls[0][0].onUndo()
    await vi.advanceTimersByTimeAsync(150)
    expect(run).not.toHaveBeenCalled()
    expect(usePendingDeletes.getState().ids).toEqual({})
  })

  it('does nothing for an empty selection', () => {
    undoableDeleteMany({ ids: [], message: 'm', undoLabel: 'u', run: vi.fn() })
    expect(showUndoToast).not.toHaveBeenCalled()
  })
})
