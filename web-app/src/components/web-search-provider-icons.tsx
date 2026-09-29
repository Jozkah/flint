import { cn } from '@/lib/utils'

const LOGOS: Record<string, string> = {
  exa: 'E',
  tavily: 'T',
  brave: 'B',
  serper: 'G',
  searxng: 'S',
  you: 'Y',
  duckduckgo: 'D',
}

/** Local provider marks: never fetch favicons from a third party. */
export function WebSearchProviderIcon({
  provider,
  className,
}: {
  provider: string
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-provider={provider}
      className={cn(
        'size-4 shrink-0 inline-flex items-center justify-center rounded-full border border-border-strong bg-muted text-[0.5rem] font-semibold text-fg-2',
        className
      )}
    >
      {LOGOS[provider] ?? '?'}
    </span>
  )
}
