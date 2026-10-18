import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useDialogOpen } from '../useDialogOpen'

const added: HTMLElement[] = []
const mount = (html: string, parent: HTMLElement = document.body) => {
  const el = document.createElement('div')
  el.innerHTML = html
  const node = el.firstElementChild as HTMLElement
  parent.appendChild(node)
  added.push(node)
  return node
}

afterEach(() => {
  added.splice(0).forEach((n) => n.remove())
  vi.restoreAllMocks()
})

describe('useDialogOpen', () => {
  it('ignores an open popover (Radix PopoverContent is role=dialog too)', async () => {
    mount('<div role="dialog" data-state="open" data-slot="popover-content"></div>')
    const { result } = renderHook(() => useDialogOpen())
    expect(result.current).toBe(false)
    mount('<div role="dialog" data-state="open"></div>')
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current).toBe(false)
  })

  it('is true while a modal dialog, sheet, drawer or alert dialog is open', async () => {
    const { result } = renderHook(() => useDialogOpen())
    expect(result.current).toBe(false)
    const dlg = mount(
      '<div role="dialog" data-slot="dialog-content" data-state="open"></div>'
    )
    await waitFor(() => expect(result.current).toBe(true))
    dlg.setAttribute('data-state', 'closed')
    await waitFor(() => expect(result.current).toBe(false))
    for (const html of [
      '<div role="dialog" data-slot="sheet-content" data-state="open"></div>',
      '<div role="dialog" data-slot="drawer-content" data-state="open"></div>',
      '<div role="alertdialog" data-state="open"></div>',
    ]) {
      const n = mount(html)
      await waitFor(() => expect(result.current).toBe(true))
      n.remove()
      await waitFor(() => expect(result.current).toBe(false))
    }
  })

  it('does not scan the document for mutations deep in the page', async () => {
    const host = mount('<div id="stream"></div>')
    const { result } = renderHook(() => useDialogOpen())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    const spy = vi.spyOn(document, 'querySelector')
    await act(async () => {
      for (let i = 0; i < 20; i++) host.appendChild(document.createTextNode('x'))
      host.appendChild(document.createElement('span'))
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.current).toBe(false)
  })

  it('disconnects its observers on unmount', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const { unmount } = renderHook(() => useDialogOpen())
    unmount()
    expect(disconnect.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
