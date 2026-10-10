import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { ExtensionTypeEnum, type VectorDBExtension } from '@janhq/core'
import {
  memoryRecordGet,
  type MemoryScope,
  type MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'
import { ChevronDown, PanelRight, RefreshCw, X } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import {
  AutoCompactRow,
  ChatActivityFrame,
  ChatChangesFrame,
  ChatToolsFrame,
} from '@/containers/ChatDetailsCards'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useThreads } from '@/hooks/useThreads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAppState } from '@/hooks/useAppState'
import { AgentBrowserWindow } from '@/containers/AgentBrowserWindow'
import { useBrowserToolMirror } from '@/hooks/useBrowserToolMirror'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useActiveMessages } from '@/hooks/useActiveMessages'
import { useTokensCount } from '@/hooks/useTokensCount'
import { useChatSessions } from '@/stores/chat-session-store'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ExtensionManager } from '@/lib/extension'
import { extractFilesFromPrompt, type FileMetadata } from '@/lib/fileMetadata'
import { contextUsage } from '@/lib/contextUsage'
import { useProviderLocations } from '@/hooks/useEndpointLocations'
import { cn, isLocalProvider } from '@/lib/utils'
import {
  evidenceFromSnapshot,
  summarizeChatContext,
  type ContextAction,
  type ContextItem,
  type ContextNotice,
  type ContextSection,
  type SnapshotEvidence,
} from '@/lib/contextSummary'
import {
  janProjectIdOf,
  memoryLocation,
  type ScopedMemoryRetrieved,
} from '@/lib/memoryBinding'
import {
  attributionOf,
  requestAttributions,
  type RequestAttribution,
} from '@/lib/requestAttribution'
import {
  DEFAULT_COMPACTION_POLICY,
  effectiveReserve,
  getCompactionPolicy,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { PromptSnapshotView } from '@/containers/PromptSnapshotView'
import { StatusChip, WorkStatus } from '@/containers/StatusChip'

const MEMORY_SCOPES: MemoryScope[] = ['chat', 'project', 'user']
/** Enough to describe a normal selection; the budget rarely injects more. */
const MAX_MEMORY_LOOKUPS = 12

function sentFilesFrom(messages: UIMessage[]): FileMetadata[] {
  const files: FileMetadata[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.parts ?? []) {
      if (part.type === 'text') {
        files.push(...extractFilesFromPrompt(part.text).files)
      }
    }
  }
  return files
}

/** The newest attribution persisted on an assistant message, after a reload. */
function persistedAttribution(messages: UIMessage[]): RequestAttribution | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const found = attributionOf(messages[i])
    if (found) return found
  }
  return null
}

/** A memory selection rebuilt from an attribution, when no live one exists. */
function memoryFromAttribution(
  attribution: RequestAttribution | null
): ScopedMemoryRetrieved | null {
  if (!attribution || attribution.memory.unavailable) return null
  const m = attribution.memory
  return {
    block: null,
    injectedIds: m.injectedIds,
    injectedHashes: m.injectedHashes,
    conflictIds: m.conflictIds,
    droppedIds: m.droppedIds,
    charsUsed: 0,
    candidateIds: m.candidateIds,
    projectId: m.projectId,
    disabled: m.disabled,
  }
}

type SnapshotRecord = { payload?: unknown; unavailable?: string | null }

type DetailsTab = 'using' | 'files'

/** Items a section shows before "Show all". */
const SECTION_PREVIEW = 3

/**
 * The state of an item or a request as a chip with its own words. Verified is
 * the only success claim; waiting and in-flight states carry an icon; failure
 * is an error. Everything else is a neutral statement of fact.
 */
function StateChip({ state, label }: { state: string; label: string }) {
  switch (state) {
    case 'included-last-request':
    case 'response-started':
      return (
        <StatusChip tone="success" wrap>
          {label}
        </StatusChip>
      )
    case 'pending-next-message':
    case 'request-assembled':
      return (
        <WorkStatus state="waiting" wrap>
          {label}
        </WorkStatus>
      )
    case 'request-sent':
      return (
        <WorkStatus state="running" wrap>
          {label}
        </WorkStatus>
      )
    case 'request-failed':
      return (
        <WorkStatus state="failed" wrap>
          {label}
        </WorkStatus>
      )
    default:
      return (
        <StatusChip tone="neutral" wrap>
          {label}
        </StatusChip>
      )
  }
}

/**
 * How full the context window is, from the same numbers the composer's token
 * counter uses. Remote providers usually report no window size; then only the
 * usage is shown, never a guessed percentage.
 */
function ContextWindowMeter({ threadId }: { threadId: string }) {
  const { t } = useTranslation()
  const threadMessages = useActiveMessages(threadId)
  const { tokenCount, maxTokens } = useTokensCount(
    threadMessages ?? [],
    { threadId }
  )
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const [policy, setPolicy] = useState<CompactionPolicy>(
    DEFAULT_COMPACTION_POLICY
  )
  useEffect(() => {
    let alive = true
    getCompactionPolicy()
      .then((p) => alive && setPolicy(p))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const compact = (n: number) =>
    new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n)
  const exact = (n: number) => n.toLocaleString()

  const known = !!maxTokens && maxTokens > 0
  // The room auto-compact keeps free for the next request: the orange part.
  const reserve =
    known && policy.auto ? effectiveReserve(maxTokens!, policy) : 0
  const usage = contextUsage(tokenCount, maxTokens, reserve)
  const percent = known ? Math.round(usage.pct) : undefined
  const usedPct = usage.pct
  const reservePct = known ? Math.min(100 - usedPct, usage.share(reserve) * 100) : 0
  const free = known ? Math.max(0, maxTokens! - tokenCount - reserve) : 0

  const summary =
    tokenCount > 0 && maxTokens
      ? t('context:contextWindow.usedOf', {
          used: compact(tokenCount),
          max: compact(maxTokens),
        })
      : tokenCount > 0
        ? t('context:contextWindow.used', { used: compact(tokenCount) })
        : t('context:contextWindow.unknown')

  const row = (swatch: string, label: string, value: string) => (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          aria-hidden
          className={cn('inline-block size-2 shrink-0 rounded-full', swatch)}
        />
        {label}
      </span>
      <span className="font-mono text-foreground tabular-nums">{value}</span>
    </div>
  )

  // Used of the window and how full it is, with an arrow to open the split;
  // then one meter of used, auto-compact room and free space, all one height.
  return (
    <section
      className="flex flex-col gap-2.5 px-4 py-3.5"
      data-testid="context-window"
      aria-label={t('context:contextWindow.title')}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center justify-between gap-2 rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11"
      >
        <span className="tabular-nums">{summary}</span>
        <span className="flex items-center gap-1.5">
          {percent !== undefined && tokenCount > 0 && (
            <b className="font-medium text-foreground tabular-nums">
              {`${usage.pct.toFixed(1)}%`}
            </b>
          )}
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
              open && 'rotate-180'
            )}
          />
        </span>
      </button>
      <div
        role="img"
        aria-label={
          percent !== undefined
            ? t('context:contextWindow.meter', { percent })
            : t('context:contextWindow.unknown')
        }
        className="flex h-1.5 w-full shrink-0 overflow-hidden rounded-full bg-track"
      >
        {known && tokenCount > 0 && (
          <>
            <div
              className="h-full bg-grad motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-expo"
              style={{ width: `${usedPct}%` }}
            />
            {reservePct > 0 && (
              <div
                className="h-full bg-warning/80 motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-expo"
                style={{ width: `${reservePct}%` }}
              />
            )}
          </>
        )}
      </div>
      {open && (
        <div
          id={detailsId}
          className="flex flex-col gap-1.5 text-xs"
          data-testid="context-window-details"
        >
          {row('bg-chart-1', t('context:contextWindow.usedLabel'), exact(tokenCount))}
          {known && reserve > 0 &&
            row(
              'bg-warning/80',
              t('context:contextWindow.reserveLabel'),
              exact(reserve)
            )}
          {known && row('bg-track', t('context:contextWindow.freeLabel'), exact(free))}
          {known && (
            <div className="flex items-center justify-between gap-3 border-t border-dashed border-border pt-1.5">
              <span className="text-muted-foreground">
                {t('context:contextWindow.windowLabel')}
              </span>
              <span className="font-mono text-foreground tabular-nums">
                {exact(maxTokens!)}
              </span>
            </div>
          )}
        </div>
      )}
      <AutoCompactRow maxTokens={maxTokens || undefined} />
    </section>
  )
}

/** The Details toggle for the conversation header. */
export function WhatJanIsUsingToggle({
  open,
  onToggle,
  controls,
  className,
}: {
  open: boolean
  onToggle: () => void
  /** The id of the panel this button shows and hides. */
  controls?: string
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="what-jan-is-using"
      aria-pressed={open}
      aria-expanded={open}
      aria-controls={controls}
      title={t('context:open')}
      onClick={onToggle}
      className={cn(
        'h-[30px] shrink-0 aria-pressed:border-border-strong aria-pressed:bg-hover-btn aria-pressed:text-foreground pointer-coarse:h-11',
        className
      )}
    >
      <PanelRight className="size-3.5" aria-hidden />
      <span className="max-sm:sr-only">{t('context:details')}</span>
    </Button>
  )
}

/**
 * A plain summary of what a chat conversation is using: model and where it
 * runs, instructions, attachments, saved memory and tools, each labelled with
 * how much is actually known -- available, retrieved, chosen, or verified in
 * the sanitized copy of the last request.
 *
 * Rendered as the conversation's right-hand inspector. Nothing is loaded
 * while it is closed.
 */
export function WhatJanIsUsingPanel({
  threadId,
  messages,
  open,
  onClose,
  id,
  className,
}: {
  threadId: string
  messages: UIMessage[]
  open: boolean
  onClose: () => void
  id?: string
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const tabsId = useId()
  const [tab, setTab] = useState<DetailsTab>('using')
  // Long sections (every tool of a server) show their first few items.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const thread = useThreads((s) => s.threads[threadId])
  const selectedModel = useModelProvider((s) => s.selectedModel)
  const selectedProvider = useModelProvider((s) => s.selectedProvider)
  const provider = useModelProvider((s) =>
    selectedProvider ? s.getProviderByName(selectedProvider) : undefined
  )
  const pendingFiles = useChatAttachments((s) => s.getAttachments(threadId))
  const setAttachments = useChatAttachments((s) => s.setAttachments)
  const mcpTools = useAppState((s) => s.tools)
  const disabledTools = useToolAvailable((s) => s.disabledTools)
  const transport = useChatSessions((s) => s.sessions[threadId]?.transport)

  const [indexedFiles, setIndexedFiles] = useState<
    { id: string; name?: string; chunk_count?: number }[] | null
  >([])
  const [memoryViews, setMemoryViews] = useState<MemoryView[]>([])
  const [evidence, setEvidence] = useState<SnapshotEvidence>({ status: 'none' })
  const [refreshKey, setRefreshKey] = useState(0)
  // Attribution moves through its send states while the panel is open.
  const [attributionTick, setAttributionTick] = useState(0)
  useEffect(
    () => requestAttributions.subscribe(() => setAttributionTick((n) => n + 1)),
    []
  )

  const temporary = threadId === TEMPORARY_CHAT_ID

  const attribution = useMemo<RequestAttribution | null>(() => {
    if (!open) return null
    return (
      transport?.lastAttribution?.() ??
      requestAttributions.latest(threadId) ??
      persistedAttribution(messages)
    )
    // `attributionTick` re-reads the live registry as a request progresses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transport, threadId, messages, attributionTick, refreshKey])

  const memory = open
    ? ((transport?.memoryUsed() as ScopedMemoryRetrieved | null | undefined) ??
      memoryFromAttribution(attribution))
    : null
  const lastProjectName =
    attribution?.memory.projectName ??
    transport?.memoryBindingForLastRequest?.()?.janProjectName ??
    null

  // Loaded when the panel opens (and on refresh), not on every render.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
          ExtensionTypeEnum.VectorDB
        )
        const files = ext?.listAttachments
          ? await ext.listAttachments(threadId)
          : []
        if (!cancelled) setIndexedFiles(files)
      } catch {
        if (!cancelled) setIndexedFiles(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, threadId, refreshKey])

  // The sanitized snapshot is the evidence for "included". Only its id is
  // held in the renderer; the record is read back from disk, scoped to this
  // conversation.
  const snapshotId = attribution?.snapshotId ?? null
  const snapshotStatus = attribution?.snapshotStatus
  useEffect(() => {
    if (!open) return
    if (!snapshotId) {
      setEvidence(
        snapshotStatus === 'not-captured'
          ? { status: 'unavailable', reason: 'not-captured' }
          : { status: 'none' }
      )
      return
    }
    let cancelled = false
    setEvidence({ status: 'loading' })
    ;(async () => {
      try {
        const found = await invoke<SnapshotRecord[]>('agent_prompt_snapshots', {
          snapshotId,
          session: threadId,
        })
        if (!cancelled) setEvidence(evidenceFromSnapshot(found?.[0] ?? null))
      } catch {
        if (!cancelled) setEvidence({ status: 'unavailable', reason: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, snapshotId, snapshotStatus, threadId, refreshKey])

  const lookupIds = [
    ...(memory?.injectedIds ?? []),
    ...(memory?.candidateIds ?? []).filter(
      (id) => !(memory?.injectedIds ?? []).includes(id)
    ),
  ]
    .slice(0, MAX_MEMORY_LOOKUPS)
    .join(',')
  const lookupProject = janProjectIdOf(memory?.projectId)
  useEffect(() => {
    if (!open || !lookupIds) {
      setMemoryViews([])
      return
    }
    let cancelled = false
    ;(async () => {
      let dataFolder: string | undefined
      try {
        dataFolder = await serviceHub.app().getJanDataFolder()
      } catch {
        return
      }
      if (!dataFolder) return
      // The project the last request used, so its project memories resolve
      // even after the conversation has moved.
      const location = memoryLocation(
        dataFolder,
        { janProjectId: lookupProject },
        threadId
      )
      const views: MemoryView[] = []
      for (const id of lookupIds.split(',')) {
        // The retrieval result names ids, not scopes; the record lives in
        // exactly one of them.
        for (const scope of MEMORY_SCOPES) {
          try {
            views.push(await memoryRecordGet(location, scope, id))
            break
          } catch {
            // Not in this scope.
          }
        }
      }
      if (!cancelled) setMemoryViews(views)
    })()
    return () => {
      cancelled = true
    }
  }, [open, lookupIds, lookupProject, threadId, serviceHub, refreshKey])

  // A host name that is neither localhost nor an address (`v100`) needs the
  // resolver's answer; without it the card said "still checking" for ever.
  const locateProvider = useProviderLocations(
    provider ? [provider] : [],
    (name) => Boolean(isLocalProvider(name))
  )

  const currentProject = thread?.metadata?.project
  const sections = useMemo(
    () =>
      summarizeChatContext({
        model: {
          id: selectedModel?.id,
          provider: selectedProvider,
          location: provider ? locateProvider(provider) : 'unknown',
        },
        assistant: {
          name: thread?.assistants?.[0]?.name,
          hasInstructions: Boolean(thread?.assistants?.[0]?.instructions?.trim()),
        },
        sentFiles: sentFilesFrom(messages),
        pendingFiles,
        indexedFiles,
        temporary,
        memory,
        memoryViews,
        tools: {
          modelSupportsTools:
            selectedModel?.capabilities?.includes('tools') ?? false,
          known: mcpTools.map((tool) => `${tool.server}::${tool.name}`),
          disabled: disabledTools,
        },
        attribution,
        evidence,
        currentProject: currentProject
          ? { id: currentProject.id, name: currentProject.name }
          : null,
        lastProjectName,
      }),
    [
      selectedModel,
      selectedProvider,
      provider,
      thread,
      messages,
      pendingFiles,
      indexedFiles,
      temporary,
      memory,
      memoryViews,
      mcpTools,
      disabledTools,
      attribution,
      evidence,
      currentProject,
      lastProjectName,
      locateProvider,
    ]
  )

  const runAction = useCallback(
    (action: ContextAction, item: ContextItem) => {
      switch (action) {
        case 'remove-pending-attachment':
          setAttachments(threadId, (prev) =>
            prev.filter(
              (file) => `pending:${file.id ?? file.name}` !== item.key
            )
          )
          return
        case 'open-memory-settings':
          onClose()
          navigate({ to: route.settings.memory })
          return
        case 'open-tool-settings':
          onClose()
          navigate({ to: route.settings.mcp_servers })
          return
        case 'open-assistant-settings':
          onClose()
          navigate({ to: route.settings.assistant })
          return
        case 'open-provider-settings':
          onClose()
          if (selectedProvider) {
            navigate({
              to: route.settings.providers,
              params: { providerName: selectedProvider },
            })
          }
      }
    },
    [navigate, onClose, selectedProvider, setAttachments, threadId]
  )

  if (!open) return null

  const labelFor = (item: ContextItem) =>
    item.labelIsKey ? t(`context:label.${item.label}`) : item.label

  const noticeText = (notice: ContextNotice) => {
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(notice.values ?? {})) {
      values[key] = value ?? t('context:notice.noProject')
    }
    return t(`context:notice.${notice.key}`, values)
  }

  const renderSection = (section: ContextSection) => (
    <section
      key={section.id}
      aria-labelledby={`${tabsId}-context-${section.id}`}
      data-testid={`context-section-${section.id}`}
      className="border-b border-dashed border-border py-2.5 last:border-b-0"
    >
      <h3
        id={`${tabsId}-context-${section.id}`}
        className="text-[13px] font-medium text-foreground"
      >
        {t(`context:section.${section.id}`)}
      </h3>
      {section.items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(`context:empty.${section.emptyReason}`)}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5 pt-0.5">
          {(expanded[section.id]
            ? section.items
            : section.items.slice(0, SECTION_PREVIEW)
          ).map((item) => (
            <li
              key={item.key}
              className="flex flex-col items-start gap-1.5"
              data-testid={`context-item-${item.key}`}
              data-state={item.state}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="break-words text-xs text-muted-foreground">
                  <span>{labelFor(item)}</span>
                  {item.detail ? (
                    <>
                      <span aria-hidden className="text-subtle-foreground"> · </span>
                      <span className="text-subtle-foreground">{item.detail}</span>
                    </>
                  ) : null}
                  {item.scope ? (
                    <>
                      <span aria-hidden className="text-subtle-foreground"> · </span>
                      <span className="text-subtle-foreground">
                        {t(`context:scope.${item.scope}`)}
                      </span>
                    </>
                  ) : null}
                </p>
                {item.reason && (
                  <p className="text-[11.5px] leading-snug text-subtle-foreground">
                    {t(`context:reason.${item.reason}`)}
                  </p>
                )}
              </div>
              <StateChip
                state={item.state}
                label={t(`context:state.${item.state}`)}
              />
              {item.action && (
                <Button
                  size="sm"
                  variant="link"
                  className="h-auto px-0 text-[12.5px] text-secondary-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
                  onClick={() => runAction(item.action!, item)}
                >
                  {t(`context:action.${item.action}`)}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {section.items.length > SECTION_PREVIEW && (
        <button
          type="button"
          className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
          aria-expanded={Boolean(expanded[section.id])}
          onClick={() =>
            setExpanded((prev) => ({ ...prev, [section.id]: !prev[section.id] }))
          }
        >
          {expanded[section.id]
            ? t('context:showFewer')
            : t('context:showAll', { count: section.items.length })}
        </button>
      )}
      {section.notices?.map((notice) => (
        <p
          key={notice.key}
          role="note"
          className="mt-2 text-xs leading-relaxed text-muted-foreground"
          data-testid={`context-notice-${notice.key}`}
        >
          {noticeText(notice)}
        </p>
      ))}
      {section.id === 'memory' && section.items.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('context:memoryScopeNote')}
        </p>
      )}
      {section.snapshotId && (
        <div className="mt-3" data-testid="context-inspect-request">
          <p className="mb-1 text-xs font-medium text-foreground">
            {t('context:inspect')}
          </p>
          {/* Advanced and collapsed by default: the sanitized record, read
              back from disk and scoped to this conversation. */}
          <PromptSnapshotView
            snapshotId={section.snapshotId}
            sessionId={threadId}
          />
        </div>
      )}
    </section>
  )

  // The last request leads, then how full the window is, then what went in.
  const payload = sections.filter((s) => s.id === 'payload')
  const included = sections.filter(
    (s) => s.id !== 'payload' && s.id !== 'attachments'
  )
  const attachments = sections.filter((s) => s.id === 'attachments')
  const fileCount = attachments.reduce((n, s) => n + s.items.length, 0)

  const tabButton = (value: DetailsTab, label: string, count?: number) => {
    const selected = tab === value
    return (
      <button
        type="button"
        role="tab"
        id={`${tabsId}-tab-${value}`}
        aria-selected={selected}
        aria-controls={`${tabsId}-panel-${value}`}
        tabIndex={selected ? 0 : -1}
        data-testid={`context-tab-${value}`}
        onClick={() => setTab(value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = value === 'using' ? 'files' : 'using'
          setTab(next)
          document.getElementById(`${tabsId}-tab-${next}`)?.focus()
        }}
        className={cn(
          'relative flex h-9 items-center gap-1.5 px-2 text-[12.5px] font-medium whitespace-nowrap transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11',
          selected
            ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-primary'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {label}
        {count !== undefined && count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </button>
    )
  }

  return (
    // The inspector is a column of Frames beside the conversation: how full
    // the context is, then what went into the last request.
    <aside
      id={id}
      aria-label={t('context:title')}
      data-testid="what-jan-is-using-panel"
      className={cn(
        'flex min-h-0 flex-col gap-4 overflow-x-hidden overflow-y-auto [scrollbar-width:none] motion-safe:animate-fade-in',
        className
      )}
    >
      <Frame
        collapseId="details-context"
        className="shrink-0 motion-safe:animate-rise-in motion-safe:[animation-delay:120ms]"
      >
        <FrameHeader
          icon={<Icon name="analytics" />}
          title={t('context:cards.context')}
          actions={
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                onClick={() => setRefreshKey((k) => k + 1)}
                aria-label={t('context:refresh')}
                title={t('context:refresh')}
              >
                <RefreshCw className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                onClick={onClose}
                aria-label={t('context:closeDetails')}
                title={t('context:closeDetails')}
              >
                <X className="size-4" />
              </Button>
            </>
          }
        />
        <FrameBody>
          <ContextWindowMeter threadId={threadId} />
        </FrameBody>
      </Frame>
      <ChatChangesFrame
        messages={messages}
        className="shrink-0 motion-safe:animate-rise-in motion-safe:[animation-delay:170ms]"
      />
      <Frame
        collapseId="details-using"
        className="shrink-0 motion-safe:animate-rise-in motion-safe:[animation-delay:220ms]"
      >
        <FrameHeader
          icon={<Icon name="x-sparkle" />}
          title={t('context:open')}
        />
        <FrameBody className="overflow-hidden">
          <div
            role="tablist"
            aria-label={t('context:tabs.label')}
            className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-dashed border-border px-2.5"
          >
            {tabButton('using', t('context:tabs.using'))}
            {tabButton('files', t('context:tabs.files'), fileCount)}
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-panel-using`}
            aria-labelledby={`${tabsId}-tab-using`}
            hidden={tab !== 'using'}
          >
            <div className="px-4">
              {included.map(renderSection)}
              {payload.map(renderSection)}
            </div>
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-panel-files`}
            aria-labelledby={`${tabsId}-tab-files`}
            hidden={tab !== 'files'}
          >
            <div className="px-4">{attachments.map(renderSection)}</div>
          </div>
        </FrameBody>
      </Frame>
      <ChatToolsFrame className="shrink-0 motion-safe:animate-rise-in motion-safe:[animation-delay:270ms]" />
      <ChatActivityFrame
        messages={messages}
        modelId={selectedModel?.id}
        className="shrink-0 motion-safe:animate-rise-in motion-safe:[animation-delay:320ms]"
      />
      {/* The agent's own browser, when it has one open: fills what is left of the
          column, like the in-app preview fills its panel. */}
      <AgentBrowserWindow
        sessionId={threadId}
        onHide={() => useBrowserToolMirror.getState().clear(threadId)}
        className="min-h-[300px] flex-1"
      />
    </aside>
  )
}

/**
 * The toggle and its panel together, for a surface that has no conversation
 * layout of its own to place the inspector in.
 */
export function WhatJanIsUsing({
  threadId,
  messages,
}: {
  threadId: string
  messages: UIMessage[]
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <>
      <WhatJanIsUsingToggle
        open={open}
        onToggle={() => setOpen((v) => !v)}
        controls={panelId}
      />
      <WhatJanIsUsingPanel
        id={panelId}
        threadId={threadId}
        messages={messages}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
