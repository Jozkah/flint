import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePrompt } from '@/hooks/usePrompt'
import { useComposerDraft } from '../useComposerDraft'

// The composer draft as ChatInput kept it inline: the main draft or a split
// pane's own, switched per chat, and a restored draft taken back out when the
// composer leaves while it is still untouched.
const base = {
  draftScope: undefined as string | undefined,
  scopeKey: undefined as string | undefined,
  threadIdProp: 't1' as string | undefined,
  routeThreadId: undefined as string | undefined,
}

describe('useComposerDraft', () => {
  beforeEach(() => {
    usePrompt.setState({ prompt: '', scoped: {} } as never)
  })

  it('edits the main draft without a scope, and a pane its own with one', () => {
    const { result: main } = renderHook(() => useComposerDraft(base))
    act(() => main.current.setPrompt('hello'))
    expect(usePrompt.getState().prompt).toBe('hello')
    expect(main.current.prompt).toBe('hello')

    const { result: pane } = renderHook(() =>
      useComposerDraft({ ...base, draftScope: 'pane-2' })
    )
    expect(pane.current.prompt).toBe('')
    act(() => pane.current.setPrompt('other'))
    expect(usePrompt.getState().prompt).toBe('hello')
    expect(pane.current.prompt).toBe('other')
  })

  it('switches the main draft to the chat shown, never a scoped one', () => {
    const switchDraft = vi.fn()
    usePrompt.setState({ switchDraft } as never)
    const { rerender } = renderHook((p) => useComposerDraft(p), { initialProps: base })
    expect(switchDraft).toHaveBeenLastCalledWith('t1')
    rerender({ ...base, threadIdProp: 't2' })
    expect(switchDraft).toHaveBeenLastCalledWith('t2')
    switchDraft.mockClear()
    renderHook(() => useComposerDraft({ ...base, draftScope: 'pane-2' }))
    expect(switchDraft).not.toHaveBeenCalled()
  })

  it('routes history to the main or the scoped draft', () => {
    const navigateHistory = vi.fn()
    const navigateScopedHistory = vi.fn()
    usePrompt.setState({ navigateHistory, navigateScopedHistory } as never)
    const { result: main } = renderHook(() => useComposerDraft(base))
    main.current.navigateHistory('up')
    expect(navigateHistory).toHaveBeenCalledWith('up')
    const { result: pane } = renderHook(() =>
      useComposerDraft({ ...base, draftScope: 'pane-2' })
    )
    pane.current.navigateHistory('down')
    expect(navigateScopedHistory).toHaveBeenCalledWith('pane-2', 'down')
  })

  it('takes back an untouched restored draft when the composer goes', () => {
    const { result, unmount } = renderHook(() => useComposerDraft(base))
    act(() => result.current.setPrompt('restored'))
    result.current.restoredDraftRef.current = 'restored'
    unmount()
    expect(usePrompt.getState().prompt).toBe('')
  })

  it('keeps a restored draft the user has since edited', () => {
    const { result, rerender, unmount } = renderHook(() => useComposerDraft(base))
    act(() => result.current.setPrompt('restored'))
    result.current.restoredDraftRef.current = 'restored'
    act(() => result.current.setPrompt('restored, edited'))
    rerender()
    unmount()
    expect(usePrompt.getState().prompt).toBe('restored, edited')
  })
})
