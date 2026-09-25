import { useCallback, useMemo, useRef } from 'react'
import type { KeyboardEvent, PointerEvent, RefObject } from 'react'
import {
  Columns2,
  List,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  useSplitConversation,
  type SplitPaneId,
} from '@/hooks/useSplitConversation'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { resolveThreadModelId } from '@/lib/models'
import { cn } from '@/lib/utils'
import { useChatSessions } from '@/stores/chat-session-store'

/** Thread titles can carry search-highlight markup. */
const plainTitle = (title: string | undefined, fallback: string) =>
  (title || fallback).replace(/<span[^>]*>|<\/span>/g, '')

/** The context bar's Split action for a single conversation. */
export function SplitToggleButton() {
  const { t } = useTranslation()
  const openSplit = useSplitConversation((s) => s.openSplit)
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-[30px] shrink-0 pointer-coarse:h-11"
      onClick={openSplit}
      aria-label={t('chat:split.open')}
      title={t('chat:split.openHint')}
      data-testid="split-conversation-open"
    >
      <Columns2 className="size-4" aria-hidden />
      <span className="hidden lg:inline">{t('chat:split.open')}</span>
    </Button>
  )
}

/** Back to one conversation: the main pane stays, the second closes. */
export function CloseSplitButton() {
  const { t } = useTranslation()
  const closeSplit = useSplitConversation((s) => s.closeSplit)
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-[30px] shrink-0 pointer-coarse:h-11"
      onClick={closeSplit}
      aria-label={t('chat:split.close')}
      data-testid="split-conversation-close"
    >
      <X className="size-4" aria-hidden />
      <span className="hidden sm:inline">{t('chat:split.close')}</span>
    </Button>
  )
}

/** The second pane's own controls: pick another conversation, or close it. */
export function SecondaryPaneControls() {
  const { t } = useTranslation()
  const setSecondaryThread = useSplitConversation((s) => s.setSecondaryThread)
  const closeSplit = useSplitConversation((s) => s.closeSplit)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
        onClick={() => setSecondaryThread(undefined)}
        aria-label={t('chat:split.change')}
        title={t('chat:split.change')}
        data-testid="split-pane-change"
      >
        <List className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
        onClick={closeSplit}
        aria-label={t('chat:split.closePane')}
        title={t('chat:split.closePane')}
        data-testid="split-pane-close"
      >
        <X className="size-4" />
      </Button>
    </>
  )
}

function PaneTab({
  pane,
  threadId,
  controls,
}: {
  pane: SplitPaneId
  threadId?: string
  controls: string
}) {
  const { t } = useTranslation()
  const activePane = useSplitConversation((s) => s.activePane)
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const title = useThreads((s) =>
    threadId ? s.threads?.[threadId]?.title : undefined
  )
  const streaming = useChatSessions((s) =>
    threadId ? (s.sessions[threadId]?.isStreaming ?? false) : false
  )
  const selected = activePane === pane
  const label =
    pane === 'primary' ? t('chat:split.primary') : t('chat:split.secondary')
  const shownTitle = threadId ? plainTitle(title, t('common:newThread')) : label
  return (
    <button
      type="button"
      role="tab"
      id={`conversation-pane-tab-${pane}`}
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      data-testid={`split-pane-tab-${pane}`}
      data-streaming={streaming}
      title={threadId ? shownTitle : undefined}
      onClick={() => setActivePane(pane)}
      className={cn(
        'relative flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-sm px-3 text-[13px] font-medium transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11',
        selected
          ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {/* Which pane, for a screen reader; the title for everyone. */}
      {threadId && <span className="sr-only">{label}: </span>}
      <span className="truncate">{shownTitle}</span>
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
 * Below 1100px the panes take turns. This says which one is showing and
 * whether either is replying, and switches between them.
 */
export function SplitPaneSwitch({
  primaryThreadId,
  secondaryThreadId,
}: {
  primaryThreadId: string
  secondaryThreadId?: string
}) {
  const { t } = useTranslation()
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const listRef = useRef<HTMLDivElement>(null)

  // Arrow keys move between the two tabs, as a tab list should.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next =
      useSplitConversation.getState().activePane === 'primary'
        ? 'secondary'
        : 'primary'
    setActivePane(next)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#conversation-pane-tab-${next}`)
      ?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t('chat:split.panes')}
      onKeyDown={onKeyDown}
      data-testid="split-pane-switch"
      className="grid w-full min-w-0 max-w-md grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5"
    >
      <PaneTab
        pane="primary"
        threadId={primaryThreadId}
        controls="conversation-pane-primary"
      />
      <PaneTab
        pane="secondary"
        threadId={secondaryThreadId}
        controls="conversation-pane-secondary"
      />
    </div>
  )
}

const RATIO_STEP = 0.02

/**
 * The line between side-by-side panes. Drag it, or focus it and use the arrow
 * keys (Home and End for the limits).
 */
export function SplitDivider({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation()
  const ratio = useSplitConversation((s) => s.ratio)
  const setRatio = useSplitConversation((s) => s.setRatio)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = useSplitConversation.getState().ratio
    const next =
      event.key === 'ArrowLeft'
        ? current - RATIO_STEP
        : event.key === 'ArrowRight'
          ? current + RATIO_STEP
          : event.key === 'Home'
            ? SPLIT_MIN_RATIO
            : event.key === 'End'
              ? SPLIT_MAX_RATIO
              : undefined
    if (next === undefined) return
    event.preventDefault()
    setRatio(next)
  }

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture?.(event.pointerId)
      const move = (e: globalThis.PointerEvent) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect || rect.width === 0) return
        setRatio((e.clientX - rect.left) / rect.width)
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
    [containerRef, setRatio]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('chat:split.resize')}
      aria-valuemin={Math.round(SPLIT_MIN_RATIO * 100)}
      aria-valuemax={Math.round(SPLIT_MAX_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      data-testid="split-divider"
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
 * The second pane before it has a conversation: a recent one, or a new chat
 * with the model currently chosen.
 */
export function SecondaryPanePicker({
  primaryThreadId,
}: {
  primaryThreadId: string
}) {
  const { t } = useTranslation()
  const threads = useThreads((s) => s.threads)
  const setSecondaryThread = useSplitConversation((s) => s.setSecondaryThread)
  const setActivePane = useSplitConversation((s) => s.setActivePane)
  const closeSplit = useSplitConversation((s) => s.closeSplit)

  const recent = useMemo(
    () =>
      Object.values(threads ?? {})
        .filter((th) => th.id !== primaryThreadId && th.id !== TEMPORARY_CHAT_ID)
        .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
        .slice(0, 12),
    [threads, primaryThreadId]
  )

  const choose = (threadId: string) => {
    setSecondaryThread(threadId)
    setActivePane('secondary')
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
      choose(created.id)
    } catch (error) {
      console.error('Failed to start a chat in the second pane:', error)
      toast.error(t('chat:split.newChatFailed'))
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col rounded-xl bg-muted p-1 shadow-[inset_0_0_0_0.8px_var(--border)]"
      data-testid="split-pane-picker"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 pr-1 pl-2 pointer-coarse:h-12">
        <span className="truncate text-sm font-medium text-secondary-foreground">
          {t('chat:split.secondary')}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
          onClick={closeSplit}
          aria-label={t('chat:split.closePane')}
          title={t('chat:split.closePane')}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border-[0.8px] border-input bg-card px-4 py-5">
        <div className="mx-auto w-full max-w-md">
          <h2 className="text-sm font-semibold text-foreground">
            {t('chat:split.pickTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('chat:split.pickDescription')}
          </p>
          <Button
            className="mt-4 pointer-coarse:h-11"
            onClick={() => void startNewChat()}
            data-testid="split-new-chat"
          >
            <MessageSquarePlus className="size-4" />
            {t('chat:split.newChat')}
          </Button>
          <h3 className="mt-6 mb-1 px-1 text-xs font-medium text-muted-foreground">
            {t('chat:split.recent')}
          </h3>
          {recent.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {t('chat:split.noRecent')}
            </p>
          ) : (
            <ul className="flex flex-col">
              {recent.map((th) => {
                const title = plainTitle(th.title, t('common:newThread'))
                return (
                  <li key={th.id}>
                    <button
                      type="button"
                      onClick={() => choose(th.id)}
                      data-testid={`split-pick-${th.id}`}
                      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"
                    >
                      <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate" title={title}>
                        {title}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
