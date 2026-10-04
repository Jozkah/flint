import { MessageCircleQuestion } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useSubagentQuestions } from '@/lib/coworkSubagentQuestions'

/**
 * Questions this session's background subagents asked the agent. Plain text:
 * the question is a child's own words. Read-only; the agent answers.
 */
export function CoworkSubagentQuestions({
  sessionId,
}: {
  sessionId: string | null | undefined
}) {
  const { t } = useTranslation()
  const all = useSubagentQuestions((s) => s.questions)
  const mine = useMemo(
    () => all.filter((q) => q.sessionId === sessionId),
    [all, sessionId]
  )
  if (mine.length === 0) return null
  return (
    <div className="my-2 space-y-2">
      {mine.map((q) => (
        <section
          key={q.id}
          data-testid={`subagent-question-${q.id}`}
          className="space-y-1 rounded-md border border-border px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <MessageCircleQuestion size={14} aria-hidden className="shrink-0" />
            <h3 className="font-medium text-foreground">
              {t('messaging:subagentQuestion.title', { name: q.agentName })}
            </h3>
            <span data-testid="subagent-question-status" role="status">
              {t(`messaging:subagentQuestion.${q.status}`)}
            </span>
          </div>
          <p
            data-testid="subagent-question-text"
            className="whitespace-pre-wrap break-words"
          >
            {q.question}
          </p>
          {q.answer !== undefined && (
            <p
              data-testid="subagent-question-answer"
              className="whitespace-pre-wrap break-words text-muted-foreground"
            >
              {q.answer}
            </p>
          )}
        </section>
      ))}
    </div>
  )
}
