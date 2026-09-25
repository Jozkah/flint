import { useRef, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { PermissionRequestDescription } from '@/lib/permissionRequest'
import {
  PermissionRequestDetails,
  PermissionScopeChoices,
  formatPermissionMessage,
} from '@/containers/PermissionRequestDetails'

export type ApprovalDecision =
  | 'allow-once'
  | 'allow-thread'
  | 'allow-always'
  | 'deny'

/**
 * Presentational approval dialog for a tool permission request.
 *
 * Given `request` (from `describePermissionRequest`), it says in plain words
 * what is being asked, what it touches, what allowing it means, and offers
 * only the scopes that request genuinely supports, least broad first. Without
 * it, the older shell is kept: the shared `tools:toolApproval.*` copy with a
 * caller-provided body in `children`.
 *
 * In both, closing counts as `deny` (Esc or click-away), the safe default, and
 * focus starts on Deny rather than on the broadest grant, so a reflexive Enter
 * never widens a permission.
 */
export function ToolApprovalDialog({
  open,
  toolName,
  description,
  request,
  offersAlways = true,
  showSecurityNotice = false,
  children,
  onDecision,
}: {
  open: boolean
  toolName: string
  /** Override the default "assistant wants to use {toolName}" description line. */
  description?: ReactNode
  /** The described request. When set, scopes come from `request.scopesOffered`. */
  request?: PermissionRequestDescription
  /** Legacy shell only: show the allow-always button (defaults to true). */
  offersAlways?: boolean
  showSecurityNotice?: boolean
  children?: ReactNode
  onDecision: (decision: ApprovalDecision) => void
}) {
  const { t } = useTranslation()
  const denyRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDecision('deny')
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          denyRef.current?.focus()
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-warning-tint text-warning">
              <ShieldAlert className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">
                {request
                  ? t('permissions:request.title')
                  : t('tools:toolApproval.title')}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-sm text-foreground">
                {description ??
                  (request ? (
                    formatPermissionMessage(t, request.action)
                  ) : (
                    <>
                      {t('tools:toolApproval.description')}{' '}
                      <span className="font-semibold">{toolName}</span>.&nbsp;
                      <span className="text-sm">
                        {t('tools:toolApproval.permissionScope')}
                      </span>
                    </>
                  ))}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {request && (
          <PermissionRequestDetails request={request} showAction={false} />
        )}

        {children}

        {showSecurityNotice && (
          <div className="rounded-md bg-muted px-3 py-2">
            <p className="text-xs leading-relaxed text-fg-2">
              {t('tools:toolApproval.securityNotice')}
            </p>
          </div>
        )}

        {request ? (
          <DialogFooter className="flex flex-col gap-2 sm:flex-col sm:justify-start">
            <PermissionScopeChoices
              request={request}
              denyRef={denyRef}
              onDecision={onDecision}
            />
            <p className="text-xs text-muted-foreground">
              {t('permissions:request.revokeHint')}
            </p>
          </DialogFooter>
        ) : (
          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              ref={denyRef}
              variant="destructive"
              size="sm"
              onClick={() => onDecision('deny')}
              className="pointer-coarse:h-11"
            >
              {t('tools:toolApproval.deny')}
            </Button>
            <div className="flex flex-col sm:flex-row gap-2 items-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDecision('allow-once')}
              >
                {t('tools:toolApproval.allowOnce')}
              </Button>
              {offersAlways && (
                <Button
                  variant="default"
                  size="sm"
                  className="capitalize"
                  onClick={() => onDecision('allow-always')}
                >
                  {t('tools:toolApproval.alwaysAllow')}
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
