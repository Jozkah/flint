import { useArchiveEnabled } from '@/hooks/useArchiveEnabled'
import { ensureKnownWindows } from '@/lib/rooms/unknownWindows'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { MessagesSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { RoomStatus, RoomSummary } from '@/lib/rooms/types'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
  type RoomsUiError,
} from '@/containers/rooms/roomsBindings'
import { activeParticipants, messagesOf } from '@/containers/rooms/roomUi'
import { RoomCard } from '@/containers/rooms/RoomCard'
import { RoomTemplates } from '@/containers/rooms/RoomTemplates'
import { useRoomDetails } from '@/containers/rooms/useRoomDetails'
import {
  CreateRoomDialog,
  RoomsKpis,
  WaitingRooms,
} from '@/containers/rooms/RoomsListParts'
import { roomFolderAdapter } from '@/lib/groups/adapters'
import { addNewItemToGroup } from '@/lib/groups/inherit'


export const Route = createFileRoute('/rooms/')({
  component: RoomsList,
  // `?new=1` opens the create dialog: the sidebar's "New room" lands here, and
  // navigating to the page it is already on did nothing. `group` names the
  // sidebar group whose "+" opened it: the new room joins that group.
  validateSearch: (search: Record<string, unknown>): { new?: 1; group?: string } =>
    search.new === 1 || search.new === '1'
      ? {
          new: 1,
          ...(typeof search.group === 'string' && search.group
            ? { group: search.group }
            : {}),
        }
      : {},
})

type Filter = 'all' | 'active' | 'finished' | 'draft'

const FILTERS: Record<Filter, RoomStatus[] | null> = {
  all: null,
  active: ['running', 'awaiting-user', 'paused'],
  finished: ['completed', 'stopped', 'failed'],
  draft: ['draft'],
}

const WEEK = 7 * 24 * 60 * 60 * 1000

function RoomsList() {
  const { t, i18n } = useTranslation()
  const lang = (i18n as { language?: string } | undefined)?.language || 'en'
  const api = useRoomsApi()
  const createdRoomRef = useRef<Awaited<ReturnType<typeof api.createRoom>> | null>(null)
  const { summaries, listLoading, lastError } = useRoomsState()
  const navigate = useNavigate()
  const [error, setError] = useState<RoomsUiError | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  // The group the room being created joins, when "+" on a group opened it.
  const [createGroup, setCreateGroup] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [titleError, setTitleError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [toDelete, setToDelete] = useState<RoomSummary | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    if (api.status !== 'ready') return
    api.loadSummaries().catch((err) => setError(normalizeError(err)))
  }, [api])

  const details = useRoomDetails(api, summaries)

  const openCreate = (preset?: { title: string; objective: string }) => {
    createdRoomRef.current = null
    setTitle(preset?.title ?? '')
    setObjective(preset?.objective ?? '')
    setTitleError(false)
    setCreateGroup(null)
    setCreateOpen(true)
  }

  const search = useSearch({ strict: false }) as { new?: 1; group?: string }
  const wantsNew = search.new === 1
  useEffect(() => {
    if (!wantsNew) return
    openCreate()
    setCreateGroup(search.group ?? null)
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
      // A retry after the group step failed reuses the room already made.
      const room =
        createdRoomRef.current ??
        (await api.createRoom({ title: title.trim(), objective: objective.trim() }))
      createdRoomRef.current = room
      if (createGroup)
        await addNewItemToGroup('rooms', room.id, createGroup, roomFolderAdapter(api))
      createdRoomRef.current = null
      setCreateGroup(null)
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

  const archiveOn = useArchiveEnabled()
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

  // A model with no known context window is settled with the user first.
  const whenWindowsKnown = async (roomId: string, go: () => Promise<void>) => {
    const room = details[roomId]?.room
    if (room && !(await ensureKnownWindows(room))) return
    await go()
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

  const templates = <RoomTemplates onPick={openCreate} />

  return (
    <div className="@container/rooms flex h-full flex-col">
      <HeaderPage />
      <div className="-mr-3 h-full overflow-y-auto pr-3">
        <div className="flex w-full flex-col gap-5 px-1 py-4">
          <div className="flex flex-wrap items-end gap-3 motion-safe:animate-rise-in">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-[length:calc(var(--ui-font-base)*1.375)] leading-tight font-semibold tracking-[-0.01em] text-foreground">
                {t('rooms:title')}
              </h1>
              <p className="text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">{t('rooms:subtitle')}</p>
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
            <div className="grid grid-cols-1 gap-4 @5xl/rooms:grid-cols-2 @[96rem]/rooms:grid-cols-3">
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
              <RoomsKpis stats={stats} />

              <WaitingRooms waiting={waiting} details={details} lang={lang} />

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[length:calc(var(--ui-font-base)*0.9375)] font-semibold text-foreground">
                    {t('rooms:list.yours')}
                  </h2>
                  <span className="flex-1" />
                  <Segmented
                    size="sm"
                    aria-label={t('rooms:filter.label')}
                    className="w-full @[40rem]/rooms:w-[380px]"
                    value={filter}
                    onValueChange={setFilter}
                    options={(Object.keys(FILTERS) as Filter[]).map((f) => ({
                      value: f,
                      label: t(`rooms:filter.${f}`),
                    }))}
                  />
                </div>
                {shown.length === 0 ? (
                  <p className="rounded-xl border-[0.8px] border-dashed border-border-strong px-4 py-8 text-center text-[length:calc(var(--ui-font-base)*0.8125)] text-muted-foreground">
                    {t('rooms:filter.none')}
                  </p>
                ) : (
                  <ul className="grid grid-cols-1 gap-4 @5xl/rooms:grid-cols-2 @[96rem]/rooms:grid-cols-3">
                    {shown.map((s, i) => (
                      <RoomCard
                        key={s.id}
                        summary={s}
                        detail={details[s.id]}
                        index={i}
                        onOpen={() => navigate({ to: route.roomDetail, params: { roomId: s.id } })}
                        onDelete={() => setToDelete(s)}
                        onPause={() => act(() => api.controller.pause(s.id))}
                        onResume={() => act(() => whenWindowsKnown(s.id, () => api.controller.resume(s.id)))}
                        onStart={() => act(() => whenWindowsKnown(s.id, () => api.controller.start(s.id)))}
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

      <CreateRoomDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={title}
        onTitleChange={(value) => {
          setTitle(value)
          setTitleError(false)
        }}
        objective={objective}
        onObjectiveChange={setObjective}
        titleError={titleError}
        creating={creating}
        onSubmit={() => void create()}
      />

      <Dialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {archiveOn ? t('archive:moveTitle') : t('rooms:delete.title')}
            </DialogTitle>
            <DialogDescription>
              {archiveOn
                ? t('archive:moveBody', { title: toDelete?.title || t('rooms:list.untitled') })
                : t('rooms:delete.description', { title: toDelete?.title || t('rooms:list.untitled') })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="surface" onClick={() => setToDelete(null)}>
              {t('rooms:delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              {archiveOn
                ? t('archive:moveButton')
                : t('rooms:delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
