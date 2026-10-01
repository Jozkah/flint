import { useEffect, useState } from 'react'
import { archiveEnabled } from '@/lib/archive'

/**
 * Whether delete currently moves things to the archive, so a delete dialog can
 * say "Move to Archive" and offer "delete permanently". False until the answer
 * is known, which is also the answer outside Tauri.
 */
export function useArchiveEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let live = true
    void archiveEnabled().then((v) => {
      if (live) setEnabled(v)
    })
    return () => {
      live = false
    }
  }, [])
  return enabled
}
