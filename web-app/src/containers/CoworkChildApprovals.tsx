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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ChevronDown, PauseCircle, ShieldAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { approvalPreviewText } from '@/lib/approvalPreview'
import { Button } from '@/components/ui/button'
import { ChangeDiff } from '@/components/ChangeDiff'
import { SecretWriteDetails } from '@/containers/SecretWriteDetails'
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
  compact = false,
}: {
  sessionId: string | null | undefined
  /**
   * One line per request (who, what, the command) with the answers inline
   * and the plain-words details behind Details; a held request is a slim
   * banner. Used where the prompt shares a small dock with the composer.
   */
  compact?: boolean
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
  // A typed reason per request; absent while that request's field is closed.
  const [reasons, setReasons] = useState<Record<string, string>>({})

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
  if (compact) {
    return (
      <section
        className="flex flex-col gap-2"
        aria-label={t('permissions:childApprovals.label')}
        data-testid="child-approvals"
        data-compact="true"
      >
        {mine.map((entry, index) => (
          <CompactApproval
            key={entry.requestId}
            entry={entry}
            armed={armed}
            denyRef={index === 0 ? firstDeny : undefined}
            onAnswer={(answer) => resolveApproval(entry.toolCallId, answer, entry.requestId)}
          />
        ))}
      </section>
    )
  }
  return (
    <section
      className="my-2 flex flex-col gap-2"
      aria-label={t('permissions:childApprovals.label')}
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
          <div className="flex items-start gap-2 border-b border-dashed border-warning/30 bg-warning-tint px-3 py-2.5 text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
            <ShieldAlertIcon
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden
            />
            <span className="min-w-0">
              {entry.origin}: <span className="font-mono">{entry.toolName}</span>{' '}
              {t('tools:toolApproval.needsApproval')}
            </span>
            {entry.held && (
              <span
                data-testid="approval-held"
                className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-muted-foreground"
              >
                {t('rooms:approvals.held')}
              </span>
            )}
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
            {entry.secret && <SecretWriteDetails findings={entry.secret} />}
            {entry.preview && (
              <ChangeDiff
                diff={entry.preview}
                label={t('tools:toolApproval.proposedChange')}
                testId="approval-preview"
              />
            )}
            {entry.held && (
              <p className="text-muted-foreground" data-testid="approval-held-hint">
                {t('rooms:approvals.heldHint')}
              </p>
            )}
            {reasons[entry.requestId] !== undefined && (
              <textarea
                data-testid="approval-deny-reason"
                aria-label={t('tools:toolApproval.denyReasonLabel')}
                placeholder={t('tools:toolApproval.denyReasonPlaceholder')}
                className="min-h-16 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                value={reasons[entry.requestId]}
                onChange={(e) =>
                  setReasons((r) => ({ ...r, [entry.requestId]: e.target.value }))
                }
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
                  resolveApproval(
                    entry.toolCallId,
                    'deny',
                    entry.requestId,
                    reasons[entry.requestId]?.trim() || undefined
                  )
                }
              >
                {entry.held ? t('rooms:approvals.dismiss') : t('tools:toolApproval.deny')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                // A held prompt's run is gone: there is nothing to allow.
                disabled={!armed || Boolean(entry.held)}
                onClick={() =>
                  resolveApproval(
                    entry.toolCallId,
                    'allow-once',
                    entry.requestId
                  )
                }
              >
                {entry.secret
                  ? t('permissions:secretWrite.writeAnyway')
                  : t('tools:toolApproval.allowOnce')}
              </Button>
              {/* Only a server's run is told the reason over the wire. */}
              {!entry.held && entry.origin === 'server' && (
                <button
                  type="button"
                  data-testid="approval-deny-reason-toggle"
                  aria-expanded={reasons[entry.requestId] !== undefined}
                  className="rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:min-h-11"
                  onClick={() =>
                    setReasons((r) => {
                      const next = { ...r }
                      if (next[entry.requestId] === undefined) next[entry.requestId] = ''
                      else delete next[entry.requestId]
                      return next
                    })
                  }
                >
                  {t('tools:toolApproval.denyWithReason')}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

type Entry = ReturnType<typeof allApprovalRequests>[number]

function CompactApproval({
  entry,
  armed,
  denyRef,
  onAnswer,
}: {
  entry: Entry
  armed: boolean
  denyRef?: React.Ref<HTMLButtonElement>
  onAnswer: (answer: 'deny' | 'allow-once') => void
}) {
  const { t } = useTranslation()
  // A file change is shown before it can be allowed, as in the full card.
  const [details, setDetails] = useState(Boolean(entry.preview || entry.secret))
  const command = approvalPreviewText(entry.input)
  const common = {
    'data-testid': 'child-approval',
    'data-approval-request': entry.requestId,
    'data-origin': entry.origin,
    'data-tool': entry.toolName,
  }
  if (entry.held) {
    // Its run is gone: nothing to weigh up, only to put away.
    return (
      <div
        {...common}
        data-held="true"
        role="status"
        className="flex min-w-0 items-center gap-2 rounded-xl border-[0.8px] border-border bg-card px-3 py-2 text-xs text-muted-foreground motion-safe:animate-rise-in"
      >
        <PauseCircle aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1" data-testid="approval-held-hint">
          {t('rooms:approvals.heldBanner')}
        </span>
        <Button
          ref={denyRef}
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 rounded-lg px-2.5 text-xs pointer-coarse:h-11"
          disabled={!armed}
          onClick={() => onAnswer('deny')}
        >
          {t('rooms:approvals.dismiss')}
        </Button>
      </div>
    )
  }
  return (
    <div
      {...common}
      className="min-w-0 rounded-xl border-[0.8px] border-border bg-card px-3 py-2 text-xs motion-safe:animate-rise-in"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2">
          <ShieldAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 truncate text-foreground" data-testid="approval-summary">
            <span className="font-medium">
              {t('rooms:approvals.wantsToRun', { origin: entry.origin, tool: entry.toolName })}
            </span>
            {command && (
              <code
                className="ml-1.5 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-fg-2"
                title={command}
                data-testid="approval-command"
              >
                {command}
              </code>
            )}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-lg px-2.5 text-xs pointer-coarse:h-11"
            aria-expanded={details}
            data-testid="approval-details-toggle"
            onClick={() => setDetails((v) => !v)}
          >
            {t('rooms:approvals.details')}
            <ChevronDown aria-hidden className={cn('size-3 transition-transform', details && 'rotate-180')} />
          </Button>
          <Button
            ref={denyRef}
            size="sm"
            variant="destructive"
            className="h-7 rounded-lg px-2.5 text-xs pointer-coarse:h-11"
            disabled={!armed}
            onClick={() => onAnswer('deny')}
          >
            {t('tools:toolApproval.deny')}
          </Button>
          <Button
            size="sm"
            className="h-7 rounded-lg px-2.5 text-xs pointer-coarse:h-11"
            disabled={!armed}
            onClick={() => onAnswer('allow-once')}
          >
            {entry.secret
              ? t('permissions:secretWrite.writeAnyway')
              : t('tools:toolApproval.allowOnce')}
          </Button>
        </span>
      </div>
      {details && (
        <div className="mt-2 space-y-2 border-t border-dashed border-border pt-2" data-testid="approval-details">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t('tools:toolApproval.childActionLabel')}</dt>
            <dd className="text-foreground">
              {t('tools:toolApproval.childAction', { origin: entry.origin, tool: entry.toolName })}
            </dd>
            {entry.serverName ? (
              <>
                <dt className="text-muted-foreground">{t('tools:toolApproval.childResourcesLabel')}</dt>
                <dd className="break-all font-mono text-foreground">{entry.serverName}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('tools:toolApproval.childScopeLabel')}</dt>
            <dd className="text-foreground">{t('tools:toolApproval.childScope')}</dd>
            <dt className="text-muted-foreground">{t('tools:toolApproval.childDenyLabel')}</dt>
            <dd className="text-foreground">{t('tools:toolApproval.childDeny')}</dd>
          </dl>
          {command && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)]">
              {command}
            </pre>
          )}
          {entry.secret && <SecretWriteDetails findings={entry.secret} />}
          {entry.preview && (
            <ChangeDiff diff={entry.preview} label={t('tools:toolApproval.proposedChange')} testId="approval-preview" />
          )}
        </div>
      )}
    </div>
  )
}
