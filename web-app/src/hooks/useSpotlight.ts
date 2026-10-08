import { useCallback, type PointerEvent } from 'react'
import { useReducedMotion } from 'motion/react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

/**
 * Props for a card whose faint spotlight follows the cursor. Add the
 * `spot-card` class and spread `onPointerMove`; the glow itself is CSS and
 * reads --mx / --my. Touch and reduced motion get nothing.
 */
export function useSpotlight() {
  const osReduce = useReducedMotion()
  const storeReduce = useInterfaceSettings((s) => s.reduceMotion)
  const off = Boolean(osReduce || storeReduce)

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (off || event.pointerType === 'touch') return
      const el = event.currentTarget
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${event.clientX - rect.left}px`)
      el.style.setProperty('--my', `${event.clientY - rect.top}px`)
    },
    [off]
  )

  return { onPointerMove, className: off ? undefined : 'spot-card' }
}
