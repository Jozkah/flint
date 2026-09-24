import { memo, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Citations, type WebCitation } from '@/components/Citations'
import { hostOf, siteInitial } from '@/lib/webUrl'
import { summarizeWebSources } from '@/lib/webSources'

const NO_READS: string[] = []

export const WebSourcesRow = memo(
  ({
    citations,
    readUrls = NO_READS,
  }: {
    citations: WebCitation[]
    /** Pages the reply fetched and read, counted apart from search hits. */
    readUrls?: string[]
  }) => {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)

    const { sources: unique, read, found } = useMemo(
      () => summarizeWebSources(citations, readUrls),
      [citations, readUrls]
    )

    if (!unique.length) return null

    // One chip per site: four pages from one domain are one letter, not four.
    const preview: WebCitation[] = []
    const hosts = new Set<string>()
    for (const c of unique) {
      const host = hostOf(c.url)
      if (hosts.has(host)) continue
      hosts.add(host)
      preview.push(c)
      if (preview.length === 4) break
    }

    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-2 rounded-full border bg-card/40 py-1 pl-1.5 pr-2.5 text-xs text-muted-foreground transition-colors hover:bg-card/70"
          aria-expanded={expanded}
        >
          <span className="flex -space-x-1.5">
            {preview.map((c) => (
              <span
                key={c.url}
                aria-hidden
                className="size-4 inline-flex items-center justify-center rounded-full border border-border/60 bg-muted text-[0.5rem] font-medium uppercase text-muted-foreground"
              >
                {siteInitial(c.url)}
              </span>
            ))}
          </span>
          <span className="font-medium">
            {read === 0
              ? t('chat:webSources', { count: found })
              : found === 0
                ? t('chat:webSourcesRead', { count: read })
                : t('chat:webSourcesReadFound', { read, found })}
          </span>
          <ChevronRightIcon
            className={cn(
              'size-3 shrink-0 transition-transform',
              expanded && 'rotate-90'
            )}
          />
        </button>
        {expanded && (
          <Citations payload={{ kind: 'web', citations: unique }} />
        )}
      </div>
    )
  }
)
WebSourcesRow.displayName = 'WebSourcesRow'
