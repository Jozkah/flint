import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { campaignApi } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { errorText } from '@/lib/errorText'

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
  const [access, setAccess] = useState<'worktree' | 'ask'>(
    allowBypass ? 'worktree' : 'ask'
  )
  const [busy, setBusy] = useState(false)

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
        <h2 className="text-sm font-medium">Approve this plan to start it</h2>
        <p className="text-xs text-muted-foreground">
          {campaign.tasks.length} task{campaign.tasks.length === 1 ? '' : 's'}.
          The server runs them on its own, with no client attached, and asks
          again before anything reaches your folder.
          {campaign.estimate
            ? ` Rough cost: ${campaign.estimate.low.toLocaleString()} to ${campaign.estimate.high.toLocaleString()} tokens.`
            : ''}
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {campaign.tasks.map((t) => (
          <li key={t.id}>
            <span className="font-medium">{t.title}</span>
            {t.dependsOn.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {' '}
                after {t.dependsOn.join(', ')}
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="How tasks work"
          className="rounded border bg-transparent px-2 py-1 text-xs"
          value={access}
          onChange={(e) => setAccess(e.target.value as 'worktree' | 'ask')}
          data-testid="server-plan-access"
        >
          {allowBypass && (
            <option value="worktree">
              Work on their own inside their own folder
            </option>
          )}
          <option value="ask">Ask for each action</option>
        </select>
        <Button
          size="sm"
          disabled={busy}
          data-testid="server-plan-approve"
          onClick={() => void run(() => campaignApi.approve(campaign.id, access))}
        >
          Approve and start
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="server-plan-reject"
          onClick={() =>
            void run(() =>
              campaignApi.cancel(campaign.id, 'the plan was not approved')
            )
          }
        >
          Reject
        </Button>
      </div>
    </section>
  )
}
