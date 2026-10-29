import { useCallback, type RefObject } from 'react'

/**
 * Keyboard use of the open model picker: arrows move between the search box
 * and the model rows (`[data-model-row]` under `pickerRef`), Home/End jump to
 * the first/last row, Enter in the search box picks the first match, and
 * typing on a row goes back to the search box.
 */
export function useModelPickerKeyNav(
  pickerRef: RefObject<HTMLElement | null>,
  searchInputRef: RefObject<HTMLInputElement | null>
) {
  return useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.nativeEvent.isComposing) return
      const rows = Array.from(
        pickerRef.current?.querySelectorAll<HTMLElement>('[data-model-row]') ??
          []
      )
      const input = searchInputRef.current
      const onInput = event.target === input
      const at = rows.indexOf(event.target as HTMLElement)
      const focusRow = (i: number) => {
        const row = rows[i]
        if (!row) return
        event.preventDefault()
        row.focus()
        row.scrollIntoView?.({ block: 'nearest' })
      }
      if (event.key === 'ArrowDown' && (onInput || at !== -1)) {
        focusRow(onInput ? 0 : Math.min(at + 1, rows.length - 1))
      } else if (event.key === 'ArrowUp' && at !== -1) {
        if (at === 0) {
          event.preventDefault()
          input?.focus()
        } else focusRow(at - 1)
      } else if (event.key === 'Home' && at !== -1) {
        focusRow(0)
      } else if (event.key === 'End' && at !== -1) {
        focusRow(rows.length - 1)
      } else if (event.key === 'Enter' && onInput && rows.length > 0) {
        event.preventDefault()
        rows[0].click()
      } else if (
        at !== -1 &&
        event.key.length === 1 &&
        event.key !== ' ' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        input?.focus()
      }
    },
    [pickerRef, searchInputRef]
  )
}
