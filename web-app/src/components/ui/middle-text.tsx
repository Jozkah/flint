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
      <span className="min-w-0 truncate">{text.slice(0, cut)}</span>
      <span className="shrink-0">{text.slice(cut)}</span>
    </span>
  )
}

export { MiddleText }
