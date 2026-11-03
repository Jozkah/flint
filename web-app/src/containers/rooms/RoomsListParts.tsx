import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { ArrowRight } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { KpiRow, KpiTile } from '@/containers/engine/EngineKit'
import type { RoomSummary } from '@/lib/rooms/types'
import { lastSaid, timeAgo, type RoomDetail } from '@/containers/rooms/roomUi'
import { RoomAvatar } from '@/containers/rooms/RoomAvatar'
import { AvatarStack } from '@/containers/rooms/RoomCard'

export type RoomsStats = {
  running: number
  paused: number
  waiting: number
  turnsWeek: number
  roomsWeek: number
  models: Array<{ provider: string; id: string }>
}

/** The four figures above the rooms list. */
export function RoomsKpis({ stats }: { stats: RoomsStats }) {
  const { t } = useTranslation()
  return (
    <>
    <KpiRow>
      <KpiTile
        testId="rooms-kpi-running"
        title={t('rooms:kpi.running')}
        icon={<Icon name="x-play" />}
        value={String(stats.running)}
        sub={t('rooms:kpi.paused', { count: stats.paused })}
        delay={40}
      />
      <KpiTile
        testId="rooms-kpi-waiting"
        title={t('rooms:kpi.waiting')}
        icon={<Icon name="bell" />}
        value={String(stats.waiting)}
        sub={
          stats.waiting > 0 ? (
            <span className="text-warning">{t('rooms:kpi.waitingHint')}</span>
          ) : (
            t('rooms:kpi.waitingNone')
          )
        }
        delay={90}
      />
      <KpiTile
        testId="rooms-kpi-turns"
        title={t('rooms:kpi.turns')}
        icon={<Icon name="x-activity" />}
        value={String(stats.turnsWeek)}
        sub={t('rooms:kpi.turnsHint', { count: stats.roomsWeek })}
        delay={140}
      />
      <KpiTile
        testId="rooms-kpi-models"
        title={t('rooms:kpi.models')}
        icon={<Icon name="x-cpu" />}
        value={String(stats.models.length)}
        sub={
          stats.models.length > 0 ? (
            <span
              className="flex items-center"
              title={stats.models.map((m) => m.id).join('\n')}
            >
              {stats.models.slice(0, 8).map((m, i) => (
                <RoomAvatar
                  key={`${m.provider}/${m.id}`}
                  model={m}
                  name={m.id}
                  size={20}
                  className={i > 0 ? '-ml-1.5 ring-2 ring-card' : 'ring-2 ring-card'}
                />
              ))}
            </span>
          ) : (
            t('rooms:kpi.modelsNone')
          )
        }
        delay={190}
      />
    </KpiRow>
    </>
  )
}

/** Rooms that stopped to ask the user something, each with a way back in. */
export function WaitingRooms({
  waiting,
  details,
  lang,
}: {
  waiting: RoomSummary[]
  details: Record<string, RoomDetail>
  lang: string
}) {
  const { t } = useTranslation()
  if (waiting.length === 0) return null
  return (
              <Frame
                data-testid="rooms-waiting"
                className="motion-safe:animate-rise-in [animation-delay:120ms]"
              >
                <FrameHeader
                  icon={<Icon name="bell" />}
                  title={t('rooms:waiting.title')}
                  actions={<Chip tone="warn" dot live>{waiting.length}</Chip>}
                />
                <FrameBody className="divide-y divide-border">
                  {waiting.map((s) => {
                    const d = details[s.id]
                    const last = d ? lastSaid(d.journal) : null
                    return (
                      <div
                        key={s.id}
                        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3"
                      >
                        {d && <AvatarStack room={d.room} size={26} />}
                        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                          <b className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-semibold text-foreground">
                            {s.title || t('rooms:list.untitled')}
                          </b>
                          <span className="truncate text-xs text-muted-foreground">
                            {last
                              ? `${last.author.kind === 'participant' ? last.author.name : t('rooms:transcript.you')}: ${last.text.replace(/[`*_#>]/g, '')}`
                              : t('rooms:stage.awaitingHint')}
                          </span>
                        </div>
                        <span className="hidden text-xs text-subtle-foreground @[40rem]/rooms:inline">
                          {timeAgo(s.updatedAt, lang)}
                        </span>
                        <Button size="sm" variant="outline" className="pointer-coarse:h-11" asChild>
                          <Link to={route.roomDetail} params={{ roomId: s.id }}>
                            {t('rooms:waiting.action')}
                            <ArrowRight aria-hidden />
                          </Link>
                        </Button>
                      </div>
                    )
                  })}
                </FrameBody>
              </Frame>
  )
}

/** The "new room" form: a title and an objective. */
export function CreateRoomDialog({
  open,
  onOpenChange,
  title,
  onTitleChange,
  objective,
  onObjectiveChange,
  titleError,
  creating,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onTitleChange: (value: string) => void
  objective: string
  onObjectiveChange: (value: string) => void
  titleError: boolean
  creating: boolean
  onSubmit: () => void
}) {
  const { t } = useTranslation()
  const uid = useId()
  return (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('rooms:create.title')}</DialogTitle>
          <DialogDescription>{t('rooms:create.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-title`}>{t('rooms:create.titleLabel')}</Label>
          <Input
            id={`${uid}-title`}
            placeholder={t('rooms:create.titlePlaceholder')}
            value={title}
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? `${uid}-title-error` : undefined}
            onChange={(e) => onTitleChange(e.target.value)}
          />
          {titleError && (
            <p id={`${uid}-title-error`} className="text-xs text-destructive">
              {t('rooms:create.titleRequired')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-objective`}>{t('rooms:create.objectiveLabel')}</Label>
          <Textarea
            id={`${uid}-objective`}
            rows={3}
            value={objective}
            placeholder={t('rooms:create.objectivePlaceholder')}
            onChange={(e) => onObjectiveChange(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="surface" onClick={() => onOpenChange(false)}>
            {t('rooms:create.cancel')}
          </Button>
          <Button type="submit" disabled={creating}>
            {t('rooms:create.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
  )
}
