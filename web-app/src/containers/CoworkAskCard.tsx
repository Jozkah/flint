import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { answerFor, buildOptions } from '@/lib/askOptions'
import type { AskAnswer, AskRequestPayload } from '@/types/coworkSession'

/**
 * The option mark: a radio dot for a single choice, a square for several. No
 * checkbox primitive exists in `ui/`.
 */
function OptionMark({ checked, multi }: { checked: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        // `mt-[2px]` puts the mark on the cap height of the first line of the
        // label rather than the line box, so it reads as aligned with the text
        // whether the label wraps or not.
        'mt-[2px] flex size-4 shrink-0 items-center justify-center border-[1.5px] transition-[border-color,border-width,background-color] duration-150 ease-expo',
        multi ? 'rounded-[5px]' : 'rounded-full',
        checked
          ? multi
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-[4px] border-primary'
          : 'border-border-strong'
      )}
    >
      {checked && multi && <Check size={11} strokeWidth={3} />}
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
      className="flex w-full flex-col gap-1.5 overflow-hidden rounded-xl border-[0.8px] border-border-strong bg-card p-3 shadow-lift motion-safe:animate-rise-in"
      data-testid="cowork-ask-card"
      role="group"
      aria-label={question.question}
    >
      {/* Header: the question, with paging and dismiss kept out of its column
          so a long question wraps against the card edge, not the controls. */}
      <div className="mb-1 flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13.5px] font-semibold leading-5 text-pretty">
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
                className="grid size-6 place-items-center rounded-md transition-colors hover:bg-hover-btn hover:text-foreground disabled:opacity-30"
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
                className="grid size-6 place-items-center rounded-md transition-colors hover:bg-hover-btn hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={decline}
            aria-label={t('common:close')}
            className="ml-1 grid size-6 place-items-center rounded-md transition-colors hover:bg-hover-btn hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Choices: one consistent vertical rhythm, inset from the card edge so
          nothing touches it, and the descriptions indented under their own
          labels rather than under the control. */}
      <div className="-mx-1 flex flex-col gap-px">
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
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  'outline-none hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40'
                )}
              >
                <OptionMark checked={checked} multi={Boolean(question.multi)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-5 font-medium">
                    {row.label}
                    {question.recommended === i && row.fromModel && (
                      <span className="ml-1.5 inline-flex h-[18px] items-center rounded-[5px] bg-success-tint px-1.5 align-[1px] text-[10.5px] font-medium text-success">
                        {t('common:askRecommended')}
                      </span>
                    )}
                  </span>
                  {row.description && (
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground text-pretty">
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
                  className="mt-1 mb-1 ml-9 h-8 w-[calc(100%-2.75rem)]"
                />
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-dashed border-border pt-1.5 text-xs">
        <span className="text-muted-foreground">
          {question.multi && selectedCount > 0
            ? t('common:askSelectedCount', { count: selectedCount })
            : null}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="surface" size="sm" onClick={decline}>
            {t('common:skip')}
          </Button>
          <Button
            size="sm"
            disabled={isLast ? !allAnswered : !isAnswered(question.id)}
            // Distinct from the chevron's `askNext`: that only pages the view,
            // this is the primary action (record this answer, then move on).
            aria-label={isLast ? t('common:submit') : t('common:askContinue')}
            onClick={advance}
          >
            {isLast ? t('common:submit') : t('common:askContinue')}
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  )
}
