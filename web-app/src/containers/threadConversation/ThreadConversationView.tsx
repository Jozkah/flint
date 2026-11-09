// The conversation's view: header controls, transcript, banners, composer and
// the Details inspector, drawn from what ThreadConversation hands it. Split
// out of ThreadConversation.tsx; the markup is unchanged.

import { switchedFromOf } from '@/lib/assistantSwitch'
import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import HeaderPage from '@/containers/HeaderPage'
import { ExportItems, ExportSubmenu } from '@/components/ExportMenu'
import { SaveChatPicturesItem } from '@/components/SaveChatPicturesItem'
import { docFromThread } from '@/lib/exportDoc'
import ChatInput from '@/containers/ChatInput'
import { ChatPaneDropZone } from '@/components/ChatPaneDropZone'
import { FolderTrustBanner } from '@/containers/FolderTrustBanner'
import { ChatTasks } from '@/containers/ChatTasks'
import { CoworkChildApprovals } from '@/containers/CoworkChildApprovals'
import { stopChatDelegation } from '@/lib/chatDelegation'
import { ChatWorkProfilePicker } from '@/containers/ChatWorkProfilePicker'
import { ConversationFindBar } from '@/containers/ConversationFindBar'
import { useConversationFind, useThreadFind } from '@/hooks/useConversationFind'
import { MessageItem } from '@/containers/MessageItem'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import { useMessages } from '@/hooks/useMessages'
import { ConversationErrorNotice } from '@/containers/ConversationErrorNotice'
import { useAppState } from '@/hooks/useAppState'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChat } from '@/hooks/use-chat'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationLoadEarlier,
} from '@/components/ai-elements/conversation'
import { stopChatTurn } from '@/lib/chatSteering'
import type { UIMessage } from '@ai-sdk/react'
import { PromptProgress } from '@/components/PromptProgress'
import { modelWaitStatus } from '@/lib/runStatus'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { CompactingIndicator, CompactionDivider } from '@/containers/CompactionDivider'
import { Button } from '@/components/ui/button'
import { Columns2, Download, Loader2, MoreHorizontal, PanelRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Icon } from '@/components/ui/icon'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Chip } from '@/components/ui/chip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatMessageTime } from '@/utils/formatMessageTime'
import { ThreadStatusMark, useThreadStatus } from '@/containers/ThreadStatusMark'
import { WidgetHostContext, type WidgetHost } from '@/lib/visualize/hostContext'
import { chatFoldersOf } from '@/lib/chatFolders'
import { PathRootsContext } from '@/lib/codeOpen'
import { ChatFoldersChip } from '@/containers/ChatFoldersChip'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { TemporaryChatBanner } from '@/containers/TemporaryChatBanner'
import { WhatJanIsUsingPanel, WhatJanIsUsingToggle } from '@/containers/WhatJanIsUsing'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { route } from '@/constants/routes'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { ACTIVE_PANE_RING } from '@/hooks/useCoworkPane'
import { paneDraftScope, useSplitConversation } from '@/hooks/useSplitConversation'
import type { useThreadDetails } from '@/hooks/threadConversation/useThreadDetails'
import type { useThreadVersioning } from '@/hooks/threadConversation/useThreadVersioning'
import type { useChatCompaction } from '@/hooks/threadConversation/useChatCompaction'
import type {
  ComponentProps,
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react'
import type { useMessageWindow } from '@/hooks/useMessageWindow'
import type { useMemoryProposals } from '@/hooks/useMemoryProposals'

const CHAT_STATUS = {
  STREAMING: 'streaming',
  SUBMITTED: 'submitted',
} as const

type MessageItemProps = ComponentProps<typeof MessageItem>

/** What the conversation's view draws from; ThreadConversation owns all of it. */
export type ThreadConversationViewProps = {
  threadId: string
  thread: Thread | undefined
  threadModel: ComponentProps<typeof ChatInput>['model']
  plainThreadTitle: string
  t: ReturnType<typeof useTranslation>['t']
  navigate: ReturnType<typeof useNavigate>
  layout: {
    isSplit: boolean
    isActive: boolean
    paneId: string
    workProfilesOn: boolean
    contextControls?: ReactNode
    paneControls?: ReactNode
  }
  details: ReturnType<typeof useThreadDetails>
  threadStatus: ReturnType<typeof useThreadStatus>
  find: Pick<ReturnType<typeof useThreadFind>, 'findOpen' | 'findSeed' | 'findWaitsForOther'> & {
    findRootRef: RefObject<HTMLDivElement | null>
    revealMessageId: (id: string) => void
  }
  transcript: {
    chatMessages: UIMessage[]
    messageWindow: ReturnType<typeof useMessageWindow>
    stickRef: RefObject<StickToBottomContext | null>
    fontSize: string
    messageZoom: number
    status: ReturnType<typeof useChat>['status']
    effectiveStatus: MessageItemProps['status']
    versionInfoById: Record<string, { index: number; count: number }>
    pendingContinueMessage: UIMessage | null
    lastIsAssistant: boolean
    quietSince: number | null
    processingEmbeddings: boolean
    compactionInForce: ReturnType<typeof useChatCompaction>['compactionInForce']
    compactionShownOnReply: boolean
  }
  reasoning: NonNullable<MessageItemProps['reasoning']>
  versioning: Pick<
    ReturnType<typeof useThreadVersioning>,
    | 'handleRegenerate'
    | 'handleFork'
    | 'handleContinue'
    | 'handleEditMessage'
    | 'handleDeleteMessage'
    | 'handleSwitchVersion'
  >
  banner: ComponentProps<typeof ConversationErrorNotice>
  memory: {
    memoryProposals: ComponentProps<typeof MemoryProposalList>['proposals']
    memoryLocation: ReturnType<typeof useMemoryProposals>['location']
    onMemoryProposalResolved: ComponentProps<typeof MemoryProposalList>['onResolved']
  }
  composer: {
    handleSubmit: ComponentProps<typeof ChatInput>['onSubmit']
    stop: () => void
    toolCallAbortController: MutableRefObject<AbortController | null>
    currentHistoryError: string | undefined
    isReadingHistory: boolean
    setHistoryReadAttempt: Dispatch<SetStateAction<number>>
  }
  chatPathRoots: ReturnType<typeof chatFoldersOf>
  widgetHost: WidgetHost
}

export function ThreadConversationView(props: ThreadConversationViewProps) {
  const {
    threadId,
    thread,
    threadModel,
    plainThreadTitle,
    t,
    navigate,
    threadStatus,
    chatPathRoots,
    widgetHost,
  } = props
  const { isSplit, isActive, paneId, workProfilesOn, contextControls, paneControls } =
    props.layout
  const {
    detailsOpen,
    narrowView,
    setNarrowView,
    detailsPanelId,
    isPhone,
    titleRef,
    toggleDetails,
    closeDetails,
  } = props.details
  const { findOpen, findSeed, findWaitsForOther, findRootRef, revealMessageId } =
    props.find
  const {
    chatMessages,
    messageWindow,
    stickRef,
    fontSize,
    messageZoom,
    status,
    effectiveStatus,
    versionInfoById,
    pendingContinueMessage,
    lastIsAssistant,
    quietSince,
    processingEmbeddings,
    compactionInForce,
    compactionShownOnReply,
  } = props.transcript
  const {
    containerRef: reasoningContainerRef,
    isAtBottom: isReasoningAtBottom,
    onScroll: handleReasoningScroll,
    onScrollToBottom: forceScrollReasoningToBottom,
  } = props.reasoning
  const {
    handleRegenerate,
    handleFork,
    handleContinue,
    handleEditMessage,
    handleDeleteMessage,
    handleSwitchVersion,
  } = props.versioning
  const {
    oomError,
    backendError,
    contextLimitError,
    error,
    contextBannerMessage,
    compacting,
    selectedProvider,
    handleCompact,
    handleContextSizeIncrease,
  } = props.banner
  const { memoryProposals, memoryLocation, onMemoryProposalResolved } = props.memory
  const {
    handleSubmit,
    stop,
    toolCallAbortController,
    currentHistoryError,
    isReadingHistory,
    setHistoryReadAttempt,
  } = props.composer

  // Who this conversation is: the title, on the chat frame's header row.
  const identity = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Icon name="comment" size={16} />
      <h1
        ref={titleRef}
        data-testid="conversation-title"
        // In a split pane the title fades out, as the sidebar's do, and the
        // pane being worked in has it in the foreground colour. text-fade is
        // added after cn(): tailwind-merge takes it for a text colour and
        // would drop it.
        className={
          cn(
            'min-w-0 text-sm leading-none font-medium',
            isSplit ? 'flex-1' : 'truncate',
            isSplit && isActive
              ? 'text-foreground'
              : 'text-secondary-foreground'
          ) + (isSplit ? ' text-fade' : '')
        }
        title={plainThreadTitle}
      >
        {plainThreadTitle}
      </h1>
      {threadId !== TEMPORARY_CHAT_ID && <ChatFoldersChip threadId={threadId} />}
    </div>
  )
  const groupLabel = thread?.isFavorite
    ? t('common:shell.pinned')
    : thread?.metadata?.project?.name
  // The mark sits in its own non-shrinking box with a little padding, so the
  // header slot's overflow clip never cuts into the dot's left edge.
  const statusMark =
    threadStatus !== 'none' ? (
      <span
        data-testid="header-thread-status"
        className="flex shrink-0 items-center px-0.5"
      >
        <ThreadStatusMark status={threadStatus} />
      </span>
    ) : null
  const projectChip = (
    <>
      {groupLabel && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Chip className="hidden max-w-48 md:inline-flex">
              <span className="truncate">{groupLabel}</span>
            </Chip>
          </TooltipTrigger>
          <TooltipContent>{groupLabel}</TooltipContent>
        </Tooltip>
      )}
    </>
  )

  // When the conversation began: its first message's time.
  const firstCreatedAt = (
    chatMessages[0]?.metadata as { createdAt?: Date | string } | undefined
  )?.createdAt

  // What acts on the conversation, plus whatever the surrounding layout adds.
  // The model sits under the composer (on a phone, on the conversation's own
  // header row).
  const buildExportDoc = ({ allVersions }: { allVersions: boolean }) =>
    docFromThread(
      thread ?? { id: threadId },
      useMessages.getState().getMessages(threadId),
      new Date(),
      { allVersions }
    )
  const controlsWith = (extra: ReactNode) => (
    <>
      <TemporaryChatBanner threadId={threadId} />
      {/* On a phone the page header has room for one button: Split and Details
          move into an overflow menu. A split pane's header row keeps them all. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {extra && <div className="hidden sm:contents">{extra}</div>}
        {!isSplit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-[30px] sm:hidden pointer-coarse:size-11"
                aria-label={t('common:more')}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={toggleDetails}>
                <PanelRight className="size-4" />
                <span>{t('context:details')}</span>
              </DropdownMenuItem>
              <ExportSubmenu
                build={buildExportDoc}
                versions
                extra={<SaveChatPicturesItem threadId={threadId} />}
              />
              {extra && (
                <DropdownMenuItem
                  onSelect={() => useSplitConversation.getState().addPane()}
                >
                  <Columns2 className="size-4" />
                  <span>{t('chat:split.open')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!isSplit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-[30px] max-sm:hidden"
                aria-label={t('common:export.header')}
                data-testid="export-thread-header"
              >
                <Download className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ExportItems
                build={buildExportDoc}
                versions
                extra={<SaveChatPicturesItem threadId={threadId} />}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <WhatJanIsUsingToggle
          open={detailsOpen}
          onToggle={toggleDetails}
          controls={detailsPanelId}
          className={isSplit ? '[&>span]:sr-only' : 'max-sm:hidden'}
        />
      </div>
    </>
  )

  return (
    <PathRootsContext.Provider value={chatPathRoots}>
    <WidgetHostContext.Provider value={widgetHost}>
    <ChatPaneDropZone
      className={cn(
        'flex h-full min-h-0 flex-col',
        // The page's own breathing room; a split pane sits flush in its half.
        !isSplit && 'px-1 pt-3.5 pb-4'
      )}
    >
      {!isSplit && (
        <HeaderPage>
          {/* The collection, then the model and the controls that act on
              the conversation. The breadcrumb already names the chat. */}
          <div className="flex w-full min-w-0 items-center gap-1.5 md:pr-1">
            {statusMark}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {projectChip}
            </div>
            {controlsWith(contextControls)}
          </div>
        </HeaderPage>
      )}
      <div
        ref={findRootRef}
        className="@container/conv relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {detailsOpen && (
          // Narrow panes show one of the two at a time.
          <div className="shrink-0 pb-2 @3xl/conv:hidden">
            <div
              role="group"
              aria-label={t('context:views.label')}
              data-testid="conversation-view-switch"
              className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5 shadow-[inset_0_0_0_0.8px_var(--border)]"
            >
              {(['conversation', 'details'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={narrowView === view}
                  onClick={() => setNarrowView(view)}
                  className={cn(
                    'flex h-7 min-w-0 items-center justify-center rounded-md px-2 text-xs font-medium transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11',
                    narrowView === view
                      ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span className="truncate">{t(`context:views.${view}`)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 gap-4">
        {/* The conversation is one Frame: its title row, then the messages
            and the composer on the card inside. */}
        <Frame
          className={cn(
            'h-full min-h-0 min-w-0 flex-1',
            // The pane being worked in: its hairline in the ring colour.
            isSplit &&
              isActive &&
              ACTIVE_PANE_RING,
            detailsOpen &&
              narrowView === 'details' &&
              '@max-3xl/conv:invisible'
          )}
        >
          <FrameHeader
            data-testid={
              isSplit ? `conversation-pane-header-${paneId}` : undefined
            }
            data-active={isSplit ? isActive : undefined}
            className="min-h-9"
          >
            {identity}
            {isSplit ? (
              <div className="flex min-w-0 shrink items-center gap-1.5">
                {controlsWith(paneControls)}
              </div>
            ) : (
              <>
                {isPhone && (
                  <div className="min-w-0 shrink">
                    <DropdownModelProvider model={threadModel} />
                  </div>
                )}
                {firstCreatedAt && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">
                    {t('chat:startedAt', {
                      time: formatMessageTime(firstCreatedAt),
                    })}
                  </span>
                )}
              </>
            )}
          </FrameHeader>
          <FrameBody className="min-h-0 overflow-hidden">
        {/* Messages Area */}
        <div
          className="message-zoom flex-1 relative min-w-0"
          style={
            {
              '--font-size-base': `calc(var(--app-font-base, ${fontSize}) * ${messageZoom})`,
            } as CSSProperties
          }
        >
          {/* Inside the chat column, so it never covers the Details panel. */}
          {findOpen && isActive && !findWaitsForOther && (
            <ConversationFindBar
              messages={chatMessages}
              root={() => findRootRef.current}
              seed={findSeed}
              onClose={() => useConversationFind.getState().setOpen(false)}
              reveal={revealMessageId}
              renderedFrom={messageWindow.start}
            />
          )}
          {/* 13.5px at the default size; the message zoom scales it. */}
          <Conversation
            contextRef={stickRef}
            className="absolute inset-0 text-start text-[calc(var(--text-base)*0.84375)] leading-[1.6] text-fg-2"
          >
            <ConversationContent
              className={cn(
                'transcript-list mx-auto w-full min-w-0 max-w-[calc(780px+2.5rem)] pt-[22px] pb-4',
                isSplit ? 'px-4' : 'px-5'
              )}
            >
              {messageWindow.hasEarlier && (
                <ConversationLoadEarlier
                  hidden={messageWindow.start}
                  onLoad={messageWindow.loadEarlier}
                />
              )}
              {chatMessages.slice(messageWindow.start).map((message, i) => {
                const index = messageWindow.start + i
                const isLastMessage = index === chatMessages.length - 1
                const isFirstMessage = index === 0
                // A banner error stands in for the failed assistant turn:
                // regenerate/reload restarts it from scratch, so hide the
                // partial (tool calls, "Worked for Ns") and show only the banner.
                // A context-limit stop keeps its partial: that text was generated
                // and stored, and the banner only offers a bigger window.
                if (
                  isLastMessage &&
                  (oomError || backendError) &&
                  message.role === 'assistant'
                )
                  return null
                return (
                  <Fragment key={message.id}>
                    {compactionInForce &&
                    !compactionShownOnReply &&
                    compactionInForce.boundaryId === message.id ? (
                      <CompactionDivider record={compactionInForce.record} />
                    ) : null}
                    <MessageItem
                      message={message}
                      isFirstMessage={isFirstMessage}
                      isLastMessage={isLastMessage}
                      status={effectiveStatus}
                      versionInfo={versionInfoById[message.id]}
                      view={{
                        switchedFrom: switchedFromOf(chatMessages, index),
                        isAnimating: !pendingContinueMessage,
                        hideActions: !!pendingContinueMessage,
                      }}
                      reasoning={{
                        containerRef: reasoningContainerRef,
                        isAtBottom: isReasoningAtBottom,
                        onScroll: handleReasoningScroll,
                        onScrollToBottom: forceScrollReasoningToBottom,
                      }}
                      actions={{
                        onRegenerate: handleRegenerate,
                        onFork: handleFork,
                        onContinue: handleContinue,
                        onEdit: handleEditMessage,
                        onDelete: handleDeleteMessage,
                        onSwitchVersion: handleSwitchVersion,
                      }}
                    />
                  </Fragment>
                )
              })}
              {compacting && <CompactingIndicator />}
              {pendingContinueMessage && status === 'submitted' && (
                <MessageItem
                  key={`continue-placeholder-${pendingContinueMessage.id}`}
                  message={pendingContinueMessage}
                  isFirstMessage={false}
                  isLastMessage={true}
                  status={effectiveStatus}
                  view={{
                    hideActions: true,
                    isAnimating: false,
                  }}
                  reasoning={{
                    containerRef: reasoningContainerRef,
                    isAtBottom: isReasoningAtBottom,
                    onScroll: handleReasoningScroll,
                    onScrollToBottom: forceScrollReasoningToBottom,
                  }}
                  actions={{
                    onRegenerate: handleRegenerate,
                    onEdit: handleEditMessage,
                    onDelete: handleDeleteMessage,
                  }}
                />
              )}
              {memoryLocation && (
                <MemoryProposalList
                  className="my-2"
                  proposals={memoryProposals}
                  location={memoryLocation}
                  onResolved={onMemoryProposalResolved}
                  onOpenSettings={() =>
                    navigate({ to: route.settings.memory })
                  }
                  projectName={thread?.metadata?.project?.name}
                />
              )}
              {processingEmbeddings && (
                <div
                  role="status"
                  className="flex items-start gap-3 px-3.5 py-3 my-2 rounded-xl border-[0.8px] border-border bg-card"
                >
                  <Loader2 className="size-4 text-muted-foreground shrink-0 mt-0.5 motion-safe:animate-spin" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground mb-0.5">
                      {t('chat:embeddings.title')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('chat:embeddings.description')}
                    </p>
                  </div>
                </div>
              )}
              {!oomError &&
                !backendError &&
                !contextLimitError &&
                status === CHAT_STATUS.SUBMITTED && (
                <div className="flex flex-row items-center gap-2">
                  {pendingContinueMessage && (
                    <Shimmer duration={1}>{t('chat:growingTheMind')}</Shimmer>
                  )}
                  {!pendingContinueMessage && !lastIsAssistant && (
                    <PromptProgress status={modelWaitStatus()} />
                  )}
                </div>
              )}
              {!oomError &&
                !backendError &&
                !contextLimitError &&
                status === CHAT_STATUS.STREAMING &&
                quietSince !== null && (
                <div className="flex flex-row items-center gap-2">
                  <PromptProgress
                    status={modelWaitStatus(true)}
                    since={quietSince}
                  />
                </div>
              )}
              {(contextLimitError || oomError || backendError) && (
                <ConversationErrorNotice
                  oomError={oomError}
                  backendError={backendError}
                  contextLimitError={contextLimitError}
                  error={error}
                  contextBannerMessage={contextBannerMessage}
                  compacting={compacting}
                  selectedProvider={selectedProvider}
                  handleCompact={handleCompact}
                  handleContextSizeIncrease={handleContextSizeIncrease}
                  handleRegenerate={handleRegenerate}
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        {/* Chat Input - Fixed at bottom. The shell sizes the page to the
            visual viewport, so this stays above a phone keyboard. A short
            fade above it lets the transcript slide under the composer. */}
        <div
          className={cn(
            'relative mx-auto w-full min-w-0 max-w-[calc(780px+2rem)] pt-2.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]',
            "before:pointer-events-none before:absolute before:inset-x-0 before:-top-9 before:z-10 before:h-9 before:bg-linear-to-b before:from-transparent before:to-card before:content-['']",
            isSplit ? 'px-3' : 'px-4'
          )}
        >
          {/* Approvals a subagent raises have no tool card to sit under. */}
          <FolderTrustBanner folder={chatPathRoots[0] ?? null} />
          <CoworkChildApprovals sessionId={threadId} />
          <ChatTasks threadId={threadId} />
          {currentHistoryError ? (
            <div role="alert" className="rounded-lg border p-4">
              <p>
                {t('common:historyReadFailed', {
                  defaultValue: 'Unable to load conversation history.',
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                {currentHistoryError}
              </p>
              <Button
                disabled={isReadingHistory}
                onClick={() => setHistoryReadAttempt((n) => n + 1)}
                className="mt-2"
              >
                {t('common:run.tryAgain')}
              </Button>
            </div>
          ) : (
          <ChatInput
            model={threadModel}
            // Under the composer, as in Cowork. A phone keeps it in the header.
            modelControl={
              isPhone && !isSplit ? undefined : (
                <DropdownModelProvider variant="quiet" model={threadModel} />
              )
            }
            groupOptions
            onSubmit={handleSubmit}
            onStop={() => {
              // Stop is for the whole turn: subagents it started, and a tool
              // call still running, whose cancelled result must not be sent
              // back to the model for another reply.
              stopChatTurn({
                toolAbort: toolCallAbortController,
                stopDelegation: () => stopChatDelegation(threadId),
                stopStream: stop,
                cancelToolCall: () => useAppState.getState().cancelToolCalls?.[threadId]?.(),
              })
            }}
            chatStatus={effectiveStatus}
            // Named, not inferred from the current thread: in a split the
            // current thread is the other pane half the time.
            threadId={threadId}
            draftScope={paneDraftScope(paneId)}
            takeFocus={isActive}
            surfaceControls={
              workProfilesOn ? (
                <ChatWorkProfilePicker threadId={threadId} />
              ) : undefined
            }
          />
          )}
        </div>
          </FrameBody>
        </Frame>
        <WhatJanIsUsingPanel
          id={detailsPanelId}
          threadId={threadId}
          messages={chatMessages}
          open={detailsOpen}
          onClose={closeDetails}
          className={cn(
            'w-(--inspector-w) shrink-0',
            '@max-3xl/conv:absolute @max-3xl/conv:inset-0 @max-3xl/conv:z-10 @max-3xl/conv:w-full',
            narrowView === 'conversation' && '@max-3xl/conv:hidden'
          )}
        />
        </div>
      </div>
    </ChatPaneDropZone>
    </WidgetHostContext.Provider>
    </PathRootsContext.Provider>
  )
}
