import { memo } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { useWebCitationStore } from '@/stores/web-citation-store'
import { cn } from '@/lib/utils'
import { hostOf, siteInitial } from '@/lib/webUrl'
import { SiteIcon } from '@/components/SiteIcon'

export const WebCitationChip = memo(
  ({ messageId, url }: { messageId?: string; url: string }) => {
    const citation = useWebCitationStore((s) =>
      messageId ? s.byMessageId[messageId]?.[url] : undefined
    )
    const host = hostOf(url)
    const initial = siteInitial(url)
    return (
      <HoverCard openDelay={80} closeDelay={120}>
        <HoverCardTrigger asChild>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="mx-0.5 inline-flex translate-y-[-0.15em] align-baseline no-underline"
            title={citation?.title || url}
          >
            <SiteIcon
              url={url}
              className="inline-block size-3.5 rounded-full border border-border/60 bg-white object-contain hover:ring-2 hover:ring-primary/40"
              fallback={
                <span
                  aria-hidden
                  className="inline-block size-3.5 inline-flex items-center justify-center rounded-full border border-border/60 bg-muted text-[0.5rem] font-medium uppercase text-muted-foreground hover:ring-2 hover:ring-primary/40"
                >
                  {initial}
                </span>
              }
            />
          </a>
        </HoverCardTrigger>
        <HoverCardContent
          align="start"
          side="top"
          className="w-72 space-y-2 p-3 text-xs"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-4 shrink-0 inline-flex items-center justify-center rounded-full border border-border/60 bg-muted text-[0.5rem] font-medium uppercase text-muted-foreground"
            >
              {initial}
            </span>
            <span className="truncate text-muted-foreground">{host}</span>
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className={cn('block truncate font-medium hover:underline')}
          >
            {citation?.title || host}
          </a>
          {citation?.text && (
            <p className="line-clamp-4 whitespace-pre-wrap leading-relaxed text-muted-foreground">
              {citation.text}
            </p>
          )}
        </HoverCardContent>
      </HoverCard>
    )
  }
)
WebCitationChip.displayName = 'WebCitationChip'
