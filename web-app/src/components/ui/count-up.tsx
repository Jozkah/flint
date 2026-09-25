import { useEffect, useRef, useState } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/

/**
 * A figure that counts up to its value when it first appears, the way the
 * dashboard tiles do. Works on a formatted string: the first number in it
 * ("412k", "48.6 tok/s", "4,790", "97.6%") is animated and everything around
 * it is kept. Shows the final value at once with Reduce motion on, and for
 * text without a number.
 */
export function CountUp({
  value,
  durationMs = 900,
  delayMs = 0,
}: {
  value: string
  durationMs?: number
  delayMs?: number
}) {
  // Tests read figures straight after render, so they get the final value.
  const reduce =
    useInterfaceSettings((s) => s.reduceMotion) || import.meta.env.MODE === 'test'
  const match = value.match(NUMBER)
  const [shown, setShown] = useState(() => (match && !reduce ? zeroed(value, match[0]) : value))
  const played = useRef(false)

  useEffect(() => {
    const m = value.match(NUMBER)
    // Later changes (a new range, live figures) replace the value directly;
    // only the first appearance counts up.
    if (!m || reduce || played.current) {
      setShown(value)
      return
    }
    played.current = true
    const target = parseFloat(m[0].replace(/,/g, ''))
    const decimals = m[0].includes('.') ? m[0].split('.')[1].length : 0
    const grouped = m[0].includes(',')
    let raf = 0
    const start = performance.now() + delayMs
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / durationMs))
      // Expo out, the design's easing.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
      const n = target * eased
      const text = grouped
        ? n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : n.toFixed(decimals)
      setShown(value.replace(m[0], text))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduce, durationMs, delayMs])

  return <span className="tabular-nums">{shown}</span>
}

function zeroed(value: string, num: string) {
  const decimals = num.includes('.') ? num.split('.')[1].length : 0
  return value.replace(num, (0).toFixed(decimals))
}
