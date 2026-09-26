import {
  Fragment,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from 'react'
import {
  Columns2,
  List,
  Loader2,
  MessagesSquare,
  Plus,
  Square,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  NoHeaderSlot,
  PaneHeaderSlot,
} from '@/components/shell/HeaderSlot'
import HeaderPage from '@/containers/HeaderPage'
import { PaneHeaderBar } from '@/containers/PaneHeaderBar'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { ThreadConversation } from '@/containers/ThreadConversation'
import {
  ConversationPaneContext,
  type ConversationPane,
} from '@/hooks/useConversationPane'
import {
  CoworkPaneContext,
  PaneChromeContext,
  PaneWidthContext,
  type PaneChrome,
} from '@/hooks/useCoworkPane'
import { plainTitle, usePaneTitle } from '@/hooks/useSplitPaneTitle'
import { useRoomsStore } from '@/lib/rooms/store'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useElementWidth } from '@/hooks/useElementWidth'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  PANE_MIN_WIDTH,
  PRIMARY_PANE,
  SINGLE_INSTANCE_KINDS,
  normalizeSizes,
  paneDraftScope,
  useSplitConversation,
  type SplitPane,
  type SplitPaneId,
  type SplitTarget,
} from '@/hooks/useSplitConversation'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { resolveThreadModelId } from '@/lib/models'
import { ShortcutAction, isMac, type ShortcutSpec } from '@/lib/shortcuts'
import { openAsPrimary, reportSplitResult } from '@/lib/splitView'
import { isCoworkEnabled } from '@/lib/version'
import { cn } from '@/lib/utils'
import { useChatSessions } from '@/stores/chat-session-store'

/**
 * Split view: up to `maxPanes` conversations side by side.
 *
 * The route's conversation is the main pane; the others come from the split
 * store. Every pane renders its own conversation with its own id -- a Chat
 * thread through `ThreadConversation`, a Cowork session through the Cowork
 * page scoped to that session -- so session, stream, model, draft,
 * attachments and approvals never cross. When the panes would be narrower
 * than `PANE_MIN_WIDTH` they take turns instead, behind a tab strip. All
 * panes stay mounted either way, so switching loses no draft, stream or
 * scroll position.
 */

// Loaded on first use: the Cowork page is large and a Chat-only split never
// needs it.
const CoworkPage = lazy(() =>
  import('@/routes/cowork').then((m) => ({ default: m.CoworkPage }))
)
const RoomView = lazy(() =>
  import('@/routes/rooms/$roomId').then((m) => ({ default: m.RoomView }))
)

const paneFallback = (
  <div className="flex h-full items-center justify-center">
    <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" />
  </div>
)

/** A binding as the user types it, e.g. `Ctrl+\`. */
function shortcutText(spec: ShortcutSpec | undefined): string {
  if (!spec) return ''
  const parts: string[] = []
  if (spec.usePlatformMetaKey) parts.push(isMac ? '⌘' : 'Ctrl')
  if (spec.ctrlKey) parts.push('Ctrl')
  if (spec.metaKey) parts.push('⌘')
  if (spec.altKey) parts.push(isMac ? '⌥' : 'Alt')
  if (spec.shiftKey) parts.push(isMac ? '⇧' : 'Shift')
  parts.push(spec.key.length === 1 ? spec.key.toUpperCase() : spec.key)
  return parts.join(isMac ? '' : '+')
}

function useSplitShortcut(): string {
  useKeybindings((s) => s.overrides[ShortcutAction.SPLIT_VIEW])
  return shortcutText(
    useKeybindings.getState().specFor?.(ShortcutAction.SPLIT_VIEW)
  )
}

/** The header's Split action: an empty pane opens beside this conversation. */
export function SplitToggleButton() {
  const { t } = useTranslation()
  const shortcut = useSplitShortcut()
  const hint = shortcut
    ? t('chat:split.openHintShortcut', { shortcut })
    : t('chat:split.openHint')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-[30px] shrink-0 pointer-coarse:h-11"
          onClick={() =>
            reportSplitResult(useSplitConversation.getState().addPane(), t)
          }
          aria-label={t('chat:split.open')}
          aria-keyshortcuts={shortcut || undefined}
          data-testid="split-conversation-open"
        >
          <Columns2 className="size-4" aria-hidden />
          <span className="max-sm:sr-only">{t('chat:split.openShort')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The split's own actions -- another pane, or back to one conversation -- as
 * a compact icon group in the app's top header, at the right of the page's
 * slot. Outside the shell (tests) the header renders in place.
 */
function SplitActions() {
  const { t } = useTranslation()
  const full = useSplitConversation((s) => s.panes.length + 1 >= s.maxPanes)
  const maxPanes = useSplitConversation((s) => s.maxPanes)
  const closeAll = useSplitConversation((s) => s.closeAll)
  const addLabel = full
    ? t('chat:split.full', { count: maxPanes })
    : t('chat:split.addPane')
  return (
    <HeaderPage>
      <div
        role="group"
        aria-label={t('chat:split.label')}
        data-testid="split-actions"
        className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5 shadow-[inset_0_0_0_0.8px_var(--border)]"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button fires no pointer events: the span keeps the
                tooltip saying why no pane can be added. */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                disabled={full}
                onClick={() =>
                  reportSplitResult(
                    useSplitConversation.getState().addPane(),
                    t
                  )
                }
                aria-label={t('chat:split.addPane')}
                data-testid="split-add-pane"
              >
                <Plus className="size-4" aria-hidden />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{addLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
              onClick={closeAll}
              aria-label={t('chat:split.close')}
              data-testid="split-conversation-close"
            >
              <Square className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('chat:split.close')}</TooltipContent>
        </Tooltip>
      </div>
    </HeaderPage>
  )
}

/**
 * Close the main pane: the first other pane with a conversation takes its
 * place as the route's conversation.
 */
function closePrimaryPane() {
  const split = useSplitConversation.getState()
  const next = split.panes.find((p) => p.refId)
  if (!next) {
    split.closeAll()
    return
  }
  split.closePane(next.id)
  split.setActivePane(PRIMARY_PANE)
  openAsPrimary({ kind: next.kind, refId: next.refId })
}

/** A pane's own controls: pick another conversation, or close it. */
export function PaneControls({ paneId }: { paneId: SplitPaneId }) {
  const { t } = useTranslation()
  const isPrimary = paneId === PRIMARY_PANE
  const close = () =>
    isPrimary
      ? closePrimaryPane()
      : useSplitConversation.getState().closePane(paneId)
  return (
    <>
      {!isPrimary && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
          onClick={() => {
            const pane = useSplitConversation
              .getState()
              .panes.find((p) => p.id === paneId)
            useSplitConversation
              .getState()
              .setPaneTarget(paneId, { kind: pane?.kind ?? 'chat' })
          }}
          aria-label={t('chat:split.change')}
          title={t('chat:split.change')}
          data-testid={`split-pane-change-${paneId}`}
        >
          <List className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
        onClick={close}
        aria-label={t('chat:split.closePane')}
        title={t('chat:split.closePane')}
        data-testid={`split-pane-close-${paneId}`}
      >
        <X className="size-4" />
      </Button>
    </>
  )
}

function usePaneStreaming(kind: SplitTarget['kind'], refId?: string) {
  const chat = useChatSessions((s) =>
    kind === 'chat' && refId ? (s.sessions[refId]?.isStreaming ?? false) : false
  )
  const cowork = useCoworkRun((s) =>
    kind === 'cowork' && refId ? Boolean(s.runs?.[refId]) : false
  )
  const room = useRoomsStore((s) =>
    kind === 'room' && refId ? s.runningRoomIds.includes(refId) : false
  )
  return chat || cowork || room
}

type ShownPane = { id: SplitPaneId; kind: SplitTarget['kind']; refId?: string }

function PaneTab({
  pane,
  index,
  selected,
  onSelect,
}: {
  pane: ShownPane
  index: number
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const title = usePaneTitle(pane.kind, pane.refId)
  const streaming = usePaneStreaming(pane.kind, pane.refId)
  const label =
    pane.id === PRIMARY_PANE
      ? t('chat:split.primary')
      : t('chat:split.paneNumber', { index: index + 1 })
  return (
    <button
      type="button"
      role="tab"
      id={`conversation-pane-tab-${pane.id}`}
      aria-selected={selected}
      aria-controls={`conversation-pane-${pane.id}`}
      tabIndex={selected ? 0 : -1}
      data-testid={`split-pane-tab-${pane.id}`}
      data-streaming={streaming}
      title={title}
      onClick={onSelect}
      className={cn(
        'relative flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-sm px-3 text-[13px] font-medium transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11',
        selected
          ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <span className="sr-only">{label}: </span>
      <span className="text-fade">{title}</span>
      {streaming && (
        <>
          {/* Replying is activity, not selection: an icon, never the accent. */}
          <Loader2
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          />
          <span className="sr-only">{t('chat:split.streaming')}</span>
        </>
      )}
    </button>
  )
}

/**
 * When the panes do not fit side by side they take turns. This says which one
 * is showing and whether any is replying, and switches between them.
 */
function PaneTabs({
  panes,
  activeId,
}: {
  panes: ShownPane[]
  activeId: SplitPaneId
}) {
  const { t } = useTranslation()
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const listRef = useRef<HTMLDivElement>(null)

  // Arrow keys move between the tabs, as a tab list should.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const at = panes.findIndex((p) => p.id === activeId)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = panes[(at + step + panes.length) % panes.length]
    setActivePane(next.id)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#conversation-pane-tab-${next.id}`)
      ?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('chat:split.panes')}
      onKeyDown={onKeyDown}
      data-testid="split-pane-switch"
      className="flex w-full min-w-0 max-w-2xl gap-0.5 rounded-md bg-muted p-0.5"
    >
      {panes.map((pane, index) => (
        <PaneTab
          key={pane.id}
          pane={pane}
          index={index}
          selected={pane.id === activeId}
          onSelect={() => setActivePane(pane.id)}
        />
      ))}
    </div>
  )
}

const RATIO_STEP = 0.02

/**
 * The line between two side-by-side panes. Drag it, or focus it and use the
 * arrow keys.
 */
function SplitDivider({
  index,
  containerRef,
}: {
  index: number
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation()
  const share = useSplitConversation(
    (s) => normalizeSizes(s.sizes, s.panes.length + 1)[index] ?? 0
  )
  const resizeDivider = useSplitConversation((s) => s.resizeDivider)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowLeft'
        ? -RATIO_STEP
        : event.key === 'ArrowRight'
          ? RATIO_STEP
          : undefined
    if (delta === undefined) return
    event.preventDefault()
    resizeDivider(index, delta)
  }

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture?.(event.pointerId)
      let lastX = event.clientX
      const move = (e: globalThis.PointerEvent) => {
        const width = containerRef.current?.getBoundingClientRect().width
        if (!width) return
        resizeDivider(index, (e.clientX - lastX) / width)
        lastX = e.clientX
      }
      const end = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    },
    [containerRef, index, resizeDivider]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('chat:split.resize')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      data-testid={`split-divider-${index}`}
      className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-border-strong group-focus-visible:bg-acc"
      />
    </div>
  )
}

/**
 * An empty pane: a recent conversation -- Chat or Cowork -- or a new chat
 * with the model currently chosen.
 */
function PanePicker({
  paneId,
  exclude,
}: {
  paneId: SplitPaneId
  exclude: ShownPane[]
}) {
  const { t } = useTranslation()
  const threads = useThreads((s) => s.threads)
  const sessions = useCoworkSessions((s) => s.sessions)
  const rooms = useRoomsStore((s) => s.summaries)
  const coworkOn = isCoworkEnabled()
  // One room at a time: the rooms engine holds a single open room.
  const roomShown = exclude.some((p) => p.kind === 'room' && p.refId)

  const taken = (kind: SplitTarget['kind'], id: string) =>
    exclude.some((p) => p.kind === kind && p.refId === id)

  const recentChats = Object.values(threads ?? {})
    .filter((th) => th.id !== TEMPORARY_CHAT_ID && !taken('chat', th.id))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, 6)
  const recentSessions = coworkOn
    ? [...(sessions ?? [])]
        .filter((s) => !taken('cowork', s.id))
        .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
        .slice(0, 4)
    : []

  const recentRooms = roomShown
    ? []
    : [...(rooms ?? [])]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 4)

  const choose = (target: SplitTarget) => {
    const split = useSplitConversation.getState()
    split.setPaneTarget(paneId, target)
    split.setActivePane(paneId)
  }

  const startNewChat = async () => {
    const { selectedModel, selectedProvider, getProviderByName } =
      useModelProvider.getState()
    // Same rule as every other way into a new chat: never a model the
    // provider cannot serve (janhq/jan#8007).
    const modelId = resolveThreadModelId(
      selectedProvider,
      selectedModel?.id,
      (getProviderByName(selectedProvider)?.models ?? []).map((m) => m.id)
    )
    if (!modelId) {
      toast.error(t('chat:split.noModel'))
      return
    }
    try {
      const created = await useThreads
        .getState()
        .createThread({ id: modelId, provider: selectedProvider })
      choose({ kind: 'chat', refId: created.id })
    } catch (error) {
      console.error('Failed to start a chat in a split pane:', error)
      toast.error(t('chat:split.newChatFailed'))
    }
  }

  const row = (
    key: string,
    target: SplitTarget,
    title: string,
    icon: ReactNode
  ) => (
    <li key={key}>
      <button
        type="button"
        onClick={() => choose(target)}
        data-testid={`split-pick-${target.refId}`}
        className="flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-secondary-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring active:scale-[.965] pointer-coarse:h-11"
      >
        {icon}
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
      </button>
    </li>
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col rounded-xl bg-muted p-1 shadow-[inset_0_0_0_0.8px_var(--border)]"
      data-testid="split-pane-picker"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 pr-1 pl-2 pointer-coarse:h-12">
        <span className="flex min-w-0 items-center gap-3">
          <Icon name="comment" size={16} />
          <span className="truncate text-sm leading-none font-medium text-secondary-foreground">
            {t('chat:split.newPane')}
          </span>
        </span>
        <div className="flex items-center">
          <PaneControls paneId={paneId} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border-[0.8px] border-input bg-card px-6 py-8 motion-safe:animate-rise-in">
        <div className="flex w-full flex-col items-start gap-2.5">
          <h2 className="text-lg font-medium text-foreground">
            {t('chat:split.pickTitle')}
          </h2>
          <p className="text-[13px] leading-normal text-muted-foreground">
            {t('chat:split.pickDescription')}
          </p>
          <Button
            className="pointer-coarse:h-11"
            onClick={() => void startNewChat()}
            data-testid="split-new-chat"
          >
            <Plus className="size-3.5" />
            {t('chat:split.newChat')}
          </Button>
          <h3 className="mt-2 mb-0.5 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
            {t('chat:split.recent')}
          </h3>
        </div>
        <div className="w-full">
          {recentChats.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {t('chat:split.noRecent')}
            </p>
          ) : (
            <ul className="flex flex-col">
              {recentChats.map((th) =>
                row(
                  th.id,
                  { kind: 'chat', refId: th.id },
                  plainTitle(th.title, t('common:newThread')),
                  <Icon name="comment" size={16} />
                )
              )}
            </ul>
          )}
        </div>
        {recentSessions.length > 0 && (
          <div className="mt-3 w-full">
            <h3 className="mb-0.5 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
              {t('chat:split.recentCowork')}
            </h3>
            <ul className="flex flex-col">
              {recentSessions.map((s) =>
                row(
                  s.id,
                  { kind: 'cowork', refId: s.id },
                  s.title || t('chat:split.cowork'),
                  <Columns2 className="size-4 shrink-0" aria-hidden />
                )
              )}
            </ul>
          </div>
        )}
        {recentRooms.length > 0 && (
          <div className="mt-3 w-full">
            <h3 className="mb-0.5 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
              {t('chat:split.recentRooms')}
            </h3>
            <ul className="flex flex-col">
              {recentRooms.map((r) =>
                row(
                  r.id,
                  { kind: 'room', refId: r.id },
                  r.title || t('chat:split.room'),
                  <MessagesSquare className="size-4 shrink-0" aria-hidden />
                )
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** A Chat thread in a pane beside the main one. */
const ChatPane = memo(function ChatPane({
  paneId,
  threadId,
  isActive,
}: {
  paneId: SplitPaneId
  threadId: string
  isActive: boolean
}) {
  const pane = useMemo<ConversationPane>(
    () => ({ paneId, threadId, isSplit: true, isActive }),
    [paneId, threadId, isActive]
  )
  return (
    <ConversationPaneContext.Provider value={pane}>
      <ThreadConversation
        // A different conversation in this pane is a fresh one.
        key={threadId}
        threadId={threadId}
        paneControls={<PaneControls paneId={paneId} />}
      />
    </ConversationPaneContext.Provider>
  )
})

/**
 * The header row of a pane whose page draws none of its own (a room). Chat
 * and Cowork pages draw the pane's header themselves, merged with their own.
 */
function PaneHeader({
  paneId,
  kind,
  refId,
  isActive,
}: {
  paneId: SplitPaneId
  kind: SplitTarget['kind']
  refId?: string
  isActive: boolean
}) {
  const title = usePaneTitle(kind, refId)
  return (
    <PaneHeaderBar
      paneId={paneId}
      isActive={isActive}
      title={title}
      controls={<PaneControls paneId={paneId} />}
    />
  )
}

/** What a Cowork page in a pane needs to draw the pane's header itself. */
function usePaneChromeValue(
  paneId: SplitPaneId,
  isActive: boolean
): PaneChrome {
  return useMemo(
    () => ({
      paneId,
      isActive,
      controls: <PaneControls paneId={paneId} />,
    }),
    [paneId, isActive]
  )
}

/** A Cowork session in a pane beside the main one. */
function CoworkPane({
  paneId,
  sessionId,
  isActive,
}: {
  paneId: SplitPaneId
  sessionId: string
  isActive: boolean
}) {
  const scope = useMemo(
    () => ({ sessionId, draftScope: paneDraftScope(paneId) }),
    [sessionId, paneId]
  )
  const chrome = usePaneChromeValue(paneId, isActive)
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <NoHeaderSlot>
        <CoworkPaneContext.Provider value={scope}>
          <PaneChromeContext.Provider value={chrome}>
            <Suspense fallback={paneFallback}>
              <CoworkPage key={sessionId} />
            </Suspense>
          </PaneChromeContext.Provider>
        </CoworkPaneContext.Provider>
      </NoHeaderSlot>
    </div>
  )
}

/** A discussion room in a pane beside the main one. */
function RoomPane({
  paneId,
  roomId,
  isActive,
}: {
  paneId: SplitPaneId
  roomId: string
  isActive: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        paneId={paneId}
        kind="room"
        refId={roomId}
        isActive={isActive}
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <NoHeaderSlot>
          <Suspense fallback={paneFallback}>
            <RoomView key={roomId} roomId={roomId} />
          </Suspense>
        </NoHeaderSlot>
      </div>
    </div>
  )
}

export type PrimaryPaneState = { isSplit: boolean; isActive: boolean }

/**
 * The route's conversation, and the panes beside it when split.
 *
 * The main pane's element stays in place whether or not the view is split,
 * so opening or closing split view never remounts the route's conversation.
 */
export function SplitWorkspace({
  primary,
  children,
}: {
  primary: SplitTarget
  children: (state: PrimaryPaneState) => ReactNode
}) {
  const panes = useSplitConversation((s) => s.panes)
  const storedActive = useSplitConversation((s) => s.activePane)
  const sizes = useSplitConversation((s) => s.sizes)
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const open = panes.length > 0
  const containerRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(containerRef)

  // Which panes point at a conversation that still exists, as one string so
  // the stores' unrelated changes do not re-render every pane.
  const chatValid = useThreads((s) =>
    panes
      .map((p) =>
        p.kind === 'chat' && p.refId && s.threads?.[p.refId] ? '1' : '0'
      )
      .join('')
  )
  const coworkValid = useCoworkSessions((s) =>
    panes
      .map((p) =>
        p.kind === 'cowork' &&
        p.refId &&
        s.sessions.some((x) => x.id === p.refId)
          ? '1'
          : '0'
      )
      .join('')
  )

  // Never one conversation in two panes: two views of one session would run
  // its tool loop twice. A temporary chat stays where it is.
  const shown = useMemo<ShownPane[]>(() => {
    const out: ShownPane[] = [
      { id: PRIMARY_PANE, kind: primary.kind, refId: primary.refId },
    ]
    panes.forEach((p: SplitPane, i) => {
      const valid =
        p.refId &&
        p.refId !== TEMPORARY_CHAT_ID &&
        (p.kind === 'chat'
          ? chatValid[i] === '1'
          : p.kind === 'cowork'
            ? coworkValid[i] === '1'
            : true) &&
        !out.some(
          (o) =>
            o.kind === p.kind &&
            (o.refId === p.refId ||
              (SINGLE_INSTANCE_KINDS.includes(p.kind) && !!o.refId))
        )
      out.push({ id: p.id, kind: p.kind, refId: valid ? p.refId : undefined })
    })
    return out
  }, [panes, primary.kind, primary.refId, chatValid, coworkValid])

  // Opening a side pane's conversation as the main one (from the sidebar)
  // swaps them, so both stay open; any navigation is work in the main pane.
  const previousPrimary = useRef(primary)
  useEffect(() => {
    const previous = previousPrimary.current
    previousPrimary.current = primary
    if (previous.kind !== primary.kind || previous.refId === primary.refId) {
      return
    }
    const split = useSplitConversation.getState()
    if (split.panes.length === 0) return
    const showing = split.panes.find(
      (p) => p.kind === primary.kind && p.refId === primary.refId
    )
    if (showing) {
      split.setPaneTarget(showing.id, {
        kind: previous.kind,
        refId: previous.refId,
      })
    }
    split.setActivePane(PRIMARY_PANE)
  }, [primary])

  const activeId = shown.some((p) => p.id === storedActive)
    ? storedActive
    : PRIMARY_PANE
  const sideBySide = !open || width >= shown.length * PANE_MIN_WIDTH
  const shares = normalizeSizes(sizes, shown.length)

  // Working in a pane -- a click, a tap, a focus from the keyboard -- makes it
  // the active one.
  const activate = (id: SplitPaneId) => () => {
    if (open) setActivePane(id)
  }

  const primaryState = useMemo<PrimaryPaneState>(
    () => ({ isSplit: open, isActive: !open || activeId === PRIMARY_PANE }),
    [open, activeId]
  )

  // A Cowork page as the main pane draws the pane's header itself.
  const primaryChrome = usePaneChromeValue(
    PRIMARY_PANE,
    activeId === PRIMARY_PANE
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="split-workspace">
      {open && <SplitActions />}
      {open && !sideBySide && (
        // Only when the panes take turns: the strip that switches them.
        <div
          className="flex h-10 shrink-0 items-center px-1 pt-2"
          data-testid="split-bar"
        >
          <PaneTabs panes={shown} activeId={activeId} />
        </div>
      )}
      <div
        ref={containerRef}
        data-testid="conversation-panes"
        data-split={open}
        data-layout={open ? (sideBySide ? 'columns' : 'tabs') : 'single'}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1',
          // Split panes are Frames of their own: give them the page's room.
          open && 'px-1 pt-2 pb-4'
        )}
      >
        {shown.map((pane, index) => {
          const isPrimary = pane.id === PRIMARY_PANE
          const isActive = !open || activeId === pane.id
          const visible = !open || sideBySide || isActive
          return (
            <Fragment key={pane.id}>
              {open && sideBySide && index > 0 && (
                <SplitDivider index={index - 1} containerRef={containerRef} />
              )}
              <div
                id={`conversation-pane-${pane.id}`}
                data-testid={`conversation-pane-${pane.id}`}
                data-kind={pane.kind}
                data-active={isActive}
                role={open && !sideBySide ? 'tabpanel' : undefined}
                aria-hidden={visible ? undefined : true}
                inert={!visible}
                onFocusCapture={activate(pane.id)}
                onPointerDownCapture={activate(pane.id)}
                style={
                  open && sideBySide
                    ? { flexGrow: shares[index], flexBasis: 0 }
                    : undefined
                }
                className={cn(
                  'flex min-h-0 min-w-0 flex-col',
                  !open && 'relative flex-1',
                  open && sideBySide && 'relative shrink',
                  open && !sideBySide && 'absolute inset-0',
                  !visible && 'invisible'
                )}
              >
                <PaneWidthContext.Provider
                  value={
                    open
                      ? sideBySide
                        ? Math.round(width * shares[index])
                        : Math.round(width)
                      : null
                  }
                >
                {isPrimary ? (
                  <>
                    {open && primary.kind === 'room' ? (
                      <PaneHeader
                        paneId={PRIMARY_PANE}
                        kind={primary.kind}
                        refId={primary.refId}
                        isActive={isActive}
                      />
                    ) : null}
                    <div className="relative min-h-0 flex-1">
                      {/* Always the same providers, split or not, so the
                          route's conversation is never remounted. */}
                      <PaneHeaderSlot inPane={open}>
                        <PaneChromeContext.Provider
                          value={
                            open && primary.kind === 'cowork'
                              ? primaryChrome
                              : null
                          }
                        >
                          {children(primaryState)}
                        </PaneChromeContext.Provider>
                      </PaneHeaderSlot>
                    </div>
                  </>
                ) : !pane.refId ? (
                  <PanePicker paneId={pane.id} exclude={shown} />
                ) : pane.kind === 'chat' ? (
                  <ChatPane
                    paneId={pane.id}
                    threadId={pane.refId}
                    isActive={isActive}
                  />
                ) : pane.kind === 'room' ? (
                  <RoomPane
                    paneId={pane.id}
                    roomId={pane.refId}
                    isActive={isActive}
                  />
                ) : (
                  <CoworkPane
                    paneId={pane.id}
                    sessionId={pane.refId}
                    isActive={isActive}
                  />
                )}
                </PaneWidthContext.Provider>
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/** The Cowork route's session as the main pane. */
export function CoworkSplitWorkspace({ children }: { children: ReactNode }) {
  const currentId = useCoworkSessions((s) => s.currentId)
  const primary = useMemo<SplitTarget>(
    () => ({ kind: 'cowork', refId: currentId ?? undefined }),
    [currentId]
  )
  return <SplitWorkspace primary={primary}>{() => children}</SplitWorkspace>
}
