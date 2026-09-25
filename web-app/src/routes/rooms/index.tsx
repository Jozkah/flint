import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useState } from 'react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { ArrowRight, MessagesSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon, type IconName } from '@/components/ui/icon'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
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
import type { RoomStatus, RoomSummary } from '@/lib/rooms/types'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
  type RoomsUiError,
} from '@/containers/rooms/roomsBindings'
import {
  activeParticipants,
  lastSaid,
  messagesOf,
  timeAgo,
  type RoomDetail,
} from '@/containers/rooms/roomUi'
import { RoomAvatar } from '@/containers/rooms/RoomAvatar'
import { AvatarStack, RoomCard } from '@/containers/rooms/RoomCard'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.rooms as any)({
  component: RoomsList,
  // `?new=1` opens the create dialog: the sidebar's "New room" lands here, and
  // navigating to the page it is already on did nothing.
  validateSearch: (search: Record<string, unknown>): { new?: 1 } =>
    search.new === 1 || search.new === '1' ? { new: 1 } : {},
})

type Filter = 'all' | 'active' | 'finished' | 'draft'

const FILTERS: Record<Filter, RoomStatus[] | null> = {
  all: null,
  active: ['running', 'awaiting-user', 'paused'],
  finished: ['completed', 'stopped', 'failed'],
  draft: ['draft'],
}

/** Starting points for the create dialog: a title and an objective to edit. */
const TEMPLATES: Array<{ id: string; icon: IconName }> = [
  { id: 'review', icon: 'x-cube' },
  { id: 'naming', icon: 'x-feather' },
  { id: 'crosscheck', icon: 'target' },
  { id: 'debate', icon: 'comment' },
]

const WEEK = 7 * 24 * 60 * 60 * 1000

function RoomsList() {
  const { t, i18n } = useTranslation()
  const lang = (i18n as { language?: string } | undefined)?.language || 'en'
  const api = useRoomsApi()
  const { summaries, listLoading, lastError } = useRoomsState()
  const navigate = useNavigate()
  const uid = useId()
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [titleError, setTitleError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [toDelete, setToDelete] = useState<RoomSummary | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [details, setDetails] = useState<Record<string, RoomDetail>>({})

  useEffect(() => {
    if (api.status !== 'ready') return
    api.loadSummaries().catch((err) => setError(normalizeError(err)))
  }, [api])

  // Each card shows its participants and last message, which live in the room
  // itself; read them without opening the room. Refetched when a summary moves.
  const detailKey = summaries.map((s) => `${s.id}:${s.updatedAt}`).join('|')
  useEffect(() => {
    const peek = api.peekRoom
    if (!peek) return
    let live = true
    Promise.all(
      summaries.slice(0, 48).map((s) =>
        peek(s.id).then(
          (d) => [s.id, d] as const,
          () => null
        )
      )
    ).then((rows) => {
      if (!live) return
      const next: Record<string, RoomDetail> = {}
      for (const row of rows) if (row) next[row[0]] = row[1]
      setDetails(next)
    })
    return () => {
      live = false
    }
    // detailKey stands for the summaries' ids and update times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, detailKey])

  const openCreate = (preset?: { title: string; objective: string }) => {
    setTitle(preset?.title ?? '')
    setObjective(preset?.objective ?? '')
    setTitleError(false)
    setCreateOpen(true)
  }

  const wantsNew = (Route.useSearch() as { new?: 1 }).new === 1
  useEffect(() => {
    if (!wantsNew) return
    openCreate()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: route.rooms as any, search: {} as any, replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsNew])

  const create = async () => {
    if (!title.trim()) {
      setTitleError(true)
      return
    }
    setCreating(true)
    setError(null)
    try {
      const room = await api.createRoom({ title: title.trim(), objective: objective.trim() })
      setCreateOpen(false)
      setTitle('')
      setObjective('')
      navigate({ to: route.roomDetail, params: { roomId: room.id } })
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    const target = toDelete
    setToDelete(null)
    if (!target) return
    setError(null)
    try {
      await api.deleteRoom(target.id)
      await api.loadSummaries()
    } catch (err) {
      setError(normalizeError(err))
    }
  }

  const act = (fn: () => Promise<void>) => {
    setError(null)
    fn()
      .then(() => api.loadSummaries())
      .catch((err) => setError(normalizeError(err)))
  }

  const stats = useMemo(() => {
    const since = Date.now() - WEEK
    let turnsWeek = 0
    const models = new Map<string, { provider: string; id: string }>()
    for (const d of Object.values(details)) {
      for (const m of messagesOf(d.journal)) {
        if (m.author.kind === 'participant' && m.createdAt >= since) turnsWeek += 1
      }
      for (const p of activeParticipants(d.room)) {
        models.set(`${p.model.provider}/${p.model.id}`, p.model)
      }
    }
    const count = (s: RoomStatus) => summaries.filter((r) => r.status === s).length
    return {
      running: count('running'),
      paused: count('paused'),
      waiting: count('awaiting-user'),
      turnsWeek,
      roomsWeek: summaries.filter((r) => r.updatedAt >= since).length,
      models: [...models.values()],
    }
  }, [details, summaries])

  const shownError = error ?? lastError
  const waiting = summaries.filter((s) => s.status === 'awaiting-user')
  const allowed = FILTERS[filter]
  const shown = allowed ? summaries.filter((s) => allowed.includes(s.status)) : summaries
  const loading = api.status === 'pending' || (listLoading && summaries.length === 0)
  const hasRooms = !loading && api.status !== 'unavailable' && summaries.length > 0

  const templates = (
    <Frame className="motion-safe:animate-rise-in [animation-delay:260ms]">
      <FrameHeader icon={<Icon name="x-sparkle" />} title={t('rooms:templates.title')} />
      <FrameBody className="grid grid-cols-1 gap-2 p-2 sm:grid-cols-2 xl:grid-cols-4">
        {TEMPLATES.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            data-testid="room-template"
            onClick={() =>
              openCreate({
                title: t(`rooms:templates.${tpl.id}.name`),
                objective: t(`rooms:templates.${tpl.id}.objective`),
              })
            }
            className="group/tpl flex min-w-0 cursor-pointer items-start gap-3 rounded-[10px] p-3 text-left outline-hidden transition-[background-color,transform] duration-200 ease-expo hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[.985]"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)] transition-transform duration-300 ease-expo group-hover/tpl:-rotate-6 group-hover/tpl:scale-105">
              <Icon name={tpl.icon} size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="text-[13px] font-semibold text-foreground">
                {t(`rooms:templates.${tpl.id}.name`)}
              </b>
              <small className="text-xs leading-snug text-muted-foreground">
                {t(`rooms:templates.${tpl.id}.hint`)}
              </small>
            </span>
          </button>
        ))}
      </FrameBody>
    </Frame>
  )

  return (
    <div className="flex h-full flex-col">
      <HeaderPage />
      <div className="h-full overflow-y-auto">
        <div className="flex w-full flex-col gap-5 px-1 py-4">
          <div className="flex flex-wrap items-end gap-3 motion-safe:animate-rise-in">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-foreground">
                {t('rooms:title')}
              </h1>
              <p className="text-[13px] text-muted-foreground">{t('rooms:subtitle')}</p>
            </div>
            <Button
              size="sm"
              className="pointer-coarse:h-11"
              disabled={api.status !== 'ready'}
              onClick={() => openCreate()}
            >
              <Plus aria-hidden />
              {t('rooms:list.create')}
            </Button>
          </div>

          {shownError && (
            <p role="alert" className="text-sm text-destructive">
              {shownError.message}
            </p>
          )}

          {loading ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              <p role="status" className="sr-only">
                {t('rooms:loading')}
              </p>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  aria-hidden
                  className="flex flex-col gap-2.5 rounded-xl border-[0.8px] border-border bg-card p-4"
                >
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-56" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          ) : api.status === 'unavailable' ? (
            <p className="text-sm text-muted-foreground">{t('rooms:engineUnavailable')}</p>
          ) : summaries.length === 0 ? (
            <>
              <EmptyState
                className="rounded-xl border-[0.8px] border-dashed border-border-strong py-12"
                icon={<MessagesSquare />}
                title={t('rooms:list.empty')}
                description={t('rooms:list.emptyHint')}
                action={
                  <Button size="sm" onClick={() => openCreate()}>
                    <Plus aria-hidden />
                    {t('rooms:list.create')}
                  </Button>
                }
              />
              {templates}
            </>
          ) : null}

          {hasRooms && (
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

              {waiting.length > 0 && (
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
                            <b className="truncate text-[13px] font-semibold text-foreground">
                              {s.title || t('rooms:list.untitled')}
                            </b>
                            <span className="truncate text-xs text-muted-foreground">
                              {last
                                ? `${last.author.kind === 'participant' ? last.author.name : t('rooms:transcript.you')}: ${last.text.replace(/[`*_#>]/g, '')}`
                                : t('rooms:stage.awaitingHint')}
                            </span>
                          </div>
                          <span className="hidden text-xs text-subtle-foreground sm:inline">
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
              )}

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[15px] font-semibold text-foreground">
                    {t('rooms:list.yours')}
                  </h2>
                  <span className="flex-1" />
                  <Segmented
                    size="sm"
                    aria-label={t('rooms:filter.label')}
                    className="w-full sm:w-[380px]"
                    value={filter}
                    onValueChange={setFilter}
                    options={(Object.keys(FILTERS) as Filter[]).map((f) => ({
                      value: f,
                      label: t(`rooms:filter.${f}`),
                    }))}
                  />
                </div>
                {shown.length === 0 ? (
                  <p className="rounded-xl border-[0.8px] border-dashed border-border-strong px-4 py-8 text-center text-[13px] text-muted-foreground">
                    {t('rooms:filter.none')}
                  </p>
                ) : (
                  <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                    {shown.map((s, i) => (
                      <RoomCard
                        key={s.id}
                        summary={s}
                        detail={details[s.id]}
                        index={i}
                        onOpen={() => navigate({ to: route.roomDetail, params: { roomId: s.id } })}
                        onDelete={() => setToDelete(s)}
                        onPause={() => act(() => api.controller.pause(s.id))}
                        onResume={() => act(() => api.controller.resume(s.id))}
                        onStart={() => act(() => api.controller.start(s.id))}
                      />
                    ))}
                  </ul>
                )}
              </div>

              {templates}
            </>
          )}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
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
                value={title}
                aria-invalid={titleError || undefined}
                aria-describedby={titleError ? `${uid}-title-error` : undefined}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setTitleError(false)
                }}
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
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="surface" onClick={() => setCreateOpen(false)}>
                {t('rooms:create.cancel')}
              </Button>
              <Button type="submit" disabled={creating}>
                {t('rooms:create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rooms:delete.title')}</DialogTitle>
            <DialogDescription>
              {t('rooms:delete.description', { title: toDelete?.title || t('rooms:list.untitled') })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="surface" onClick={() => setToDelete(null)}>
              {t('rooms:delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              {t('rooms:delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
