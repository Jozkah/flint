import type { ReactNode } from 'react'
import { Chip } from '@/components/ui/chip'
import { diffStat } from '@/components/ChangeDiff'
import type { ToolCallBar, parseBashOutput } from '@/lib/toolPresentation'
import { cn } from '@/lib/utils'

const textOf = (output: unknown): string =>
  typeof output === 'string'
    ? output
    : typeof (output as { content?: unknown })?.content === 'string'
      ? (output as { content: string }).content
      : ''

/** "5 passed" from a test runner's summary line, when the output has one. */
const PASSED = /\b(\d+) passed\b/

/** Five small squares, filled by the share of added against removed lines. */
const diffBlocks = (add: number, del: number) => {
  const total = add + del
  const green = total === 0 ? 0 : Math.round((add / total) * 5)
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <i
          key={i}
          className={cn(
            'size-[7px] rounded-[2px]',
            total === 0
              ? 'bg-border'
              : i < green
                ? 'bg-success'
                : 'bg-destructive'
          )}
        />
      ))}
    </span>
  )
}

/**
 * A short outcome beside the argument, from the call's own result: a
 * command's exit or passed tests, a search's match count, an edit's +/-.
 * Each input is set only when the card would show it (a finished call).
 */
export const toolBadge = ({
  bash,
  exitFailed,
  bar,
  output,
  diff,
  t,
}: {
  bash?: ReturnType<typeof parseBashOutput>
  exitFailed: boolean
  bar?: ToolCallBar
  output: unknown
  diff?: string
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactNode => {
  // A short outcome beside the argument, from the call's own result.
  if (bash) {
    const passed = PASSED.exec(bash.text)?.[1]
    if (exitFailed) {
      return bash.signaled ? (
        <Chip tone="err" dot>
          {t('tools:toolCall.terminated')}
        </Chip>
      ) : (
        <Chip tone="warn" dot className="tabular-nums">
          {t('tools:toolCall.exitCode', { code: bash.exit })}
        </Chip>
      )
    } else if (passed) {
      return (
        <Chip tone="ok" dot className="tabular-nums">
          {t('tools:toolCall.testsPassed', { count: Number(passed) })}
        </Chip>
      )
    }
  } else if (
    bar?.variant === 'workspace' &&
    (bar.tool === 'grep' || bar.tool === 'find')
  ) {
    const lines = textOf(output)
      .split('\n')
      .filter((l) => l.trim()).length
    if (lines > 0) {
      return (
        <span className="text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground tabular-nums">
          {t('tools:toolCall.matches', { count: lines })}
        </span>
      )
    }
  } else if (diff) {
    const { add, del } = diffStat(diff)
    return (
      <>
        <span className="inline-flex gap-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)] font-medium tabular-nums">
          <span className="text-success">+{add}</span>
          <span className="text-destructive">−{del}</span>
        </span>
        {diffBlocks(add, del)}
      </>
    )
  }
  return null
}
