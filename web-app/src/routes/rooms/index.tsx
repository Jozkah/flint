import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { MessagesSquare, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
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
import type { RoomSummary } from '@/lib/rooms/types'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
  type RoomsUiError,
} from '@/containers/rooms/roomsBindings'
import { RoomStatusBadge } from '@/containers/rooms/RoomStatusBadge'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.rooms as any)({
  component: RoomsList,
})

function RoomsList() {
  const { t } = useTranslation()
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

  useEffect(() => {
    if (api.status !== 'ready') return
    api.loadSummaries().catch((err) => setError(normalizeError(err)))
  }, [api])

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

  const shownError = error ?? lastError

  return (
    <div className="flex h-full flex-col">
      <HeaderPage>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <Button
            size="sm"
            disabled={api.status !== 'ready'}
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden />
            {t('rooms:list.create')}
          </Button>
        </div>
      </HeaderPage>
      <div className="h-[calc(100%-var(--ctx-h,52px))] overflow-y-auto">
        <div className="flex w-full flex-col gap-4 px-1 py-4">
          <div className="flex flex-col gap-1 motion-safe:animate-rise-in">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-foreground">
              {t('rooms:title')}
            </h1>
            <p className="text-[13px] text-muted-foreground">{t('rooms:subtitle')}</p>
          </div>

          {shownError && (
            <p role="alert" className="text-sm text-destructive">
              {shownError.message}
            </p>
          )}

          {api.status === 'pending' || (listLoading && summaries.length === 0) ? (
            <div className="flex max-w-[820px] flex-col gap-3">
              <p role="status" className="sr-only">
                {t('rooms:loading')}
              </p>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  aria-hidden
                  className="flex flex-col gap-2.5 rounded-xl border-[0.8px] border-border bg-card px-4 py-3.5"
                >
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-56" />
                </div>
              ))}
            </div>
          ) : api.status === 'unavailable' ? (
            <p className="text-sm text-muted-foreground">{t('rooms:engineUnavailable')}</p>
          ) : summaries.length === 0 ? (
            <EmptyState
              className="max-w-[820px] rounded-xl border-[0.8px] border-dashed border-border-strong py-12"
              icon={<MessagesSquare />}
              title={t('rooms:list.empty')}
              description={t('rooms:list.emptyHint')}
              action={
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden />
                  {t('rooms:list.create')}
                </Button>
              }
            />
          ) : (
            <ul className="flex max-w-[820px] flex-col gap-3">
              {summaries.map((s, i) => {
                const name = s.title || t('rooms:list.untitled')
                return (
                  <li
                    key={s.id}
                    data-testid="room-summary"
                    style={{ animationDelay: `${60 + Math.min(i, 8) * 50}ms` }}
                    className="group/room relative flex min-w-0 flex-col gap-2 rounded-xl border-[0.8px] border-border bg-card px-4 py-3.5 transition-[box-shadow,transform] duration-300 ease-expo focus-within:shadow-lift hover:-translate-y-px hover:shadow-lift motion-safe:animate-rise-in"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                      {/* The title link covers the whole card, so anywhere on it opens
                          the room; Delete sits above that overlay. */}
                      <Link
                        to={route.roomDetail}
                        params={{ roomId: s.id }}
                        aria-label={t('rooms:list.open', { title: name })}
                        className="min-w-0 truncate text-sm font-semibold text-foreground outline-hidden after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
                      >
                        {name}
                      </Link>
                      <RoomStatusBadge status={s.status} />
                      <span className="flex-1" />
                      <Button
                        size="xs"
                        variant="ghost"
                        className="relative z-10 opacity-70 group-hover/room:opacity-100 focus-visible:opacity-100"
                        aria-label={t('rooms:list.deleteLabel', { title: name })}
                        onClick={() => setToDelete(s)}
                      >
                        {t('rooms:list.delete')}
                      </Button>
                    </div>
                    {s.objective && (
                      <p className="line-clamp-2 text-[13px] leading-normal text-muted-foreground">
                        {s.objective}
                      </p>
                    )}
                    <p className="text-xs text-subtle-foreground">
                      {[
                        t(`rooms:mode.${s.mode}`),
                        t('rooms:list.participants', { count: s.participantCount }),
                        t('rooms:list.turns', { count: s.turns }),
                        t('rooms:list.updated', { time: new Date(s.updatedAt).toLocaleString() }),
                      ].join(' · ')}
                    </p>
                  </li>
                )
              })}
            </ul>
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
