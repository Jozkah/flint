/**
 * Desktop notifications for a campaign: one per transition into needs-you,
 * reviewing, done or failed. Split out of the runner (campaignRunner.ts).
 */
import type { CampaignApi } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import type { RunnerHost } from '@/lib/campaignRunner'

/**
 * The one desktop notification a campaign's state calls for, or null. The key
 * is what makes it once per transition: the same state yields the same key.
 */
export function noticeFor(
  c: Campaign
): { key: string; title: string; body: string } | null {
  if (c.status === 'done') {
    return {
      key: 'done',
      title: `Campaign done: ${c.title}`,
      body: 'Its changes were applied.',
    }
  }
  if (c.status === 'failed') {
    return {
      key: 'failed',
      title: `Campaign failed: ${c.title}`,
      body: 'Open the board to see why.',
    }
  }
  if (c.status === 'reviewing') {
    return {
      key: `reviewing:${c.proposalId ?? ''}:${c.gate?.at ?? ''}`,
      title: `Ready for your review: ${c.title}`,
      body: 'Every task is merged. Review the changes.',
    }
  }
  if (c.status !== 'running' && c.status !== 'paused') return null
  const waiting = c.tasks
    .filter(
      (t) =>
        t.status === 'awaiting_input' ||
        t.status === 'awaiting_approval' ||
        t.status === 'failed' ||
        (t.status === 'conflict' && (t.resolver?.attempts ?? 0) >= 1) ||
        (t.status === 'completed' && t.verdict === 'BLOCKED')
    )
    .map((t) => `${t.id}@${t.status}`)
    .sort()
  if (waiting.length === 0) return null
  return {
    key: `needs-you:${waiting.join(',')}`,
    title: `Needs you: ${c.title}`,
    body:
      waiting.length === 1
        ? '1 task is waiting for you.'
        : `${waiting.length} tasks are waiting for you.`,
  }
}

export type NotifierContext = {
  host: Pick<RunnerHost, 'desktopNotify'>
  api: Pick<CampaignApi, 'claimNotice'>
}

export function createNotifier(ctx: NotifierContext) {
  const { host, api } = ctx
  /** Keys already claimed by this process; the log covers earlier ones. */
  const claimed = new Set<string>()

  /**
   * One desktop notification per transition into needs-you, reviewing, done
   * or failed. Claimed in the campaign's event log first, so a restart or a
   * second window does not repeat it.
   */
  const announce = async (c: Campaign): Promise<boolean> => {
    if (!host.desktopNotify || !api.claimNotice) return false
    const notice = noticeFor(c)
    if (!notice) return false
    const memo = `${c.id}/${notice.key}`
    if (claimed.has(memo)) return false
    claimed.add(memo)
    let first = false
    try {
      first = await api.claimNotice(c.id, notice.key)
    } catch {
      return false
    }
    if (!first) return false
    return host.desktopNotify(notice.title, notice.body)
  }

  return { announce }
}
