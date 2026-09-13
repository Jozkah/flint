import { useId, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
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
    <div className={cn('space-y-3 text-sm', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
          {formatPermissionMessage(t, request.categoryLabel)}
        </span>
        {showAction && (
          <span className="font-medium text-foreground">
            {formatPermissionMessage(t, request.action)}
          </span>
        )}
      </div>

      {request.resources.length > 0 && (
        <div>
          <h4
            id={affectsId}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('permissions:request.affects')}
          </h4>
          <ul
            aria-labelledby={affectsId}
            className="mt-1 max-h-32 space-y-0.5 overflow-auto"
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
        <p>
          <span className="font-medium text-foreground">
            {t('permissions:request.reason')}:
          </span>{' '}
          {request.reason}
        </p>
      )}

      {request.consequences.length > 0 && (
        <div>
          <h4
            id={consequencesId}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('permissions:request.consequences')}
          </h4>
          <ul
            aria-labelledby={consequencesId}
            className="mt-1 list-disc space-y-0.5 pl-5"
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
            <Button variant="ghost" size="sm" type="button" className="-ml-2">
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  'size-4 transition-transform',
                  detailsOpen && 'rotate-180'
                )}
              />
              {t('permissions:request.technicalDetails')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1 text-xs">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t('permissions:request.tool')}
              </dt>
              <dd className="font-mono">{technicalDetails.toolName}</dd>
              {technicalDetails.serverName && (
                <>
                  <dt className="text-muted-foreground">
                    {t('permissions:request.server')}
                  </dt>
                  <dd className="font-mono">{technicalDetails.serverName}</dd>
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
                  className="max-h-48 overflow-auto rounded-md border border-border bg-sunken p-2 font-mono whitespace-pre-wrap break-all"
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
 * scope is labelled as such in text, not only by colour.
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

  return (
    <div
      role="group"
      aria-label={t('permissions:request.chooseScope')}
      className={cn('flex flex-col gap-2', className)}
    >
      <div>
        <Button
          ref={denyRef}
          size="sm"
          variant="destructive"
          type="button"
          autoFocus={autoFocusDeny}
          disabled={disabled}
          onClick={() => onDecision('deny')}
        >
          {t('permissions:scope.deny')}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {request.scopesOffered.map((scope) => {
          const info = request.scopeExplanations[scope]
          if (!info) return null
          const explanationId = `${baseId}-${scope}`
          return (
            <li key={scope} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                size="sm"
                variant="outline"
                type="button"
                aria-describedby={explanationId}
                data-scope={scope}
                disabled={disabled}
                onClick={() => onDecision(scope)}
              >
                {formatPermissionMessage(t, info.label)}
              </Button>
              {info.broader && (
                <span className="rounded-full border border-warning/40 bg-warning-tint px-2 py-0.5 text-xs text-warning">
                  {t('permissions:scope.broader')}
                </span>
              )}
              <span id={explanationId} className="text-xs text-muted-foreground">
                {formatPermissionMessage(t, info.explanation)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
