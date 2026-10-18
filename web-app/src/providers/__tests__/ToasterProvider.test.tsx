import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

const props: Record<string, unknown>[] = []
vi.mock('@/components/ui/sonner', () => ({
  Toaster: (p: Record<string, unknown>) => {
    props.push(p)
    return null
  },
}))
vi.mock('@/lib/settingsRecoveryNotice', () => ({
  notifyToasterMounted: vi.fn(),
}))
let phone = false
let pathname = '/'
vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (l: { pathname: string }) => string }) => select({ pathname }),
}))
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => phone }))

import { ToasterProvider } from '../ToasterProvider'

const last = () => props[props.length - 1]

async function openModal(role: string, slot?: string) {
  const dlg = document.createElement('div')
  dlg.setAttribute('role', role)
  if (slot) dlg.setAttribute('data-slot', slot)
  dlg.setAttribute('data-state', 'open')
  await act(async () => {
    document.body.appendChild(dlg)
    await new Promise((r) => setTimeout(r, 40))
  })
  return dlg
}

describe('ToasterProvider with a modal open', () => {
  beforeEach(() => {
    props.length = 0
    phone = false
    document.body.innerHTML = ''
  })

  it('never puts toasts at the top: bottom-right, at most 3, above the composer', () => {
    render(<ToasterProvider />)
    expect(last().position).toBe('bottom-right')
    expect(last().visibleToasts).toBe(3)
    expect(String((last().offset as { bottom: string }).bottom)).toMatch(
      /164px.*safe-area-inset-bottom/
    )
  })

  it('uses bottom-center on phones', () => {
    phone = true
    render(<ToasterProvider />)
    expect(last().position).toBe('bottom-center')
  })

  it('moves toasts to the bottom edge while a dialog is open, then back', async () => {
    render(<ToasterProvider />)
    expect(String(last().position)).toMatch(/^bottom-/)
    const dlg = await openModal('dialog', 'dialog-content')
    await waitFor(() => expect(String(last().position)).toMatch(/^bottom-/))
    await act(async () => {
      dlg.setAttribute('data-state', 'closed')
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(String(last().position)).toBe('bottom-right')
  })

  it('leaves toasts alone while a popover (role=dialog too) is open', async () => {
    render(<ToasterProvider />)
    await openModal('dialog', 'popover-content')
    expect(String(last().position)).toBe('bottom-right')
  })

  it('treats an alertdialog the same', async () => {
    render(<ToasterProvider />)
    await openModal('alertdialog')
    await waitFor(() => expect(String(last().position)).toMatch(/^bottom-/))
  })
})
