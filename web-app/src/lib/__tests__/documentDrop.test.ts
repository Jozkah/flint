import { afterEach, describe, expect, it } from 'vitest'
import { shouldBlockDocumentDrop } from '../documentDrop'

/** A DragEvent-shaped drop whose dataTransfer carries `data` by MIME type. */
function drop(target: EventTarget, data: Record<string, string>, files = 0) {
  const types = files > 0 ? ['Files', ...Object.keys(data)] : Object.keys(data)
  const dataTransfer = {
    types,
    files: { length: files },
    getData: (t: string) => data[t] ?? '',
  } as unknown as DataTransfer
  return { target, dataTransfer } as unknown as DragEvent
}

describe('shouldBlockDocumentDrop', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('lets a URL dropped onto a contenteditable composer through', () => {
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    const inner = document.createElement('p')
    host.appendChild(inner)
    document.body.appendChild(host)
    const url = 'https://example.com/a'
    expect(
      shouldBlockDocumentDrop(
        drop(inner, { 'text/uri-list': url, 'text/plain': url })
      )
    ).toBe(false)
  })

  it('lets plain text dropped onto a textarea through', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(shouldBlockDocumentDrop(drop(ta, { 'text/plain': 'hi' }))).toBe(false)
  })

  it('blocks files anywhere, even over an editable field', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(shouldBlockDocumentDrop(drop(ta, {}, 1))).toBe(true)
    expect(shouldBlockDocumentDrop(drop(document.body, {}, 1))).toBe(true)
  })

  it('blocks a Linux file-manager uri-list drop (no Files type)', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(
      shouldBlockDocumentDrop(
        drop(ta, { 'text/uri-list': 'file:///home/u/a.txt' })
      )
    ).toBe(true)
  })

  it('blocks a link dropped on non-editable page area (no navigation)', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(
      shouldBlockDocumentDrop(drop(div, { 'text/uri-list': 'https://x.y' }))
    ).toBe(true)
  })
})
