import { createFileRoute, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import {
  normalizeError,
  useRoomsApi,
  useRoomsState,
  type RoomsUiError,
} from '@/containers/rooms/roomsBindings'
import { activeParticipants, participantColor } from '@/containers/rooms/roomUi'
import { RoomAvatar } from '@/containers/rooms/RoomAvatar'
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

  if (!room) {
    const loading = api.status === 'pending' || (state.roomLoading && !error)
    return (
      <div className="flex h-full flex-col">
        <HeaderPage />
        <div className="flex h-[calc(100%-var(--ctx-h,52px))] items-center justify-center p-4 text-center">
          {loading ? (
            <div className="flex w-full max-w-md flex-col items-center gap-3">
              <p role="status" className="sr-only">
                {t('rooms:loading')}
              </p>
              <Skeleton aria-hidden className="h-4 w-2/3" />
              <Skeleton aria-hidden className="h-3 w-1/2" />
            </div>
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

  const people = activeParticipants(room)

  return (
    <div className="flex h-full flex-col">
      <HeaderPage>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <RoomStatusBadge status={room.status} />
          <Chip className="hidden sm:inline-flex">{t(`rooms:mode.${room.mode}`)}</Chip>
          <span className="flex-1" />
          {people.length > 0 && (
            <span
              className="hidden items-center pr-1 sm:flex"
              title={people.map((p) => p.name).join(', ')}
            >
              {people.map((p, i) => (
                <RoomAvatar
                  key={p.id}
                  model={p.model}
                  name={p.name}
                  color={participantColor(p.id)}
                  size={22}
                  className={i > 0 ? '-ml-1.5 ring-[1.5px] ring-card' : 'ring-[1.5px] ring-card'}
                />
              ))}
            </span>
          )}
        </div>
      </HeaderPage>
      {/*
        Wide: the conversation fills the left column and the controls scroll in
        their own right column. Narrow: one column; the conversation gets a
        fixed 70vh block so its transcript still scrolls, and the page scroll
        reaches the controls below it.
      */}
      <div className="grid h-[calc(100%-var(--ctx-h,52px))] min-h-0 grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto px-1 py-4 lg:grid-cols-[minmax(0,1fr)_370px] lg:overflow-hidden">
        <Frame className="h-[70vh] min-h-0 motion-safe:animate-rise-in lg:h-full">
          <FrameHeader
            icon={<MessagesSquare />}
            title={room.title || t('rooms:list.untitled')}
            actions={
              <span className="text-xs text-muted-foreground">
                {t('rooms:list.participants', { count: people.length })}
              </span>
            }
          />
          {/* The transcript owns its own vertical scroll (see RoomTranscript), so
              the body only bounds its height and pins the composer beneath it. */}
          <FrameBody className="min-h-0 overflow-hidden">
            <RoomUsageBar room={room} />
            <RoomTranscript room={room} journal={state.journal} liveTurn={state.liveTurn} />
            <RoomComposer room={room} />
          </FrameBody>
        </Frame>
        <aside
          data-testid="room-side-panel"
          className="flex w-full min-w-0 shrink-0 flex-col gap-4 pb-0.5 [scrollbar-width:none] lg:min-h-0 lg:w-[370px] lg:overflow-y-auto"
        >
          <RoomControls room={room} />
          <RoomEditor room={room} />
        </aside>
      </div>
    </div>
  )
}
