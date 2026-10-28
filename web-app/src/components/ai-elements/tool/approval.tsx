/* eslint-disable react-refresh/only-export-components */
import { cn } from '@/lib/utils'
import { ChevronDownIcon, MoreHorizontalIcon } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { canTemporarilyAllowGit, useToolApprovalRequests, wasCommandAllowedOnce, usePendingApprovalCount } from '@/hooks/useToolApprovalRequests'
import { useArmedAfterChange } from '@/hooks/useArmedAfterChange'
import { useConversationPane } from '@/hooks/conversationPaneContext'
import { approvalForCall } from '@/lib/toolApprovalScope'
import { describePermissionRequest, requestSubject } from '@/lib/permissionRequest'
import { PermissionRequestDetails, formatPermissionMessage, type PermissionDecision } from '@/containers/PermissionRequestDetails'
import { SecretWriteDetails } from '@/containers/SecretWriteDetails'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { isTypingTarget } from '@/lib/fileDrop'
import { EVERYWHERE_CHOICE, scopeFromChoiceId } from '@/lib/approvalScopes'
import type { ApprovalChoice } from '@/hooks/useToolApprovalRequests'
import { commandEditable } from '@/lib/commandEditable'
import { Chip } from '@/components/ui/chip'
import { CampaignPlanCard, planCardOf, usePlanDraftStore } from '@/components/campaign/PlanEditor'
import { ChangeDiff } from '@/components/ChangeDiff'
import { useTool } from './shared'

/** The options of a structured choice as radios, the selected one marked. */
function ApprovalChoiceRadios({
  choice,
  value,
  disabled,
  onChange,
  idPrefix,
}: {
  choice: ApprovalChoice
  value: string
  disabled: boolean
  onChange: (id: string) => void
  idPrefix: string
}) {
  const questionId = `${idPrefix}-question`
  return (
    <div
      data-testid="approval-choice"
      className="flex min-w-0 flex-col gap-1.5"
    >
      <span
        id={questionId}
        className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground"
      >
        {choice.question}
      </span>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        aria-labelledby={questionId}
        className="gap-1.5"
      >
        {choice.options.map((option) => {
          const inputId = `${idPrefix}-${option.id}`
          return (
            <label
              key={option.id}
              htmlFor={inputId}
              data-selected={value === option.id}
              className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-left has-data-[state=checked]:border-(--tk) pointer-coarse:min-h-11"
            >
              <RadioGroupItem
                id={inputId}
                value={option.id}
                className="mt-0.5"
              />
              <span className="min-w-0 text-[length:calc(var(--ui-font-base)*0.8125)] leading-snug">
                <b className="font-medium text-foreground">{option.label}</b>
                {option.description && (
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </RadioGroup>
    </div>
  )
}

/**
 * A pending request, as the one expanded step of the timeline: what is asked
 * (tool, workspace, the full command), why, what allowing it means, then the
 * decision. "Allow once" is the one filled answer; broader grants sit behind
 * "More options", each with its explanation, and none is chosen for the user.
 */
export const ToolApprovalActions = memo(() => {
  const { t } = useTranslation()
  const { toolCallId } = useTool()
  const paneThreadId = useConversationPane()?.threadId
  const pending = useToolApprovalRequests((s) =>
    approvalForCall(s, toolCallId, paneThreadId)
  )
  const resolveApproval = useToolApprovalRequests((s) => s.resolveApproval)
  const chooseOption = useToolApprovalRequests((s) => s.chooseOption)
  // When this request is answered, the next one under the same call id takes
  // its place under the same buttons. They pause first, so a double-click or a
  // repeated key cannot answer a request that was never read.
  const armed = useArmedAfterChange(pending?.requestId)
  const planDirty = usePlanDraftStore((s) => s.dirty)
  const threadPendingCount = usePendingApprovalCount(pending?.threadId)
  // One announcement per thread, from its oldest waiting request, so several
  // pending requests do not all speak at once.
  const isFirstInThread = useToolApprovalRequests((s) =>
    pending
      ? Object.values(s.pending).find((e) => e.threadId === pending.threadId)
          ?.toolCallId === toolCallId
      : false
  )
  // The user already allowed this exact command once here: say so, open the
  // broader options and mark "Allow in this conversation". It is still their
  // click, and "Allow once" stays the filled answer.
  const repeatedCommand = useToolApprovalRequests((s) =>
    pending && !pending.origin
      ? wasCommandAllowedOnce(
          s,
          pending.threadId,
          pending.toolName,
          pending.input
        )
      : false
  )
  const request = useMemo(
    () =>
      pending
        ? describePermissionRequest({
            toolName: pending.toolName,
            input: pending.input,
            serverName: pending.serverName,
            workspaceLabel: pending.workspaceLabel,
            taskContext: pending.taskContext,
            threadIsEphemeral: pending.threadIsEphemeral,
            alwaysAsk: pending.alwaysAsk,
            conversationProgram: pending.conversationProgram,
          })
        : undefined,
    [pending]
  )
  const [moreOpen, setMoreOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The secondary answers (details, more options, deny with a reason, edit)
  // sit behind one "..." button beside Deny and Allow once.
  const [linksOpen, setLinksOpen] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const setEditedCommand = useToolApprovalRequests((s) => s.setEditedCommand)
  const denyRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const moreId = useId()
  const editedNoteId = `${moreId}-edited`
  const requestId = pending?.requestId

  // Each new request starts with its details closed (the broader options open
  // only for a repeated command) and focus on Deny, so a reflexive Enter never
  // grants anything.
  useEffect(() => {
    setMoreOpen(Boolean(repeatedCommand))
    setDetailsOpen(false)
    setReasonOpen(false)
    setReason('')
    setEditOpen(false)
    setDraft('')
  }, [requestId, repeatedCommand])
  // Focus goes to Deny once per new request, and never out of a field the
  // person is typing in (the composer keeps its caret while they write).
  const focusedRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (requestId === undefined || focusedRequest.current === requestId) return
    focusedRequest.current = requestId
    if (isTypingTarget(document.activeElement)) return
    denyRef.current?.focus({ preventScroll: true })
  }, [requestId])

  // A subagent's request is not this card's: its call id is only unique inside
  // the child's own conversation, so it can coincide with a card here and would
  // be answered from the wrong place. It is shown on its own (see
  // `CoworkChildApprovals`).
  if (!pending || !toolCallId || pending.origin || !request) return null

  // Only a shell command can be rewritten before it is allowed once.
  const originalCommand =
    commandEditable(pending) &&
    typeof (pending.input as { command?: unknown } | undefined)?.command ===
      'string'
      ? (pending.input as { command: string }).command
      : undefined
  const commandEdited =
    editOpen && draft.trim() !== '' && draft.trim() !== originalCommand?.trim()
  const decide = (
    decision: PermissionDecision | 'allow-git-temporary'
  ) => {
    if (decision === 'allow-once' && commandEdited) {
      setEditedCommand(toolCallId, pending.requestId, draft)
    }
    resolveApproval(toolCallId, decision, pending.requestId)
  }
  const broader = request.scopesOffered.filter(
    (scope) => scope !== 'allow-once' && request.scopeExplanations[scope]
  )
  const temporaryGit = canTemporarilyAllowGit(
    pending.toolName,
    pending.input,
    pending.threadIsEphemeral === true
  )
  const once = request.scopeExplanations['allow-once']
  // "Always" on a file change or a command asks how far it reaches. That form
  // sits under "Always" itself, so the row names what the choice means.
  const scopeFormChoice =
    pending.scopeForm && pending.choice ? pending.choice : undefined
  const chosenScopeId = pending.chosenId ?? scopeFormChoice?.defaultId
  const chosenScope = scopeFormChoice
    ? scopeFromChoiceId(chosenScopeId, pending.scopeForm?.options ?? [])
    : null
  const alwaysEverywhere =
    !scopeFormChoice || chosenScopeId === EVERYWHERE_CHOICE
  const subject = requestSubject(pending.input, request.resources)
  const planCard = planCardOf(pending.toolName, pending.input)
  const planUnsaved = Boolean(planCard && planDirty[planCard.campaignId])
  const pendingText =
    threadPendingCount === 1
      ? t('permissions:pending.one')
      : t('permissions:pending.many', { count: threadPendingCount })

  return (
    <section
      data-testid="inline-approval-card"
      data-slot="approval-panel"
      data-approval-request={pending.requestId}
      aria-labelledby={titleId}
      // A container: a narrow card (a phone, a split pane) stacks its rows and
      // gives its answers the full width, whatever the window's width.
      className="@container/approval flex min-w-0 flex-col gap-2.5 p-3 text-foreground sm:p-3.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[length:calc(var(--ui-font-base)*0.8125)]">
        <span className="font-medium text-(--tk)">
          {t('tools:toolApproval.approvalNeeded')}
        </span>
        <Chip tone="warn" data-testid="approval-tool">
          {pending.toolName}
        </Chip>
        {isFirstInThread && threadPendingCount > 1 && (
          <span
            className="ml-auto text-xs text-muted-foreground tabular-nums"
            aria-hidden
          >
            {pendingText}
          </span>
        )}
      </div>
      {isFirstInThread && (
        <p role="status" aria-live="polite" className="sr-only">
          {pendingText}
        </p>
      )}
      <h3
        id={titleId}
        className="min-w-0 text-[length:calc(var(--ui-font-base)*0.9375)] leading-snug font-semibold wrap-break-word text-foreground"
      >
        {pending.secret
          ? t('permissions:secretWrite.title')
          : formatPermissionMessage(t, request.action)}
      </h3>
      {/* A write the credential scan stopped: where, which rule, the masked
          line. The answers below are for this one write only. */}
      {pending.secret && <SecretWriteDetails findings={pending.secret} />}
      {subject && (
        <pre
          data-testid="approval-subject"
          tabIndex={0}
          className="max-h-48 min-w-0 overflow-auto rounded-lg bg-code-bg px-3 py-2 font-mono text-[length:calc(var(--ui-font-base)*0.78125)] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground shadow-[inset_0_0_0_0.8px_var(--border)]"
        >
          {subject}
        </pre>
      )}
      {/* What will land, before it is allowed (AH-146). */}
      {pending.preview && (
        <ChangeDiff
          diff={pending.preview}
          label={t('tools:toolApproval.proposedChange')}
          testId="approval-preview"
        />
      )}
      {/* The code block already shows what it touches in full. */}
      <PermissionRequestDetails
        request={subject ? { ...request, resources: [] } : request}
        showAction={false}
        showTechnicalDetails={false}
        layout="rows"
      />
      {/* The campaign plan: estimate, task list and the editor. */}
      {planCard && (
        <CampaignPlanCard
          campaignId={planCard.campaignId}
          estimate={planCard.estimate}
          tasks={planCard.tasks}
        />
      )}
      {planUnsaved && (
        <p
          role="status"
          data-testid="plan-unsaved-notice"
          className="text-xs text-warning"
        >
          {t('settings:campaigns.plan.saveFirst')}
        </p>
      )}
      {/* A structured choice the request asks for with its answer (the
          campaign plan: how tasks work). The recommended one is selected. */}
      {pending.choice && !scopeFormChoice && (
        <ApprovalChoiceRadios
          choice={pending.choice}
          value={pending.chosenId ?? pending.choice.defaultId}
          disabled={!armed}
          onChange={(id) => chooseOption(toolCallId, pending.requestId, id)}
          idPrefix={`${titleId}-choice`}
        />
      )}
      {repeatedCommand && (
        <p
          data-testid="approval-repeat-notice"
          className="text-xs text-muted-foreground"
        >
          {t('permissions:repeat.allowedOnceBefore')}
        </p>
      )}
      {/* Answers name this request, so a click cannot land on the next one. */}
      <div
        role="group"
        aria-label={t('permissions:request.chooseScope')}
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
      >
        <button
          type="button"
          hidden={Boolean(pending.secret)}
          aria-expanded={linksOpen}
          aria-controls={`${moreId}-links`}
          aria-label={t('common:more')}
          title={t('common:more')}
          data-testid="approval-links-toggle"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-hidden hover:bg-hover-btn hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:bg-hover-btn aria-expanded:text-foreground pointer-coarse:size-11"
          onClick={() => setLinksOpen((open) => !open)}
        >
          <MoreHorizontalIcon aria-hidden className="size-4" />
        </button>
        <div
          id={`${moreId}-links`}
          hidden={!linksOpen && !pending.secret}
          className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        >
          <button
            type="button"
            hidden={Boolean(pending.secret)}
            aria-expanded={detailsOpen}
            data-testid="approval-details-toggle"
            className="rounded-sm text-acc-text underline-offset-4 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {t('tools:toolApproval.permissionDetails')}
          </button>
          <button
            type="button"
            hidden={Boolean(pending.secret)}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            data-testid="approval-more-options"
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
            onClick={() => setMoreOpen((open) => !open)}
          >
            {t('tools:toolApproval.moreOptions')}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                'size-3 motion-safe:transition-transform',
                moreOpen && 'rotate-180'
              )}
            />
          </button>
          <button
            type="button"
            aria-expanded={reasonOpen}
            data-testid="approval-deny-reason-toggle"
            className="rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
            onClick={() => {
              setReasonOpen((open) => !open)
              setEditOpen(false)
            }}
          >
            {t('tools:toolApproval.denyWithReason')}
          </button>
          {originalCommand !== undefined && (
            <button
              type="button"
              aria-expanded={editOpen}
              data-testid="approval-edit-toggle"
              className="rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
              onClick={() => {
                setEditOpen((open) => !open)
                setReasonOpen(false)
                setDraft(originalCommand)
              }}
            >
              {t('tools:toolApproval.editCommand')}
            </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 @max-[30rem]/approval:min-w-0 @max-[30rem]/approval:whitespace-normal">
          <Button
            ref={denyRef}
            size="sm"
            variant="destructive"
            type="button"
            disabled={!armed || (reasonOpen && reason.trim() === '')}
            data-scope={reasonOpen ? 'deny-with-reason' : 'deny'}
            className="min-w-16 border-destructive/40 pointer-coarse:h-11 @max-[30rem]/approval:min-w-0 @max-[30rem]/approval:h-auto @max-[30rem]/approval:min-h-7 @max-[30rem]/approval:whitespace-normal"
            onClick={() =>
              reasonOpen
                ? resolveApproval(toolCallId, 'deny', pending.requestId, reason)
                : decide('deny')
            }
          >
            {reasonOpen
              ? t('tools:toolApproval.denyAndSend')
              : t('permissions:scope.deny')}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={!armed || planUnsaved}
            data-scope="allow-once"
            data-primary="true"
            aria-describedby={once ? `${moreId}-once` : undefined}
            className="min-w-20 pointer-coarse:h-11 @max-[30rem]/approval:min-w-0 @max-[30rem]/approval:h-auto @max-[30rem]/approval:min-h-7 @max-[30rem]/approval:whitespace-normal"
            onClick={() => decide('allow-once')}
          >
            {pending.secret
              ? t('permissions:secretWrite.writeAnyway')
              : t('permissions:scope.allowOnce')}
          </Button>
          {once && (
            <span id={`${moreId}-once`} className="sr-only">
              {formatPermissionMessage(t, once.explanation)}
            </span>
          )}
        </div>
        {editOpen && originalCommand !== undefined && (
          <div
            data-testid="approval-edit"
            className="flex w-full min-w-0 flex-col gap-1.5"
          >
            <label
              htmlFor={`${moreId}-edit`}
              className="text-xs font-medium text-foreground"
            >
              {t('tools:toolApproval.editCommandLabel')}
            </label>
            <Textarea
              id={`${moreId}-edit`}
              value={draft}
              rows={3}
              autoFocus
              spellCheck={false}
              className="font-mono text-[length:calc(var(--ui-font-base)*0.78125)]"
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {commandEdited
                ? t('tools:toolApproval.editCommandNote')
                : t('tools:toolApproval.editCommandHint')}
            </p>
          </div>
        )}
        {reasonOpen && (
          <div
            data-testid="approval-deny-reason"
            className="flex w-full min-w-0 flex-col gap-2"
          >
            <label
              htmlFor={`${moreId}-reason`}
              className="text-xs font-medium text-foreground"
            >
              {t('tools:toolApproval.denyReasonLabel')}
            </label>
            <Textarea
              id={`${moreId}-reason`}
              value={reason}
              maxLength={500}
              rows={2}
              autoFocus
              placeholder={t('tools:toolApproval.denyReasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}
        {moreOpen && (
          <ul
            id={moreId}
            data-testid="approval-scope-menu"
            className="flex w-full min-w-0 flex-col divide-y divide-border overflow-hidden rounded-md border border-border"
          >
            {temporaryGit && (
              <li className="flex">
                <button
                  type="button"
                  aria-describedby={`${moreId}-allow-git-temporary`}
                  data-scope="allow-git-temporary"
                  disabled={!armed}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors outline-hidden hover:bg-hover-row focus-visible:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11"
                  onClick={() => decide('allow-git-temporary')}
                >
                  <b className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                    {t('permissions:scope.allowGitTemporary')}
                  </b>
                  <Chip tone="warn">{t('permissions:scope.broader')}</Chip>
                  <span
                    id={`${moreId}-allow-git-temporary`}
                    className="w-full text-xs leading-snug text-muted-foreground"
                  >
                    {t('permissions:scope.allowGitTemporaryExplanation')}
                  </span>
                </button>
              </li>
            )}
            {commandEdited && broader.length > 0 && (
              <li
                id={editedNoteId}
                data-testid="approval-edited-note"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                {t('permissions:scope.editedRunsOnce')}
              </li>
            )}
            {broader.map((scope) => {
              const info = request.scopeExplanations[scope]!
              const explanationId = `${moreId}-${scope}`
              // With the scope form, "Always" says what was chosen below it.
              const formRow = scope === 'allow-always' && scopeFormChoice
              const named =
                formRow && chosenScope?.type === 'folder'
                  ? {
                      label: t('permissions:scopeForm.alwaysFolder', {
                        dir: chosenScope.dir,
                      }),
                      explanation: t(
                        'permissions:scopeForm.alwaysFolderExplanation'
                      ),
                    }
                  : formRow && chosenScope?.type === 'command_prefix'
                    ? {
                        label: t('permissions:scopeForm.alwaysPrefix', {
                          prefix: chosenScope.prefix,
                        }),
                        explanation: t(
                          'permissions:scopeForm.alwaysPrefixExplanation'
                        ),
                      }
                    : undefined
              const label = named?.label ?? formatPermissionMessage(t, info.label)
              return (
                <li key={scope} className="flex flex-col">
                  <button
                    type="button"
                    aria-label={label}
                    aria-describedby={
                      commandEdited
                        ? `${explanationId} ${editedNoteId}`
                        : explanationId
                    }
                    data-scope={scope}
                    data-suggested={
                      (repeatedCommand && scope === 'allow-thread') || undefined
                    }
                    disabled={!armed || planUnsaved || commandEdited}
                    className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors outline-hidden hover:bg-hover-row focus-visible:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 data-suggested:border-l-2 data-suggested:border-l-warning pointer-coarse:min-h-11"
                    onClick={() => decide(scope)}
                  >
                    <b className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                      {label}
                    </b>
                    {info.broader && (!formRow || alwaysEverywhere) && (
                      <Chip tone="warn">{t('permissions:scope.broader')}</Chip>
                    )}
                    <span
                      id={explanationId}
                      // With the scope radios below, each choice carries its
                      // own hint: the heading's explanation would repeat it,
                      // so it stays for assistive tech only.
                      className={cn(
                        'w-full text-xs leading-snug text-muted-foreground',
                        named && 'sr-only'
                      )}
                    >
                      {named?.explanation ??
                        formatPermissionMessage(t, info.explanation)}
                    </span>
                  </button>
                  {formRow && (
                    <div className="px-3 pt-1 pb-2.5">
                      <ApprovalChoiceRadios
                        choice={scopeFormChoice}
                        value={chosenScopeId ?? scopeFormChoice.defaultId}
                        disabled={!armed}
                        onChange={(id) =>
                          chooseOption(toolCallId, pending.requestId, id)
                        }
                        idPrefix={`${titleId}-scope`}
                      />
                    </div>
                  )}
                </li>
              )
            })}
            {!temporaryGit && broader.length === 0 && (
              <li
                data-testid="approval-no-broader-options"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                {t('permissions:scope.noBroaderOptions')}
              </li>
            )}
          </ul>
        )}
      </div>
      {detailsOpen && (
        <PermissionRequestDetails
          request={request}
          showAction={false}
          className="rounded-md bg-muted/40 p-2.5"
        />
      )}
    </section>
  )
})

ToolApprovalActions.displayName = 'ToolApprovalActions'

