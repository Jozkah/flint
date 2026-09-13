import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { answerFor, buildOptions } from '@/lib/askOptions'
import type { AskAnswer, AskRequestPayload } from '@/types/coworkSession'

/** Square check used by the option rows. No checkbox primitive exists in `ui/`. */
function CheckSquare({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        // `mt-[3px]` puts the box on the cap height of the first line of the
        // label rather than the line box, so it reads as aligned with the text
        // whether the label wraps or not.
        'mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-md border transition-colors',
        checked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-line-strong'
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </span>
  )
}

/**
 * Inline card for the agent core's `ask` tool (see interaction.rs), rendered in
 * the transcript at the point the run asked -- the run is paused, but the user
 * can still scroll and type a normal reply instead of answering.
 *
 * One question at a time with paging, because a request may carry several.
 */
export function CoworkAskCard({
  requestId,
  request,
  onRespond,
}: {
  requestId: string | null
  request: AskRequestPayload | null
  onRespond: (requestId: string, answers: AskAnswer[] | null) => void
}) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  /** Option ids, never labels: a label can change under a streamed update. */
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})

  // A new request is a clean slate; keeping prior picks would silently answer
  // the next question with the previous one's selections.
  useEffect(() => {
    setIndex(0)
    setSelected({})
    setCustom({})
  }, [requestId])

  const questions = useMemo(() => request?.questions ?? [], [request])
  const question = questions[index]

  const fallbackLabel = t('common:askSomethingElse')
  /**
   * Rows per question, so the ids a selection refers to stay valid while the
   * user pages back and forth.
   */
  const rowsByQuestion = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildOptions>>()
    for (const q of questions) {
      map.set(q.id, buildOptions(q.options, fallbackLabel))
    }
    return map
  }, [questions, fallbackLabel])

  const isAnswered = (qid: string) => {
    const picks = selected[qid] ?? []
    if (picks.length === 0) return false
    const rows = rowsByQuestion.get(qid) ?? []
    const usingCustom = picks.some((id) => rows.find((r) => r.id === id)?.isCustom)
    return usingCustom ? !!custom[qid]?.trim() : true
  }
  // The core rejects a response that doesn't answer every question exactly
  // once (`validate_results`), so submit stays closed until all are answered.
  const allAnswered = useMemo(
    () => questions.length > 0 && questions.every((q) => isAnswered(q.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, selected, custom, rowsByQuestion]
  )

  if (!requestId || !question) return null

  const rows = rowsByQuestion.get(question.id) ?? []
  const picks = selected[question.id] ?? []
  const isLast = index === questions.length - 1

  const toggle = (id: string) => {
    setSelected((prev) => {
      const current = prev[question.id] ?? []
      const row = rows.find((r) => r.id === id)
      // Free text is exclusive with options: the contract allows one or the
      // other on a `QuestionResult`, never both.
      if (row?.isCustom) {
        return { ...prev, [question.id]: current.includes(id) ? [] : [id] }
      }
      const customIds = rows.filter((r) => r.isCustom).map((r) => r.id)
      const withoutCustom = current.filter((c) => !customIds.includes(c))
      if (!question.multi) {
        return {
          ...prev,
          [question.id]: withoutCustom.includes(id) ? [] : [id],
        }
      }
      return {
        ...prev,
        [question.id]: withoutCustom.includes(id)
          ? withoutCustom.filter((c) => c !== id)
          : [...withoutCustom, id],
      }
    })
  }

  const submit = () => {
    onRespond(
      requestId,
      questions.map((q) =>
        answerFor(
          q,
          rowsByQuestion.get(q.id) ?? [],
          selected[q.id] ?? [],
          custom[q.id] ?? ''
        )
      )
    )
  }

  const advance = () => (isLast ? submit() : setIndex((i) => i + 1))
  // Declining resolves the whole request as cancelled — the core has no
  // per-question skip, since every question must come back answered.
  const decline = () => onRespond(requestId, null)

  const selectedCount = picks.filter(
    (id) => !rows.find((r) => r.id === id)?.isCustom
  ).length

  return (
    <div
      className="w-full overflow-hidden rounded-lg border bg-card"
      data-testid="cowork-ask-card"
      role="group"
      aria-label={question.question}
    >
      {/* Header: the question, with paging and dismiss kept out of its column
          so a long question wraps against the card edge, not the controls. */}
      <div className="flex items-start gap-2 px-3 pt-3 pb-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-5 text-pretty">
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          {questions.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                aria-label={t('common:askPrev')}
                className="rounded-md p-0.5 hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-0.5 text-xs tabular-nums">
                {index + 1}/{questions.length}
              </span>
              <button
                type="button"
                onClick={() =>
                  setIndex((i) => Math.min(questions.length - 1, i + 1))
                }
                disabled={isLast}
                aria-label={t('common:askNext')}
                className="rounded-md p-0.5 hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={decline}
            aria-label={t('common:close')}
            className="rounded-md p-0.5 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Choices: one consistent vertical rhythm, inset from the card edge so
          nothing touches it, and the descriptions indented under their own
          labels rather than under the control. */}
      <div className="flex flex-col gap-px px-2 pb-2">
        {rows.map((row, i) => {
          const checked = picks.includes(row.id)
          return (
            <div key={row.id}>
              <button
                type="button"
                role={question.multi ? 'checkbox' : 'radio'}
                aria-checked={checked}
                onClick={() => toggle(row.id)}
                data-testid={row.isCustom ? 'ask-custom-option' : 'ask-option'}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
                  'hover:bg-sunken focus-visible:outline-none',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  checked && 'bg-sunken'
                )}
              >
                <CheckSquare checked={checked} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-5">
                    {row.label}
                    {question.recommended === i && row.fromModel && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        {t('common:askRecommended')}
                      </span>
                    )}
                  </span>
                  {row.description && (
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground text-pretty">
                      {row.description}
                    </span>
                  )}
                </span>
              </button>
              {/* The input belongs to the row that revealed it, indented to
                  the label column so it reads as part of that choice. */}
              {row.isCustom && checked && (
                <Input
                  autoFocus
                  value={custom[question.id] ?? ''}
                  onChange={(e) =>
                    setCustom((prev) => ({
                      ...prev,
                      [question.id]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isAnswered(question.id)) {
                      e.preventDefault()
                      advance()
                    }
                  }}
                  placeholder={t('common:askSomethingElsePlaceholder')}
                  data-testid="ask-custom-input"
                  className="mt-1 mb-1 ml-8 h-8 w-[calc(100%-2.5rem)]"
                />
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {question.multi && selectedCount > 0
            ? t('common:askSelectedCount', { count: selectedCount })
            : null}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7" onClick={decline}>
            {t('common:skip')}
          </Button>
          <Button
            size="icon-sm"
            className="rounded-full"
            disabled={isLast ? !allAnswered : !isAnswered(question.id)}
            // Distinct from the chevron's `askNext`: that only pages the view,
            // this is the primary action (record this answer, then move on).
            aria-label={isLast ? t('common:submit') : t('common:askContinue')}
            onClick={advance}
          >
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}
