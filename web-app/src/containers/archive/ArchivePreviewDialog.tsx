import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  archiveApi,
  formatBytes,
  type ArchivedItem,
  type ArchivePreview,
} from '@/lib/archive'

/** The short text and number fields of an item's `extra`, as label and value. */
export function extraFields(extra: unknown): [string, string][] {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return []
  return Object.entries(extra as Record<string, unknown>)
    .filter(
      ([, v]) =>
        (typeof v === 'string' && v.length > 0 && v.length <= 400) ||
        typeof v === 'number' ||
        typeof v === 'boolean'
    )
    .slice(0, 8)
    .map(([k, v]) => [k, String(v)])
}

/**
 * Reads the item's contents through `archive_preview` (bounded, read-only,
 * nothing restored). A failed read keeps the metadata block and says so.
 */
function usePreview(item: ArchivedItem | null) {
  const [state, setState] = useState<{
    key: string | null
    preview: ArchivePreview | null
    failed: boolean
  }>({ key: null, preview: null, failed: false })
  const key = item ? `${item.kind}/${item.archiveId}` : null
  useEffect(() => {
    if (!item || !key) return
    let live = true
    Promise.resolve()
      .then(() => archiveApi.preview(item.kind, item.archiveId))
      .then((preview) => live && setState({ key, preview, failed: false }))
      .catch(() => live && setState({ key, preview: null, failed: true }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // A result for an earlier item never shows under the current one.
  return state.key === key ? state : { key, preview: null, failed: false }
}

function PreviewContents({ item, preview }: { item: ArchivedItem; preview: ArchivePreview }) {
  const { t } = useTranslation()
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : null)
  const rows: [string, string | null][] = [
    [t('archive:previewCreated'), when(preview.createdAt)],
    [t('archive:previewUpdated'), when(preview.updatedAt)],
    [t('archive:previewFolder'), preview.folder ?? null],
    [t('archive:previewParticipants'), preview.participants.join(', ') || null],
    ...preview.fields.map((f): [string, string] => [f.label, f.value]),
  ]
  const total = preview.totalMessages
  const cut = total !== undefined && total > preview.messages.length
  return (
    <div className="space-y-3 text-xs" data-testid="archive-preview-contents">
      {preview.thumbnail && (
        <img
          src={preview.thumbnail}
          alt={t('archive:previewThumbnail')}
          className="max-h-40 rounded-md border"
        />
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
      </dl>
      {preview.instructions && (
        <div>
          <div className="text-muted-foreground mb-1">{t('archive:previewInstructions')}</div>
          <p className="whitespace-pre-wrap break-words">{preview.instructions}</p>
        </div>
      )}
      {preview.threads.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">{t('archive:previewThreads')}</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {preview.threads.map((title, i) => (
              <li key={i} className="break-words">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(item.kind === 'thread' || item.kind === 'room' || item.kind === 'cowork') && (
        <div>
          <div className="text-muted-foreground mb-1">
            {item.kind === 'cowork'
              ? t('archive:previewLastTurns')
              : t('archive:previewMessages')}
            {cut &&
              ` (${t('archive:previewShown', { shown: preview.messages.length, total })})`}
          </div>
          {preview.messages.length === 0 ? (
            <p className="text-muted-foreground">{t('archive:previewNoMessages')}</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto" data-testid="archive-preview-messages">
              {preview.messages.map((m, i) => (
                <li key={i} className="break-words">
                  <span className="font-medium">{m.role}: </span>
                  {m.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A read-only look at an archived item: the metadata block (title, kind,
 * dates, size, any short fields it was archived with) and, below it, what is
 * inside, read without restoring.
 */
export function ArchivePreviewDialog({
  item,
  onClose,
}: {
  item: ArchivedItem | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const extras = item ? extraFields(item.extra) : []
  const { preview, failed } = usePreview(item)
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="archive-preview">
        <DialogHeader>
          <DialogTitle className="truncate">
            {item?.title || t('archive:untitled')}
          </DialogTitle>
          <DialogDescription>{t('archive:previewNote')}</DialogDescription>
        </DialogHeader>
        {item && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">{t('archive:previewKind')}</dt>
            <dd>{t(`archive:kind.${item.kind}`)}</dd>
            <dt className="text-muted-foreground">{t('archive:previewArchived')}</dt>
            <dd>{new Date(item.archivedAt).toLocaleString()}</dd>
            <dt className="text-muted-foreground">{t('archive:previewSize')}</dt>
            <dd>{formatBytes(item.sizeBytes)}</dd>
            <dt className="text-muted-foreground">{t('archive:previewOrigin')}</dt>
            <dd className="break-all">{item.origin}</dd>
            {extras.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {item && preview && <PreviewContents item={item} preview={preview} />}
        {item && !preview && !failed && (
          <p className="text-xs text-muted-foreground">{t('archive:previewLoading')}</p>
        )}
        {item && failed && (
          <p className="text-xs text-muted-foreground" data-testid="archive-preview-failed">
            {t('archive:previewUnavailable')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
