import { memo } from 'react'
import { cn } from '@/lib/utils'
import { splitReasoningParagraphs } from '@/lib/reasoning'

type StepRowProps = {
  text: string
  connector?: boolean
}

const StepRow = ({ text, connector = false }: StepRowProps) => (
  <li className="relative flex gap-2.5">
    {connector && (
      <span className="absolute left-[3px] top-3.5 -bottom-2.5 border-l border-dotted border-border" />
    )}
    <span className="relative z-10 mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
    <div
      dir="auto"
      className="select-text whitespace-pre-wrap wrap-break-word text-sm text-main-view-fg/70"
    >
      {text}
    </div>
  </li>
)

/**
 * Full stepped reasoning trace — one dot-railed step per paragraph, joined by a
 * single dotted connector. Shown when reasoning has finished (or for historical
 * messages) where the whole trace is revealed on expand.
 */
export const ReasoningTimeline = memo(({ text }: { text: string }) => {
  const steps = splitReasoningParagraphs(text)
  if (steps.length === 0) return null
  return (
    <ol className="relative flex flex-col gap-2.5">
      {steps.map((step, i) => (
        <StepRow key={i} text={step} connector={i < steps.length - 1} />
      ))}
    </ol>
  )
})

/**
 * While reasoning streams, show only the most recently *completed* paragraph as
 * plain text — never the paragraph currently being written. As the model
 * finishes each paragraph and starts the next, the derived last-completed
 * paragraph swaps, so exactly one bounded block is visible at a time instead of
 * the whole growing trace.
 */
export const ReasoningActiveStep = memo(({ text }: { text: string }) => {
  const steps = splitReasoningParagraphs(text)
  // The final element is the in-progress paragraph; the one before it is the
  // last paragraph the model has actually finished.
  const completed = steps.slice(0, -1)
  const current = completed[completed.length - 1] ?? ''
  if (!current) return null
  // Key by paragraph index so each swap remounts the block, replaying the
  // fade/collapse enter transition as one paragraph gives way to the next.
  return (
    <div
      key={completed.length}
      dir="auto"
      className={cn(
        'select-text whitespace-pre-wrap wrap-break-word text-sm text-main-view-fg/70',
        'animate-in fade-in-0 slide-in-from-top-1 duration-300 ease-out'
      )}
    >
      {current}
    </div>
  )
})

ReasoningTimeline.displayName = 'ReasoningTimeline'
ReasoningActiveStep.displayName = 'ReasoningActiveStep'
