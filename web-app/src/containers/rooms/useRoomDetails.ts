import { useEffect, useState } from 'react'
import { peekBatches } from '@/lib/rooms/peekBatches'
import type { RoomSummary } from '@/lib/rooms/types'
import type { RoomDetail } from './roomUi'
import type { useRoomsApi } from './roomsBindings'

/** What each room card shows beyond its summary: participants and the last
 * message, read from the rooms themselves. */
export function useRoomDetails(
  api: ReturnType<typeof useRoomsApi>,
  summaries: RoomSummary[]
): Record<string, RoomDetail> {
  const [details, setDetails] = useState<Record<string, RoomDetail>>({})

  // Each card shows its participants and last message, which live in the room
  // itself; read them without opening the room. Refetched when a summary moves.
  const detailKey = summaries.map((s) => `${s.id}:${s.updatedAt}`).join('|')
  useEffect(() => {
    const peek = api.peekRoom
    if (!peek) return
    let live = true
    const byId = new Map(summaries.map((s) => [s.id, s]))
    void (async () => {
      // Every room, newest first, a few at a time: the cards in view fill in
      // first and the weekly statistics end up covering all rooms.
      for (const batch of peekBatches(summaries)) {
        const rows = await Promise.all(
          batch.map((id) =>
            peek(id).then(
              (d) => [id, d] as const,
              () => null
            )
          )
        )
        if (!live) return
        // Keep what earlier rounds read (a refetch must not blank the cards),
        // drop rooms that are gone, and overwrite with this round's answers.
        setDetails((prev) => {
          const next: Record<string, RoomDetail> = {}
          for (const id of byId.keys()) if (prev[id]) next[id] = prev[id]
          for (const row of rows) if (row && byId.has(row[0])) next[row[0]] = row[1]
          return next
        })
      }
      if (live && summaries.length === 0) setDetails({})
    })()
    return () => {
      live = false
    }
    // detailKey stands for the summaries' ids and update times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, detailKey])

  return details
}
