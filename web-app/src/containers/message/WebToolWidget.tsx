import { memo, useMemo } from 'react'
import type { ToolUIPart } from 'ai'
import { GlobeIcon, SearchIcon } from 'lucide-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseCitationsFromToolOutput } from '@/lib/citation-parser'
import {
  isToolRunning,
  parseWebFetchOutput,
  type ToolCallBar,
} from '@/lib/toolPresentation'
import { hostOf, siteInitial } from '@/lib/webUrl'
import { ToolBar } from './ToolBar'

/** Dark tiles for the site letters, one per host so results tell apart. */
const FAVICON_TONES = ['#1f2937', '#24292f', '#334155', '#3f3f46', '#1e3a5f', '#3b2f4a']

const toneOf = (url: string) => {
  const host = hostOf(url)
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) | 0
  return FAVICON_TONES[Math.abs(h) % FAVICON_TONES.length]
}

/** The site's initial. Drawn here rather than fetched from a third party. */
const Favicon = ({ url }: { url: string }) => (
  <span
    aria-hidden
    style={{ background: toneOf(url) }}
    className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[10px] font-semibold uppercase text-white"
  >
    {siteInitial(url)}
  </span>
)

const ResultRow = ({
  url,
  title,
}: {
  url: string
  title?: string
}) => (
  <a
    href={url}
    target="_blank"
    rel="noreferrer noopener"
    className="-mx-1 flex min-w-0 items-center gap-2.5 rounded-md px-1 py-1.5 text-xs no-underline transition-colors hover:bg-hover-row focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:min-h-11"
    title={url}
  >
    <Favicon url={url} />
    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
      {title || hostOf(url)}
    </span>
    <span className="shrink-0 text-subtle-foreground">
      {hostOf(url)}
    </span>
  </a>
)

export type WebToolWidgetProps = {
  bar: Extract<ToolCallBar, { variant: 'search' | 'address' }>
  state: ToolUIPart['state']
  output?: ToolUIPart['output']
  errorText?: string
  /**
   * Inside a tool card, whose header already shows the query or address: the
   * bar is left out and only the results render.
   */
  embedded?: boolean
}

/**
 * Native web tool calls rendered as the thing they are: a search bar the model
 * types a query into, or an address bar it navigates to, followed by the
 * results. Replaces the raw argument/response JSON for these two tools.
 */
export const WebToolWidget = memo(
  ({ bar, state, output, errorText, embedded = false }: WebToolWidgetProps) => {
    const { t } = useTranslation()
    const running = isToolRunning(state)

    const searchResults = useMemo(() => {
      if (bar.variant !== 'search' || !output) return []
      const parsed = parseCitationsFromToolOutput(output)
      return parsed?.kind === 'web' ? parsed.citations : []
    }, [bar.variant, output])

    const page = useMemo(
      () => (bar.variant === 'address' && output ? parseWebFetchOutput(output) : undefined),
      [bar.variant, output]
    )

    return (
      <div className={embedded ? 'space-y-2' : 'space-y-2 px-2.5 py-2'}>
        {embedded ? null : bar.variant === 'search' ? (
          <ToolBar
            icon={<SearchIcon className="size-4" />}
            value={bar.query}
            placeholder={t('tools:toolCall.searchPlaceholder')}
            typing={running}
            trailing={
              bar.count !== undefined && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('tools:toolCall.resultLimit', { count: bar.count })}
                </span>
              )
            }
          />
        ) : (
          <ToolBar
            icon={<GlobeIcon className="size-4" />}
            value={bar.url}
            placeholder={t('tools:toolCall.addressPlaceholder')}
            typing={running}
            mono
            trailing={bar.url ? <Favicon url={bar.url} /> : undefined}
          />
        )}

        {errorText && (
          <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
            {errorText}
          </div>
        )}

        {running && !errorText && (
          <div className="px-2 text-sm">
            <Shimmer duration={1}>
              {bar.variant === 'search'
                ? t('tools:toolCall.searching')
                : t('tools:toolCall.opening')}
            </Shimmer>
          </div>
        )}

        {!running && !errorText && bar.variant === 'search' && (
          searchResults.length > 0 ? (
            <div className="flex flex-col">
              {searchResults.map((citation) => (
                <ResultRow
                  key={citation.url}
                  url={citation.url}
                  title={citation.title}
                />
              ))}
            </div>
          ) : (
            <p className="px-2 text-sm text-muted-foreground">
              {t('tools:toolCall.noResults')}
            </p>
          )
        )}

        {!running && !errorText && page && (
          <div className="space-y-1.5">
            {page.url && <ResultRow url={page.url} title={page.title} />}
            <div className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-code-bg px-2.5 py-2 font-mono text-xs text-fg-2 shadow-[inset_0_0_0_0.8px_var(--border)]">
              {page.content}
            </div>
            {page.truncated && (
              <p className="px-2 text-xs text-muted-foreground">
                {t('tools:toolCall.contentTruncated')}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }
)

WebToolWidget.displayName = 'WebToolWidget'
