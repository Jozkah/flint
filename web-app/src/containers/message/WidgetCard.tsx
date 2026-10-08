import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Code2,
  Copy,
  Download,
  ExternalLink,
  LayoutTemplate,
  Maximize2,
  RotateCw,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { openInBrowser } from '@/lib/browserOpen'
import { cn } from '@/lib/utils'
import { normalizeWidgetCode, widgetFallbackTitle } from '@/lib/visualize/code'
import { MAX_WIDGET_CODE_CHARS } from '@/lib/visualize/constants'
import { buildStandalonePage } from '@/lib/visualize/document'
import { useWidgetHost } from '@/lib/visualize/hostContext'
import { readThemeSnapshot } from '@/lib/visualize/themeVars'
import { WidgetFrame } from './WidgetFrame'
import type { MessagePartLike } from './types'

/** A widget this far from the viewport is parked as a placeholder. */
const NEAR_MARGIN = '1200px'
const PARK_DELAY_MS = 4000
const LOADING_LINE_MS = 2200

/** Whether the element is within `NEAR_MARGIN` of the viewport. */
function useNearViewport(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => setNear(entries[entries.length - 1]?.isIntersecting ?? true),
      { rootMargin: NEAR_MARGIN }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, near]
}

const argsOf = (input: unknown) => {
  const a = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >
  const code = typeof a.widget_code === 'string' ? a.widget_code : ''
  const title =
    typeof a.title === 'string' && a.title.trim()
      ? a.title.trim()
      : code
        ? widgetFallbackTitle(code)
        : ''
  const loading = Array.isArray(a.loading_messages)
    ? a.loading_messages.filter(
        (m): m is string => typeof m === 'string' && m.trim().length > 0
      )
    : []
  return { code, title, loading }
}

/**
 * The inline card for a `show_widget` call: caption row, the widget in its
 * sandboxed frame, and source / copy / save / expand. The widget is drawn from
 * the call's stored arguments, so it comes back identically after a reload.
 */
export const WidgetCard = memo(function WidgetCard({
  part,
  className,
}: {
  part: MessagePartLike
  messageId: string
  className?: string
}) {
  const { t } = useTranslation()
  const host = useWidgetHost()
  const allowCdn = useVisualizeConfig((s) => s.allowCdn)
  const maxHeight = useVisualizeConfig((s) => s.maxHeight)
  const { code, title, loading } = argsOf(part.input)
  const streaming = part.state === 'input-streaming'
  const refused = part.state === 'output-error' || part.state === 'output-denied'
  const tooLarge = code.length > MAX_WIDGET_CODE_CHARS

  const [collapsed, setCollapsed] = useState(false)
  const [view, setView] = useState<'preview' | 'source'>('preview')
  const [painted, setPainted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runKey, setRunKey] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [pendingLink, setPendingLink] = useState<string | null>(null)
  const [loadingAt, setLoadingAt] = useState(0)
  const [parked, setParked] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [ref, near] = useNearViewport()

  // Off-screen widgets give up their frame after a pause, so a long chat does
  // not keep dozens of live documents. One that is streaming never parks.
  useEffect(() => {
    if (near || streaming) {
      setParked(false)
      return
    }
    const timer = setTimeout(() => setParked(true), PARK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [near, streaming])

  useEffect(() => {
    if (painted || loading.length < 2) return
    const timer = setInterval(
      () => setLoadingAt((n) => n + 1),
      LOADING_LINE_MS
    )
    return () => clearInterval(timer)
  }, [painted, loading.length])

  const sendPrompt = useCallback(
    (text: string) => {
      if (!host) {
        toast.info(t('chat:widget.noHost'))
        return
      }
      if (!host.sendPrompt(text)) toast.info(t('chat:widget.busy'))
    },
    [host, t]
  )

  const copyHtml = () =>
    void navigator.clipboard
      ?.writeText(normalizeWidgetCode(code))
      .then(() => toast.success(t('chat:widget.copied')))
      .catch(() => toast.error(t('chat:widget.copyFailed')))

  const save = () => {
    const { vars, dark } = readThemeSnapshot()
    const page = buildStandalonePage(title || 'Widget', normalizeWidgetCode(code), vars, dark)
    const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${(title || 'widget').replace(/[^\w.-]+/g, '-').slice(0, 60)}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const askToFix = () =>
    sendPrompt(
      t('chat:widget.fixPrompt', { title: title || 'widget', error: error ?? '' })
    )

  const iconBtn = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    pressed?: boolean
  ) => (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(pressed && 'bg-accent text-foreground')}
    >
      {icon}
    </Button>
  )

  const frame = (fill: boolean) => (
    <WidgetFrame
      key={runKey}
      title={title || t('chat:widget.label')}
      code={code}
      final={!streaming}
      allowCdn={allowCdn}
      maxHeight={fill ? null : maxHeight}
      cacheKey={fill ? undefined : part.toolCallId}
      className={fill ? 'h-full' : undefined}
      onPainted={() => setPainted(true)}
      onStalled={() => setStalled(true)}
      onError={(message) => setError((prev) => prev ?? message)}
      onPrompt={sendPrompt}
      onLink={setPendingLink}
    />
  )

  const body = refused ? (
    <div
      role="alert"
      data-testid="widget-refused"
      className="flex items-start gap-2 px-3 py-2.5 text-xs text-destructive"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {t('chat:widget.refused', {
          reason: part.errorText || part.error || t('chat:widget.refusedUnknown'),
        })}
      </span>
    </div>
  ) : tooLarge ? (
    <div role="alert" className="px-3 py-2.5 text-xs text-destructive">
      {t('chat:widget.tooLarge', { max: MAX_WIDGET_CODE_CHARS })}
    </div>
  ) : stalled && view === 'preview' ? (
    <div
      role="alert"
      data-testid="widget-stalled"
      className="flex min-h-24 flex-wrap items-center justify-center gap-3 px-3 py-6 text-xs text-muted-foreground"
    >
      <TriangleAlert className="size-3.5 text-warning" aria-hidden />
      <span>{t('chat:widget.stalled')}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => {
          setStalled(false)
          setPainted(false)
          setRunKey((n) => n + 1)
        }}
      >
        <RotateCw aria-hidden />
        {t('chat:widget.rerun')}
      </Button>
    </div>
  ) : parked && view === 'preview' ? (
    <div
      data-testid="widget-parked"
      className="flex min-h-24 items-center justify-center gap-3 px-3 py-6 text-xs text-muted-foreground"
    >
      <span>{t('chat:widget.parked')}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => {
          setParked(false)
          setRunKey((n) => n + 1)
        }}
      >
        <RotateCw aria-hidden />
        {t('chat:widget.rerun')}
      </Button>
    </div>
  ) : (
    <>
      {view === 'source' && (
        <CodeBlock
          code={normalizeWidgetCode(code) || code}
          language="html"
          className="max-h-[480px] overflow-auto border-0"
        />
      )}
      {/* Kept mounted behind the source view, so toggling does not restart it. */}
      <div className={cn('relative', view === 'source' && 'hidden')}>
      {frame(false)}
      {!painted && (
        <div
          data-testid="widget-loading"
          className="pointer-events-none absolute inset-0 flex items-center px-4 text-xs"
        >
          <Shimmer as="span">
            {loading.length
              ? loading[loadingAt % loading.length]
              : t('chat:widget.drawing')}
          </Shimmer>
        </div>
      )}
      </div>
    </>
  )

  return (
    <div
      ref={ref}
      data-testid="widget-card"
      data-state={part.state}
      className={cn('mb-2 w-full min-w-0', className)}
    >
      <div className="flex min-h-7 items-center gap-1 text-xs text-muted-foreground">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 hover:text-foreground"
        >
          <LayoutTemplate className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0">
            {streaming ? t('chat:widget.drawing') : t('chat:widget.label')}
          </span>
          {title && (
            <span className="truncate font-medium text-fg-2" title={title}>
              {title}
            </span>
          )}
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              collapsed && '-rotate-90'
            )}
            aria-hidden
          />
        </button>
        <span className="flex-1" />
        {!refused && !tooLarge && code && (
          <div className="flex items-center gap-0.5">
            {iconBtn(
              t('chat:widget.source'),
              <Code2 aria-hidden />,
              () => setView((v) => (v === 'source' ? 'preview' : 'source')),
              view === 'source'
            )}
            {iconBtn(t('chat:widget.copy'), <Copy aria-hidden />, copyHtml)}
            {iconBtn(t('chat:widget.save'), <Download aria-hidden />, save)}
            {iconBtn(t('chat:widget.expand'), <Maximize2 aria-hidden />, () =>
              setExpanded(true)
            )}
          </div>
        )}
      </div>

      {!collapsed && (
        <div
          data-testid="widget-body"
          className="overflow-hidden rounded-xl border-[0.8px] border-border bg-card text-foreground"
        >
          {error && (
            <div
              role="alert"
              data-testid="widget-error"
              className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive-tint px-3 py-1.5 text-xs text-destructive"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-words">
                <strong className="font-medium">{t('chat:widget.error')}</strong>{' '}
                {error}
              </span>
              {view !== 'source' && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setView('source')}
                >
                  {t('chat:widget.viewSource')}
                </Button>
              )}
              <Button type="button" size="xs" variant="outline" onClick={askToFix}>
                {t('chat:widget.askFix')}
              </Button>
            </div>
          )}
          {pendingLink && (
            <div
              role="alertdialog"
              data-testid="widget-link-confirm"
              className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs"
            >
              <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-all">
                {t('chat:widget.openLink', { url: pendingLink })}
              </span>
              <Button
                type="button"
                size="xs"
                onClick={() => {
                  const url = pendingLink
                  setPendingLink(null)
                  void openInBrowser(url).catch(() =>
                    toast.error(t('chat:browserCard.failed'))
                  )
                }}
              >
                {t('chat:browserCard.open')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setPendingLink(null)}
              >
                {t('chat:widget.cancel')}
              </Button>
            </div>
          )}
          {body}
        </div>
      )}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="h-[85vh] max-w-[min(1100px,95vw)] grid-rows-[auto_1fr] p-3 sm:max-w-[min(1100px,95vw)]"
          showCloseButton
        >
          <DialogTitle className="pr-8 text-sm font-medium">{title}</DialogTitle>
          <div className="min-h-0 overflow-hidden rounded-lg border-[0.8px] border-border bg-card">
            {expanded && frame(true)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
})
