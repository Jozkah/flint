import { useEffect, useState } from 'react'

// Modal content only. Radix PopoverContent is also role="dialog" with
// data-state="open", so a role match would treat every open popover (model
// picker, sampler, @ menu) as a modal.
const OPEN_MODAL = [
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="sheet-content"][data-state="open"]',
  '[data-slot="drawer-content"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
].join(', ')

/** True while any Radix modal (Dialog, Sheet, Drawer, AlertDialog) is open. */
export function useDialogOpen(): boolean {
  const [open, setOpen] = useState(
    () => typeof document !== 'undefined' && !!document.querySelector(OPEN_MODAL)
  )
  useEffect(() => {
    let frame = 0
    // One scan per frame, however many mutations arrive in it.
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setOpen(!!document.querySelector(OPEN_MODAL))
      })
    }
    setOpen(!!document.querySelector(OPEN_MODAL))
    // Radix portals mount as direct children of body, so a modal appearing or
    // leaving needs no subtree watch (streaming text mutates the subtree
    // constantly); one opening or closing in place flips its data-state.
    const portals = new MutationObserver(schedule)
    portals.observe(document.body, { childList: true })
    const states = new MutationObserver(schedule)
    states.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
    return () => {
      portals.disconnect()
      states.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return open
}
