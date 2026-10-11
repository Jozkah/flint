import { campaignApi } from '@/lib/campaignApi'
import { createLiveBoardActions } from '@/lib/campaignHost'
import type { Campaign } from '@/lib/campaignModel'
import { settleProposals, useCampaignStore } from '@/hooks/useCampaigns'
import {
  applyProposal,
  approvalFor,
  defaultSelection,
  flagsOf,
  listProposals,
  unacknowledgedSelection,
} from '@/lib/proposals'
import { RemoteRpcError } from './bridge'
import type { RemoteCampaigns } from './campaigns'
import type { CampaignTaskWire, CampaignWire } from './protocol'

const NOT_STARTED = new Set(['pending', 'blocked', 'queued'])

function wire(c: Campaign, files: Record<string, CampaignTaskWire['files']> = {}): CampaignWire {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    coordinatorSession: c.coordinatorSession,
    updatedAt: c.updatedAt,
    tasks: c.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dependsOn: t.dependsOn,
      attempt: t.attempt,
      sessionId: t.sessionId ?? null,
      detail: t.detail.slice(0, 600),
      verdict: t.verdict ?? null,
      files: files[t.id] ?? null,
    })),
    maxParallel: c.limits.maxParallel,
    tokenBudget: c.limits.tokenBudget ?? null,
    tokensUsed: c.tasks.reduce((n, t) => n + (t.tokensUsed || 0), 0),
    proposalId: c.proposalId ?? null,
    gate: c.gate ? { passed: c.gate.passed, skipped: c.gate.skipped, command: c.gate.command } : null,
  }
}

const refusal = (message: string) => new RemoteRpcError('refused', message)

async function apply(id: string, acknowledged: string[]): Promise<{ ok: true; note?: string }> {
  const c = await campaignApi.get(id)
  if (!c.proposalId || (c.status !== 'reviewing' && c.status !== 'merging')) {
    throw refusal(`The campaign is ${c.status}, not ready to apply`)
  }
  const proposal = (await listProposals(c.sourceRoot)).find((p) => p.id === c.proposalId)
  if (!proposal) throw refusal('The proposed changes are no longer there. Open the campaign on the computer.')
  // Everything but what can never be applied, as the board's review starts out.
  const selected = defaultSelection(proposal)
  const missing = unacknowledgedSelection(proposal, selected, acknowledged)
  if (missing.length > 0) throw refusal(`Look at the flagged files first: ${missing.slice(0, 3).join(', ')}`)
  const done = await applyProposal(approvalFor(proposal, selected, acknowledged))
  if (!done.ok) {
    const first = done.conflicts[0]
    throw refusal(first ? `${done.message} (${first.path})` : done.message)
  }
  await campaignApi.refresh(id).catch(() => undefined)
  void useCampaignStore.getState().refresh()
  return { ok: true }
}

/** Campaigns as phones see them: the desktop's own records and board actions. */
export const appCampaigns: RemoteCampaigns = {
  async list() {
    const all = await settleProposals(await campaignApi.list())
    return all.map((c) => wire(c))
  },
  async get(id) {
    let c = await campaignApi.get(id)
    if ((c.status === 'merging' || c.status === 'reviewing') && c.proposalId) {
      c = (await settleProposals([c]))[0]
    }
    const counts: Record<string, CampaignTaskWire['files']> = {}
    await Promise.all(
      c.tasks
        .filter((t) => t.worktreePath && !NOT_STARTED.has(t.status))
        .map(async (t) => {
          try {
            const d = await campaignApi.taskDiff(c.id, t.id, false)
            counts[t.id] = { count: d.files.length, added: d.added, removed: d.removed, uncommitted: d.uncommitted }
          } catch {
            counts[t.id] = null
          }
        })
    )
    let proposal: Awaited<ReturnType<RemoteCampaigns['get']>>['proposal'] = null
    if (c.proposalId) {
      const found = (await listProposals(c.sourceRoot)).find((p) => p.id === c.proposalId)
      if (found) {
        proposal = {
          id: found.id,
          state: found.state,
          files: found.files.map((f) => ({
            path: f.path,
            change: f.change,
            additions: f.additions,
            deletions: f.deletions,
            binary: f.binary,
            sensitive: f.sensitive,
            flags: flagsOf(f).map((x) => x.summary),
          })),
        }
      }
    }
    let gateCommand: string | null = null
    if (c.status === 'reviewing') {
      gateCommand = await campaignApi.gatePlan(c.id).then((g) => g.command ?? null, () => null)
    }
    return { campaign: wire(c, counts), proposal, gateCommand }
  },
  async act(id, action, opts) {
    const board = createLiveBoardActions()
    const need = () => {
      if (!opts.taskId) throw refusal('Name a task')
      return opts.taskId
    }
    const fromResult = (r: { ok: true; note?: string } | { ok: false; error: string }) => {
      if (!r.ok) throw refusal(r.error)
      return { ok: true as const, ...(r.note ? { note: r.note } : {}) }
    }
    switch (action) {
      case 'pause':
        await board.pause(id)
        break
      case 'resume':
        await board.resume(id)
        break
      case 'cancel':
        await board.cancel(id)
        break
      case 'finalize':
        return fromResult(await board.finalize(id))
      case 'apply':
        return apply(id, opts.acknowledged ?? [])
      case 'retry':
        return fromResult(await board.retryTask(id, need()))
      case 'skip':
        return fromResult(await board.skipTask(id, need()))
      case 'stop':
        return fromResult(await board.stopTask(id, need()))
    }
    void useCampaignStore.getState().refresh()
    return { ok: true }
  },
}
