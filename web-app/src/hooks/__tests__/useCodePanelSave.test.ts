import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

import { toast } from 'sonner'
import { useCodePanelSave } from '../useCodePanelSave'
import { useCodeBuffers, useCoworkUserEdits } from '@/hooks/useCoworkUserEdits'
import {
  emptyCodePanelState,
  projectKeyOf,
  projectTab,
  tabId,
} from '@/lib/coworkCode'
import type { Buffers, EditTarget } from '@/lib/coworkCodeEdit'

const SESSION = 's1'
const KEY = projectKeyOf('/root') as string
const TAB = projectTab('a.ts', KEY)
const ID = tabId(TAB)
const TARGET: EditTarget = { kind: 'real', path: '/root/a.ts', grant: 'g' }
const t = (k: string) => k

const bufferOf = () => useCodeBuffers.getState().bySession[SESSION]?.[ID]
const setBuffers = (next: (c: Buffers) => Buffers) =>
  useCodeBuffers.getState().update(SESSION, next)
const seed = (base: string, text: string) =>
  setBuffers((c) => ({ ...c, [ID]: { base, text } }))

function setup(over: Partial<Parameters<typeof useCodePanelSave>[0]> = {}) {
  const saveFile = vi.fn(async () => ({ ok: true as const, diff: '' }))
  const recheckDisk = vi.fn(async () => 'disk')
  const onStateChange = vi.fn()
  const onSaved = vi.fn()
  const hook = renderHook(
    (props: Partial<Parameters<typeof useCodePanelSave>[0]>) =>
      useCodePanelSave({
        active: TAB,
        activeId: ID,
        sessionKey: SESSION,
        editTarget: TARGET,
        editable: true,
        readyContent: undefined,
        diskEol: '\n',
        buffers: useCodeBuffers.getState().bySession[SESSION] ?? {},
        setBuffers,
        recheckDisk,
        saveFile,
        onSaved,
        onStateChange,
        t,
        ...over,
        ...props,
      }),
    { initialProps: {} }
  )
  return { hook, saveFile, recheckDisk, onStateChange, onSaved }
}

beforeEach(() => {
  useCodeBuffers.setState({ bySession: {} })
  useCoworkUserEdits.setState({ bySession: {} })
  vi.clearAllMocks()
})

describe('useCodePanelSave', () => {
  it('seeds an empty buffer from the bytes read', () => {
    setup({ readyContent: 'hello' })
    expect(bufferOf()).toEqual({ base: 'hello', text: 'hello' })
  })

  it('raises a conflict when new bytes arrive under a dirty buffer', () => {
    seed('old', 'typed')
    const { hook } = setup({ readyContent: 'new' })
    expect(hook.result.current.conflict).toEqual({
      id: ID,
      disk: 'new',
      fromSave: false,
    })
    expect(bufferOf()).toEqual({ base: 'old', text: 'typed' })
  })

  it('save writes the buffer and records the edit when the disk is unchanged', async () => {
    seed('disk', 'edited')
    const { hook, saveFile, onSaved } = setup()
    let ok: boolean | undefined
    await act(async () => {
      ok = await hook.result.current.save()
    })
    expect(ok).toBe(true)
    expect(saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, content: 'edited' })
    )
    expect(bufferOf()).toEqual({ base: 'edited', text: 'edited' })
    expect(onSaved).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('common:codePanel.saved')
    expect(useCoworkUserEdits.getState().bySession[SESSION]?.edits).toHaveLength(1)
  })

  it('save stops at a conflict when the disk moved, and Overwrite completes it', async () => {
    seed('old', 'edited')
    const { hook, saveFile } = setup()
    await act(async () => {
      expect(await hook.result.current.save()).toBe(false)
    })
    expect(saveFile).not.toHaveBeenCalled()
    expect(hook.result.current.conflict).toEqual({
      id: ID,
      disk: 'disk',
      fromSave: true,
    })
    hook.rerender({ buffers: useCodeBuffers.getState().bySession[SESSION] })
    await act(async () => {
      await hook.result.current.resolveConflict('overwrite')
    })
    expect(saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'edited' })
    )
    expect(hook.result.current.conflict).toBeNull()
  })

  it('resolveConflict reload takes the disk; keep rebases the typed text', async () => {
    seed('old', 'typed')
    const { hook } = setup({ readyContent: 'new' })
    act(() => {
      void hook.result.current.resolveConflict('keep')
    })
    expect(bufferOf()).toEqual({ base: 'new', text: 'typed' })
    expect(hook.result.current.conflict).toBeNull()

    seed('older', 'typed2')
    hook.rerender({ readyContent: 'newer' })
    act(() => {
      void hook.result.current.resolveConflict('reload')
    })
    expect(bufferOf()).toEqual({ base: 'newer', text: 'newer' })
  })

  it('a failed save keeps the buffer and reports the error', async () => {
    seed('disk', 'edited')
    const saveFile = vi.fn(async () => ({ ok: false as const, error: 'nope' }))
    const { hook } = setup({ saveFile })
    await act(async () => {
      await hook.result.current.save()
    })
    expect(hook.result.current.saveError).toBe('nope')
    expect(bufferOf()).toEqual({ base: 'disk', text: 'edited' })
  })

  it('discard returns the buffer to its base and clears the error', () => {
    seed('base', 'typed')
    const { hook } = setup()
    act(() => hook.result.current.discard())
    expect(bufferOf()?.text).toBe('base')
  })

  it('requestClose closes clean tabs at once and asks for dirty ones', async () => {
    const next = emptyCodePanelState()
    const { hook, onStateChange } = setup()
    act(() => hook.result.current.requestClose([ID], next))
    expect(onStateChange).toHaveBeenCalledWith(next)

    onStateChange.mockClear()
    seed('a', 'b')
    hook.rerender({ buffers: useCodeBuffers.getState().bySession[SESSION] })
    act(() => hook.result.current.requestClose([ID], next))
    expect(onStateChange).not.toHaveBeenCalled()
    expect(hook.result.current.pendingClose).toEqual({ ids: [ID], next })

    await act(async () => {
      await hook.result.current.confirmClose('discard')
    })
    expect(onStateChange).toHaveBeenCalledWith(next)
    expect(bufferOf()).toBeUndefined()
    expect(hook.result.current.pendingClose).toBeNull()
  })

  it('confirmClose cancel keeps the tabs and the buffer', async () => {
    seed('a', 'b')
    const { hook, onStateChange } = setup()
    act(() =>
      hook.result.current.requestClose([ID], emptyCodePanelState())
    )
    await act(async () => {
      await hook.result.current.confirmClose('cancel')
    })
    expect(onStateChange).not.toHaveBeenCalled()
    expect(bufferOf()).toEqual({ base: 'a', text: 'b' })
  })
})
