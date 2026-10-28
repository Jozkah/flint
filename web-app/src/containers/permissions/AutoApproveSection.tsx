import { confirmBypass } from '@/lib/bypassConfirm'
import { useEffect, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Card, CardItem } from '@/containers/Card'
import { Input } from '@/components/ui/input'
import { MAX_AUTO_APPROVE_LIMIT, useAutoApproveLimit } from '@/hooks/useAutoApproveLimit'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval, type PermissionMode } from '@/hooks/useToolApproval'

export function AutoApproveSection() {
  const { t } = useTranslation()
  const permissionMode = useToolApproval((s) => s.permissionMode)
  const setPermissionMode = useToolApproval((s) => s.setPermissionMode)
  return (
    <Card
      anchor="settings-permissions-mode"
      title={t('permissions:settings.permissionMode')}
      description={t('permissions:settings.permissionModeDesc')}
    >
      <span id="tool-permission-mode-label" className="text-sm font-medium">
        {t('permissions:settings.approvalBehavior')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="mt-2 w-full justify-between text-sm"
            aria-labelledby="tool-permission-mode-label"
          >
            {t(
              permissionMode === 'ask'
                ? 'permissions:settings.modeAsk'
                : permissionMode === 'auto-approve'
                  ? 'permissions:settings.modeAuto'
                  : 'permissions:settings.modeBypass'
            )}
            <ChevronDown aria-hidden className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          {([
            ['ask', 'permissions:settings.modeAsk'],
            ['auto-approve', 'permissions:settings.modeAuto'],
            ['bypass', 'permissions:settings.modeBypass'],
          ] as const).map(([mode, label]) => (
            <DropdownMenuItem
              key={mode}
              role="menuitemradio"
              aria-checked={permissionMode === mode}
              onSelect={() => {
                void (async () => {
                  if (
                    mode === 'bypass' &&
                    !(await confirmBypass(t('permissions:settings.bypassConfirm')))
                  ) return
                  setPermissionMode(mode as PermissionMode)
                })()
              }}
            >
              <span className="flex-1">{t(label)}</span>
              {permissionMode === mode && <Check aria-hidden className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('permissions:settings.modeDetails')}
      </p>
    </Card>
  )
}

export function AutoApproveLimitCard() {
  const { t } = useTranslation()
  const limit = useAutoApproveLimit((s) => s.limit)
  const setLimit = useAutoApproveLimit((s) => s.setLimit)
  const [draft, setDraft] = useState(String(limit))
  useEffect(() => setDraft(String(limit)), [limit])
  const commit = () => {
    setLimit(draft)
    // Show the value actually kept, e.g. 5000 clamped to the maximum.
    setDraft(String(useAutoApproveLimit.getState().limit))
  }
  return (
    <Card
      anchor="settings-permissions-auto-approve-limit"
      title={t('permissions:settings.autoApproveLimit')}
    >
      <CardItem
        anchor="settings-permissions-auto-approve-limit-value"
        title={t('permissions:settings.autoApproveLimitLabel')}
        description={
          limit === 0
            ? t('permissions:settings.autoApproveLimitOff')
            : t('permissions:settings.autoApproveLimitDesc', {
                count: limit,
                max: MAX_AUTO_APPROVE_LIMIT,
              })
        }
        actions={
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_AUTO_APPROVE_LIMIT}
            step={1}
            aria-label={t('permissions:settings.autoApproveLimitLabel')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
            className="w-28"
          />
        }
      />
    </Card>
  )
}
