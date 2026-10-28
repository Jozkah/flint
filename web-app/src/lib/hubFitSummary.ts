import { formatModelBytes } from '@/lib/huggingface'
import type { GroupFit } from '@/lib/huggingfaceFit'

export type FitSummary = {
  titleKey: string
  detailKey: string
  detailValues?: Record<string, string>
}

export function fitSummary(fit: GroupFit): FitSummary {
  if (fit.verdict === 'fits')
    return {
      titleKey: 'hub:detail.fit.fitsTitle',
      detailKey: 'hub:detail.fit.fitsDetail',
      detailValues: { size: formatModelBytes(fit.required.total) },
    }
  if (fit.verdict === 'fits-partial-offload')
    return { titleKey: 'hub:detail.fit.partialTitle', detailKey: 'hub:detail.fit.partialDetail' }
  if (fit.verdict === 'tight')
    return { titleKey: 'hub:detail.fit.tightTitle', detailKey: 'hub:detail.fit.tightDetail' }
  if (fit.verdict === 'exceeds')
    return { titleKey: 'hub:detail.fit.exceedsTitle', detailKey: 'hub:detail.fit.exceedsDetail' }
  return { titleKey: 'hub:detail.fit.unknownTitle', detailKey: 'hub:detail.fit.unknownDetail' }
}
