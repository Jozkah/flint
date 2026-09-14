import { createFileRoute, Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
  type RoomsUiError,
} from '@/containers/rooms/roomsBindings'
import { RoomStatusBadge } from '@/containers/rooms/RoomStatusBadge'
import { RoomUsageBar } from '@/containers/rooms/RoomUsageBar'
import { RoomTranscript } from '@/containers/rooms/RoomTranscript'
import { RoomComposer } from '@/containers/rooms/RoomComposer'
import { RoomControls } from '@/containers/rooms/RoomControls'
import { RoomEditor } from '@/containers/rooms/RoomEditor'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.roomDetail as any)({
  component: RoomPage,
})

function RoomPage() {
  const { t } = useTranslation()
  const { roomId } = useParams({ from: '/rooms/$roomId' })
  const api = useRoomsApi()
  const state = useRoomsState()
  const [error, setError] = useState<RoomsUiError | null>(null)

  useEffect(() => {
    if (api.status !== 'ready') return
    setError(null)
    api.loadRoom(roomId).catch((err) => setError(normalizeError(err)))
  }, [api, roomId])

  const room = state.room?.id === roomId ? state.room : null

  const back = (
    <Link
      to={route.rooms}
      aria-label={t('rooms:back')}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent pointer-coarse:size-11"
    >
      <ArrowLeft className="size-4" aria-hidden />
    </Link>
  )

  if (!room) {
    const loading = api.status === 'pending' || (state.roomLoading && !error)
    return (
      <div className="flex h-full flex-col">
        <HeaderPage>
          <div className="flex min-w-0 items-center gap-2">
            {back}
            <h1 className="truncate text-sm font-medium">{t('rooms:title')}</h1>
          </div>
        </HeaderPage>
        <div className="flex h-[calc(100%-var(--ctx-h,52px))] items-center justify-center p-4 text-center">
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('rooms:loading')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                {api.status === 'unavailable' ? t('rooms:engineUnavailable') : t('rooms:notFound')}
              </p>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error.message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <HeaderPage>
        <div className="flex min-w-0 items-center gap-2 pr-2">
          {back}
          <h1 className="truncate text-sm font-medium">{room.title || t('rooms:list.untitled')}</h1>
          <RoomStatusBadge status={room.status} />
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-var(--ctx-h,52px))] min-h-0 flex-col">
        <RoomUsageBar room={room} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/*
            The transcript owns its own vertical scroll (see RoomTranscript), so
            `main` only has to bound its height and pin the composer beneath it.
            Narrow: a fixed 70vh block scrolls its messages while the page scroll
            still reaches the side panel below. Wide: main fills the row and the
            transcript scrolls within it. `overflow-hidden` keeps the composer
            from scrolling away with the messages.
          */}
          <main className="flex h-[70vh] min-w-0 flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1">
            <RoomTranscript room={room} journal={state.journal} liveTurn={state.liveTurn} />
            <RoomComposer room={room} />
          </main>
          <aside
            data-testid="room-side-panel"
            className="flex w-full shrink-0 flex-col gap-6 border-t border-border bg-card p-4 lg:w-[360px] lg:overflow-y-auto lg:border-l lg:border-t-0"
          >
            <RoomControls room={room} />
            <RoomEditor room={room} />
          </aside>
        </div>
      </div>
    </div>
  )
}
