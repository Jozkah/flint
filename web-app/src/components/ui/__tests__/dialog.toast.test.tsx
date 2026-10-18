import { describe, it, expect, vi } from 'vitest'

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ignoreToastPresses } from '@/lib/toastInteractOutside'

// Radix arms its outside-press listener on the next tick.
const armed = () => new Promise((r) => setTimeout(r, 20))

function Host({ own }: { own?: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <ol data-sonner-toaster>
        <li data-testid="toast">
          <button type="button">close toast</button>
        </li>
      </ol>
      <p data-testid="elsewhere">elsewhere</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onInteractOutside={own}>
          <DialogTitle>Edit</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SheetHost() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <ol data-sonner-toaster>
        <li>
          <button type="button">close toast</button>
        </li>
      </ol>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetTitle>Panel</SheetTitle>
        </SheetContent>
      </Sheet>
    </>
  )
}

describe('a press on a toast does not close the modal under it', () => {
  it('keeps a dialog open when a toast is pressed', async () => {
    render(<Host />)
    await armed()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByText('close toast'))
    fireEvent.click(screen.getByText('close toast'))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('still closes a dialog on a press anywhere else outside it', async () => {
    render(<Host />)
    await armed()
    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps a sheet open when a toast is pressed', async () => {
    render(<SheetHost />)
    await armed()
    fireEvent.pointerDown(screen.getByText('close toast'))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('still runs the dialog own handler for other outside presses', async () => {
    const own = vi.fn()
    render(<Host own={own} />)
    await armed()
    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    await waitFor(() => expect(own).toHaveBeenCalled())
  })

  it('ignoreToastPresses prevents default only for toast targets', () => {
    const own = vi.fn()
    const handler = ignoreToastPresses(own)
    const toast = document.createElement('div')
    toast.setAttribute('data-sonner-toaster', '')
    const inner = document.createElement('span')
    toast.appendChild(inner)
    document.body.appendChild(toast)
    const e1 = new Event('x', { cancelable: true })
    Object.defineProperty(e1, 'target', { value: inner })
    handler(e1)
    expect(e1.defaultPrevented).toBe(true)
    expect(own).not.toHaveBeenCalled()
    const e2 = new Event('x', { cancelable: true })
    Object.defineProperty(e2, 'target', { value: document.body })
    handler(e2)
    expect(e2.defaultPrevented).toBe(false)
    expect(own).toHaveBeenCalledTimes(1)
    toast.remove()
  })
})
