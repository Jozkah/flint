import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
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
        <div className="flex min-w-0 items-center gap-2 pr-2">
          <h1 className="truncate text-sm font-medium">{t('rooms:title')}</h1>
          <Button
            size="sm"
            className="ml-auto"
            disabled={api.status !== 'ready'}
            onClick={() => setCreateOpen(true)}
          >
            {t('rooms:list.create')}
          </Button>
        </div>
      </HeaderPage>
      <div className="h-[calc(100%-var(--ctx-h,52px))] overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          <p className="text-sm text-muted-foreground">{t('rooms:subtitle')}</p>

          {shownError && (
            <p role="alert" className="text-sm text-destructive">
              {shownError.message}
            </p>
          )}

          {api.status === 'pending' || (listLoading && summaries.length === 0) ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('rooms:loading')}
            </p>
          ) : api.status === 'unavailable' ? (
            <p className="text-sm text-muted-foreground">{t('rooms:engineUnavailable')}</p>
          ) : summaries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center">
              <h2 className="text-base font-medium">{t('rooms:list.empty')}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">{t('rooms:list.emptyHint')}</p>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                {t('rooms:list.create')}
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {summaries.map((s) => {
                const name = s.title || t('rooms:list.untitled')
                return (
                  <li
                    key={s.id}
                    data-testid="room-summary"
                    className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-card p-3"
                  >
                    <Link
                      to={route.roomDetail}
                      params={{ roomId: s.id }}
                      aria-label={t('rooms:list.open', { title: name })}
                      className="flex min-w-0 flex-1 flex-col gap-1 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{name}</span>
                        <RoomStatusBadge status={s.status} />
                      </span>
                      {s.objective && (
                        <span className="line-clamp-2 text-sm text-muted-foreground">{s.objective}</span>
                      )}
                      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{t(`rooms:mode.${s.mode}`)}</span>
                        <span>{t('rooms:list.participants', { count: s.participantCount })}</span>
                        <span>{t('rooms:list.turns', { count: s.turns })}</span>
                        <span>
                          {t('rooms:list.updated', { time: new Date(s.updatedAt).toLocaleString() })}
                        </span>
                      </span>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('rooms:list.deleteLabel', { title: name })}
                      onClick={() => setToDelete(s)}
                    >
                      {t('rooms:list.delete')}
                    </Button>
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
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
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
            <Button variant="ghost" onClick={() => setToDelete(null)}>
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
