import { useEffect, useRef } from 'react'
import type { SessionKind } from '@/lib/remote/protocol'
import { followThread } from '../state/app'
import { useRpc } from '../state/rpc'

/** Keeps a conversation scrolled to its newest message. */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

/** Follows a conversation's live events while mounted. */
export function useFollow(kind: SessionKind, id: string) {
  useEffect(() => followThread(kind, id), [kind, id])
}

/** What this phone may answer, per Settings › Remote access on the computer. */
export function usePhonePermissions() {
  const { data } = useRpc('status', {})
  return data?.permissions ?? { approvals: true, alwaysAllow: false }
}
