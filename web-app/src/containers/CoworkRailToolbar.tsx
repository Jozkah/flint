import { Activity, Code2, Eye, FileDiff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ActivityProgress } from '@/lib/coworkActivity'

/** The four mutually-exclusive Cowork rail panels. */
export type RailMode = 'code' | 'preview' | 'changes' | 'activity'

/**
 * The stable, always-visible control for the Cowork right rail.
 *
 * Before this, each panel was reachable only through a scattered chip that hid
 * itself until it had content (Changes, Activity) or, for Preview, through no
 * discoverable control at all — a user could run a whole session without ever
 * learning the rails existed. This toolbar always shows all four modes, marks
 * the active one, and lets any of them open into its own empty state, so the
 * feature is discoverable rather than depending on a transient event firing.
 *
 * The panels themselves still own resizing/expanding/closing via
 * `CoworkSidePanel`; this only chooses which one is open. Automatic opens (an
 * artifact finishing, a diff landing) still work and simply light up the
 * matching button here.
 */
export function CoworkRailToolbar({
  active,
  onSelect,
  changeCount,
  additions,
  deletions,
  activity,
}: {
  active: RailMode | null
  onSelect: (mode: RailMode) => void
  /** Combined project-git + sandbox changed-file count. */
  changeCount: number
  additions: number
  deletions: number
  /** This session's activity totals, from the canonical activity store. */
  activity: ActivityProgress
}) {
  const { t } = useTranslation()
  const inFlight = activity.running + activity.queued
  const hasActivity = inFlight > 0 || activity.finished > 0

  const item = (
    mode: RailMode,
    label: string,
    icon: React.ReactNode,
    badge?: React.ReactNode
  ) => (
    <Tooltip key={mode}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={active === mode}
          aria-label={label}
          onClick={() => onSelect(mode)}
          className={cn('shrink-0 gap-1', active === mode && 'text-primary')}
        >
          {icon}
          {badge}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <div
      role="group"
      aria-label={t('common:rail.label')}
      className="flex shrink-0 items-center"
    >
      {item('code', t('common:rail.code'), <Code2 className="size-3.5 shrink-0" />)}
      {item('preview', t('common:rail.preview'), <Eye className="size-3.5 shrink-0" />)}
      {item(
        'changes',
        t('common:rail.changes'),
        <FileDiff className="size-3.5 shrink-0" />,
        changeCount > 0 ? (
          <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>+{additions}</span>
            <span>-{deletions}</span>
          </span>
        ) : undefined
      )}
      {item(
        'activity',
        t('common:rail.activity'),
        inFlight > 0 ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Activity className="size-3.5 shrink-0" />
        ),
        hasActivity ? (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {inFlight > 0 ? inFlight : activity.finished}
          </span>
        ) : undefined
      )}
    </div>
  )
}
