import { useState } from 'react'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CompactionRecord } from '@/lib/compaction'

/**
 * Shown in the transcript while a compaction is running, so `/compact` and an
 * automatic compaction are visible from the start instead of only once done.
 */
export function CompactingIndicator() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      data-testid="compacting-indicator"
      className="my-3 flex items-center gap-2 text-xs text-muted-foreground"
    >
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5 px-1.5 py-0.5">
        <Layers size={12} aria-hidden className="shrink-0 motion-safe:animate-pulse" />
        <span className="motion-safe:animate-pulse">{t('common:compaction.working')}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

/**
 * Where a conversation was compacted: a divider row naming how many earlier
 * messages the summary replaced, expandable to the summary itself. Shared by
 * Chat, Cowork and Rooms, so the event reads the same on every surface.
 *
 * The summary is model output about the conversation, rendered as plain text.
 */
export function CompactionDivider({
  record,
}: {
  record: Pick<CompactionRecord, 'summarizedCount' | 'summary'>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="compaction-divider" className="my-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted"
          title={open ? t('common:compaction.hideSummary') : t('common:compaction.showSummary')}
        >
          <Layers size={12} aria-hidden className="shrink-0" />
          <span>
            {t('common:compaction.divider', { count: record.summarizedCount })}
          </span>
          {open ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )}
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
      {open ? (
        <div
          data-testid="compaction-summary"
          className="mx-auto mt-2 max-w-[680px] whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-foreground/80"
        >
          {record.summary}
        </div>
      ) : null}
    </div>
  )
}
