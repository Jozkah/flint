import { FileDiff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Opens the Changes review rail, and stays out of the way until there is
 * something to review — the same rule the plan, folder and skills controls
 * follow.
 *
 * The counts are combined across both change sources the rail distinguishes:
 * the attached project's uncommitted Git working tree and the files this
 * session wrote into its sandbox. So the chip appears whenever either the repo
 * or the agent has changes, not only after a write.
 */
export function CoworkChangesChip({
  fileCount,
  additions,
  deletions,
  open,
  onToggle,
}: {
  fileCount: number
  additions: number
  deletions: number
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  if (fileCount === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={open}
          aria-label={t('common:changes.a11y', {
            files: fileCount,
            additions,
            deletions,
          })}
          onClick={onToggle}
          className={cn('shrink-0', open && 'text-acc-text')}
        >
          <FileDiff className="size-3.5 shrink-0" />
          <span className="font-mono tabular-nums text-muted-foreground">
            +{additions}
          </span>
          <span className="font-mono tabular-nums text-muted-foreground">
            -{deletions}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('common:changes.title')}</TooltipContent>
    </Tooltip>
  )
}
