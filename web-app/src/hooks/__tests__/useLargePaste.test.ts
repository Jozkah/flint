import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const { showUndoToast, dismiss } = vi.hoisted(() => ({
  showUndoToast: vi.fn(() => 'toast-1'),
  dismiss: vi.fn(),
}))
vi.mock('@/lib/toastUndo', () => ({ showUndoToast }))
vi.mock('sonner', () => ({ toast: { dismiss } }))

import { useLargePaste, resetLargePasteAnnouncement } from '../useLargePaste'

const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')

function pasteEvent(opts: { text?: string; types?: string[] } = {}) {
  const items = (opts.types ?? []).map((type) => ({
    kind: type.startsWith('image/') ? 'file' : 'string',
    type,
  }))
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      items,
      files: (opts.types ?? []).some((t) => t.startsWith('image/'))
        ? [new File(['x'], 'a.png', { type: 'image/png' })]
        : [],
      getData: (type: string) => (type === 'text/plain' ? (opts.text ?? '') : ''),
    } as unknown as DataTransfer,
  }
}

function setup(over: Partial<Parameters<typeof useLargePaste>[0]> = {}) {
  const attach = vi.fn().mockResolvedValue(undefined)
  const insertText = vi.fn()
  const detach = vi.fn()
  const hook = renderHook(() =>
    useLargePaste({
      enabled: true,
      attachedNames: [],
      attach,
      insertText,
      detach,
      t: (k: string) => k,
      ...over,
    })
  )
  return { ...hook, attach, insertText, detach }
}

// File.text() settles on a later task in jsdom.
const flush = () => new Promise((r) => setTimeout(r, 50))

describe('useLargePaste', () => {
  beforeEach(() => {
    showUndoToast.mockClear()
    dismiss.mockClear()
    resetLargePasteAnnouncement()
  })

  it('attaches an over-threshold paste as one .txt file and inserts no text', async () => {
    const { result, attach, insertText } = setup()
    const event = pasteEvent({ text: big, types: ['text/plain'] })
    expect(result.current.handlePaste(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    await flush()
    expect(attach).toHaveBeenCalledTimes(1)
    const file = attach.mock.calls[0][0] as File
    expect(file.name).toBe('pasted-text-1.txt')
    expect(file.type).toBe('text/plain')
    expect(await file.text()).toBe(big)
    expect(insertText).not.toHaveBeenCalled()
  })

  it('attaches a paste over the character limit even on one line', async () => {
    const { result, attach } = setup()
    expect(
      result.current.handlePaste(pasteEvent({ text: 'x'.repeat(8001) }))
    ).toBe(true)
    await flush()
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('numbers the file after those already attached', async () => {
    const { result, attach } = setup({
      attachedNames: ['pasted-text-1.txt', 'notes.md'],
    })
    result.current.handlePaste(pasteEvent({ text: big }))
    await flush()
    expect((attach.mock.calls[0][0] as File).name).toBe('pasted-text-2.txt')
  })

  it('leaves a small paste to the editor', async () => {
    const { result, attach } = setup()
    const event = pasteEvent({ text: 'hello\nworld' })
    expect(result.current.handlePaste(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    await flush()
    expect(attach).not.toHaveBeenCalled()
  })

  it('leaves image pastes alone even with large text alongside', () => {
    const { result, attach } = setup()
    const event = pasteEvent({ text: big, types: ['text/plain', 'image/png'] })
    expect(result.current.handlePaste(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('pastes raw text after Ctrl+Shift+V, once', async () => {
    const { result, attach } = setup()
    result.current.noteKeyDown({
      key: 'V',
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    })
    const raw = pasteEvent({ text: big })
    expect(result.current.handlePaste(raw)).toBe(false)
    expect(raw.preventDefault).not.toHaveBeenCalled()
    // The next ordinary paste is converted again.
    expect(result.current.handlePaste(pasteEvent({ text: big }))).toBe(true)
    await flush()
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('does nothing when attachments are off', () => {
    const { result } = setup({ enabled: false })
    expect(result.current.handlePaste(pasteEvent({ text: big }))).toBe(false)
  })

  it('inserts the text when the pipeline would refuse it', async () => {
    const { result, attach, insertText } = setup()
    const binaryish = `${'a\n'.repeat(30)}\u0000`
    expect(result.current.handlePaste(pasteEvent({ text: binaryish }))).toBe(true)
    await flush()
    expect(attach).not.toHaveBeenCalled()
    expect(insertText).toHaveBeenCalledWith(binaryish)
  })

  it('toasts once per session and Undo swaps the file for the text', async () => {
    const { result, detach, insertText } = setup()
    result.current.handlePaste(pasteEvent({ text: big }))
    await flush()
    expect(showUndoToast).toHaveBeenCalledTimes(1)
    // Shown at the top: at the bottom it covered the composer it is about.
    expect((showUndoToast.mock.calls[0] as unknown as [{ position?: string }])[0].position).toBe('top-center')
    result.current.handlePaste(pasteEvent({ text: big }))
    await flush()
    expect(showUndoToast).toHaveBeenCalledTimes(1)

    showUndoToast.mock.calls[0][0].onUndo()
    expect(detach).toHaveBeenCalledWith('pasted-text-1.txt')
    expect(insertText).toHaveBeenCalledWith(big)
  })

  it('takes its toast away when the composer goes', async () => {
    const { result, unmount } = setup()
    result.current.handlePaste(pasteEvent({ text: big }))
    await flush()
    unmount()
    expect(dismiss).toHaveBeenCalledWith('toast-1')
  })
})
