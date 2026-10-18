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
import { stringSource, urlSource } from '@/lib/fileChunks'
import { FileViewerDialog, type ViewerSpec } from '@/containers/FileViewerDialog'

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

/**
 * The readable form of a file chip on a sent message: its inline text from
 * the message metadata (matched by name), else its id when that is a path.
 */
export function sentAttachment(
  file: { id: string; name: string; type?: string; size?: number },
  metadata?: Record<string, unknown>
): Pick<Attachment, 'name' | 'path' | 'fileType' | 'inlineContent' | 'size'> {
  const inline = metadata?.inline_file_contents
  const hit = Array.isArray(inline)
    ? (inline as Array<{ name?: string; content?: string; path?: string }>).find(
        (f) => f?.name === file.name && typeof f.content === 'string'
      )
    : undefined
  return {
    name: file.name,
    fileType: file.type,
    size: file.size,
    inlineContent: hit?.content,
    path: ABSOLUTE.test(file.id)
      ? file.id
      : hit?.path && ABSOLUTE.test(hit.path)
        ? hit.path
        : undefined,
  }
}

/** UTF-8 size of a string, without encoding it. */
function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

const MEDIA = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'pdf',
])

/**
 * How the full viewer reads an attachment, or null when it cannot: text is
 * read in chunks (inline text sliced, a file by byte range); Office files
 * are parsed with higher limits. Images keep their own viewer.
 */
export function viewerSpec(
  att: Pick<Attachment, 'name' | 'path' | 'fileType' | 'inlineContent' | 'size'>
): ViewerSpec | null {
  const ext = (att.fileType || extensionOf(att.name ?? '')).toLowerCase()
  if (MEDIA.has(ext)) return null
  const kind = previewKind(ext)
  const zip = kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
  const inline = att.inlineContent
  const path = att.path
  if (!zip && inline) {
    // Inline text is capped when it is added: a file larger than what was kept
    // is read from disk when it still can be, and otherwise says it is cut.
    const shown = utf8Bytes(inline)
    const cut = typeof att.size === 'number' && att.size > shown
    if (!cut) return { mode: 'lines', open: async () => stringSource(inline) }
    if (!path || !ABSOLUTE.test(path)) {
      return {
        mode: 'lines',
        open: async () => stringSource(inline),
        truncated: { shown, total: att.size as number },
      }
    }
  }
  if (!path || !ABSOLUTE.test(path)) return null
  if (zip) {
    if (typeof att.size === 'number' && att.size > ZIP_CAP) return null
    return {
      mode: 'doc',
      load: async (signal) => {
        const bytes = await readCapped(await toAssetUrl(path), ZIP_CAP, signal, true)
        return bytes ? previewFromBytes(ext, bytes, 500) : null
      },
    }
  }
  return {
    mode: 'lines',
    open: async () =>
      urlSource(await toAssetUrl(path), typeof att.size === 'number' ? att.size : null),
  }
}

function PreviewBody({ preview }: { preview: FilePreview }) {
  if (preview.kind === 'table') {
    return (
      <table
        data-testid="file-preview-table"
        className="w-full table-fixed border-collapse text-[length:calc(var(--ui-font-base)*0.6875)]"
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
      className="max-h-40 overflow-hidden whitespace-pre font-mono text-[length:calc(var(--ui-font-base)*0.6875)] leading-snug"
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
  viewer,
  className,
  children,
}: {
  /** Full name or path; only its display name is shown. */
  name: string
  meta?: string
  load?: ((signal: AbortSignal) => Promise<FilePreview | null>) | null
  /** When set, an "Open full preview" button opens the full viewer. */
  viewer?: ViewerSpec | null
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
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
    <>
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
          <div className="truncate text-sm font-medium">
            {title}
          </div>
          <div className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
            {[ext, meta].filter(Boolean).join(' · ')}
          </div>
        </div>
        {state.status === 'ready' ? (
          <PreviewBody preview={state.preview} />
        ) : state.status === 'loading' ? (
          <div className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground" role="status">
            {t('common:composerChip.previewLoading')}
          </div>
        ) : (
          <div className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">
            {t('common:composerChip.previewNone')}
          </div>
        )}
        {viewer ? (
          <button
            type="button"
            data-testid="file-preview-open-full"
            onClick={() => {
              setOpen(false)
              setFull(true)
            }}
            className="mt-2 w-full rounded-md border-[0.8px] border-border bg-card px-2 py-1 text-xs font-medium hover:bg-hover-btn focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            {t('common:fileViewer.openFull')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
    {viewer && full ? (
      <FileViewerDialog
        open={full}
        onOpenChange={setFull}
        name={name}
        meta={meta}
        spec={viewer}
      />
    ) : null}
    </>
  )
}
