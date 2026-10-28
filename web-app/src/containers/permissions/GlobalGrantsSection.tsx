import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval } from '@/hooks/useToolApproval'
import { ROW, EMPTY, REVOKE } from '@/containers/permissions/shared'

export function GlobalGrantsSection() {
  const { t } = useTranslation()
  const approvedToolsGlobal = useToolApproval((s) => s.approvedToolsGlobal)
  const approvedSimilarCalls = useToolApproval((s) => s.approvedSimilarCalls)
  const revokeSimilarCall = useToolApproval((s) => s.revokeSimilarCall)
  const revokeToolEverywhere = useToolApproval((s) => s.revokeToolEverywhere)
  return (
    <Card
      anchor="settings-permissions-everywhere"
      title={t('permissions:settings.toolsEverywhere')}
      description={t('permissions:settings.toolsEverywhereDesc')}
      aside={
        <span className="tabular-nums">{approvedToolsGlobal.length + approvedSimilarCalls.length}</span>
      }
    >
      {approvedToolsGlobal.length === 0 && approvedSimilarCalls.length === 0 ? (
        <p className={EMPTY}>
          {t('permissions:settings.noToolsEverywhere')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {approvedToolsGlobal.map((tool) => (
            <li key={`tool-${tool}`} className={ROW}>
              <span className="min-w-0 break-all text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {t('permissions:settings.toolLabel', { tool })}
              </span>
              <Button
                variant="destructive"
                className={REVOKE}
                aria-label={t('permissions:settings.revokeLabel', {
                  name: tool,
                })}
                onClick={() => revokeToolEverywhere(tool)}
              >
                {t('permissions:settings.revoke')}
              </Button>
            </li>
          ))}
          {approvedSimilarCalls.map((grant) => (
            <li key={grant.key} className={ROW}>
              <span className="min-w-0 text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                {grant.label}
              </span>
              <Button
                variant="destructive"
                className={REVOKE}
                aria-label={t('permissions:settings.revokeLabel', { name: grant.label })}
                onClick={() => revokeSimilarCall(grant.key)}
              >
                {t('permissions:settings.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
