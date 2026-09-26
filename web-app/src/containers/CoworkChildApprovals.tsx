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
 * the same answers, resolved through the same store. Each answer names the
 * request it is for, and the buttons pause after the list changes, so a click
 * meant for one request cannot land on the one that takes its place.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ShieldAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChangeDiff } from '@/components/ChangeDiff'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { useArmedAfterChange } from '@/hooks/useArmedAfterChange'

/** Is the person typing somewhere? Focus is never pulled out of a field. */
function isTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  return (
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  )
}

export function CoworkChildApprovals({
  sessionId,
}: {
  sessionId: string | null | undefined
}) {
  const { t } = useTranslation()
  const pending = useToolApprovalRequests((s) => s.pending)
  const queued = useToolApprovalRequests((s) => s.queued)
  const resolveApproval = useToolApprovalRequests((s) => s.resolveApproval)
  // Queued ones too: a child's request can wait behind another session's
  // request under the same call id, and it is answerable here on its own.
  const mine = useMemo(
    () =>
      allApprovalRequests({ pending, queued }).filter(
        (entry) => entry.origin && entry.threadId === sessionId
      ),
    [pending, queued, sessionId]
  )
  const shown = mine.map((entry) => entry.requestId).join('|')
  const armed = useArmedAfterChange(shown || undefined)
  const firstDeny = useRef<HTMLButtonElement | null>(null)

  // Focus starts on Deny, the answer that changes nothing, whenever a new
  // request takes the first place -- unless the person is typing, whose
  // keystrokes must never land on an approval.
  const firstId = mine[0]?.requestId
  useEffect(() => {
    if (!firstId || !armed) return
    if (isTyping(document.activeElement)) return
    firstDeny.current?.focus({ preventScroll: true })
  }, [firstId, armed])

  if (!sessionId || mine.length === 0) return null
  return (
    <section
      className="my-2 flex flex-col gap-2"
      aria-label="Changes waiting for your approval"
      data-testid="child-approvals"
    >
      {mine.map((entry, index) => (
        <div
          key={entry.requestId}
          // A separate object that waits on a person: a bordered card whose
          // warning header says so, not a failure colour on the whole block.
          className="overflow-hidden rounded-xl border-[0.8px] border-warning/40 bg-card text-xs shadow-lift motion-safe:animate-rise-in"
          data-testid="child-approval"
          data-approval-request={entry.requestId}
          data-origin={entry.origin}
          data-tool={entry.toolName}
        >
          <div className="flex items-start gap-2 border-b border-dashed border-warning/30 bg-warning-tint px-3 py-2.5 text-[13px] font-medium text-foreground">
            <ShieldAlertIcon
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden
            />
            <span className="min-w-0">
              {entry.origin}: <span className="font-mono">{entry.toolName}</span>{' '}
              {t('tools:toolApproval.needsApproval')}
            </span>
          </div>
          <div className="space-y-3 p-3">
            {/* What answering does, in plain words, before the buttons. */}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t('tools:toolApproval.childActionLabel')}
              </dt>
              <dd className="text-foreground">
                {t('tools:toolApproval.childAction', {
                  origin: entry.origin,
                  tool: entry.toolName,
                })}
              </dd>
              {entry.serverName ? (
                <>
                  <dt className="text-muted-foreground">
                    {t('tools:toolApproval.childResourcesLabel')}
                  </dt>
                  <dd className="break-all font-mono text-foreground">
                    {entry.serverName}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">
                {t('tools:toolApproval.childScopeLabel')}
              </dt>
              <dd className="text-foreground">
                {t('tools:toolApproval.childScope')}
              </dd>
              <dt className="text-muted-foreground">
                {t('tools:toolApproval.childDenyLabel')}
              </dt>
              <dd className="text-foreground">
                {t('tools:toolApproval.childDeny')}
              </dd>
            </dl>
            {entry.preview && (
              <ChangeDiff
                diff={entry.preview}
                label={t('tools:toolApproval.proposedChange')}
                testId="approval-preview"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                ref={index === 0 ? firstDeny : undefined}
                size="sm"
                variant="destructive"
                className="pointer-coarse:h-11"
                disabled={!armed}
                onClick={() =>
                  resolveApproval(entry.toolCallId, 'deny', entry.requestId)
                }
              >
                {t('tools:toolApproval.deny')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                disabled={!armed}
                onClick={() =>
                  resolveApproval(
                    entry.toolCallId,
                    'allow-once',
                    entry.requestId
                  )
                }
              >
                {t('tools:toolApproval.allowOnce')}
              </Button>
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}
