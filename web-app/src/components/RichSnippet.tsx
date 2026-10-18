import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { richSnippet, type RichSnippetPart } from '@/lib/richSnippet'

type Props = {
  /** Raw snippet text (Markdown) as the search backend returned it. */
  text: string
  /** The query to mark; empty marks nothing. */
  query: string
  className?: string
}

function partClass(part: RichSnippetPart): string {
  return cn(
    part.bold && 'font-semibold',
    part.italic && 'italic',
    part.strike && 'line-through',
    part.link && 'text-primary underline underline-offset-2',
    part.code && 'rounded-[3px] bg-muted px-[3px] font-mono text-[0.92em]'
  )
}

/**
 * A search snippet with its Markdown shown formatted and the query marked.
 * Built from text nodes only: message text never reaches innerHTML.
 */
export const RichSnippet = memo(function RichSnippet({ text, query, className }: Props) {
  const parts = useMemo(() => richSnippet(text, query), [text, query])
  return (
    <span data-testid="rich-snippet" className={cn('line-clamp-2 break-words', className)}>
      {parts.map((part, i) => {
        const cls = partClass(part)
        const inner = cls ? (
          <span className={cls} data-style={styleTag(part)}>
            {part.text}
          </span>
        ) : (
          part.text
        )
        return part.match ? (
          <mark key={i} className="rounded-[3px] bg-mark px-px text-foreground">
            {inner}
          </mark>
        ) : (
          <span key={i}>{inner}</span>
        )
      })}
    </span>
  )
})

function styleTag(part: RichSnippetPart): string {
  return ['bold', 'italic', 'code', 'strike', 'link']
    .filter((k) => part[k as keyof RichSnippetPart])
    .join(' ')
}
