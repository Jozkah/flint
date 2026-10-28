import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { campaignApi } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { errorText } from '@/lib/errorText'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The human gate of a campaign the server runs: the plan the server's model
 * proposed waits here until a person approves it. Nothing on the server has
 * started and no checkout exists before then; rejecting cancels the record.
 *
 * `allowBypass` is the operator's `--agent-allow-bypass`: without it tasks
 * cannot work unattended, so "ask for each action" is the only choice.
 */
export function ServerPlanApproval({
  campaign,
  allowBypass,
}: {
  campaign: Pick<Campaign, 'id' | 'tasks' | 'estimate'>
  allowBypass: boolean
}) {
  const { t } = useTranslation()
  const [access, setAccess] = useState<'worktree' | 'ask'>(
    allowBypass ? 'worktree' : 'ask'
  )
  const [busy, setBusy] = useState(false)
  // The operator can lose --agent-allow-bypass after mount (a reconnect):
  // never submit a mode the select no longer offers.
  useEffect(() => {
    if (!allowBypass) setAccess('ask')
  }, [allowBypass])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
      await useCampaignStore.getState().refresh()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid="server-plan-approval"
    >
      <div>
        <h2 className="text-sm font-medium">{t('server:planApproval.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('server:planApproval.summary', { count: campaign.tasks.length })}
          {campaign.estimate
            ? ' ' +
              t('server:planApproval.cost', {
                low: campaign.estimate.low.toLocaleString(),
                high: campaign.estimate.high.toLocaleString(),
              })
            : ''}
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {campaign.tasks.map((task) => (
          <li key={task.id}>
            <span className="font-medium">{task.title}</span>
            {task.dependsOn.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {' '}
                {t('server:planApproval.after', { deps: task.dependsOn.join(', ') })}
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('server:planApproval.accessLabel')}
          className="rounded border bg-transparent px-2 py-1 text-xs"
          value={access}
          onChange={(e) => setAccess(e.target.value as 'worktree' | 'ask')}
          data-testid="server-plan-access"
        >
          {allowBypass && (
            <option value="worktree">
              {t('server:planApproval.accessWorktree')}
            </option>
          )}
          <option value="ask">{t('server:planApproval.accessAsk')}</option>
        </select>
        <Button
          size="sm"
          disabled={busy}
          data-testid="server-plan-approve"
          onClick={() => void run(() => campaignApi.approve(campaign.id, access))}
        >
          {t('server:planApproval.approve')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="server-plan-reject"
          onClick={() =>
            void run(() =>
              campaignApi.cancel(campaign.id, t('server:planApproval.rejectReason'))
            )
          }
        >
          {t('server:planApproval.reject')}
        </Button>
      </div>
    </section>
  )
}
