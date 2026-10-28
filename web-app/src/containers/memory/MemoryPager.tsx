import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  offset: number
  total: number
  pageSize: number
  onOffsetChange: (offset: number) => void
}

export function MemoryPager({ offset, total, pageSize, onOffsetChange }: Props) {
  const { t } = useTranslation()
  return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
        <span>
          {t('settings:memoryPage.showing', {
            from: offset + 1,
            to: Math.min(offset + pageSize, total),
            total,
          })}
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            disabled={offset === 0}
            onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
          >
            {t('settings:memoryPage.previous')}
          </Button>
          <Button
            variant="ghost"
            disabled={offset + pageSize >= total}
            onClick={() => onOffsetChange(offset + pageSize)}
          >
            {t('common:next')}
          </Button>
        </div>
      </div>
  )
}
