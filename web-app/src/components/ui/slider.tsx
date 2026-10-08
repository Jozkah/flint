import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { useReducedMotion } from 'motion/react'

import { cn } from '@/lib/utils'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

const DRAG_SLOP = 3
const MAX_STRETCH = 0.4

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Text shown in the value bubble above a horizontal thumb. */
  formatValue?: (value: number) => string
}

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  orientation = 'horizontal',
  formatValue = String,
  onValueChange,
  onPointerDown,
  onPointerMove,
  onPointerEnter,
  onPointerLeave,
  ...props
}: SliderProps) {
  const storeReduce = useInterfaceSettings((s) => s.reduceMotion)
  const osReduce = useReducedMotion()
  const reduce = storeReduce || !!osReduce
  const horizontal = orientation === 'horizontal'

  const [internal, setInternal] = React.useState<number[]>(() =>
    Array.isArray(defaultValue) ? defaultValue : [min, max]
  )
  const _values = Array.isArray(value) ? value : internal

  const [hovering, setHovering] = React.useState(false)
  const [pressed, setPressed] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)

  const gesture = React.useRef({
    el: null as HTMLElement | null,
    downX: 0,
    lastX: 0,
    lastT: 0,
    sx: 1,
    target: 1,
    raf: 0,
    moved: false,
  })

  const paintStretch = (el: HTMLElement | null, sx: number) => {
    el?.style.setProperty('--flint-sx', String(sx))
  }

  const stopStretch = React.useCallback(() => {
    const g = gesture.current
    cancelAnimationFrame(g.raf)
    g.raf = 0
    g.sx = 1
    g.target = 1
    paintStretch(g.el, 1)
  }, [])

  const runStretch = React.useCallback(() => {
    const g = gesture.current
    if (g.raf) return
    const tick = () => {
      g.raf = 0
      if (performance.now() - g.lastT > 50) g.target = 1 + (g.target - 1) * 0.8
      g.sx += (g.target - g.sx) * 0.3
      if (Math.abs(g.sx - 1) < 0.003 && g.target - 1 < 0.003) {
        g.sx = 1
        g.target = 1
        paintStretch(g.el, 1)
        return
      }
      paintStretch(g.el, g.sx)
      g.raf = requestAnimationFrame(tick)
    }
    g.raf = requestAnimationFrame(tick)
  }, [])

  React.useEffect(() => stopStretch, [stopStretch])

  const endGesture = React.useCallback(() => {
    setPressed(false)
    setDragging(false)
    gesture.current.moved = false
    stopStretch()
  }, [stopStretch])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(e)
    const g = gesture.current
    g.el = e.currentTarget
    g.downX = g.lastX = e.clientX
    g.lastT = performance.now()
    g.moved = false
    setPressed(true)
    const release = () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      endGesture()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(e)
    const g = gesture.current
    if (!pressed) return
    if (!g.moved && Math.abs(e.clientX - g.downX) > DRAG_SLOP) {
      g.moved = true
      setDragging(true)
    }
    if (reduce) return
    if (!g.moved || !horizontal) return
    const now = performance.now()
    const dt = Math.max(1, now - g.lastT)
    const width = e.currentTarget.getBoundingClientRect().width || 1
    // Pointer speed in widths per second; a full width per 0.6 s is the cap.
    const speed = ((Math.abs(e.clientX - g.lastX) / dt) * 1000) / width
    g.target = 1 + Math.min(MAX_STRETCH, speed / 1.5)
    g.lastX = e.clientX
    g.lastT = now
    runStretch()
  }

  const hot = hovering || pressed

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-hot={hot && horizontal ? '' : undefined}
      data-pressed={pressed ? '' : undefined}
      data-dragging={dragging || reduce ? '' : undefined}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      orientation={orientation}
      onValueChange={(next) => {
        if (!Array.isArray(value)) setInternal(next)
        onValueChange?.(next)
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerEnter={(e) => {
        onPointerEnter?.(e)
        if (e.pointerType !== 'touch') setHovering(true)
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        setHovering(false)
      }}
      className={cn(
        'flint-slider relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "bg-track relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "bg-grad absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="flint-slider-thumb border-border-strong ring-ring/30 relative block size-4 shrink-0 rounded-full border bg-knob shadow-[0_2.2px_3px_rgba(27,28,29,.12)] transition-[color,box-shadow,scale] duration-200 ease-expo hover:ring-4 active:scale-110 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        >
          {horizontal && (
            <span
              aria-hidden="true"
              data-slot="slider-bubble"
              className="flint-slider-bubble bg-primary text-primary-foreground pointer-events-none absolute bottom-full left-1/2 mb-2 rounded-md px-2 py-1.5 text-xs leading-none font-medium whitespace-nowrap tabular-nums"
            >
              {formatValue(_values[index] ?? min)}
            </span>
          )}
        </SliderPrimitive.Thumb>
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
