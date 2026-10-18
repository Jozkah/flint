import { useMemo } from 'react'
import { useAppState } from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useThreads } from '@/hooks/useThreads'
import { useSeen } from '@/stores/seen-store'
import { useMinuteClock } from '@/lib/minuteClock'
import { statusFor } from '@/containers/ThreadStatusMark'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { NestStatus } from '@/lib/nesting'

/** Ids as one string: store updates that change nothing leave it equal. */
const key = (ids: readonly string[]) => ids.join('\n')
const toSet = (k: string) => new Set(k ? k.split('\n') : [])

/** The ids a tool approval waits on. */
function useApprovalKey(ids: readonly string[]) {
  return useToolApprovalRequests((s) => {
    const waiting = new Set(
      Object.values(s.pending ?? {}).map((p) => p.threadId)
    )
    return key(ids.filter((id) => waiting.has(id)))
  })
}

/** Minutes since the epoch: re-evaluates "new" as the hour runs out. */
const useMinute = () => useMinuteClock((now) => Math.floor(now / 60_000))

/**
 * Each chat's mark for the nested summary, by the same rules as its row's
 * ThreadStatusMark: waiting, working, or finished in the last hour unseen.
 */
export function useChatNestStatus(
  ids: readonly string[],
  selectedId?: string
): (id: string) => NestStatus {
  const busy = useAppState((s) =>
    key(
      ids.filter(
        (id) =>
          id in s.streamingContents ||
          id in s.loadingModels ||
          id in s.cancelToolCalls ||
          id in s.busyThreads
      )
    )
  )
  const streaming = useChatSessions((s) =>
    key(ids.filter((id) => s.sessions[id]?.isStreaming))
  )
  const waiting = useApprovalKey(ids)
  const threads = useThreads((s) => s.threads)
  const seen = useSeen((s) => s.seen)
  const minute = useMinute()
  return useMemo(() => {
    const working = new Set([...toSet(busy), ...toSet(streaming)])
    const wait = toSet(waiting)
    const now = minute * 60_000
    return (id: string) => {
      const thread = threads[id]
      if (!thread) return 'none'
      const s = statusFor(thread, working.has(id), now, wait.has(id), seen[id] ?? 0) as NestStatus
      return id === selectedId && s === 'recent' ? 'none' : s
    }
  }, [busy, streaming, waiting, threads, seen, minute, selectedId])
}

/** The same for Cowork sessions (server sessions report their own state). */
export function useCoworkNestStatus(
  sessions: readonly CoworkSession[],
  selectedId?: string
): (id: string) => NestStatus {
  const ids = useMemo(() => sessions.map((s) => s.id), [sessions])
  const running = useCoworkRun((s) => key(ids.filter((id) => !!s.runs[id])))
  const asking = useCoworkRun((s) =>
    key(ids.filter((id) => (s.pendingAsks?.[id]?.length ?? 0) > 0))
  )
  const waiting = useApprovalKey(ids)
  const seen = useSeen((s) => s.seen)
  const minute = useMinute()
  return useMemo(() => {
    const run = toSet(running)
    const wait = new Set([...toSet(asking), ...toSet(waiting)])
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const now = minute * 60_000
    return (id: string) => {
      const session = byId.get(id)
      if (!session) return 'none'
      const remote = session.remote === true
      const s = statusFor(
        { updated: session.updated },
        run.has(id) || (remote && session.remoteStatus === 'running'),
        now,
        wait.has(id) ||
          (remote && session.remoteStatus?.startsWith('awaiting') === true),
        seen[`cowork:${id}`] ?? 0
      ) as NestStatus
      return id === selectedId && s === 'recent' ? 'none' : s
    }
  }, [running, asking, waiting, sessions, seen, minute, selectedId])
}
