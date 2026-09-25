import { memo } from 'react'
import type React from 'react'
import { cn } from '@/lib/utils'
import { segmentReasoningSteps } from '@/lib/reasoning'

type StepRowProps = {
  text?: string
  connector?: boolean
  children?: React.ReactNode
  marker?: React.ReactNode
}

/**
 * One step on the dotted timeline rail: a small ringed dot plus content, with
 * an optional dotted connector descending to the next step. Pass `text` for a
 * plain reasoning paragraph, or `children` to host arbitrary content (e.g. a
 * tool call) on the same continuous rail. A step holding a tool call takes
 * that call's kind colour for its dot (styles/chat.css), so the rail doubles
 * as a legend for the cards beside it.
 */
export const StepRow = ({
  text,
  connector = false,
  children,
  marker,
}: StepRowProps) => {
  // A card's header is taller than a line of text: centre the dot on it.
  const dotTop = children ? 'top-3' : 'top-[7px]'
  return (
  <li data-slot="step-row" className="relative flex gap-3">
    {connector && (
      <span
        aria-hidden
        className={cn(
          'absolute left-[3px] -bottom-2.5 border-l-[1.5px] border-dotted border-border-strong',
          children ? 'top-5' : 'top-4'
        )}
      />
    )}
    {marker ? (
      <span className="relative z-10 mt-1 flex w-[7px] shrink-0 items-center justify-center">
        <span className="absolute flex items-center justify-center bg-card">
          {marker}
        </span>
      </span>
    ) : (
      <span className="relative w-[7px] shrink-0">
        <span
          aria-hidden
          data-slot="step-dot"
          className={cn(
            'absolute left-0 z-10 size-[7px] rounded-full bg-card shadow-[0_0_0_1.5px_var(--border-strong)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
            dotTop
          )}
        />
      </span>
    )}
    {children ? (
      <div className="min-w-0 flex-1">{children}</div>
    ) : (
      <div
        dir="auto"
        className="select-text whitespace-pre-wrap wrap-break-word text-[13px] leading-[1.55] text-muted-foreground"
      >
        {text}
      </div>
    )}
  </li>
  )
}

export type ReasoningStepMode = 'settled' | 'live'

/**
 * One bounded block of a streaming reasoning trace, rather than the whole
 * growing text. `settled` shows the last step the model actually finished, so
 * the condensed view does not shift under the reader; `live` shows the step
 * being written, so tokens appear as they arrive. Steps are budget-bounded, so
 * either mode advances even when the model never emits a paragraph break.
 */
export const ReasoningActiveStep = memo(
  ({ text, mode = 'settled' }: { text: string; mode?: ReasoningStepMode }) => {
    const steps = segmentReasoningSteps(text)
    // The final element is always the step in progress.
    const index = mode === 'live' ? steps.length - 1 : steps.length - 2
    const current = index >= 0 ? steps[index] : undefined
    if (!current) return null
    // Key by step index so each swap remounts the block, replaying the
    // fade/collapse enter transition as one step gives way to the next. A step
    // keeps its key while it grows, so it is not remounted on every token.
    return (
      <div
        key={index}
        dir="auto"
        className={cn(
          'select-text whitespace-pre-wrap wrap-break-word text-[13px] leading-[1.55] text-muted-foreground',
          'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 duration-300 ease-out'
        )}
      >
        {current}
      </div>
    )
  }
)

ReasoningActiveStep.displayName = 'ReasoningActiveStep'
