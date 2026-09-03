/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import { CodeOpenProvider } from '@/containers/message/CodeOpenProvider'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import { getLoadedModels } from '@janhq/tauri-plugin-llamacpp-api'
import {
  bashJobsList,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { cn } from '@/lib/utils'
import {
  useCoworkSessions,
  ensureCurrentSession,
} from '@/hooks/useCoworkSessions'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import {
  lastUserQuestion,
  recordAgentDispatch,
  recordJobCollected,
  recordShellDispatch,
  recordShellOutcome,
  type RunContext,
} from '@/lib/coworkActivityRecorder'
import { collectedJobId, commandOf, countToolCalls } from '@/lib/coworkTasks'
import {
  INTERRUPTED_BY_RUN_END,
  findTaskByJob,
  sessionTotals,
  sessionWorkflows,
  taskIdFor,
  workflowAnchoredAt,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'
import {
  CANCELLED_BY_USER,
  cancelMessage,
  cancelTask as cancelTaskRequest,
  cancelWorkflow as cancelWorkflowRequest,
  patchForOutcome,
} from '@/lib/coworkCancel'
import { CoworkWorkflowCard } from '@/containers/CoworkWorkflowCard'
import type { AskAnswer, CoworkTurn, Usage } from '@/types/coworkSession'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { MessageItem } from '@/containers/MessageItem'
import SkillSelector from '@/containers/SkillSelector'
import { assistantAnchorId, coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { PromptProgress } from '@/components/PromptProgress'
import { useAppState } from '@/hooks/useAppState'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { CoworkWorkspacePill } from '@/containers/CoworkWorkspacePill'
import { CoworkPlanToggle } from '@/containers/CoworkPlanToggle'
import { CoworkEmptyState } from '@/containers/CoworkEmptyState'
import { usePrompt } from '@/hooks/usePrompt'
import { awaitsModel } from '@/lib/agentActivity'
import { artifactsFromParts } from '@/lib/coworkArtifacts'
import { CoworkArtifactCard } from '@/containers/CoworkArtifactCard'
import { CoworkPreviewPanel } from '@/containers/CoworkPreviewPanel'
import { CoworkDiffPanel } from '@/containers/CoworkDiffPanel'
import { CoworkCodePanel } from '@/containers/CoworkCodePanel'
import { CoworkTasksPanel } from '@/containers/CoworkTasksPanel'
import { CoworkTasksChip } from '@/containers/CoworkTasksChip'
import type { LiveJob } from '@/lib/coworkTasks'
import { Code2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  codeRefToken,
  emptyCodePanelState,
  expandCodeRefs,
  artifactTab,
  openTab,
  projectKeyOf,
  projectTab,
  sandboxTab,
  shouldOpenInCode,
  relativeToRoot,
  type CodeRef,
  type CodeTab,
} from '@/lib/coworkCode'
import { CoworkChangesChip } from '@/containers/CoworkChangesChip'
import { useCoworkGitStatus } from '@/hooks/useCoworkGitStatus'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { CoworkSandboxChip } from '@/containers/CoworkSandboxChip'
import { CoworkBudgetNotice } from '@/containers/CoworkBudgetNotice'
import { CoworkRunNotice } from '@/containers/CoworkRunNotice'
import { CoworkAskCard } from '@/containers/CoworkAskCard'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import { dispatchCoworkTool } from '@/lib/coworkDispatch'
import { applyTodoOp, renderTodoResult } from '@/lib/coworkTodo'
import { parseAskRequest, renderAskResult } from '@/lib/coworkAsk'
import { getSandboxStatus, sandboxEnforces } from '@/lib/agentTools'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { MAX_AGENT_STEPS } from '@/lib/coworkBudget'
import {
  abortRun,
  beginRun,
  endRun,
  hasSubagent,
  registerSubagent,
  unregisterSubagent,
  isAbortLike,
  answerAsk,
  runTurn,
  type RunOutcome,
  type StreamSink,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  listSubagents,
  type SubagentDefinition,
} from '@/lib/coworkSubagentRegistry'
import {
  parseSubagentRequest,
  resolveSubagent,
  parentToolNames,
  runSubagent,
} from '@/lib/coworkSubagent'

/** How often the backend's background-job list is re-read. Slower than the
 * activity panel's clock tick: the list changes when a command starts or ends,
 * not every second. */
const JOB_POLL_MS = 3000

export const Route = createFileRoute(route.cowork as any)({
  component: CoworkPage,
})

function CoworkPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { selectedModel, selectedProvider } = useModelProvider()

  const sessions = useCoworkSessions((s) => s.sessions)
  const currentId = useCoworkSessions((s) => s.currentId)
  const session = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId]
  )
  const folder = session?.folder ?? null
  const planMode = session?.planMode ?? false

  const [running, setRunning] = useState(false)
  const [liveTurns, setLiveTurns] = useState<CoworkTurn[]>([])
  const liveTurnsRef = useRef<CoworkTurn[]>([])
  const [stoppedBy, setStoppedBy] = useState<RunOutcome['stoppedBy'] | null>(
    null
  )
  const [runError, setRunError] = useState<string | undefined>(undefined)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [projectInstructions, setProjectInstructions] = useState<string | null>(
    null
  )
  const [subagentDefs, setSubagentDefs] = useState<SubagentDefinition[]>([])
  const workspacePath = useSessionWorkspacePath(session?.id)
  // The step just finished, so the counter tracks a run instead of jumping once
  // at the end. Falls back to the committed usage between runs.
  const [liveUsage, setLiveUsage] = useState<Usage | null>(null)
  // The rail holds one panel at a time: preview, diff and code all want the
  // width, so showing two together starves the transcript (C7).
  const [rail, setRail] = useState<
    | { kind: 'preview'; path: string }
    | { kind: 'diff' }
    | { kind: 'code' }
    | { kind: 'tasks' }
    | null
  >(null)
  /** Open a tab in the Code panel. `sandbox` marks paths under the session
   * workspace (agent artifacts) rather than the attached project. */
  const openCode = useCallback(
    (tab: CodeTab) => {
      const sid = ensureCurrentSession()
      const store = useCoworkSessions.getState()
      const current = store.sessions.find((s) => s.id === sid)
      store.setCodePanel(
        sid,
        openTab(current?.codePanel ?? emptyCodePanelState(), tab)
      )
      setRail({ kind: 'code' })
    },
    []
  )

  /**
   * Open a path a tool acted on, from its widget in the transcript.
   *
   * The path comes from the tool call's own `path` argument — structured
   * data, never text parsed out of the model's prose. It still has to land in
   * an allowed root: paths under the attached project open as project paths,
   * everything else is treated as the session sandbox, which is the only
   * other place the agent can write. Non-source files are left alone rather
   * than opened as code.
   */
  const openToolPath = useCallback(
    (path: string) => {
      if (!shouldOpenInCode(path)) return
      const projectKey = projectKeyOf(folder)
      const relative = relativeToRoot(folder, path)
      // Only call it a project file when it really resolved inside the project.
      if (projectKey && relative !== path) {
        openCode(projectTab(relative, projectKey))
      } else if (session?.id) {
        openCode(sandboxTab(relativeToRoot(workspacePath, path), session.id))
      }
    },
    [folder, workspacePath, openCode, session?.id]
  )

  // Source artifacts open as code, not as a plain-text preview dump.
  const showPreview = useCallback(
    (path: string) => {
      // An artifact is something the agent generated: it lives in the session
      // workspace, never in the user's project.
      // An artifact is something the agent generated: it lives in this
      // session's workspace, never in the user's project.
      if (shouldOpenInCode(path) && session?.id) {
        openCode(artifactTab(path, session.id))
      } else setRail({ kind: 'preview', path })
    },
    [openCode, session?.id]
  )
  const [ask, setAsk] = useState<{
    requestId: string
    request: ReturnType<typeof parseAskRequest>
  } | null>(null)

  const {
    containerRef: reasoningContainerRef,
    isAtBottom: isReasoningAtBottom,
    handleScroll: handleReasoningScroll,
    forceScrollToBottom: forceScrollReasoningToBottom,
  } = useAutoScroll()


  // Saved definitions name the `task` tool's options. Loaded once: the list is
  // only advertised, so a definition added mid-session applies at the next run.
  useEffect(() => {
    let alive = true
    void listSubagents().then((defs) => {
      if (alive) setSubagentDefs(defs)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!folder) {
      setGitBranch(null)
      return
    }
    invoke<string | null>('agent_git_branch', { project: folder })
      .then(setGitBranch)
      .catch(() => setGitBranch(null))
  }, [folder])

  // `JAN.md` at the attached root: the one instructions file Jan reads. Read
  // through the same root-contained reader the code panel uses, so it cannot
  // become a way to pull in a file from outside the attached folder. A missing
  // file is the normal case and simply leaves the prompt without the block.
  useEffect(() => {
    if (!folder) {
      setProjectInstructions(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const dataFolder = await serviceHub.app().getJanDataFolder()
        if (!dataFolder || !alive) return
        const file = await projectReadFile(dataFolder, folder, 'JAN.md', false)
        if (!alive) return
        setProjectInstructions(
          file.oversized || file.binary ? null : file.content
        )
      } catch {
        // No JAN.md is the ordinary case; the prompt simply omits the block.
        if (alive) setProjectInstructions(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [folder, serviceHub])

  // Selected-code references staged by “Add to chat”: the visible prompt gets
  // the concise `@path:start-end` token, and the refs wait here until submit,
  // when the model's copy of the message is expanded with the selected text.
  const pendingRefs = useRef<CodeRef[]>([])
  // Cleared when the session changes *or* when the attached project does: a
  // reference carries the bytes and the path of the project it was taken
  // from, and sending it after a switch would label another project's source
  // as this one's.
  useEffect(() => {
    pendingRefs.current = []
  }, [session?.id, folder])

  const addCodeToChat = useCallback((ref: CodeRef) => {
    pendingRefs.current = [
      ...pendingRefs.current.filter(
        (existing) => codeRefToken(existing) !== codeRefToken(ref)
      ),
      ref,
    ]
    const { prompt, setPrompt } = usePrompt.getState()
    const token = codeRefToken(ref)
    if (!prompt.includes(token)) {
      setPrompt(prompt ? `${prompt.trimEnd()} ${token} ` : `${token} `)
    }
  }, [])

  const attachFolder = useCallback(async () => {
    const picked = await serviceHub.dialog().open({ directory: true })
    if (typeof picked !== 'string') return
    const sid = ensureCurrentSession()
    useCoworkSessions.getState().setFolder(sid, picked)
  }, [serviceHub])

  const detachFolder = useCallback(() => {
    if (session?.id) useCoworkSessions.getState().setFolder(session.id, null)
  }, [session?.id])

  // `liveTurns` holds only the rows this run has produced — `commitTurns`
  // appends them — so the committed transcript has to be shown alongside it or
  // the conversation disappears the moment a follow-up run starts.
  const displayedTurns = useMemo(
    () =>
      running
        ? [...(session?.turns ?? []), ...liveTurns]
        : (session?.turns ?? []),
    [running, liveTurns, session?.turns]
  )
  const uiMessages = useMemo(
    () => coworkTurnsToUIMessages(displayedTurns, session?.id ?? 'cowork'),
    [displayedTurns, session?.id]
  )

  const usage = liveUsage ?? session?.lastUsage ?? null
  const tokenSource = useMemo(
    () => ({
      threadId: session?.id,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    }),
    [session?.id, usage]
  )

  // Live runs write into the run store; a committed session carries its own.
  const liveSubagents = useCoworkRun((s) =>
    session?.id ? s.subagents[session.id] : undefined
  )
  const fileDiffs = useMemo(
    () =>
      collectCodeFileDiffs(
        displayedTurns,
        liveSubagents ?? session?.subagents ?? []
      ),
    [displayedTurns, liveSubagents, session?.subagents]
  )

  // Read-only working-tree status for the attached repo, loaded lazily and kept
  // strictly separate from the sandbox diffs above. The chip's counts combine
  // both sources so it appears whenever either has changes.
  const git = useCoworkGitStatus(folder)
  const changeCounts = useMemo(() => {
    const sandboxAdds = fileDiffs.reduce((s, f) => s + f.additions, 0)
    const sandboxDels = fileDiffs.reduce((s, f) => s + f.deletions, 0)
    const gitFiles = git.status?.files.length ?? 0
    return {
      fileCount: fileDiffs.length + gitFiles,
      additions: sandboxAdds + (git.status?.additions ?? 0),
      deletions: sandboxDels + (git.status?.deletions ?? 0),
    }
  }, [fileDiffs, git.status])

  // Background shell jobs, polled here rather than inside the Activity panel:
  // the chip derives its counts from the same list, and polling only while the
  // panel was open let the two disagree — a collected job still spinning in the
  // chip while the panel showed it finished.
  const [liveJobs, setLiveJobs] = useState<LiveJob[]>([])
  useEffect(() => {
    let alive = true
    const poll = () => {
      void bashJobsList()
        .then((jobs) => {
          if (alive) setLiveJobs(jobs)
        })
        .catch(() => {
          // No backend (web build, or the command unavailable): the list still
          // shows what the transcript knows.
        })
    }
    poll()
    const id = setInterval(poll, JOB_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // The one activity record. The panel, the chip and every inline workflow
  // card select from this, so none of them can disagree about the same work.
  const activityWorkflows = useCoworkActivity((s) => s.workflows)
  const activityTasks = useCoworkActivity((s) => s.tasks)
  const activity = useMemo(
    () => ({ workflows: activityWorkflows, tasks: activityTasks }),
    [activityWorkflows, activityTasks]
  )
  const workflowViews = useMemo(
    () => sessionWorkflows(activity, session?.id),
    [activity, session?.id]
  )
  const taskCounts = useMemo(
    () => sessionTotals(activity, session?.id),
    [activity, session?.id]
  )

  // The backend is the authority on whether a backgrounded shell is still
  // running: the agent may not collect a job for many turns, and until it does
  // nothing else would ever settle that row.
  useEffect(() => {
    const state = useCoworkActivity.getState()
    for (const job of liveJobs) {
      if (!job.finished) continue
      const task = findTaskByJob(state, job.jobId)
      if (task && task.status === 'running') {
        state.patchTask(task.id, { status: 'done', endedAt: Date.now() })
      }
    }
  }, [liveJobs])

  // Advances the cards' elapsed labels. Only while work is live: an idle
  // conversation must not re-render every second.
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const activityActive = taskCounts.running + taskCounts.queued > 0
  useEffect(() => {
    if (!activityActive) return
    const id = setInterval(() => setActivityNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [activityActive])

  // A task the inline card asked the panel to reveal.
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  const [focusWorkflowId, setFocusWorkflowId] = useState<string | null>(null)
  const showTaskInPanel = useCallback((task: ActivityTask) => {
    setRail({ kind: 'tasks' })
    setFocusWorkflowId(task.workflowId)
    setFocusTaskId(task.id)
  }, [])
  const showWorkflowInPanel = useCallback((workflowId: string) => {
    setRail({ kind: 'tasks' })
    setFocusTaskId(null)
    setFocusWorkflowId(workflowId)
  }, [])

  // Whether the run still holds a controller for an agent task. Consulted
  // rather than assumed, so a Stop control is only offered where pressing it
  // would reach something.
  const sessionId = session?.id
  const agentReachable = useCallback(
    (task: ActivityTask) =>
      sessionId != null && hasSubagent(sessionId, task.id),
    [sessionId]
  )

  const applyCancel = useCallback(
    (task: ActivityTask, result: Awaited<ReturnType<typeof cancelTaskRequest>>) => {
      const patch = patchForOutcome(result, Date.now())
      if (patch) useCoworkActivity.getState().patchTask(task.id, patch)
      return patch != null
    },
    []
  )

  const cancelTask = useCallback(
    async (task: ActivityTask) => {
      if (!session?.id) return
      const result = await cancelTaskRequest(session.id, task)
      // Nothing was stopped. Say which of the reasons it was rather than
      // leaving the row looking as though the click did nothing.
      if (!applyCancel(task, result)) toast.info(cancelMessage(result, t))
    },
    [session?.id, applyCancel, t]
  )

  const cancelWorkflowTasks = useCallback(
    async (view: WorkflowView) => {
      if (!session?.id) return
      const outcome = await cancelWorkflowRequest(session.id, view, {
        agentReachable,
      })
      const byId = new Map(view.tasks.map((task) => [task.id, task]))
      for (const result of outcome.results) {
        const task = byId.get(result.taskId)
        if (task) applyCancel(task, result)
      }
      // Honest about a partial result: some children stopped, some did not.
      if (outcome.failed > 0) {
        toast.info(
          t('common:tasks.stopWorkflowPartial', {
            cancelled: outcome.cancelled,
            failed: outcome.failed,
          })
        )
      }
    },
    [session?.id, agentReachable, applyCancel, t]
  )

  const awaitingModel = useMemo(
    () => awaitsModel(running, displayedTurns),
    [running, displayedTurns]
  )

  const pushLive = useCallback((turns: CoworkTurn[]) => {
    liveTurnsRef.current = [...liveTurnsRef.current, ...turns]
    setLiveTurns(liveTurnsRef.current)
  }, [])

  /**
   * Drive one request. `text` is null for a resume — a retry after a failure
   * re-runs the committed history rather than re-sending the question, which
   * would leave the model reading it twice.
   */
  const runRequest = async (text: string | null) => {
    if (running) return
    const sid = ensureCurrentSession()
    const store = useCoworkSessions.getState()
    const current = store.sessions.find((s) => s.id === sid)
    if (!text && !(current?.messages?.length ?? 0)) return
    if (!selectedModel?.id) {
      toast.error(t('common:selectModel'))
      return
    }
    // Without tool calling the transport drops the tool set silently, and the
    // agent then narrates work it never did. Refusing up front is honest; a
    // toolless "agent" run is worse than no run.
    if (!selectedModel.capabilities?.includes('tools')) {
      toast.error(t('common:modelNoTools', { model: selectedModel.id }))
      return
    }
    if (text && current?.title === 'New session')
      store.setTitle(sid, text.slice(0, 40))

    setStoppedBy(null)
    setRunError(undefined)
    setLiveUsage(null)
    liveTurnsRef.current = text ? [{ role: 'user', content: text }] : []
    setLiveTurns(liveTurnsRef.current)
    useCoworkRun.getState().resetSubagents(sid)
    setRunning(true)

    // Local models load before the first token, but only on a cold start. Probe
    // the engine so the load card shows on a real load, not on every warm run.
    if (selectedProvider === 'llamacpp') {
      try {
        const loaded = await getLoadedModels()
        if (!loaded.includes(selectedModel.id)) {
          useAppState.getState().updateModelLoadProgress(undefined)
          useAppState.getState().updateLoadingModel(true)
        }
      } catch {
        // Probe failed; skip the card rather than flash it every run.
      }
    }

    // Warm the sandbox probe: the transport's prompt and tool set read it
    // synchronously via sandboxEnforces().
    await getSandboxStatus()
    // Read once per run, not subscribed: the advertised set is frozen for the
    // run anyway, so a mid-run flip in Settings would only desync the prompt.
    const webSearch = useWebSearchConfig.getState().webSearchEnabled
    const transport = new CoworkChatTransport(sid, {
      planMode: current?.planMode ?? false,
      subagentNames: subagentDefs.map((d) => d.name),
      // Always on at depth 0, even with nothing saved: a one-off subagent with
      // an inline `system_prompt` is first-class, as it is in Rust.
      allowSubagents: true,
      webSearch,
      workspacePath,
      readOnlyFolder: current?.folder ?? null,
      gitBranch,
      projectInstructions,
    })
    await transport.refreshTools()

    const controller = new AbortController()
    abortRef.current = controller
    // One run, one workflow id. Registering the run is what makes stopping it —
    // as a whole, or one dispatched child at a time — actually reach anything.
    const runId = crypto.randomUUID()
    beginRun(sid, runId, controller)
    const run: RunContext = {
      sessionId: sid,
      runId,
      // The turn's own question, or the one being taken again.
      title: text || lastUserQuestion(current?.messages) || t('common:tasks.untitledRun'),
      model: selectedModel.id,
    }

    const sink: StreamSink = {
      onText: (delta) => {
        const last = liveTurnsRef.current[liveTurnsRef.current.length - 1]
        if (last && last.role === 'assistant') {
          last.content += delta
          setLiveTurns([...liveTurnsRef.current])
        } else {
          pushLive([{ role: 'assistant', content: delta }])
        }
      },
      onToolStart: (callId, name) =>
        pushLive([
          { role: 'tool', content: '', callId, name, status: 'running' },
        ]),
      onToolArgsDelta: () => {},
      onToolCall: (call) => {
        const row = liveTurnsRef.current.find(
          (turn) => turn.callId === call.toolCallId
        )
        if (row) {
          row.args = call.input
          setLiveTurns([...liveTurnsRef.current])
        }
        // A shell command is background work the moment it starts, and its
        // arguments are the only place the command line exists.
        const command = commandOf(call.input)
        if (command) {
          recordShellDispatch(run, {
            callId: call.toolCallId,
            command,
            anchorMessageId: anchorMessageId(),
          })
        }
      },
    }

    const baseMessages = current?.messages ?? []
    // The message this run's work is reported under, named by the same rule the
    // transcript conversion uses. Read at dispatch rather than guessed up
    // front: the block's id depends on which turn opened it, and only the
    // first dispatch's answer is kept, so the conversation shows exactly one
    // card per workflow.
    const anchorMessageId = () =>
      assistantAnchorId(
        [
          ...(useCoworkSessions.getState().sessions.find((s) => s.id === sid)
            ?.turns ?? []),
          ...liveTurnsRef.current,
        ],
        sid
      )
    // The transcript shows `text` as typed; the model additionally receives the
    // staged code references expanded under it (exact path, line range and the
    // selected source). Only content the user explicitly selected travels.
    const modelText = text ? expandCodeRefs(text, pendingRefs.current) : text
    pendingRefs.current = []
    const messages = text
      ? [
          ...baseMessages,
          {
            id: `${sid}-user-${baseMessages.length}`,
            role: 'user',
            parts: [{ type: 'text', text: modelText }],
          } as any,
        ]
      : [...baseMessages]

    let outcome: RunOutcome | null = null
    let thrown: Pick<RunOutcome, 'stoppedBy' | 'errorText'> | null = null
    try {
      outcome = await runTurn({
        messages,
        signal: controller.signal,
        // Starts at zero each request, matching Rust: `SessionBudget` is built
        // inside `run_orchestration_streamed`, so the allowance is per request.
        // The previous turn's `total_tokens` is a context size, not a spend, and
        // seeding with it would pre-charge the whole replayed prompt.
        sessionTokens: 0,
        deps: {
          sendStep: (msgs, signal) =>
            transport.sendMessages({
              chatId: sid,
              messages: msgs,
              abortSignal: signal,
              trigger: 'submit-message',
              messageId: undefined,
            } as any),
          dispatch: (call) =>
            dispatchCoworkTool(call, {
              sessionId: sid,
              readOnlyFolder: current?.folder ?? null,
              planMode: current?.planMode ?? false,
              webSearch,
              onTodo: async (input) => {
                const result = applyTodoOp(
                  useCoworkSessions
                    .getState()
                    .sessions.find((s) => s.id === sid)?.todos,
                  input
                )
                if (result.error) {
                  return { output: `ERROR: ${result.error}`, isError: true }
                }
                useCoworkSessions.getState().setTodos(sid, result.list)
                return { output: renderTodoResult(result.list) }
              },
              onAsk: (callId, input) =>
                new Promise<ToolOutcome>((resolve) => {
                  const parsed = parseAskRequest(input)
                  if (typeof parsed === 'string') {
                    resolve({ output: `ERROR: ${parsed}`, isError: true })
                    return
                  }
                  setAsk({ requestId: callId, request: parsed })
                  askResolvers.current.set(callId, (answers) => {
                    setAsk(null)
                    resolve(renderAskResult(answers))
                  })
                }),
              onTask: async (callId, input) => {
                const req = parseSubagentRequest(input)
                if (typeof req === 'string') {
                  return { output: `ERROR: ${req}`, isError: true }
                }
                const resolved = resolveSubagent(
                  req,
                  subagentDefs,
                  parentToolNames(transport.advertisedTools)
                )
                if ('error' in resolved) {
                  return { output: `ERROR: ${resolved.error}`, isError: true }
                }
                if (!transport.model) {
                  return {
                    output:
                      'ERROR: no model is loaded for this run, so no subagent can start',
                    isError: true,
                  }
                }
                // Recorded before the child starts: the dispatch is the only
                // moment the agent name, description and model are known
                // together, and the record has to exist for the queue position
                // that arrives next to land on something.
                recordAgentDispatch(run, {
                  callId,
                  agentName: resolved.name,
                  description: req.description,
                  model: selectedModel.id,
                  anchorMessageId: anchorMessageId(),
                })
                // Its own controller, chained to the run's, so this one child
                // can be stopped without stopping the turn.
                const childTaskId = taskIdFor(sid, runId, callId)
                const childAbort = registerSubagent(sid, childTaskId)
                const stopChild = () => childAbort.abort('cancelled')
                controller.signal.addEventListener('abort', stopChild, {
                  once: true,
                })
                const activity = useCoworkActivity.getState()
                /**
                 * Record how this child actually ended.
                 *
                 * A child stopped by the run's own Stop is cancelled, not
                 * failed: the abort is why it ended. Anything already settled
                 * — the panel's per-task Stop writes `cancelled` first — keeps
                 * the status it has, because the guard in `updateTask` refuses
                 * to overwrite a finished one.
                 */
                const settleChild = (isError: boolean, output?: string) => {
                  const aborted = childAbort.signal.aborted
                  useCoworkActivity.getState().patchTask(childTaskId, {
                    ...(output != null ? { output } : {}),
                    status: aborted
                      ? ('cancelled' as const)
                      : isError
                        ? ('error' as const)
                        : ('done' as const),
                    endedAt: Date.now(),
                    ...(aborted ? { detail: CANCELLED_BY_USER } : {}),
                  })
                }
                try {
                  const child = await runSubagent({
                  resolved,
                  description: req.description,
                  // The parent's instance: a second one would mean a second
                  // llama-server load for the same model.
                  model: transport.model,
                  parentTools: transport.advertisedTools,
                  system: {
                    workspacePath,
                    readOnlyFolder: current?.folder ?? null,
                    bashAvailable: sandboxEnforces(),
                  },
                  signal: childAbort.signal,
                  sessionTokens: 0,
                  // A child never gets `todo`/`ask`/`task`, so these refuse
                  // rather than execute: a model can still emit a call to a
                  // tool that was never advertised.
                  dispatch: (call) =>
                    dispatchCoworkTool(call, {
                      sessionId: sid,
                      readOnlyFolder: current?.folder ?? null,
                      planMode: current?.planMode ?? false,
                      webSearch,
                      onTodo: async () => ({
                        output:
                          'The todo list belongs to the agent that dispatched you.',
                        isError: true,
                      }),
                      onAsk: async () => ({
                        output:
                          'You cannot ask the user questions. Decide, and say what you assumed.',
                        isError: true,
                      }),
                      onTask: async () => ({
                        output: 'A subagent cannot dispatch subagents.',
                        isError: true,
                      }),
                    }),
                  events: {
                    onQueued: (waiting) => {
                      useCoworkRun
                        .getState()
                        .queueSubagent(sid, callId, resolved.name, waiting)
                      activity.patchTask(childTaskId, {
                        status: 'queued',
                        waiting,
                      })
                    },
                    onStart: () => {
                      useCoworkRun
                        .getState()
                        .startSubagent(sid, callId, resolved.name)
                      activity.patchTask(childTaskId, {
                        status: 'running',
                        waiting: undefined,
                        startedAt: Date.now(),
                      })
                    },
                    onInner: (event) => {
                      useCoworkRun
                        .getState()
                        .routeIntoSubagent(sid, callId, event)
                      // Mirrored onto the record so the panel can show the
                      // child's own trace without reaching into the run store.
                      const turns = (
                        useCoworkRun.getState().subagents[sid] ?? []
                      ).find((one) => one.runId === callId)?.turns
                      if (turns) {
                        activity.patchTask(childTaskId, {
                          transcript: turns,
                          toolCount: countToolCalls(turns),
                        })
                      }
                    },
                    onEnd: (usage) => {
                      useCoworkRun.getState().endSubagent(sid, callId, usage)
                      // Usage only. `onEnd` fires for *every* ending — an
                      // abort before the child even starts, a failed model
                      // step, an exhausted step budget — so writing a terminal
                      // status here would record every one of them as success,
                      // and the finished-status guard would then refuse the
                      // real outcome that arrives a moment later.
                      activity.patchTask(childTaskId, {
                        usage: usage ?? undefined,
                      })
                    },
                  },
                })
                useCoworkRun
                  .getState()
                  .attachSubagentOutput(sid, callId, child.output)
                settleChild(Boolean(child.isError), child.output)
                return { output: child.output, isError: child.isError }
                } finally {
                  controller.signal.removeEventListener('abort', stopChild)
                  unregisterSubagent(sid, childTaskId)
                  // A throw from the dispatch would otherwise leave the record
                  // running with nothing left to finish it.
                  settleChild(true)
                }
              },
            }),
          sink,
          onStep: ({ result, turns, outcomes }) => {
            if (result.usage) setLiveUsage(result.usage)
            // Replace the optimistic running rows with the settled ones so the
            // transcript shows results, not spinners.
            liveTurnsRef.current = liveTurnsRef.current.filter(
              (turn) =>
                !(turn.role === 'tool' && outcomes.has(turn.callId ?? '')) &&
                !(turn.role === 'assistant' && turn.content === result.text)
            )
            pushLive(turns)
            for (const [callId, outcome] of outcomes) {
              if (outcome.diff) {
                useToolCallRuntime.getState().recordDiff(callId, outcome.diff)
              }
              const turn = turns.find(
                (one) => one.role === 'tool' && one.callId === callId
              )
              if (turn?.name !== 'bash') continue
              // A collecting call settles the command it collects, which is a
              // different row; a plain call settles its own.
              const collecting = collectedJobId(turn.args)
              if (collecting) recordJobCollected(collecting, outcome)
              else recordShellOutcome(run, callId, outcome)
            }
          },
          nextMessageId: (() => {
            let n = baseMessages.length
            return () => `${sid}-asst-${n++}`
          })(),
        },
      })
    } catch (e) {
      // The runner turns a failed step into an outcome, so this is the last
      // resort — a fault in the loop itself. Either way it is not a tool call,
      // and rendering it as one claimed the agent had run something.
      thrown = isAbortLike(e, controller.signal)
        ? { stoppedBy: 'aborted' }
        : {
            stoppedBy: 'error',
            errorText: e instanceof Error ? e.message : String(e),
          }
    } finally {
      useAppState.getState().updateLoadingModel(false)
      endRun(sid, runId)
      // Nothing can still be running once the turn is over: the streams are
      // closed and the dispatch loop has stopped awaiting them. Settle before
      // closing the workflow, so its status is derived from settled children.
      // This run's orphans only — scoped to its own workflow, and leaving a
      // backgrounded shell job alone: the process is still running, and
      // marking it cancelled would be false at the moment it was written and
      // unrepairable afterwards.
      useCoworkActivity.getState().settleRun(runId, INTERRUPTED_BY_RUN_END)
      useCoworkActivity.getState().finishWorkflow(runId)
      useCoworkSessions
        .getState()
        .commitTurns(
          sid,
          liveTurnsRef.current,
          outcome?.messages ?? messages,
          useCoworkRun.getState().subagents[sid] ?? [],
          outcome?.usage ?? undefined
        )
      liveTurnsRef.current = []
      setLiveTurns([])
      setRunning(false)
      abortRef.current = null
      askResolvers.current.clear()
      setAsk(null)
      setStoppedBy(thrown?.stoppedBy ?? outcome?.stoppedBy ?? null)
      setRunError(thrown?.errorText ?? outcome?.errorText)
    }
  }

  // Read through a ref so the memoized message rows keep a stable callback
  // while still calling the current render's closure.
  const runRequestRef = useRef(runRequest)
  runRequestRef.current = runRequest

  const handleSubmit = (text: string) => void runRequest(text)

  /**
   * Take the last turn again. Rewinding to the question and resuming is the
   * whole operation — an agent turn is a chain of tool calls, so regenerating
   * means discarding that chain, not re-sending the question after it.
   */
  const handleRegenerate = useCallback(() => {
    if (running || !session?.id) return
    useCoworkSessions.getState().rewindToLastUser(session.id)
    void runRequestRef.current(null)
  }, [running, session?.id])

  const abortRef = useRef<AbortController | null>(null)
  const askResolvers = useRef(
    new Map<string, (answers: AskAnswer[] | null) => void>()
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort('cancelled')
    if (session?.id) abortRun(session.id)
    for (const resolve of askResolvers.current.values()) resolve(null)
    askResolvers.current.clear()
  }, [session?.id])

  const respondAsk = useCallback(
    (requestId: string, answers: AskAnswer[] | null) => {
      const resolve = askResolvers.current.get(requestId)
      askResolvers.current.delete(requestId)
      if (resolve) resolve(answers)
      else if (session?.id) answerAsk(session.id, requestId, answers)
    },
    [session?.id]
  )

  // A run outlives this component, so unmounting must not stop it.
  useEffect(() => () => useCoworkRun.getState().clearPendingPreview(), [])

  // The artifacts library selects a session, parks the path here and navigates.
  // Consumed once, so returning to Cowork later does not reopen it.
  const pendingPreview = useCoworkRun((s) => s.pendingPreview)
  useEffect(() => {
    if (!pendingPreview || !session?.id) return
    if (pendingPreview.sessionId !== session.id) return
    setRail({ kind: 'preview', path: pendingPreview.path })
    useCoworkRun.getState().clearPendingPreview()
  }, [pendingPreview, session?.id])

  // Nothing to show once the session changes: every panel describes the session
  // it was opened from.
  //
  // Only a real switch closes the rail. Opening the Code or Activity rail with
  // no session yet *creates* one (ensureCurrentSession), which moved
  // `session?.id` from null to a fresh id in the same commit — and this effect
  // then closed the rail the click had just opened, so the first click did
  // nothing and only a second one worked.
  const lastSessionId = useRef(session?.id)
  useEffect(() => {
    const previous = lastSessionId.current
    lastSessionId.current = session?.id
    if (previous != null && previous !== session?.id) setRail(null)
  }, [session?.id])

  return (
    <div className="flex flex-col h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))]">
      <HeaderPage>
        <div className="flex items-center justify-between w-full pr-2">
          <DropdownModelProvider useLastUsedModel />
        </div>
      </HeaderPage>

      <div className="flex flex-1 h-full overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden">
          <div className="flex-1 relative">
            {displayedTurns.length === 0 ? (
              <CoworkEmptyState
                folder={folder}
                onPick={(text) => usePrompt.getState().setPrompt(text)}
              />
            ) : (
              <Conversation className="absolute inset-0 text-start">
                <ConversationContent
                  className={cn('mx-auto w-full md:w-4/5 xl:w-4/6')}
                >
                  <CodeOpenProvider open={openToolPath}>
                  {uiMessages.map((message, i) => (
                    <Fragment key={message.id}>
                      <MessageItem
                        message={message}
                        isFirstMessage={i === 0}
                        isLastMessage={i === uiMessages.length - 1}
                        status={running ? 'streaming' : 'ready'}
                        onRegenerate={handleRegenerate}
                        reasoningContainerRef={reasoningContainerRef}
                        isReasoningAtBottom={isReasoningAtBottom}
                        onReasoningScroll={handleReasoningScroll}
                        onReasoningScrollToBottom={forceScrollReasoningToBottom}
                      />
                      {/* One card per workflow, at the message its first
                        dispatch landed under. Same store as the panel, so it
                        is live without a copy of anything. */}
                      {(() => {
                        const view = workflowAnchoredAt(
                          activity,
                          session?.id,
                          message.id
                        )
                        return view ? (
                          <CoworkWorkflowCard
                            view={view}
                            now={activityNow}
                            onOpenTask={showTaskInPanel}
                            onOpenPanel={showWorkflowInPanel}
                          />
                        ) : null
                      })()}
                      {/* Derived from the message's own write parts, so nothing
                        shared with the chat surface needs to know artifacts
                        exist. */}
                      {artifactsFromParts(message.parts).map((artifact) => (
                        <CoworkArtifactCard
                          key={artifact.path}
                          artifact={artifact}
                          root={workspacePath}
                          onPreview={showPreview}
                        />
                      ))}
                    </Fragment>
                  ))}
                  </CodeOpenProvider>
                  {running && (
                    // Row wrapper as in the chat route: the transcript is a
                    // column flex, which stretches the indicator's own
                    // `inline-flex` box across the whole column.
                    <div className="flex flex-row items-center gap-2">
                      <PromptProgress
                        hideIdle={!awaitingModel}
                        stateKey={session?.id}
                      />
                    </div>
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
                  {stoppedBy === 'error' && (
                    <CoworkRunNotice
                      kind="error"
                      message={runError}
                      onRetry={() => void runRequest(null)}
                    />
                  )}
                  {stoppedBy === 'tokens' && (
                    <CoworkBudgetNotice
                      kind="tokens"
                      onCompact={() => toast.info(t('common:budget.compact'))}
                      onNewSession={() =>
                        useCoworkSessions.getState().createSession()
                      }
                    />
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className="pb-4 shrink-0">
            <div className="mx-auto w-full md:w-4/5 xl:w-4/6">
              {ask && typeof ask.request !== 'string' && (
                <div className="px-1 pb-2">
                  <CoworkAskCard
                    requestId={ask.requestId}
                    request={ask.request}
                    onRespond={respondAsk}
                  />
                </div>
              )}
              <ChatInput
                showSpeedToken={false}
                initialMessage={true}
                scopeKey={session?.id}
                ownsToolSet={false}
                onSubmit={handleSubmit}
                onStop={handleStop}
                chatStatus={running ? 'streaming' : 'ready'}
                tokenSource={tokenSource}
                surfaceControls={
                  <>
                    <CoworkPlanToggle
                      planMode={planMode}
                      onChange={(next) => {
                        if (session?.id)
                          useCoworkSessions
                            .getState()
                            .setPlanMode(session.id, next)
                      }}
                    />
                    <CoworkWorkspacePill
                      folder={folder}
                      gitBranch={gitBranch}
                      onAttach={() => void attachFolder()}
                      onDetach={detachFolder}
                    />
                    <CoworkSandboxChip />
                    <CoworkChangesChip
                      fileCount={changeCounts.fileCount}
                      additions={changeCounts.additions}
                      deletions={changeCounts.deletions}
                      open={rail?.kind === 'diff'}
                      onToggle={() =>
                        setRail((r) =>
                          r?.kind === 'diff' ? null : { kind: 'diff' }
                        )
                      }
                    />
                    <CoworkTasksChip
                      totals={taskCounts}
                      open={rail?.kind === 'tasks'}
                      onToggle={() =>
                        setRail((r) =>
                          r?.kind === 'tasks' ? null : { kind: 'tasks' }
                        )
                      }
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-pressed={rail?.kind === 'code'}
                          aria-label={t('common:codePanel.title')}
                          onClick={() => {
                            // The panel is per-session and renders nothing
                            // without one, so opening it before the first
                            // message used to press the button and show
                            // nothing at all. Same session guarantee the
                            // artifact route into Code already makes.
                            if (rail?.kind !== 'code') ensureCurrentSession()
                            setRail((r) =>
                              r?.kind === 'code' ? null : { kind: 'code' }
                            )
                          }}
                          className={cn(
                            'shrink-0',
                            rail?.kind === 'code' && 'text-primary'
                          )}
                        >
                          <Code2 className="size-3.5 shrink-0" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('common:codePanel.title')}
                      </TooltipContent>
                    </Tooltip>
                    <div className="ml-auto flex items-center">
                      <SkillSelector folder={folder} />
                    </div>
                  </>
                }
              />
            </div>
          </div>
        </div>

        {rail?.kind === 'preview' && (
          <CoworkPreviewPanel
            root={workspacePath}
            path={rail.path}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'diff' && (
          <CoworkDiffPanel
            sandboxFiles={fileDiffs}
            folder={folder}
            git={git}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'tasks' && (
          <CoworkTasksPanel
            workflows={workflowViews}
            totals={taskCounts}
            focusWorkflowId={focusWorkflowId}
            focusTaskId={focusTaskId}
            onFocusHandled={() => {
              setFocusTaskId(null)
              setFocusWorkflowId(null)
            }}
            agentReachable={agentReachable}
            onCancelTask={cancelTask}
            onCancelWorkflow={cancelWorkflowTasks}
            onClearFinished={() => {
              if (session?.id) {
                useCoworkActivity.getState().clearFinished(session.id)
              }
            }}
            onClose={() => setRail(null)}
          />
        )}
        {rail?.kind === 'code' && session?.id && (
          <CoworkCodePanel
            folder={folder}
            workspacePath={workspacePath}
            sessionKey={session.id}
            state={session.codePanel}
            turns={displayedTurns}
            onStateChange={(next) =>
              useCoworkSessions.getState().setCodePanel(session.id, next)
            }
            onAddToChat={addCodeToChat}
            onAttach={() => void attachFolder()}
            onClose={() => setRail(null)}
          />
        )}
      </div>
    </div>
  )
}
