import { memo } from 'react'
import type React from 'react'
import { cn } from '@/lib/utils'
import { segmentReasoningSteps } from '@/lib/reasoning'

type StepRowProps = {
  text?: string
  /**
   * Kept for callers that still pass it; the rail is one continuous line drawn
   * by the list (`TIMELINE_RAIL`), so a step no longer draws its own piece.
   */
  connector?: boolean
  children?: React.ReactNode
  /** Replaces the dot: the step is a closing line (e.g. "Done") on the rail. */
  marker?: React.ReactNode
  /** Position in the list, for the staggered entrance. */
  index?: number
}

/**
 * The list a trace's steps hang off: one smooth, solid line down the left,
 * with each step's dot sitting on it.
 */
export const TIMELINE_RAIL =
  'relative ml-1.5 flex flex-col gap-2.5 border-l-[1.5px] border-solid border-border-strong pl-[18px]'

/**
 * One step on the timeline: a small ringed dot on the rail plus content. Pass
 * `text` for a plain reasoning paragraph, or `children` to host arbitrary
 * content (e.g. a tool call) on the same rail. A step holding a tool call takes
 * that call's kind colour for its dot (styles/chat.css), so the rail doubles
 * as a legend for the cards beside it.
 */
export const StepRow = ({ text, children, marker, index = 0 }: StepRowProps) => {
  if (marker) {
    return (
      <li
        data-slot="step-done"
        className="flex items-center gap-1.5 text-xs text-success [&_svg]:size-3.5"
      >
        {marker}
        <span>{text}</span>
      </li>
    )
  }
  return (
    <li
      data-slot="step-row"
      className="relative min-w-0 motion-safe:animate-cot-in"
      style={{ animationDelay: `${0.08 + Math.min(index, 9) * 0.06}s` }}
    >
      <span
        aria-hidden
        data-slot="step-dot"
        className="pointer-events-none absolute top-3 left-[-18.75px] z-10 size-2 -translate-x-1/2 rounded-full"
      />
      {children ? (
        <div className="min-w-0">{children}</div>
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
