import { cn } from '@/lib/utils'

/**
 * One line of text that, when the room runs out, loses its middle rather than
 * its end: the head shrinks with an ellipsis and the last `tail` characters
 * always stay (a file's quant and extension). Plain CSS, so it follows the
 * cell's actual width instead of a guessed character count.
 */
function MiddleText({
  text,
  tail = 14,
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  text: string
  tail?: number
}) {
  const cut = Math.max(0, text.length - tail)
  return (
    <span
      className={cn('flex min-w-0 whitespace-nowrap', className)}
      {...props}
    >
      {/* The split halves are drawn from attributes, so the page text (what
          assistive tech, find-in-page and copy see) is the whole name once. */}
      <span className="sr-only">{text}</span>
      <span
        aria-hidden
        data-text={text.slice(0, cut)}
        className="min-w-0 overflow-hidden text-ellipsis whitespace-pre before:content-[attr(data-text)]"
      />
      <span
        aria-hidden
        data-text={text.slice(cut)}
        className="shrink-0 whitespace-pre before:content-[attr(data-text)]"
      />
    </span>
  )
}

export { MiddleText }
