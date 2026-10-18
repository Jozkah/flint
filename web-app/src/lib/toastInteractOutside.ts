type OutsideEvent = Event & {
  detail?: { originalEvent?: Event }
}

/**
 * Radix closes a modal on a pointer press outside it. A toast raised over the
 * modal (an error with a close button, an Undo, an approval) is outside it
 * too, so pressing the toast shut the dialog and threw away whatever was being
 * edited. Pass the modal's own `onInteractOutside` through this to leave toast
 * presses alone.
 */
export function ignoreToastPresses<E extends OutsideEvent>(
  own?: (event: E) => void
) {
  return (event: E) => {
    const target = (event.detail?.originalEvent?.target ?? event.target) as
      | Element
      | null
    if (target instanceof Element && target.closest('[data-sonner-toaster]')) {
      event.preventDefault()
      return
    }
    own?.(event)
  }
}
