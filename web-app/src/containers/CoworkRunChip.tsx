import { useState, type ReactNode } from 'react'
import { ChevronDown, FolderLock, FolderPen, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { AccessMode } from '@/lib/coworkAccess'

const ICONS: Record<AccessMode, typeof FolderLock> = {
  'review-only': FolderLock,
  'managed-worktree': GitBranch,
  'edit-folder': FolderPen,
}

/**
 * The run's folder, access and mode as one quiet chip under a narrow
 * composer: the access in force names it (one word), and a tap opens the
 * folder, access and mode controls, each with its own menu as before.
 */
export function CoworkRunChip({
  access,
  accessLabel,
  children,
}: {
  access: AccessMode
  accessLabel: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Icon = ICONS[access]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          data-testid="cowork-run-chip"
          aria-label={`${t('common:coworkRunSettings.label')}: ${accessLabel}`}
          className={cn(
            'h-7 shrink-0 gap-1.5 px-2 text-xs font-medium whitespace-nowrap pointer-coarse:h-11',
            access === 'edit-folder'
              ? 'text-warning hover:text-warning'
              : 'text-muted-foreground'
          )}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span>{accessLabel}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        data-testid="cowork-run-chip-panel"
        className="flex w-auto max-w-[calc(100vw-24px)] flex-col items-start gap-1 p-2"
      >
        <p className="px-2 pb-0.5 text-xs font-medium text-muted-foreground">
          {t('common:coworkRunSettings.label')}
        </p>
        {children}
      </PopoverContent>
    </Popover>
  )
}
