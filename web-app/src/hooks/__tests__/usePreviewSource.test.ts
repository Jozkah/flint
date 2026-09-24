import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (path: string, scheme: string) =>
    `${scheme}://localhost/${path}`,
}))

import {
  choosePreviewSource,
  previewProtocolAvailable,
  usePreviewSource,
} from '../usePreviewSource'

const DOC = '<!doctype html><html><body><script>1</script></body></html>'

type TauriWindow = { __TAURI_INTERNALS__?: unknown }

describe('choosePreviewSource', () => {
  it('falls back to srcdoc where the protocol is unavailable', () => {
    expect(
      choosePreviewSource(DOC, { protocol: false, id: 'abc', failed: false })
    ).toEqual({ srcDoc: DOC })
  })

  it('uses the protocol URL once the document is registered', () => {
    expect(
      choosePreviewSource(DOC, { protocol: true, id: 'abc', failed: false })
    ).toEqual({ src: 'flintpreview://localhost/abc' })
  })

  it('stays blank while registering instead of showing a script-dead srcdoc', () => {
    expect(
      choosePreviewSource(DOC, { protocol: true, id: null, failed: false })
    ).toEqual({ src: 'about:blank' })
  })

  it('falls back to srcdoc when registration failed', () => {
    expect(
      choosePreviewSource(DOC, { protocol: true, id: null, failed: true })
    ).toEqual({ srcDoc: DOC })
  })
})

describe('usePreviewSource', () => {
  beforeEach(() => {
    invoke.mockReset()
  })
  afterEach(() => {
    delete (window as unknown as TauriWindow).__TAURI_INTERNALS__
  })

  it('uses srcdoc and never invokes outside the desktop app', () => {
    expect(previewProtocolAvailable()).toBe(false)
    const { result } = renderHook(() => usePreviewSource(DOC, false, true))
    expect(result.current).toEqual({ srcDoc: DOC })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('registers the document, loads it by URL, and releases it on replace and unmount', async () => {
    ;(window as unknown as TauriWindow).__TAURI_INTERNALS__ = {}
    let n = 0
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'preview_register' ? `id${++n}` : undefined)
    )
    const { result, rerender, unmount } = renderHook(
      ({ doc }) => usePreviewSource(doc, false, true),
      { initialProps: { doc: DOC } }
    )
    await waitFor(() =>
      expect(result.current).toEqual({ src: 'flintpreview://localhost/id1' })
    )
    expect(invoke).toHaveBeenCalledWith('preview_register', {
      html: DOC,
      allowNetwork: false,
      allowScripts: true,
    })

    rerender({ doc: DOC + '<!-- v2 -->' })
    expect(invoke).toHaveBeenCalledWith('preview_release', { id: 'id1' })
    await waitFor(() =>
      expect(result.current).toEqual({ src: 'flintpreview://localhost/id2' })
    )

    unmount()
    expect(invoke).toHaveBeenCalledWith('preview_release', { id: 'id2' })
  })

  it('falls back to srcdoc when the register command fails', async () => {
    ;(window as unknown as TauriWindow).__TAURI_INTERNALS__ = {}
    invoke.mockRejectedValue(new Error('no command'))
    const { result } = renderHook(() => usePreviewSource(DOC, false, true))
    await waitFor(() => expect(result.current).toEqual({ srcDoc: DOC }))
  })
})
