import { createFileRoute, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import HeaderPage from '@/containers/HeaderPage'
import { SplitWorkspace } from '@/containers/SplitConversation'
import type { SplitTarget } from '@/hooks/useSplitConversation'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
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

/** The room the route names, with any split-view panes beside it. */
function RoomPage() {
  const { roomId } = useParams({ from: '/rooms/$roomId' })
  const primary = useMemo<SplitTarget>(
    () => ({ kind: 'room', refId: roomId }),
    [roomId]
  )
  return (
    <SplitWorkspace primary={primary}>
      {() => <RoomView roomId={roomId} />}
    </SplitWorkspace>
  )
}

/** One room: its conversation and its controls. Also a split-view pane. */
export function RoomView({ roomId }: { roomId: string }) {
  const { t } = useTranslation()
  const api = useRoomsApi()
  const state = useRoomsState()
  const [error, setError] = useState<RoomsUiError | null>(null)
  // Narrow widths show one pane at a time; wide ones show both.
  const [pane, setPane] = useState<'talk' | 'controls'>('talk')

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
        <div className="flex h-full items-center justify-center p-4 text-center">
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
    <div className="@container/room flex h-full flex-col" data-testid="room-page">
      <HeaderPage>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <RoomStatusBadge status={room.status} />
          <Chip className="hidden @[40rem]/room:inline-flex">{t(`rooms:mode.${room.mode}`)}</Chip>
          <span className="flex-1" />
          {people.length > 0 && (
            <span
              className="hidden items-center pr-1 @[40rem]/room:flex"
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
        their own right column. Narrow (phones, small windows): one pane at a
        time, switched by the tabs above; the conversation fills the height so
        its composer stays at the bottom, and the controls scroll on their own.
      */}
      <div className="px-1 pt-3 @5xl/room:hidden">
        <Segmented
          aria-label={t('rooms:page.panes')}
          value={pane}
          onValueChange={setPane}
          options={[
            { value: 'talk', label: t('rooms:page.talk'), testId: 'room-pane-talk' },
            { value: 'controls', label: t('rooms:page.controls'), testId: 'room-pane-controls' },
          ]}
        />
      </div>
      <div
        className={cn(
          'grid h-full min-h-0 grid-cols-[minmax(0,1fr)] gap-4 px-1 py-3 @5xl/room:grid-cols-[minmax(0,1fr)_370px] @5xl/room:overflow-hidden @5xl/room:py-4',
          pane === 'controls' ? 'overflow-y-auto' : 'overflow-hidden'
        )}
      >
        <Frame
          className={cn(
            'h-full min-h-0 motion-safe:animate-rise-in',
            pane === 'controls' && '@max-5xl/room:hidden'
          )}
        >
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
          className={cn(
            'flex w-full min-w-0 shrink-0 flex-col gap-4 pb-0.5 [scrollbar-width:none] @5xl/room:min-h-0 @5xl/room:w-[370px] @5xl/room:overflow-y-auto',
            pane === 'talk' && '@max-5xl/room:hidden'
          )}
        >
          <RoomControls room={room} />
          <RoomEditor room={room} />
        </aside>
      </div>
    </div>
  )
}
