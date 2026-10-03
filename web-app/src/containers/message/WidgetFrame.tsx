import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePreviewSource } from '@/hooks/usePreviewSource'
import {
  buildWidgetShell,
  parseFrameMessage,
  WIDGET_SANDBOX,
} from '@/lib/visualize/document'
import { normalizeWidgetCode, partialMarkup } from '@/lib/visualize/code'
import { readThemeSnapshot, watchTheme } from '@/lib/visualize/themeVars'
import {
  checkOpenLink,
  checkSendPrompt,
  newBridgeState,
  userIsActive,
} from '@/lib/visualize/bridge'
import { MIN_WIDGET_HEIGHT } from '@/lib/visualize/constants'

/** How long a half-written widget waits before it is repainted. */
export const PARTIAL_PAINT_DELAY_MS = 300

/** A frame silent this long is treated as stuck in a loop. */
export const STALL_AFTER_MS = 10_000

/** Heights measured so far, so a remounted widget does not collapse and jump. */
const measured = new Map<string, number>()

export type WidgetFrameProps = {
  title: string
  code: string
  /** The call's arguments are complete: scripts run. False while streaming. */
  final: boolean
  allowCdn: boolean
  /** Tallest the frame grows before it scrolls; `null` fills the parent. */
  maxHeight: number | null
  /** Remembers the measured height across remounts. */
  cacheKey?: string
  className?: string
  onPainted?: () => void
  /** The frame stopped answering (a script that never returns). */
  onStalled?: () => void
  onError?: (message: string) => void
  onPrompt?: (text: string) => void
  onLink?: (url: string) => void
}

/**
 * The sandboxed iframe a widget runs in. The document is a constant shell;
 * the markup and the theme arrive by message, so a streamed widget is painted
 * as it grows without reloading (and its scripts start once, when the call is
 * complete). Everything the frame sends back is checked here.
 */
export const WidgetFrame = memo(function WidgetFrame({
  title,
  code,
  final,
  allowCdn,
  maxHeight,
  cacheKey,
  className,
  onPainted,
  onStalled,
  onError,
  onPrompt,
  onLink,
}: WidgetFrameProps) {
  const shell = useMemo(() => buildWidgetShell(allowCdn), [allowCdn])
  // `allowCdn` only widens the response header the desktop app sends; the
  // meta policy inside the shell still names the two hosts and nothing else.
  const source = usePreviewSource(shell, allowCdn, true)
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(
    () => (cacheKey ? measured.get(cacheKey) : undefined) ?? MIN_WIDGET_HEIGHT
  )
  const bridge = useRef(newBridgeState())
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPaint = useRef(0)
  const latestCode = useRef(code)
  latestCode.current = code
  const sourceKey = 'src' in source ? source.src : 'doc'
  const handlers = useRef({ onPainted, onStalled, onError, onPrompt, onLink })
  handlers.current = { onPainted, onStalled, onError, onPrompt, onLink }
  const lastBeat = useRef(Date.now())

  // A new document (the desktop scheme's id arriving, or a policy change) has
  // not announced itself yet.
  useEffect(() => {
    setReady(false)
  }, [sourceKey])

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ flint: 1, ...message }, '*')
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const msg = parseFrameMessage(event.data)
      if (!msg) return
      switch (msg.op) {
        case 'ready':
          lastBeat.current = Date.now()
          setReady(true)
          break
        case 'beat':
          lastBeat.current = Date.now()
          break
        case 'height': {
          const h = Math.max(MIN_WIDGET_HEIGHT, msg.h)
          if (cacheKey) measured.set(cacheKey, h)
          setHeight(h)
          break
        }
        case 'error':
          handlers.current.onError?.(msg.message)
          break
        case 'sendPrompt': {
          const verdict = checkSendPrompt(
            msg.text,
            { userActive: userIsActive(), now: Date.now() },
            bridge.current
          )
          if (verdict.ok) handlers.current.onPrompt?.(verdict.text)
          break
        }
        case 'openLink': {
          const verdict = checkOpenLink(msg.url, { userActive: userIsActive() })
          if (verdict.ok) handlers.current.onLink?.(verdict.url)
          break
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [cacheKey])

  // Watchdog: a widget stuck in a loop stops sending its heartbeat. The host
  // page is not blocked, but the frame is dead weight: the card replaces it.
  useEffect(() => {
    if (!ready) return
    lastBeat.current = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - lastBeat.current > STALL_AFTER_MS) {
        clearInterval(timer)
        handlers.current.onStalled?.()
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [ready])

  // The theme, once the frame is up and whenever the app's theme changes.
  useEffect(() => {
    if (!ready) return
    const send = () => post({ op: 'theme', ...readThemeSnapshot() })
    send()
    return watchTheme(send)
  }, [ready, post])

  // The markup. A half-written widget is repainted at most every 300 ms and
  // only once it holds a whole element; the finished one goes at once.
  useEffect(() => {
    if (!ready) return
    if (final) {
      if (paintTimer.current) {
        clearTimeout(paintTimer.current)
        paintTimer.current = null
      }
      post({ op: 'content', html: normalizeWidgetCode(code), final: true })
      handlers.current.onPainted?.()
      return
    }
    // Throttled, not debounced: a stream that never pauses must still paint.
    if (paintTimer.current) return
    const wait = Math.max(0, lastPaint.current + PARTIAL_PAINT_DELAY_MS - Date.now())
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null
      lastPaint.current = Date.now()
      const html = partialMarkup(latestCode.current)
      if (html === null) return
      post({ op: 'content', html, final: false })
      handlers.current.onPainted?.()
    }, wait)
  }, [ready, final, code, post])

  useEffect(
    () => () => {
      if (paintTimer.current) clearTimeout(paintTimer.current)
    },
    []
  )

  const shown =
    maxHeight === null ? undefined : Math.min(height, Math.max(maxHeight, MIN_WIDGET_HEIGHT))
  return (
    <iframe
      ref={frame}
      title={title}
      data-testid="widget-frame"
      sandbox={WIDGET_SANDBOX}
      referrerPolicy="no-referrer"
      className={className}
      style={{
        width: '100%',
        border: 0,
        display: 'block',
        background: 'transparent',
        ...(shown === undefined ? { height: '100%' } : { height: shown }),
      }}
      {...source}
    />
  )
})
