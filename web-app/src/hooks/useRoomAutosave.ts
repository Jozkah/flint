import { useEffect, useRef, useState } from 'react'

/** How long after the last edit the editor saves by itself. */
export const AUTOSAVE_MS = 700

/**
 * Autosave bookkeeping for the room editor (R-041): whether there is anything
 * unsaved, which room the draft belongs to, the debounce timer, the flush when
 * the editor goes away, and the saving / saved status.
 *
 * The write itself stays with the editor, which owns the draft: it assigns it
 * to `saveRef.current` on every render so the timer and the unmount flush
 * always run the latest one.
 */
export function useRoomAutosave(roomId: string) {
  /** Edits not written yet. */
  const dirty = useRef(false)
  /** The room the draft belongs to; a save for any other room is refused. */
  const draftRoomId = useRef(roomId)
  // Every edit bumps this; a save clears `dirty` only when nothing changed
  // while it was in flight.
  const editGen = useRef(0)
  const [tick, setTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveRef = useRef<(auto: boolean) => Promise<void>>(async () => {})

  /** An edit happened: start (or restart) the debounce. */
  const markEdited = () => {
    dirty.current = true
    editGen.current += 1
    setSaved(false)
    setTick((n) => n + 1)
  }

  useEffect(() => {
    if (tick === 0) return
    const timer = setTimeout(() => void saveRef.current(true), AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [tick])

  // Leaving the editor (another room, another page) still saves the edit.
  useEffect(
    () => () => {
      if (dirty.current) void saveRef.current(true)
    },
    []
  )

  return {
    dirty,
    draftRoomId,
    editGen,
    saving,
    setSaving,
    saved,
    setSaved,
    markEdited,
    saveRef,
  }
}
