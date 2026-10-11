import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { displayNameOf, extensionOf } from '@/lib/displayName'
import {
  previewFromBytes,
  previewKind,
  readCapped,
  textPreview,
  csvPreview,
  TEXT_CAP,
  ZIP_CAP,
  type FilePreview,
} from '@/lib/filePreview'
import { toAssetUrl } from '@/lib/assetPath'
import type { Attachment } from '@/types/attachment'

const ABSOLUTE = /^([a-z]:[\\/]|\\\\|\/|file:\/\/)/i

/**
 * How to read a composer attachment's first bytes, or null when there is
 * nothing to read (a browser upload keeps only its name). Text that was
 * already extracted is used as is; otherwise the file is read from disk,
 * capped.
 */
export function previewLoader(
  att: Pick<Attachment, 'name' | 'path' | 'fileType' | 'inlineContent' | 'size'>
): ((signal: AbortSignal) => Promise<FilePreview | null>) | null {
  const ext = (att.fileType || extensionOf(att.name ?? '')).toLowerCase()
  const kind = previewKind(ext)
  if (!kind) return null
  const zip = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  if (!zip && att.inlineContent) {
    const text = att.inlineContent.slice(0, TEXT_CAP)
    return async () =>
      kind === 'table'
        ? csvPreview(text, ext === 'tsv' ? '\t' : ',')
        : textPreview(text)
  }
  const path = att.path
  if (!path || !ABSOLUTE.test(path)) return null
  if (zip && typeof att.size === 'number' && att.size > ZIP_CAP) return null
  return async (signal) => {
    const url = await toAssetUrl(path)
    const bytes = await readCapped(url, zip ? ZIP_CAP : TEXT_CAP, signal, zip)
    return bytes ? previewFromBytes(ext, bytes) : null
  }
}

function PreviewBody({ preview }: { preview: FilePreview }) {
  if (preview.kind === 'table') {
    return (
      <table
        data-testid="file-preview-table"
        className="w-full table-fixed border-collapse text-[11px]"
      >
        <tbody>
          {preview.rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((c, j) => (
                <td key={j} className="truncate px-1 py-0.5" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (preview.kind === 'doc') {
    return (
      <div data-testid="file-preview-doc" className="space-y-1 text-xs">
        {preview.paragraphs.map((p, i) => (
          <p key={i} className="line-clamp-3">
            {p}
          </p>
        ))}
      </div>
    )
  }
  return (
    <pre
      data-testid="file-preview-text"
      className="max-h-40 overflow-hidden whitespace-pre font-mono text-[11px] leading-snug"
    >
      {preview.lines.join('\n')}
    </pre>
  )
}

/**
 * A chip body that opens a small popover: the file name and extension as the
 * title, the type and size, and, when it can be read cheaply, the first lines
 * or rows. Nothing is read until it is opened; closing or unmounting aborts.
 */
export function FilePreviewPopover({
  name,
  meta,
  load,
  className,
  children,
}: {
  /** Full name or path; only its display name is shown. */
  name: string
  meta?: string
  load?: ((signal: AbortSignal) => Promise<FilePreview | null>) | null
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<
    { status: 'idle' | 'loading' | 'none' } | { status: 'ready'; preview: FilePreview }
  >({ status: 'idle' })
  const loadRef = useRef(load)
  loadRef.current = load
  const title = displayNameOf(name)
  const ext = extensionOf(name).toUpperCase()

  useEffect(() => {
    const load = loadRef.current
    if (!open || !load || state.status === 'ready') return
    const ctl = new AbortController()
    setState({ status: 'loading' })
    const run = () =>
      load(ctl.signal)
        .then((p) => {
          if (ctl.signal.aborted) return
          setState(p ? { status: 'ready', preview: p } : { status: 'none' })
        })
        .catch(() => {
          if (!ctl.signal.aborted) setState({ status: 'none' })
        })
    // Never compete with typing: start when the browser is idle.
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number
      cancelIdleCallback?: (id: number) => void
    }
    const id = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 0)
    return () => {
      ctl.abort()
      if (w.requestIdleCallback) w.cancelIdleCallback?.(id)
      else window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        // An aborted load restarts the next time it opens.
        if (!v) setState((s) => (s.status === 'ready' ? s : { status: 'idle' }))
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={t('common:composerChip.details', { name: title })}
        className={className}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-3"
        data-testid="file-preview-popover"
      >
        <div className="mb-1 min-w-0">
          <div className="truncate text-sm font-medium" title={name}>
            {title}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {[ext, meta].filter(Boolean).join(' · ')}
          </div>
        </div>
        {state.status === 'ready' ? (
          <PreviewBody preview={state.preview} />
        ) : state.status === 'loading' ? (
          <div className="text-[11px] text-muted-foreground" role="status">
            {t('common:composerChip.previewLoading')}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            {t('common:composerChip.previewNone')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
