import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

// Warm tooltips: the first one waits, the neighbours that follow open at once
// and glide from the previous tooltip's box to their own.
// Tests open tooltips at once so they need no timers.
const openDelay = () => (import.meta.env.MODE === 'test' ? 0 : 400)
const WARM_WINDOW = 300
const GLIDE_MS = 320
const GLIDE_EASE = 'cubic-bezier(0.34, 1.3, 0.5, 1)'
const TEXT_SHIFT = 10

const openTips = new Set<symbol>()
let warmUntil = 0
let warmTimer: ReturnType<typeof setTimeout> | undefined
const warmListeners = new Set<() => void>()

const isWarm = () => openTips.size > 0 || performance.now() < warmUntil
const notifyWarm = () => warmListeners.forEach((l) => l())

function setTipOpen(id: symbol, open: boolean) {
  const was = isWarm()
  if (open) {
    openTips.add(id)
    clearTimeout(warmTimer)
  } else if (openTips.delete(id) && openTips.size === 0) {
    warmUntil = performance.now() + WARM_WINDOW
    clearTimeout(warmTimer)
    warmTimer = setTimeout(notifyWarm, WARM_WINDOW + 1)
  }
  if (was !== isWarm()) notifyWarm()
}

function subscribeWarm(cb: () => void) {
  warmListeners.add(cb)
  return () => {
    warmListeners.delete(cb)
  }
}

// The last visible tooltip box, to glide from.
let lastRect: { rect: DOMRect; at: number } | null = null
let liveContents = 0

function TooltipProvider({
  delayDuration = openDelay(),
  skipDelayDuration = WARM_WINDOW,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({
  onOpenChange,
  delayDuration,
  open,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const idRef = React.useRef<symbol | null>(null)
  if (idRef.current === null) idRef.current = Symbol('tooltip')
  const warm = React.useSyncExternalStore(subscribeWarm, isWarm, isWarm)

  React.useEffect(() => {
    const tip = idRef.current as symbol
    return () => setTipOpen(tip, false)
  }, [])

  React.useEffect(() => {
    if (open !== undefined) setTipOpen(idRef.current as symbol, open)
  }, [open])

  const handleOpenChange = (next: boolean) => {
    setTipOpen(idRef.current as symbol, next)
    onOpenChange?.(next)
  }

  return (
    <TooltipProvider>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={open}
        delayDuration={delayDuration ?? (warm ? 0 : openDelay())}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  showArrow = true,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  showArrow?: boolean
}) {
  const storeReduce = useInterfaceSettings((s) => s.reduceMotion)
  const osReduce = useReducedMotion()
  const reduce = storeReduce || !!osReduce
  const elRef = React.useRef<HTMLDivElement | null>(null)
  const textRef = React.useRef<HTMLSpanElement | null>(null)
  const glideRef = React.useRef(false)

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      elRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref)
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    },
    [ref]
  )

  // Decide before paint whether this tooltip glides, so the pop is skipped.
  React.useLayoutEffect(() => {
    const warm =
      !reduce &&
      lastRect !== null &&
      (liveContents > 0 || performance.now() - lastRect.at < WARM_WINDOW)
    glideRef.current = warm
    if (warm) elRef.current?.setAttribute('data-glide', '')
    liveContents += 1
    return () => {
      liveContents -= 1
      if (lastRect) lastRect.at = performance.now()
    }
  }, [reduce])

  // Once Radix has placed the box, remember it and glide in from the last one.
  React.useEffect(() => {
    let frame = 0
    let tries = 0
    const run = () => {
      const el = elRef.current
      if (!el) return
      const wrapper = el.parentElement
      // Radix parks the wrapper off screen until it is measured.
      if (wrapper && /-200%/.test(wrapper.style.transform) && tries++ < 8) {
        frame = requestAnimationFrame(run)
        return
      }
      const next = el.getBoundingClientRect()
      const prev = lastRect?.rect
      if (glideRef.current && prev && typeof el.animate === 'function') {
        const dx = prev.left - next.left
        const dy = prev.top - next.top
        const sx = next.width ? prev.width / next.width : 1
        const sy = next.height ? prev.height / next.height : 1
        el.animate(
          [
            {
              transformOrigin: '0 0',
              transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
            },
            { transformOrigin: '0 0', transform: 'none' },
          ],
          { duration: GLIDE_MS, easing: GLIDE_EASE }
        )
        const dir =
          Math.sign(
            next.left + next.width / 2 - (prev.left + prev.width / 2)
          ) || 1
        textRef.current?.animate(
          [
            {
              opacity: 0,
              transform: `translateX(${TEXT_SHIFT * dir}px)`,
              filter: 'blur(3px)',
            },
            { opacity: 1, transform: 'none', filter: 'blur(0)' },
          ],
          { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
        )
      }
      lastRect = { rect: next, at: performance.now() }
    }
    frame = requestAnimationFrame(run)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={setRefs}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-primary text-on-grad flint-tip z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1.5 text-xs leading-none font-medium text-balance',
          className
        )}
        {...props}
      >
        <span ref={textRef} className="block">
          {children}
        </span>
        {showArrow && (
          <TooltipPrimitive.Arrow className="bg-primary fill-primary z-50 size-2 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px]" />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
