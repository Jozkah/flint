import { PromptProgress } from '@/components/PromptProgress'
import { TurnUsageDetails } from '@/components/TurnUsageDetails'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { CompactingIndicator, CompactionDivider } from '@/containers/CompactionDivider'
import { CoworkArtifactCard } from '@/containers/CoworkArtifactCard'
import { CoworkAskEntry } from '@/containers/CoworkAskEntry'
import { CoworkAskedCard } from '@/containers/CoworkAskedCard'
import { CoworkBudgetNotice } from '@/containers/CoworkBudgetNotice'
import { CoworkChildApprovals } from '@/containers/CoworkChildApprovals'
import { CoworkEmptyState } from '@/containers/CoworkEmptyState'
import { CoworkHeldInput } from '@/containers/CoworkHeldInput'
import { CoworkHiddenTools } from '@/containers/CoworkHiddenTools'
import { CoworkInterruptedTurn } from '@/containers/CoworkInterruptedTurn'
import { CoworkPlanStrip } from '@/containers/CoworkPlanStrip'
import { CoworkRecap } from '@/containers/CoworkRecap'
import { CoworkRunNotice } from '@/containers/CoworkRunNotice'
import { CoworkRunSummary } from '@/containers/CoworkRunSummary'
import { CoworkSubagentQuestions } from '@/containers/CoworkSubagentQuestions'
import { CoworkTeamConflicts } from '@/containers/CoworkTeamConflicts'
import { CoworkWorkflowCard } from '@/containers/CoworkWorkflowCard'
import { MemoryProposalList } from '@/containers/MemoryProposalCard'
import { MessageItem } from '@/containers/MessageItem'
import { PromptSnapshotView } from '@/containers/PromptSnapshotView'
import { SessionStopNotice } from '@/containers/SessionStopNotice'
import { CodeOpenProvider } from '@/containers/message/CodeOpenProvider'
import { type RunEnding } from '@/hooks/useCoworkRun'
import { startPaneSessionParked, useCoworkSessions } from '@/hooks/useCoworkSessions'
import { type CoworkRail } from '@/hooks/useCoworkView'
import { usePrompt } from '@/hooks/usePrompt'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { askedFromParts } from '@/lib/askedSessions'
import { switchedFromOf } from '@/lib/assistantSwitch'
import { type VerifyReport } from '@/lib/browserVerify'
import { type CodeOpenOptions, type CodePathCheck } from '@/lib/codeOpen'
import { type CompactionRecord } from '@/lib/compaction'
import { type ActivityTask, workflowAnchoredAt } from '@/lib/coworkActivity'
import { artifactsFromParts } from '@/lib/coworkArtifacts'
import { type CoworkAttachmentInput, type SubmittedFile } from '@/lib/coworkAttachments'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import { continueRequest, shouldShowRunOutcome } from '@/lib/coworkRunOutcome'
import { segmentAssistantMessage, workflowSegmentIndex } from '@/lib/coworkTurns'
import { samePlan } from '@/lib/todoLabels'
import { fromCoworkUsage } from '@/lib/tokenUsage'
import { stopToolCall } from '@/lib/toolCallStop'
import { transcriptWindowStart } from '@/lib/transcriptWindow'
import { type WidgetHost, WidgetHostContext } from '@/lib/visualize/hostContext'
import { type QueuedMessageSender } from '@/stores/message-queue-store'
import { type AskAnswer, type AskRecord, type CoworkTurn, type SessionStopNotice as SessionStopNoticeData, type TurnMemory, type Usage } from '@/types/coworkSession'
import { type UIMessage } from 'ai'
import { Fragment } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { SessionOrigins } from '@/hooks/useCoworkOrigins'
import type { CoworkPane } from '@/hooks/useCoworkPane'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { EffectiveAccess } from '@/lib/coworkAccess'
import type { ActivityWorkflow } from '@/lib/coworkActivity'
import type { BudgetStop } from '@/lib/coworkBudget'
import type { RunOutcome } from '@/lib/coworkRunOutcome'
import type { RunStatus } from '@/lib/runStatus'
import type { TodoList } from '@/types/coworkSession'
import type { MemoryLocation, PendingProposal } from '@janhq/tauri-plugin-agent-tools-api'
import type { UseNavigateResult } from '@tanstack/react-router'
import type { UIDataTypes, UITools } from 'ai'
import type { Dispatch, RefObject, SetStateAction } from 'react'

type CoworkTranscriptProps = {
  transcriptRef: RefObject<HTMLDivElement | null>
  displayedTurns: CoworkTurn[]
  folder: string | null
  effective: EffectiveAccess
  attachFolder: (given?: string) => Promise<void>
  widgetHost: WidgetHost
  openToolPath: (path: string, options?: CodeOpenOptions) => void
  checkToolPath: (path: string) => CodePathCheck
  toolPathExists: (path: string) => Promise<boolean>
  openToolDiff: (path: string) => void
  displayToolPath: (path: string) => string
  pathLinkRoots: string[]
  windowStart: number
  setEarlierShown: Dispatch<SetStateAction<{ sid: string | null; pages: number; }>>
  session: CoworkSession | null
  earlierPages: number
  messageWeights: number[]
  uiMessages: UIMessage<unknown, UIDataTypes, UITools>[]
  activity: { workflows: Record<string, ActivityWorkflow>; tasks: Record<string, ActivityTask>; }
  running: boolean
  handleRegenerate: () => void
  reasoningContainerRef: RefObject<HTMLDivElement | null>
  isReasoningAtBottom: boolean
  handleReasoningScroll: () => void
  forceScrollReasoningToBottom: () => void
  snapshotByAnchor: Map<string, TodoList>
  activityNow: number
  waitingForUser: boolean
  handleSubmit: (text: string, files?: SubmittedFile[], onRefused?: () => void) => void
  showTaskInPanel: (task: ActivityTask) => void
  revealOutput: () => void
  showWorkflowInPanel: (workflowId: string) => void
  setRevealHiddenTools: Dispatch<SetStateAction<boolean>>
  respondAsk: (requestId: string, answers: AskAnswer[] | null) => void
  snapshotByMessageId: Map<string, { id: string; hash: string; redactions: number; }>
  showPromptSnapshot: boolean
  workspacePath: string | null
  showPreview: (path: string) => void
  runEnding: RunEnding | undefined
  runOrigins: SessionOrigins | null
  runOutcome: RunOutcome
  browserReports: VerifyReport[]
  treeRoot: string | null
  openSummaryPath: (path: string) => void
  openRail: (next: CoworkRail) => void
  runRequest: (text: string | null, from?: QueuedMessageSender, hidden?: boolean, attachmentInput?: CoworkAttachmentInput, onRefused?: () => void) => Promise<void>
  stripMode: boolean
  awaitingModel: boolean
  runStatusNow: RunStatus | null
  memoryProposalLocation: MemoryLocation | null
  memoryProposals: PendingProposal[]
  onMemoryProposalResolved: (id: string) => void
  navigateTo: UseNavigateResult<string>
  stoppedBy: "done" | "error" | BudgetStop | "aborted" | "deadline" | "timeout" | "loop"
  runRequestRef: RefObject<(text: string | null, from?: QueuedMessageSender, hidden?: boolean, attachmentInput?: CoworkAttachmentInput, onRefused?: () => void) => Promise<void>>
  runError: string | undefined
  compactNow: (opts?: { thenContinue?: boolean; }) => Promise<void>
  compacting: boolean
  sidePaneIdRef: RefObject<string | undefined>
  paneSessionIdRef: RefObject<string | undefined>
  coworkPane: CoworkPane | null
}

export function CoworkTranscript({
  transcriptRef,
  displayedTurns,
  folder,
  effective,
  attachFolder,
  widgetHost,
  openToolPath,
  checkToolPath,
  toolPathExists,
  openToolDiff,
  displayToolPath,
  pathLinkRoots,
  windowStart,
  setEarlierShown,
  session,
  earlierPages,
  messageWeights,
  uiMessages,
  activity,
  running,
  handleRegenerate,
  reasoningContainerRef,
  isReasoningAtBottom,
  handleReasoningScroll,
  forceScrollReasoningToBottom,
  snapshotByAnchor,
  activityNow,
  waitingForUser,
  handleSubmit,
  showTaskInPanel,
  revealOutput,
  showWorkflowInPanel,
  setRevealHiddenTools,
  respondAsk,
  snapshotByMessageId,
  showPromptSnapshot,
  workspacePath,
  showPreview,
  runEnding,
  runOrigins,
  runOutcome,
  browserReports,
  treeRoot,
  openSummaryPath,
  openRail,
  runRequest,
  stripMode,
  awaitingModel,
  runStatusNow,
  memoryProposalLocation,
  memoryProposals,
  onMemoryProposalResolved,
  navigateTo,
  stoppedBy,
  runRequestRef,
  runError,
  compactNow,
  compacting,
  sidePaneIdRef,
  paneSessionIdRef,
  coworkPane,
}: CoworkTranscriptProps) {
  const { t } = useTranslation()
  return (
    <div
        ref={transcriptRef}
        className="relative flex-1 [mask-image:linear-gradient(to_bottom,transparent,#000_14px)]"
      >
        {displayedTurns.length === 0 ? (
          <CoworkEmptyState
            folder={folder}
            access={effective.access}
            onPick={(text) => usePrompt.getState().setPrompt(text)}
            onAttachFolder={() => void attachFolder()}
          />
        ) : (
          <Conversation className="absolute inset-0 text-start">
            <ConversationContent className="transcript-list mx-auto w-full max-w-[756px] px-[18px] pt-4 pb-3">
              <WidgetHostContext.Provider value={widgetHost}>
              <CodeOpenProvider
        open={openToolPath}
        check={checkToolPath}
        exists={toolPathExists}
        openDiff={openToolDiff}
        displayPath={displayToolPath}
        roots={pathLinkRoots}
      >
                {windowStart > 0 && (
                  <div className="flex justify-center pb-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="show-earlier-messages"
                      className="text-muted-foreground"
                      onClick={() =>
                        setEarlierShown({
                          sid: session?.id ?? null,
                          pages: earlierPages + 1,
                        })
                      }
                    >
                      {t('common:coworkShowEarlier', {
                        count:
                          windowStart -
                          transcriptWindowStart(messageWeights, earlierPages + 1),
                      })}
                    </Button>
                  </div>
                )}
                {uiMessages.slice(windowStart).map((whole, shownAt) => {
                  const i = shownAt + windowStart
                  // Each model round renders with its own rows beneath
                  // it, so the newest content is always last.
                  const segments = segmentAssistantMessage(whole)
                  const workflow = workflowAnchoredAt(
                    activity,
                    session?.id,
                    whole.id
                  )
                  const workflowAt = workflow
                    ? workflowSegmentIndex(
                        segments,
                        workflow.tasks.map((task) => task.callId)
                      )
                    : -1
                  return segments.map((message, k) => (
                  <Fragment key={message.id}>
                    <MessageItem
                      message={message}
                      isFirstMessage={i === 0 && k === 0}
                      isLastMessage={
                        i === uiMessages.length - 1 &&
                        k === segments.length - 1
                      }
                      status={running ? 'streaming' : 'ready'}
                      view={{
                        switchedFrom:
                          k === 0 ? switchedFromOf(uiMessages, i) : undefined,
                        hideActions: k < segments.length - 1 || undefined,
                        continuation: k > 0 || undefined,
                        midReply: k < segments.length - 1 || undefined,
                        runParts:
                          segments.length > 1 ? whole.parts : undefined,
                        // The tool calls are the work here, not scaffolding
                        // behind an answer: they stay in the conversation
                        // unless the display option hides the finished ones.
                        keepToolActivity: true,
                      }}
                      reasoning={{
                        containerRef: reasoningContainerRef,
                        isAtBottom: isReasoningAtBottom,
                        onScroll: handleReasoningScroll,
                        onScrollToBottom: forceScrollReasoningToBottom,
                      }}
                      actions={{ onRegenerate: handleRegenerate }}
                    />
                    {/* The plan as this run left it, after its prompt. */}
                    {k === segments.length - 1 &&
                    snapshotByAnchor.has(whole.id) &&
                    // The pinned plan above already shows this very list.
                    !(
                      !session?.progressUi?.unpinned &&
                      samePlan(snapshotByAnchor.get(whole.id), session?.todos)
                    ) ? (
                      <CoworkPlanStrip
                        todos={snapshotByAnchor.get(whole.id)}
                        defaultOpen={false}
                        snapshot
                      />
                    ) : null}
                    {/* One card per workflow, at the message its first
                    dispatch landed under. Same store as the panel, so it
                    is live without a copy of anything. */}
                    {(() => {
                      const view = k === workflowAt ? workflow : null
                      return view ? (
                        <CoworkWorkflowCard
                          view={view}
                          now={activityNow}
                          waiting={waitingForUser}
                          onResume={(id) =>
                            void handleSubmit(
                              `Resume the stopped workflow run ${id}: call workflow with resume_run_id "${id}".`
                            )
                          }
                          onOpenTask={(task) => {
                            showTaskInPanel(task)
                            revealOutput()
                          }}
                          onOpenPanel={(workflowId) => {
                            showWorkflowInPanel(workflowId)
                            revealOutput()
                          }}
                        />
                      ) : null
                    })()}
                    {/* Completed tool activity the display option is
                    filtering out. The turns are still in the session; this
                    says how many and offers to look. */}
                    {(() => {
                      const part = (
                        message.parts as { type: string; data?: unknown }[]
                      ).find((p) => p.type === 'data-hidden-tools')
                      const data = part?.data as
                        | { count: number }
                        | undefined
                      return data ? (
                        <CoworkHiddenTools
                          count={data.count}
                          onReveal={() => setRevealHiddenTools(true)}
                        />
                      ) : null
                    })()}
                    {/* Questions the run asked here, in the order they
                    were asked. A pending one is the card; an answered,
                    skipped or stale one collapses to what happened, and
                    stays in the transcript. */}
                    {(message.parts as { type: string; data?: unknown }[])
                      .filter((p) => p.type === 'data-ask')
                      .map((p) => {
                        const record = p.data as AskRecord
                        return (
                          <CoworkAskEntry
                            key={record.requestId}
                            record={record}
                            running={running}
                            onRespond={respondAsk}
                            plan={session?.todos}
                          />
                        )
                      })}
                    {/* The conversation was compacted here. */}
                    {(message.parts as { type: string; data?: unknown }[])
                      .filter((p) => p.type === 'data-compaction')
                      .map((p) => {
                        const record = p.data as CompactionRecord
                        return (
                          <CompactionDivider
                            key={`compaction-${record.at}`}
                            record={record}
                          />
                        )
                      })}
                    {/* Another session stopped this run, with its user's
                    approval: who, and the reason it gave. */}
                    {(message.parts as { type: string; data?: unknown }[])
                      .filter((p) => p.type === 'data-session-stop')
                      .map((p) => {
                        const notice = p.data as SessionStopNoticeData
                        return (
                          <SessionStopNotice
                            key={notice.requestId}
                            notice={notice}
                          />
                        )
                      })}
                    {/* What the model received, at the message it
                    produced. Collapsed, and it fetches nothing until
                    someone opens it. */}
                    {(() => {
                      // AH-078. The message's own part first: it was
                      // stamped onto the assistant row when that row was
                      // created, so it names the dispatch that produced
                      // this reply -- including a continuation, a retry or
                      // a compaction, which position cannot distinguish.
                      //
                      // The positional map stays as the fallback for turns
                      // already on disk, written before rows carried one.
                      const own = (
                        message.parts as { type: string; data?: unknown }[]
                      ).find((part) => part.type === 'data-prompt-snapshot')
                        ?.data as { id: string } | undefined
                      const ref = own ?? snapshotByMessageId.get(message.id)
                      return ref && showPromptSnapshot ? (
                        <PromptSnapshotView
                          snapshotId={ref.id}
                          sessionId={session?.id}
                        />
                      ) : null
                    })()}
                    {/* This turn's own token breakdown and the memory ids
                    its request carried (AH-211, AH-083). */}
                    {(() => {
                      const data = (
                        message.parts as { type: string; data?: unknown }[]
                      ).find((part) => part.type === 'data-turn-usage')
                        ?.data as
                        | { usage?: Usage; memory?: TurnMemory }
                        | undefined
                      return data && showPromptSnapshot ? (
                        <TurnUsageDetails
                          usage={fromCoworkUsage(data.usage)}
                          memory={data.memory}
                        />
                      ) : null
                    })()}
                    {/* Derived from the message's own write parts, so nothing
                    shared with the chat surface needs to know artifacts
                    exist. */}
                    {askedFromParts(message.parts).map((asked) => (
                      <CoworkAskedCard key={asked.key} asked={asked} />
                    ))}
                    {artifactsFromParts(message.parts).map((artifact) => (
                      <CoworkArtifactCard
                        key={artifact.path}
                        artifact={artifact}
                        root={workspacePath}
                        onPreview={(path) => {
                          showPreview(path)
                          revealOutput()
                        }}
                      />
                    ))}
                  </Fragment>
                                      ))
                })}
              </CodeOpenProvider>
              </WidgetHostContext.Provider>
              {/* AH-109: overlapping team tasks, before either runs. */}
              <CoworkTeamConflicts sessionId={session?.id} />
              <CoworkChildApprovals sessionId={session?.id} />
              <CoworkSubagentQuestions sessionId={session?.id} />
              {/* Once the run has ended: while it goes, the header says
                  Running and Changes shows its files, and a card growing
                  under the transcript said it a third time. */}
              {(((!running && (runEnding || runOrigins?.summary)) &&
                // Only when the run has something of its own to report:
                // a write, a check, a loose end, or an ending that was
                // not a clean finish. A working tree that was already
                // dirty is not the run's work, and reporting it here left
                // a permanent panel over the composer listing the user's
                // own edits. The stop reason itself stays in the notice
                // below; this shows what was kept.
                shouldShowRunOutcome(runOutcome)) ||
                // A browser verification is evidence the user asked
                // for; it is shown even after a run with nothing else.
                browserReports.length > 0) && (
                  <CoworkRunSummary
                    outcome={runOutcome}
                    browserChecks={browserReports}
                    canOpenPath={() => true}
                    onOpenPath={
                      runOutcome.resultLocation.destination ===
                        'repository' && treeRoot
                        ? (path) => openSummaryPath(`${treeRoot}/${path}`)
                        : runOutcome.resultLocation.destination ===
                            'sandbox'
                          ? openSummaryPath
                          : undefined
                    }
                    onReviewChanges={() => openRail({ kind: 'diff' })}
                    onRestore={() => openRail({ kind: 'diff' })}
                    onRetry={() => void runRequest(null)}
                    // A follow-up run under the session's current mode,
                    // asked to retry what this one left unresolved.
                    // Focusing the composer did nothing visible. The
                    // request is Flint's, so it is not drawn as a user
                    // message.
                    onContinue={() =>
                      void runRequest(
                        continueRequest(runOutcome.unresolved),
                        undefined,
                        true
                      )
                    }
                  />
                )}
              {running && !(stripMode && waitingForUser) && (
                // Row wrapper as in the chat route: the transcript is a
                // column flex, which stretches the indicator's own
                // `inline-flex` box across the whole column.
                <div className="flex flex-row items-center gap-2">
                  <PromptProgress
                    hideIdle={!awaitingModel}
                    stateKey={session?.id}
                    status={runStatusNow}
                    onStopTool={(callId) => {
                      if (session?.id) stopToolCall(session.id, callId)
                    }}
                    waitingLabel={
                      waitingForUser ? t('common:waitingForYou') : undefined
                    }
                  />
                </div>
              )}
              {memoryProposalLocation && (
                <MemoryProposalList
                  className="my-2"
                  proposals={memoryProposals}
                  location={memoryProposalLocation}
                  onResolved={onMemoryProposalResolved}
                  onOpenSettings={() =>
                    navigateTo({ to: route.settings.memory })
                  }
                />
              )}
              {stoppedBy === 'steps' && (
                <CoworkBudgetNotice
                  kind="steps"
                  max={MAX_AGENT_STEPS}
                  onContinue={() => void handleSubmit('Continue.')}
                />
              )}
              {stoppedBy === 'aborted' && (
                <CoworkRunNotice kind="stopped" />
              )}
              {session?.id ? (
                <CoworkRecap sessionId={session.id} running={running} />
              ) : null}
              {session?.id ? (
                <CoworkInterruptedTurn
                  sessionId={session.id}
                  running={running}
                  onContinue={() => void runRequestRef.current(null)}
                />
              ) : null}
              {session?.id ? (
                <CoworkHeldInput sessionId={session.id} running={running} />
              ) : null}
              {stoppedBy === 'error' && (
                <CoworkRunNotice
                  kind="error"
                  message={runError}
                  onRetry={() => void runRequest(null)}
                />
              )}
              {(stoppedBy === 'deadline' ||
                stoppedBy === 'timeout' ||
                stoppedBy === 'loop') && (
                <CoworkRunNotice
                  kind={stoppedBy}
                  message={runError}
                  onRetry={() => void runRequest(null)}
                  onAttachFolder={
                    stoppedBy === 'loop' && !session?.folder
                      ? () => void attachFolder()
                      : undefined
                  }
                />
              )}
              {stoppedBy === 'tokens' && (
                <CoworkBudgetNotice
                  kind="tokens"
                  // An overflow carries its measurement; the spend cap
                  // stops with none.
                  cause={runError ? 'window' : 'budget'}
                  detail={runError ?? undefined}
                  // Compacts the session's history for real, then
                  // resumes the run on the room that freed.
                  onCompact={() =>
                    void compactNow({ thenContinue: true })
                  }
                  compacting={compacting}
                  onNewSession={() => {
                    // Same rule as the sidebar's entry point: one press,
                    // at most one session. An unsent draft is parked on
                    // the session being left (held input) when it has
                    // content, so the new one opens blank.
                    const paneId = sidePaneIdRef.current
                    const paneSid = paneSessionIdRef.current
                    const prompts = usePrompt.getState()
                    const scope = coworkPane?.draftScope
                    if (paneId && paneSid && scope) {
                      // From a pane beside the main one: judged on that
                      // pane's session and draft, opened in that pane.
                      const { id, parked } = startPaneSessionParked(paneSid, {
                        running,
                        draft: prompts.scoped[scope]?.prompt,
                      })
                      useSplitConversation
                        .getState()
                        .setPaneTarget(paneId, { kind: 'cowork', refId: id })
                      if (parked) prompts.setScopedPrompt(scope, '')
                      return
                    }
                    const store = useCoworkSessions.getState()
                    const { id, parked } = store.startSessionParked({
                      running,
                      draft: prompts.prompt,
                    })
                    store.selectSession(id)
                    // Cleared here, not in the store, and only when parked:
                    // otherwise the draft would be lost.
                    if (parked) prompts.resetPrompt()
                  }}
                />
              )}
              {compacting && <CompactingIndicator />}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        )}
      </div>
  )
}
