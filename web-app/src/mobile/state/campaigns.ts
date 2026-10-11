// Plain-language view of a campaign for the phone. The words come from the
// desktop's own view model (lib/campaignView.ts), fed with the wire shape.

import type { CampaignTask } from '@/lib/campaignModel'
import { headlineOf, primaryActionOf, type Headline } from '@/lib/campaignView'
import type { CampaignWire, CampaignTaskWire } from '@/lib/remote/protocol'
import { t } from '../i18n'

type Model = Parameters<typeof headlineOf>[0]

/** The wire carries only what the phone shows; the view model needs the
 * same fields under the desktop's names. */
export const modelOf = (c: CampaignWire): Model => ({
  status: c.status as Model['status'],
  tasks: c.tasks.map(taskModel),
})

export const taskModel = (x: CampaignTaskWire): CampaignTask =>
  ({
    id: x.id,
    title: x.title,
    brief: '',
    acceptance: [],
    paths: [],
    dependsOn: x.dependsOn,
    sessionId: x.sessionId,
    status: x.status as CampaignTask['status'],
    attempt: x.attempt,
    verdict: (x.verdict as CampaignTask['verdict']) ?? null,
    tokensUsed: 0,
    detail: x.detail,
  }) as CampaignTask

export function headlineText(h: Headline): string {
  return t(`campaigns.headline.${h.key}`, { count: h.count, done: h.done, total: h.total })
}

/** A campaign that needs the person right now. */
export const needsYou = (c: CampaignWire): boolean => {
  const h = headlineOf(modelOf(c))
  return h.key === 'attention' || h.key === 'review'
}

/** Newest first, campaigns that are moving ahead of finished ones. */
export function sortCampaigns(list: CampaignWire[]): CampaignWire[] {
  const over = new Set(['done', 'failed', 'cancelled'])
  return [...list].sort((a, b) => {
    const oa = over.has(a.status) ? 1 : 0
    const ob = over.has(b.status) ? 1 : 0
    if (oa !== ob) return oa - ob
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

export { headlineOf, primaryActionOf }
