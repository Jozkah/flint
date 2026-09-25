import { Check, CircleSlash, Clock } from 'lucide-react'
import { CoworkAskCard } from '@/containers/CoworkAskCard'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AskAnswer, AskRecord, TodoList } from '@/types/coworkSession'

/**
 * One question, at the point in the conversation where it was asked.
 *
 * While it is waiting it is the card. Once it has been answered, skipped, or
 * left behind by a run that is gone, it collapses to a line saying what
 * happened -- it does not disappear, because "what was I asked, and what did I
 * say" is part of the transcript.
 *
 * Staleness is derived rather than stored: a pending question whose run is no
 * longer active cannot be answered, because nothing is waiting for the answer.
 */
export function CoworkAskEntry({
  record,
  running,
  onRespond,
  plan,
}: {
  record: AskRecord
  /** The session's staged todos, for a plan review card. */
  plan?: TodoList | null
  /** Whether the run that asked is still alive. */
  running: boolean
  onRespond: (requestId: string, answers: AskAnswer[] | null) => void
}) {
  const { t } = useTranslation()
  const state = record.state === 'pending' && !running ? 'stale' : record.state

  if (state === 'pending') {
    return (
      <div className="py-1" data-testid="ask-entry" data-state="pending">
        <CoworkAskCard
          requestId={record.requestId}
          request={record.request}
          onRespond={onRespond}
          plan={plan}
        />
      </div>
    )
  }

  const Icon =
    state === 'answered' ? Check : state === 'cancelled' ? CircleSlash : Clock
  const questions = record.request.questions ?? []

  return (
    <div
      className="py-1"
      data-testid="ask-entry"
      data-state={state}
      aria-disabled={state === 'stale'}
    >
      <div
        className={cn(
          'flex items-start gap-2.5 rounded-xl border-[0.8px] border-dashed border-border-strong bg-card px-3 py-2.5 text-[13px] motion-safe:animate-fade-in',
          state === 'stale' && 'opacity-70'
        )}
      >
        <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {questions.map((question) => {
            const answer = record.answers?.find((a) => a.id === question.id)
            return (
              <div key={question.id} className="flex flex-col gap-0.5 py-0.5">
                <span className="font-semibold text-foreground text-pretty">
                  {question.question}
                </span>
                <span
                  className="text-[12.5px] text-muted-foreground text-pretty"
                  data-testid="ask-entry-answer"
                >
                  {state === 'answered'
                    ? summarize(answer)
                    : state === 'cancelled'
                      ? t('common:askSkipped')
                      : t('common:askStale')}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** What was chosen: the selected labels, or the text that was typed. */
function summarize(answer: AskAnswer | undefined): string {
  if (!answer) return '—'
  if (answer.custom_input?.trim()) return answer.custom_input.trim()
  return answer.selected.length > 0 ? answer.selected.join(', ') : '—'
}

export default CoworkAskEntry
