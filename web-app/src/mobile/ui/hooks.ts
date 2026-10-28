import { useEffect, useRef } from 'react'
import type { SessionKind } from '@/lib/remote/protocol'
import { followThread } from '../state/app'
import { useRpc } from '../state/rpc'

/** How near the bottom (px) still counts as "following" the conversation. */
export const STICK_THRESHOLD = 80

/** True when a scroller sits within the threshold of its end. */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD
}

/**
 * Keeps a conversation scrolled to its newest message, unless the reader has
 * scrolled up: new text must not yank them away from what they are reading.
 */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      following.current = isNearBottom(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && following.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

/**
 * Calls `reload` every `ms` while the page is visible, and once as soon as it
 * becomes visible again, so a hidden tab costs no requests.
 */
export function usePollWhileVisible(reload: () => void, ms: number) {
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') reload()
    }
    const timer = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [reload, ms])
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
