/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { StatusChip } from '@/containers/StatusChip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type {
  ApprovalScope,
  PermissionMessage,
  PermissionRequestDescription,
} from '@/lib/permissionRequest'

export type PermissionDecision = ApprovalScope | 'deny'

type Translate = (key: string, options?: Record<string, unknown>) => string

export const formatPermissionMessage = (t: Translate, msg: PermissionMessage) =>
  t(msg.key, msg.values)

const BADGE_TONE = {
  neutral: 'neutral',
  warning: 'warning',
  danger: 'destructive',
} as const

/** Chips such as "Reaches GitHub", and the stronger warning, when present. */
function RequestFlags({
  request,
  t,
}: {
  request: PermissionRequestDescription
  t: Translate
}) {
  if (!request.badges?.length && !request.warning) return null
  return (
    <div className="space-y-1.5" data-testid="permission-flags">
      {request.badges && request.badges.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {request.badges.map((badge) => (
            <StatusChip
              key={badge.message.key}
              tone={BADGE_TONE[badge.tone]}
              data-testid="permission-badge"
            >
              {formatPermissionMessage(t, badge.message)}
            </StatusChip>
          ))}
        </div>
      )}
      {request.warning && (
        <p
          role="alert"
          data-testid="permission-warning"
          className="rounded-md bg-destructive-tint px-2.5 py-1.5 text-xs font-medium text-destructive"
        >
          {formatPermissionMessage(t, request.warning)}
        </p>
      )}
    </div>
  )
}

/** Sentence-case label for a part of the request (no uppercase tracking). */
const LABEL = 'text-xs font-medium text-muted-foreground'

/**
 * The body of a permission request: what is asked, what it touches, why (when
 * known), what allowing it means, and the raw call behind a disclosure.
 *
 * Shared by the approval dialog and the inline tool-card prompt so both say
 * the same thing about the same call.
 */
export function PermissionRequestDetails({
  request,
  showAction = true,
  showTechnicalDetails = true,
  layout = 'stack',
  className,
}: {
  request: PermissionRequestDescription
  /** Off when the surrounding surface already shows the action sentence. */
  showAction?: boolean
  /** Off where the arguments are already on screen. */
  showTechnicalDetails?: boolean
  /**
   * `rows`: one compact label/value grid (Affects, Why, What allowing it
   * means), for the prompt inside a tool card. `stack`: the dialog's layout.
   */
  layout?: 'stack' | 'rows'
  className?: string
}) {
  const { t } = useTranslation()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const affectsId = useId()
  const consequencesId = useId()
  const { technicalDetails } = request

  if (layout === 'rows') {
    return (
      <>
        <RequestFlags request={request} t={t} />
        <dl
          className={cn(
            'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[12.5px] text-foreground',
            className
          )}
        >
          {request.resources.length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {t('permissions:request.affects')}
              </dt>
              <dd className="min-w-0 font-mono text-xs leading-[19px] break-all">
                {request.resources.join(' · ')}
              </dd>
            </>
          )}
          {request.reason && (
            <>
              <dt className="text-muted-foreground">
                {t('permissions:request.reason')}
              </dt>
              <dd className="min-w-0 break-words">
                {request.reason}
                {request.script && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code-bg p-2 font-mono text-xs">
                    <code>{request.script}</code>
                  </pre>
                )}
              </dd>
            </>
          )}
          {request.consequences.length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {t('permissions:request.consequences')}
              </dt>
              <dd className="min-w-0 break-words">
                {request.consequences
                  .map((msg) => formatPermissionMessage(t, msg))
                  .join(' ')}
              </dd>
            </>
          )}
        </dl>
      </>
    )
  }

  return (
    <div className={cn('space-y-2.5 text-[12.5px] text-fg-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="neutral">
          {formatPermissionMessage(t, request.categoryLabel)}
        </StatusChip>
        {showAction && (
          <span className="font-medium text-foreground">
            {formatPermissionMessage(t, request.action)}
          </span>
        )}
      </div>

      <RequestFlags request={request} t={t} />

      {request.resources.length > 0 && (
        <div className="space-y-1">
          <h4 id={affectsId} className={LABEL}>
            {t('permissions:request.affects')}
          </h4>
          <ul
            aria-labelledby={affectsId}
            tabIndex={request.resources.length > 4 ? 0 : undefined}
            className="max-h-32 space-y-0.5 overflow-auto rounded-lg bg-code-bg px-2.5 py-2 shadow-[inset_0_0_0_0.8px_var(--border)]"
          >
            {request.resources.map((resource) => (
              <li
                key={resource}
                className="break-all font-mono text-xs text-foreground"
              >
                {resource}
              </li>
            ))}
          </ul>
        </div>
      )}

      {request.reason && (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3">
          <dt className={cn(LABEL, 'pt-0.5')}>
            {t('permissions:request.reason')}
          </dt>
          <dd className="min-w-0 break-words text-foreground">
            {request.reason}
            {request.script && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code-bg p-2 font-mono text-xs">
                <code>{request.script}</code>
              </pre>
            )}
          </dd>
        </dl>
      )}

      {request.consequences.length > 0 && (
        <div className="space-y-1">
          <h4 id={consequencesId} className={LABEL}>
            {t('permissions:request.consequences')}
          </h4>
          <ul
            aria-labelledby={consequencesId}
            className="list-disc space-y-0.5 pl-5 text-foreground marker:text-muted-foreground"
          >
            {request.consequences.map((msg) => (
              <li key={msg.key}>{formatPermissionMessage(t, msg)}</li>
            ))}
          </ul>
        </div>
      )}

      {showTechnicalDetails && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="-ml-2 text-muted-foreground pointer-coarse:h-11"
            >
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  'size-4 motion-safe:transition-transform',
                  detailsOpen && 'rotate-180'
                )}
              />
              {t('permissions:request.technicalDetails')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1.5 pt-1 text-xs">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t('permissions:request.tool')}
              </dt>
              <dd className="break-all font-mono text-foreground">
                {technicalDetails.toolName}
              </dd>
              {technicalDetails.serverName && (
                <>
                  <dt className="text-muted-foreground">
                    {t('permissions:request.server')}
                  </dt>
                  <dd className="break-all font-mono text-foreground">
                    {technicalDetails.serverName}
                  </dd>
                </>
              )}
            </dl>
            {technicalDetails.argumentsJson && (
              <>
                <div className="text-muted-foreground">
                  {t('permissions:request.arguments')}
                </div>
                <pre
                  tabIndex={0}
                  className="max-h-48 overflow-auto rounded-lg bg-code-bg p-2 font-mono whitespace-pre-wrap break-all text-foreground shadow-[inset_0_0_0_0.8px_var(--border)]"
                >
                  {technicalDetails.argumentsJson}
                </pre>
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/**
 * Deny plus one button per scope the request genuinely supports, least broad
 * first, each with the plain explanation of how far it reaches. The broadest
 * scope is labelled as such in text, not only by colour. Deny is an outlined
 * destructive button and is where focus starts; the narrowest grant is the
 * one filled action.
 *
 * With `preferredScope` (offered), that scope is the filled action instead
 * and focus starts on it rather than on Deny. Nothing is chosen for the user.
 */
export function PermissionScopeChoices({
  request,
  onDecision,
  denyRef,
  autoFocusDeny = false,
  disabled = false,
  preferredScope,
  className,
}: {
  request: PermissionRequestDescription
  onDecision: (decision: PermissionDecision) => void
  denyRef?: React.Ref<HTMLButtonElement>
  autoFocusDeny?: boolean
  /** Paused, e.g. just after the request shown here changed. */
  disabled?: boolean
  /** The scope to fill and focus first, when it is offered. */
  preferredScope?: ApprovalScope
  className?: string
}) {
  const { t } = useTranslation()
  const baseId = useId()
  const offered = request.scopesOffered.filter(
    (scope) => request.scopeExplanations[scope]
  )
  const preferred =
    preferredScope && offered.includes(preferredScope)
      ? preferredScope
      : undefined
  const filled = preferred ?? offered[0]
  const preferredRef = useRef<HTMLButtonElement>(null)
  // Focus the preferred answer once it can be pressed (the buttons may start
  // paused), so Enter takes it without a hunt.
  useEffect(() => {
    if (preferred && !disabled) preferredRef.current?.focus()
  }, [preferred, disabled])

  return (
    <div
      role="group"
      aria-label={t('permissions:request.chooseScope')}
      className={cn('flex flex-wrap items-start gap-2.5', className)}
    >
      {/* Deny comes first in the tab order: focus starts here, and Tab then
          walks the scopes from the narrowest to the broadest. */}
      <div className="flex shrink-0">
        <Button
          ref={denyRef}
          size="sm"
          variant="destructive"
          type="button"
          autoFocus={autoFocusDeny && !preferred}
          disabled={disabled}
          className="pointer-coarse:h-11"
          onClick={() => onDecision('deny')}
        >
          {t('permissions:scope.deny')}
        </Button>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col divide-y divide-border overflow-hidden rounded-md border border-border bg-card shadow-sm">
        {offered.map((scope) => {
          const info = request.scopeExplanations[scope]!
          const explanationId = `${baseId}-${scope}`
          return (
            <li key={scope} className="flex">
              {/* The whole row answers; the narrowest scope is marked as the
                  expected choice by weight, not by a filled button. */}
              <button
                ref={scope === preferred ? preferredRef : undefined}
                type="button"
                // Named by the scope alone; the explanation describes it.
                aria-label={formatPermissionMessage(t, info.label)}
                aria-describedby={explanationId}
                data-scope={scope}
                data-primary={scope === filled || undefined}
                disabled={disabled}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors outline-hidden hover:bg-hover-row data-primary:border-l-2 data-primary:border-l-primary data-primary:bg-primary/10 data-primary:hover:bg-primary/15 focus-visible:bg-hover-row focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11"
                onClick={() => onDecision(scope)}
              >
                <b className="text-[13px] font-medium text-foreground">
                  {formatPermissionMessage(t, info.label)}
                </b>
                {info.broader && (
                  <StatusChip tone="warning">
                    {t('permissions:scope.broader')}
                  </StatusChip>
                )}
                <span
                  id={explanationId}
                  className="w-full text-xs leading-snug text-muted-foreground"
                >
                  {formatPermissionMessage(t, info.explanation)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
