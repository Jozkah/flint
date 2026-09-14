import { useId, useState } from 'react'
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
  className,
}: {
  request: PermissionRequestDescription
  /** Off when the surrounding surface already shows the action sentence. */
  showAction?: boolean
  /** Off where the arguments are already on screen. */
  showTechnicalDetails?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const affectsId = useId()
  const consequencesId = useId()
  const { technicalDetails } = request

  return (
    <div className={cn('space-y-3 text-sm text-ink-2', className)}>
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

      {request.resources.length > 0 && (
        <div className="space-y-1">
          <h4 id={affectsId} className={LABEL}>
            {t('permissions:request.affects')}
          </h4>
          <ul
            aria-labelledby={affectsId}
            tabIndex={request.resources.length > 4 ? 0 : undefined}
            className="max-h-32 space-y-0.5 overflow-auto rounded-md bg-code px-3 py-2"
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
              className="-ml-2 text-ink-2 pointer-coarse:h-11"
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
                  className="max-h-48 overflow-auto rounded-md bg-code p-2 font-mono whitespace-pre-wrap break-all text-foreground"
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
 */
export function PermissionScopeChoices({
  request,
  onDecision,
  denyRef,
  autoFocusDeny = false,
  disabled = false,
  className,
}: {
  request: PermissionRequestDescription
  onDecision: (decision: PermissionDecision) => void
  denyRef?: React.Ref<HTMLButtonElement>
  autoFocusDeny?: boolean
  /** Paused, e.g. just after the request shown here changed. */
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const baseId = useId()
  const offered = request.scopesOffered.filter(
    (scope) => request.scopeExplanations[scope]
  )

  return (
    <div
      role="group"
      aria-label={t('permissions:request.chooseScope')}
      className={cn('flex flex-col gap-2', className)}
    >
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {offered.map((scope, index) => {
          const info = request.scopeExplanations[scope]!
          const explanationId = `${baseId}-${scope}`
          return (
            <li
              key={scope}
              className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
            >
              <Button
                size="sm"
                variant={index === 0 ? 'default' : 'outline'}
                type="button"
                aria-describedby={explanationId}
                data-scope={scope}
                disabled={disabled}
                className="shrink-0 justify-start self-start pointer-coarse:h-11 sm:self-auto"
                onClick={() => onDecision(scope)}
              >
                {formatPermissionMessage(t, info.label)}
              </Button>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  id={explanationId}
                  className="text-xs leading-snug text-muted-foreground"
                >
                  {formatPermissionMessage(t, info.explanation)}
                </span>
                {info.broader && (
                  <StatusChip tone="warning">
                    {t('permissions:scope.broader')}
                  </StatusChip>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="flex">
        <Button
          ref={denyRef}
          size="sm"
          variant="destructive"
          type="button"
          autoFocus={autoFocusDeny}
          disabled={disabled}
          className="pointer-coarse:h-11"
          onClick={() => onDecision('deny')}
        >
          {t('permissions:scope.deny')}
        </Button>
      </div>
    </div>
  )
}
