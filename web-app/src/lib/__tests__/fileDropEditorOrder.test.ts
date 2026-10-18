// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { transferFilePaths } from '@/lib/fileDrop'

/**
 * Simulates a Linux file-manager paste into the real composer editor
 * (Tiptap/ProseMirror), which is what no Windows machine can do natively.
 * ProseMirror listens on its own element, so it handles the event before any
 * bubbling handler; only a capture-phase preventDefault keeps the URI out.
 */
const GNOME_PASTE = {
  'text/plain': 'x-special/nautilus-clipboard\ncopy\nfile:///home/me/evil%20corp.png\n',
  'text/uri-list': 'file:///home/me/evil%20corp.png\r\n',
}

function pasteEvent(data: Record<string, string>): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { types: Object.keys(data), getData: (t: string) => data[t] ?? '', files: [], items: [] },
  })
  return event
}

let editor: Editor | null = null
let host: HTMLElement | null = null

function mount(capture?: (e: Event) => void) {
  host = document.createElement('div')
  document.body.appendChild(host)
  if (capture) host.addEventListener('paste', capture, true)
  editor = new Editor({ element: host, extensions: [StarterKit] })
  return editor
}

afterEach(() => {
  editor?.destroy()
  host?.remove()
  editor = null
  host = null
})

describe('composer editor and a Linux file paste', () => {
  it('inserts the raw file URI text when nothing intercepts it (the bug)', () => {
    const ed = mount()
    ed.view.dom.dispatchEvent(pasteEvent(GNOME_PASTE))
    expect(ed.getText()).toContain('file:///home/me/evil%20corp.png')
  })

  it('a capture-phase handler using transferFilePaths keeps it out and gets the path', () => {
    const seen: string[][] = []
    const ed = mount((e) => {
      const paths = transferFilePaths((e as ClipboardEvent).clipboardData)
      if (!paths) return
      e.preventDefault()
      seen.push(paths)
    })
    ed.view.dom.dispatchEvent(pasteEvent(GNOME_PASTE))
    expect(ed.getText()).toBe('')
    expect(seen).toEqual([['/home/me/evil corp.png']])
  })

  it('a bubbling handler is too late: the editor already inserted the text', () => {
    const ed = mount()
    host!.addEventListener('paste', (e) => e.preventDefault())
    ed.view.dom.dispatchEvent(pasteEvent(GNOME_PASTE))
    expect(ed.getText()).toContain('file:///')
  })
})
