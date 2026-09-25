import { useEffect, useRef } from 'react'
import { Activity, Code, Diff, Eye, ListTree, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ActivityProgress } from '@/lib/coworkActivity'

/** The mutually-exclusive Cowork rail panels. */
export type RailMode = 'code' | 'preview' | 'changes' | 'activity' | 'timeline'

/** The tab a keyboard user just pressed, to be focused again after a move. */
let refocusMode: RailMode | null = null

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
  changeSummary,
  presentation = 'toolbar',
}: {
  /** `toolbar` in the composer row; `tabs` in the output panel header. The
   * buttons, their names and `aria-pressed` are the same in both. */
  presentation?: 'toolbar' | 'tabs'
  active: RailMode | null
  onSelect: (mode: RailMode) => void
  /** Files this session changed. The user's own uncommitted work is not
   * counted here: reporting it would be Flint claiming someone else's edits. */
  changeCount: number
  additions: number
  deletions: number
  /** This session's activity totals, from the canonical activity store. */
  activity: ActivityProgress
  /** `3 files changed · +24 −8`, for the tooltip and the accessible name. The
   * row itself stays compact. */
  changeSummary?: string
}) {
  const { t } = useTranslation()
  const inFlight = activity.running + activity.queued
  const hasActivity = inFlight > 0 || activity.finished > 0
  const tabs = presentation === 'tabs'
  const buttons = useRef<Partial<Record<RailMode, HTMLButtonElement | null>>>(
    {}
  )

  // The toolbar moves between the composer row and the panel header as a panel
  // opens or closes, which remounts it. A keyboard user who pressed a tab is
  // put back on that same tab rather than dropped at the top of the page.
  useEffect(() => {
    const mode = refocusMode
    if (!mode) return
    refocusMode = null
    const target = buttons.current[mode]
    if (target && document.activeElement !== target) target.focus()
  })

  const item = (
    mode: RailMode,
    label: string,
    icon: React.ReactNode,
    badge?: React.ReactNode,
    name?: string
  ) => (
    <Tooltip key={mode}>
      <TooltipTrigger asChild>
        <Button
          ref={(el) => {
            buttons.current[mode] = el
          }}
          variant="ghost"
          size="xs"
          aria-pressed={active === mode}
          aria-label={label}
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) {
              refocusMode = mode
            }
            onSelect(mode)
          }}
          className={cn(
            'shrink-0 gap-1.5',
            tabs
              ? 'h-8 min-w-0 justify-center rounded-lg px-2 text-[12.5px] font-normal pointer-coarse:min-h-11'
              : 'pointer-coarse:h-11 pointer-coarse:px-3',
            tabs && active === mode
              ? 'bg-card font-medium text-foreground shadow-lift hover:bg-card'
              : tabs
                ? 'text-muted-foreground hover:bg-hover-btn hover:text-foreground'
                : active === mode && 'bg-accent text-foreground'
          )}
        >
          {icon}
          {tabs && name ? <span>{name}</span> : null}
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
      // Kept `shrink-0` so the icons never squash; the composer's control row
      // wraps instead (see ChatInput), which is what stops this group from
      // overflowing to the right and sliding under the send button.
      className={cn(
        tabs ? 'grid grid-cols-3 gap-1' : 'flex shrink-0 items-center'
      )}
    >
      {item(
        'preview',
        t('common:rail.preview'),
        <Eye className="size-3.5 shrink-0" aria-hidden />,
        undefined,
        t('common:rail.preview')
      )}
      {item(
        'code',
        t('common:rail.code'),
        <Code className="size-3.5 shrink-0" aria-hidden />,
        undefined,
        t('common:rail.code')
      )}
      {item(
        'changes',
        changeCount > 0 && changeSummary
          ? `${t('common:rail.changes')} — ${changeSummary}`
          : t('common:rail.changes'),
        <Diff className="size-3.5 shrink-0" aria-hidden />,
        changeCount > 0 ? (
          <span className="flex items-center gap-1 font-mono text-[10.5px] tabular-nums">
            <span className="text-diff-add">+{additions}</span>
            <span className="text-diff-del">−{deletions}</span>
          </span>
        ) : undefined,
        t('common:rail.changes')
      )}
      {item(
        'activity',
        t('common:rail.activity'),
        inFlight > 0 ? (
          <Loader2
            className="size-3.5 shrink-0 motion-safe:animate-spin"
            aria-hidden
          />
        ) : (
          <Activity className="size-3.5 shrink-0" aria-hidden />
        ),
        hasActivity ? (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10.5px] tabular-nums text-muted-foreground">
            {inFlight > 0 ? inFlight : activity.finished}
          </span>
        ) : undefined,
        t('common:rail.activity')
      )}
      {item(
        'timeline',
        t('common:rail.timeline'),
        <ListTree className="size-3.5 shrink-0" aria-hidden />,
        undefined,
        t('common:rail.timeline')
      )}
    </div>
  )
}
