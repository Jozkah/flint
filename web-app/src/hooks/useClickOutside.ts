/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react'

const DEFAULT_EVENTS = ['mousedown', 'touchstart']

export function useClickOutside<T extends HTMLElement = any>(
  handler: () => void,
  events?: string[] | null,
  nodes?: (HTMLElement | null)[]
) {
  const ref = useRef<T>(null)
  // Latest values, read when the event fires: an inline handler or a new
  // `nodes` array each render must not re-register the document listeners.
  const handlerRef = useRef(handler)
  const nodesRef = useRef(nodes)
  useEffect(() => {
    handlerRef.current = handler
    nodesRef.current = nodes
  })
  const eventsKey = (events || DEFAULT_EVENTS).join(',')

  useEffect(() => {
    const listener = (event: any) => {
      const target = event?.target
      const currentNodes = nodesRef.current
      if (Array.isArray(currentNodes)) {
        const shouldIgnore =
          !target ||
          target.hasAttribute?.('data-ignore-outside-clicks') ||
          (!document.body.contains(target) && target.tagName !== 'HTML')
        const shouldTrigger = currentNodes.every(
          (node) => !!node && !event.composedPath().includes(node)
        )
        if (shouldTrigger && !shouldIgnore) handlerRef.current()
      } else if (ref.current && !ref.current.contains(target)) {
        handlerRef.current()
      }
    }

    const names = eventsKey.split(',')
    names.forEach((fn) => document.addEventListener(fn, listener))

    return () => {
      names.forEach((fn) => document.removeEventListener(fn, listener))
    }
  }, [ref, eventsKey])

  return ref
}
