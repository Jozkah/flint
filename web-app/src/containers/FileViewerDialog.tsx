import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check, WrapText } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { displayNameOf, extensionOf } from '@/lib/displayName'
import { formatChipSize } from '@/lib/attachmentChip'
import { csvPreview, type FilePreview } from '@/lib/filePreview'
import {
  capLine,
  LINE_CAP,
  createChunkReader,
  rowOffsets,
  visibleWindow,
  type ChunkReader,
  type ChunkSource,
} from '@/lib/fileChunks'
import { cn } from '@/lib/utils'

/** What the full viewer shows: text read in chunks, or a parsed document. */
export type ViewerSpec =
  | {
      mode: 'lines'
      open: () => Promise<ChunkSource | null>
      /** The text was cut when it was added (bytes kept of the file's bytes). */
      truncated?: { shown: number; total: number }
    }
  | { mode: 'doc'; load: (signal: AbortSignal) => Promise<FilePreview | null> }

const ROW = 18

/**
 * Windowed monospace lines: only the rows in view (plus overscan) are in the
 * DOM, laid out between two spacers so a wrapped row that measures taller
 * than estimated only nudges the scroll, never overlaps.
 */
export function LinesView({
  lines,
  version,
  wrap,
  table,
  initialHeight = 480,
}: {
  lines: readonly string[]
  /** Bumped when `lines` grew in place. */
  version: number
  wrap: boolean
  /** Delimiter to show rows as cells (csv/tsv). */
  table?: ',' | '\t'
  initialHeight?: number
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [box, setBox] = useState({ h: initialHeight, w: 800 })
  const [charW, setCharW] = useState(7.2)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const probe = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      if (el.clientHeight > 0) setBox({ h: el.clientHeight, w: el.clientWidth })
      const pw = probe.current?.getBoundingClientRect().width ?? 0
      if (pw > 0) setCharW(pw / 100)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const gutter = Math.max(3, String(lines.length).length) + 2
  const cols = wrap && !table ? Math.max(20, Math.floor(box.w / charW) - gutter - 2) : Infinity
  const offsets = useMemo(
    () => rowOffsets(lines, ROW, cols, expanded),
    // `version` tracks in-place growth of `lines`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, version, cols, expanded]
  )
  const { start, end } = visibleWindow(offsets, scrollTop, box.h)
  const rows = []
  for (let i = start; i < end; i++) {
    const isOpen = expanded.has(i)
    const { text, cut } = capLine(lines[i], isOpen)
    const parsed = table ? csvPreview(text, table, 1, 50) : null
    const cells = parsed?.kind === 'table' ? parsed.rows[0] : table ? [text] : null
    rows.push(
      <div
        key={i}
        data-testid="viewer-line"
        className="flex min-h-[18px]"
        style={wrap ? undefined : { height: ROW }}
      >
        <span
          aria-hidden
          className="sticky left-0 shrink-0 select-none bg-popover pr-3 text-right text-muted-foreground tabular-nums"
          style={{ width: `${gutter}ch` }}
        >
          {i + 1}
        </span>
        <span
          className={cn(
            'min-w-0',
            wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
          )}
        >
          {cells
            ? cells.map((c, j) => (
                <span
                  key={j}
                  className="inline-block max-w-60 truncate border-r border-border px-2 align-top"
                >
                  {c}
                </span>
              ))
            : text}
          {cut || (isOpen && lines[i].length > LINE_CAP) ? (
            <button
              type="button"
              className="ms-2 rounded px-1 text-[11px] text-primary underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={() =>
                setExpanded((s) => {
                  const n = new Set(s)
                  if (n.has(i)) n.delete(i)
                  else n.add(i)
                  return n
                })
              }
            >
              {isOpen ? t('common:fileViewer.collapseLine') : t('common:fileViewer.expandLine')}
            </button>
          ) : null}
        </span>
      </div>
    )
  }
  return (
    <div
      ref={ref}
      data-testid="viewer-scroll"
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-auto rounded-md border border-border bg-popover font-mono text-[12px] leading-[18px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
    >
      <span ref={probe} aria-hidden className="invisible absolute whitespace-pre">
        {'0'.repeat(100)}
      </span>
      <div style={{ height: offsets[start] }} />
      <div className={wrap ? undefined : 'w-max min-w-full'}>{rows}</div>
      <div style={{ height: offsets[lines.length] - offsets[end] }} />
    </div>
  )
}

function DocView({ preview }: { preview: FilePreview }) {
  if (preview.kind === 'doc')
    return (
      <div className="min-h-0 flex-1 space-y-2 overflow-auto text-sm">
        {preview.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    )
  if (preview.kind === 'table')
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-xs">
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i} className="border-b border-border">
                {r.map((c, j) => (
                  <td key={j} className="max-w-60 truncate px-2 py-0.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  return (
    <pre className="min-h-0 flex-1 overflow-auto font-mono text-xs">{preview.lines.join('\n')}</pre>
  )
}

type Status = 'loading' | 'ready' | 'none' | 'binary'

/**
 * Full preview of an attachment: the first chunk of a text file (2 MB),
 * more on request, line numbers, wrap toggle, copy of what is loaded.
 */
export function FileViewerDialog({
  open,
  onOpenChange,
  name,
  meta,
  spec,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  meta?: string
  spec: ViewerSpec
}) {
  const { t } = useTranslation()
  const title = displayNameOf(name)
  const ext = extensionOf(name).toLowerCase()
  const [status, setStatus] = useState<Status>('loading')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const [doc, setDoc] = useState<FilePreview | null>(null)
  const reader = useRef<ChunkReader | null>(null)
  const ctl = useRef<AbortController | null>(null)
  // Callers rebuild the spec each render; only opening starts a read.
  const specRef = useRef(spec)
  specRef.current = spec

  useEffect(() => {
    if (!open) return
    const c = new AbortController()
    ctl.current = c
    setStatus('loading')
    setDoc(null)
    reader.current = null
    const spec = specRef.current
    const run = async () => {
      if (spec.mode === 'doc') {
        const p = await spec.load(c.signal)
        if (c.signal.aborted) return
        setDoc(p)
        setStatus(p ? 'ready' : 'none')
        return
      }
      const src = await spec.open()
      if (c.signal.aborted) return
      if (!src) return setStatus('none')
      const r = createChunkReader(src)
      await r.next(c.signal)
      if (c.signal.aborted) return
      reader.current = r
      setVersion((v) => v + 1)
      setStatus(r.binary ? 'binary' : 'ready')
    }
    run().catch(() => {
      if (!c.signal.aborted) setStatus('none')
    })
    return () => c.abort()
  }, [open])

  const loadMore = useCallback(async () => {
    const r = reader.current
    if (!r || r.done || busy) return
    setBusy(true)
    try {
      await r.next(ctl.current?.signal)
      setVersion((v) => v + 1)
    } finally {
      setBusy(false)
    }
  }, [busy])

  const r = reader.current
  const lines = r?.state.lines ?? []
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard refused */
    }
  }
  const table = ext === 'csv' ? ',' : ext === 'tsv' ? '\t' : undefined
  // In-memory text counts characters; show sizes only for byte sources.
  const fmt = (n: number) => formatChipSize(n)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="file-viewer-dialog"
        className="flex h-[min(85vh,52rem)] flex-col gap-3 sm:max-w-[min(64rem,calc(100vw-2rem))] lg:max-w-[min(64rem,calc(100vw-2rem))] xl:max-w-[min(64rem,calc(100vw-2rem))]"
      >
        <div className="min-w-0 pe-10">
          <DialogTitle className="truncate text-sm font-medium">{title}</DialogTitle>
          <div className="text-[11px] text-muted-foreground">
            {[ext.toUpperCase(), meta].filter(Boolean).join(' · ')}
            {r && status === 'ready' ? (
              <> · {t('common:fileViewer.lines', { count: lines.length })}</>
            ) : null}
          </div>
        </div>
        {specRef.current.mode === 'lines' && status === 'ready' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={wrap ? 'secondary' : 'outline'}
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
            >
              <WrapText aria-hidden className="size-3.5" />
              {t('common:fileViewer.wrap')}
            </Button>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? (
                <Check aria-hidden className="size-3.5" />
              ) : (
                <Copy aria-hidden className="size-3.5" />
              )}
              {copied ? t('common:fileViewer.copied') : t('common:fileViewer.copy')}
            </Button>
            {specRef.current.truncated ? (
              <span data-testid="viewer-truncated" className="text-[11px] text-muted-foreground">
                {t('common:fileViewer.truncatedOnAdd', {
                  shown: fmt(specRef.current.truncated.shown),
                  total: fmt(specRef.current.truncated.total),
                })}
              </span>
            ) : null}
            {r && !r.done ? (
              <span
                data-testid="viewer-partial"
                className="text-[11px] text-muted-foreground"
              >
                {t('common:fileViewer.showingFirst', {
                  loaded: fmt(r.loaded),
                  total: r.size != null ? fmt(r.size) : '?',
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        {status === 'loading' ? (
          <div className="text-xs text-muted-foreground" role="status">
            {t('common:composerChip.previewLoading')}
          </div>
        ) : status === 'binary' || status === 'none' ? (
          <div className="text-xs text-muted-foreground" data-testid="viewer-none">
            {status === 'binary'
              ? t('common:fileViewer.binary')
              : t('common:composerChip.previewNone')}
          </div>
        ) : doc ? (
          <DocView preview={doc} />
        ) : (
          <LinesView lines={lines} version={version} wrap={wrap} table={table} />
        )}
        {r && !r.done && status === 'ready' ? (
          <div className="flex justify-center">
            <Button size="sm" variant="outline" disabled={busy} onClick={loadMore}>
              {t('common:fileViewer.loadMore')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
