import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes, type ArchivedItem } from '@/lib/archive'

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
 * A read-only look at an archived item. The archive commands list an item's
 * details but not its contents (reading those needs a Rust `archive_preview`),
 * so this shows what the list holds: title, kind, dates, size and any short
 * fields the item was archived with.
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
      </DialogContent>
    </Dialog>
  )
}
