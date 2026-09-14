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
import { PanelRight, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useThreads } from '@/hooks/useThreads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useMessages } from '@/hooks/useMessages'
import { useTokensCount } from '@/hooks/useTokensCount'
import { useChatSessions } from '@/stores/chat-session-store'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ExtensionManager } from '@/lib/extension'
import { extractFilesFromPrompt, type FileMetadata } from '@/lib/fileMetadata'
import { classifyModelLocation } from '@/lib/modelLocation'
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
import { TermHint } from '@/containers/TermHint'
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
  const threadMessages = useMessages((s) => s.messages?.[threadId])
  const { tokenCount, maxTokens, percentage } = useTokensCount(
    threadMessages ?? [],
    { threadId }
  )
  const compact = (n: number) =>
    new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n)
  const percent =
    typeof percentage === 'number'
      ? Math.max(0, Math.min(100, Math.round(percentage)))
      : undefined

  return (
    <section
      className="border-b border-border px-4 py-3"
      data-testid="context-window"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('context:contextWindow.title')}
        </h3>
        <span className="text-xs text-ink-2 tabular-nums">
          {tokenCount > 0 && maxTokens
            ? t('context:contextWindow.usedOf', {
                used: compact(tokenCount),
                max: compact(maxTokens),
              })
            : tokenCount > 0
              ? t('context:contextWindow.used', { used: compact(tokenCount) })
              : t('context:contextWindow.unknown')}
        </span>
      </div>
      {percent !== undefined && tokenCount > 0 && (
        <div
          role="img"
          aria-label={t('context:contextWindow.meter', { percent })}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent"
        >
          <div
            className={cn(
              'h-full rounded-full motion-safe:transition-[width]',
              percent > 85 ? 'bg-warning' : 'bg-brand-fill'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
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
      variant="ghost"
      size="sm"
      data-testid="what-jan-is-using"
      aria-pressed={open}
      aria-expanded={open}
      aria-controls={controls}
      title={t('context:open')}
      onClick={onToggle}
      className={cn(
        'shrink-0 text-ink-2 hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:h-11',
        className
      )}
    >
      <PanelRight className="size-4" aria-hidden />
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

  const currentProject = thread?.metadata?.project
  const sections = useMemo(
    () =>
      summarizeChatContext({
        model: {
          id: selectedModel?.id,
          provider: selectedProvider,
          location: provider
            ? classifyModelLocation({
                baseUrl: provider.base_url,
                builtInEngine: Boolean(isLocalProvider(provider.provider)),
              })
            : 'unknown',
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
      className="border-b border-border px-4 py-3 last:border-b-0"
    >
      <h3
        id={`${tabsId}-context-${section.id}`}
        className="text-xs font-medium text-muted-foreground"
      >
        {t(`context:section.${section.id}`)}
      </h3>
      {section.items.length === 0 ? (
        <p className="mt-1.5 text-xs text-ink-2">
          {t(`context:empty.${section.emptyReason}`)}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {section.items.map((item) => (
            <li
              key={item.key}
              className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2"
              data-testid={`context-item-${item.key}`}
              data-state={item.state}
            >
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words text-sm text-foreground">
                  <span>{labelFor(item)}</span>
                  {item.detail ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                </p>
                {item.scope && (
                  <p className="text-xs text-muted-foreground">
                    {t(`context:scope.${item.scope}`)}
                  </p>
                )}
                {item.reason && (
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
                    {t(`context:reason.${item.reason}`)}
                  </p>
                )}
                {item.action && (
                  <Button
                    size="sm"
                    variant="link"
                    className="h-auto px-0 text-xs text-brand-text pointer-coarse:min-h-11"
                    onClick={() => runAction(item.action!, item)}
                  >
                    {t(`context:action.${item.action}`)}
                  </Button>
                )}
              </div>
              <StateChip
                state={item.state}
                label={t(`context:state.${item.state}`)}
              />
            </li>
          ))}
        </ul>
      )}
      {section.notices?.map((notice) => (
        <p
          key={notice.key}
          role="note"
          className="mt-2 text-xs leading-relaxed text-ink-2"
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
          <p className="mb-1 text-xs font-medium text-brand-text">
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
          'relative flex h-10 items-center gap-1.5 px-2 text-[13px] font-medium whitespace-nowrap transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11',
          selected
            ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-brand-fill'
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
    <aside
      id={id}
      aria-label={t('context:title')}
      data-testid="what-jan-is-using-panel"
      className={cn(
        'flex min-h-0 flex-col border-l border-border bg-sunken',
        className
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {t('context:details')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-ink-2 hover:text-foreground pointer-coarse:size-11"
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label={t('context:refresh')}
          title={t('context:refresh')}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-ink-2 hover:text-foreground pointer-coarse:size-11"
          onClick={onClose}
          aria-label={t('context:closeDetails')}
          title={t('context:closeDetails')}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div
        role="tablist"
        aria-label={t('context:tabs.label')}
        className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-2"
      >
        {tabButton('using', t('context:tabs.using'))}
        {tabButton('files', t('context:tabs.files'), fileCount)}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4">
        <div
          role="tabpanel"
          id={`${tabsId}-panel-using`}
          aria-labelledby={`${tabsId}-tab-using`}
          hidden={tab !== 'using'}
        >
          <p className="border-b border-border px-4 py-3 text-xs leading-relaxed text-ink-2">
            {t('context:description')} <TermHint term="context" />
          </p>
          {payload.map(renderSection)}
          <ContextWindowMeter threadId={threadId} />
          {included.length > 0 && (
            <h3 className="px-4 pt-3 text-[13px] font-semibold text-foreground">
              {t('context:included')}
            </h3>
          )}
          {included.map(renderSection)}
        </div>
        <div
          role="tabpanel"
          id={`${tabsId}-panel-files`}
          aria-labelledby={`${tabsId}-tab-files`}
          hidden={tab !== 'files'}
        >
          {attachments.map(renderSection)}
        </div>
      </div>
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
