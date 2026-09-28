import { useEffect, useRef } from 'react'

/** Keeps a conversation scrolled to its newest message. */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
