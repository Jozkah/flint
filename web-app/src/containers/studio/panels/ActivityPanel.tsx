import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useStudio } from '@/hooks/useStudio'
import { cn } from '@/lib/utils'
import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { type GalleryItem, type StudioKind } from '@/lib/studio/studio'
import { Elapsed } from '@/containers/studio/panels/Elapsed'
import { PanelButton } from '@/containers/studio/panels/PanelButton'
import { Thumb } from '@/containers/studio/panels/Thumb'
import { ACTIVITY_TONE, ON, phaseText, rise, timeAgo } from '@/containers/studio/studioHelpers'

/** Recent Activity: what is running now, what just finished, what failed. */
export function ActivityPanel({
  kind,
  onOpen,
  onRemix,
}: {
  kind: StudioKind
  onOpen: (index: number) => void
  onRemix: (item: GalleryItem) => void
}) {
  const { t, i18n } = useTranslation()
  const job = useStudio((s) => s.job)
  const jobPrompt = useStudio((s) => s.jobPrompt)
  const activity = useStudio((s) => s.activity)
  const items = useStudio((s) => s.gallery[kind])
  const remove = useStudio((s) => s.remove)
  const archiveOn = useArchiveEnabled()
  // "Clear all" empties this list only; the pictures stay in Your Generations.
  const [clearedAt, setClearedAt] = useState(0)
  const percent = Math.round((job?.fraction ?? 0) * 100)
  const recent = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.recipe.createdAtMs > clearedAt)
    .slice(0, 8)
  const problems = activity
    .filter((a) => a.kind === kind && a.status !== 'done' && a.at > clearedAt)
    .slice(0, 3)
  const empty = !job && recent.length === 0 && problems.length === 0

  return (
    <Frame className="motion-safe:animate-rise-in" style={rise(3)}>
      <FrameHeader
        title={t('studio:activity.title')}
        actions={
          <PanelButton
            disabled={empty}
            onClick={() => setClearedAt(Date.now())}
            title={t('studio:activity.clearTitle')}
          >
            {t('studio:activity.clearAll')}
          </PanelButton>
        }
      />
      <FrameBody className="min-h-0 flex-1 p-2.5">
        {empty ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            {t('studio:activity.empty')}
          </p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-0.5 [scrollbar-width:thin]">
            {job && (
              <li className="flex min-w-0 flex-col gap-1.5 rounded-xl border-[0.8px] border-blue-500/40 bg-blue-500/5 p-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone="info" live>
                    {t('studio:activity.making')}
                  </Chip>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {job.remote ? t('studio:prompt.waitingFor', { provider: job.remote }) : `${phaseText(t, job.phase)} · ${percent}%`}
                    {job.remote ? <Elapsed since={job.startedAt} /> : null}
                  </span>
                </div>
                <p className="line-clamp-2 text-[length:calc(var(--ui-font-base)*0.78125)] text-foreground">{jobPrompt}</p>
                <Progress
                  value={job.remote ? 100 : percent}
                  className={cn(job.remote && 'motion-safe:animate-pulse')}
                />
              </li>
            )}
            {recent.map(({ item, index }, i) => (
              <li
                key={item.id}
                className={cn(
                  'group flex min-w-0 items-center gap-3 rounded-xl border-[0.8px] p-2 transition-colors',
                  i === 0 && !job ? ON : 'border-transparent hover:bg-accent/60'
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(index)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden"
                >
                  <span className="size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                    <Thumb item={item} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="line-clamp-2 text-[length:calc(var(--ui-font-base)*0.8125)] leading-snug text-foreground">
                      {item.recipe.prompt}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(item.recipe.createdAtMs, t, i18n.language)}
                    </span>
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('common:more')}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden pointer-coarse:size-11"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onOpen(index)}>{t('studio:activity.open')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onRemix(item)}>
                      {t('studio:prompt.remix')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => void remove(item.kind, item.id)}
                    >
                      {archiveOn ? t('studio:actions.archive') : t('studio:actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
            {problems.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-col gap-1 rounded-xl p-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone={ACTIVITY_TONE[entry.status]} dot>
                    {t(`studio:activity.${entry.status}`)}
                  </Chip>
                  <span className="text-xs text-muted-foreground">{timeAgo(entry.at, t, i18n.language)}</span>
                </div>
                <p className="line-clamp-2 text-[length:calc(var(--ui-font-base)*0.78125)] text-foreground">{entry.prompt}</p>
                {entry.error && (
                  <p className="line-clamp-3 text-xs break-words text-muted-foreground">
                    {entry.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </FrameBody>
    </Frame>
  )
}
