/**
 * Approval prompts from a run's subagents and team children.
 *
 * A child's tool calls happen in its own conversation, which is not a message
 * on screen, so the prompt that sits under a tool card has nowhere to appear.
 * Before this, a child's change in Ask mode was shown only when its call id
 * happened to match a card in the parent's transcript -- which a provider that
 * numbers calls per response makes likely for the first call and impossible
 * for the second -- and otherwise the child waited forever with nothing on
 * screen. Found by the AH-109 Windows scenario.
 *
 * Every request here is the same request a card would show: the same diff,
 * the same answers, resolved through the same store.
 */
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ShieldAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChangeDiff } from '@/components/ChangeDiff'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

export function CoworkChildApprovals({
  sessionId,
}: {
  sessionId: string | null | undefined
}) {
  const { t } = useTranslation()
  const pending = useToolApprovalRequests((s) => s.pending)
  const resolveApproval = useToolApprovalRequests((s) => s.resolveApproval)
  const mine = Object.values(pending).filter(
    (entry) => entry.origin && entry.threadId === sessionId
  )
  if (!sessionId || mine.length === 0) return null
  return (
    <section
      className="my-2 flex flex-col gap-2"
      aria-label="Changes waiting for your approval"
      data-testid="child-approvals"
    >
      {mine.map((entry) => (
        <div
          key={entry.toolCallId}
          className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
          data-testid="child-approval"
          data-origin={entry.origin}
          data-tool={entry.toolName}
        >
          <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
            <ShieldAlertIcon className="size-4" />
            <span>
              {entry.origin}: <span className="font-mono">{entry.toolName}</span>{' '}
              {t('tools:toolApproval.needsApproval')}
            </span>
          </div>
          {entry.preview && (
            <ChangeDiff
              diff={entry.preview}
              label={t('tools:toolApproval.proposedChange')}
              testId="approval-preview"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => resolveApproval(entry.toolCallId, 'deny')}
            >
              {t('tools:toolApproval.deny')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => resolveApproval(entry.toolCallId, 'allow-once')}
            >
              {t('tools:toolApproval.allowOnce')}
            </Button>
          </div>
        </div>
      ))}
    </section>
  )
}
