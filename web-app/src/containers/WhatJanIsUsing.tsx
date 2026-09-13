import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useNavigate } from '@tanstack/react-router'
import { ExtensionTypeEnum, type VectorDBExtension } from '@janhq/core'
import {
  memoryRecordGet,
  type MemoryScope,
  type MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useThreads } from '@/hooks/useThreads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useChatSessions } from '@/stores/chat-session-store'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ExtensionManager } from '@/lib/extension'
import { extractFilesFromPrompt, type FileMetadata } from '@/lib/fileMetadata'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isLocalProvider } from '@/lib/utils'
import {
  summarizeChatContext,
  type ContextAction,
  type ContextItem,
} from '@/lib/contextSummary'
import { TermHint } from '@/containers/TermHint'

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

/**
 * A plain summary of what a chat conversation is using: model and where it
 * runs, instructions, attachments, saved memory and tools, each labelled with
 * how much is actually known (available, chosen, or sent).
 */
export function WhatJanIsUsing({
  threadId,
  messages,
}: {
  threadId: string
  messages: UIMessage[]
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const [open, setOpen] = useState(false)

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
  const [refreshKey, setRefreshKey] = useState(0)

  const temporary = threadId === TEMPORARY_CHAT_ID
  const memory = open ? (transport?.memoryUsed() ?? null) : null

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

  const injectedIds = memory?.injectedIds.join(',') ?? ''
  useEffect(() => {
    if (!open || !injectedIds) {
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
      const views: MemoryView[] = []
      for (const id of injectedIds.split(',').slice(0, MAX_MEMORY_LOOKUPS)) {
        // The retrieval result names ids, not scopes; the record lives in
        // exactly one of them.
        for (const scope of MEMORY_SCOPES) {
          try {
            views.push(
              await memoryRecordGet({ dataFolder, sessionId: threadId }, scope, id)
            )
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
  }, [open, injectedIds, threadId, serviceHub, refreshKey])

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
          setOpen(false)
          navigate({ to: route.settings.memory })
          return
        case 'open-tool-settings':
          setOpen(false)
          navigate({ to: route.settings.mcp_servers })
          return
        case 'open-assistant-settings':
          setOpen(false)
          navigate({ to: route.settings.assistant })
          return
        case 'open-provider-settings':
          setOpen(false)
          if (selectedProvider) {
            navigate({
              to: route.settings.providers,
              params: { providerName: selectedProvider },
            })
          }
      }
    },
    [navigate, selectedProvider, setAttachments, threadId]
  )

  const labelFor = (item: ContextItem) =>
    item.labelIsKey ? t(`context:label.${item.label}`) : item.label

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="what-jan-is-using">
          {t('context:open')}
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('context:title')}</SheetTitle>
          <SheetDescription className="text-xs leading-normal">
            {t('context:description')}{' '}
            <TermHint term="context" />
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4 space-y-5 text-sm">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            {t('context:refresh')}
          </Button>
          {sections.map((section) => (
            <section
              key={section.id}
              aria-labelledby={`context-${section.id}`}
              data-testid={`context-section-${section.id}`}
            >
              <h3 id={`context-${section.id}`} className="font-medium">
                {t(`context:section.${section.id}`)}
              </h3>
              {section.items.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-1">
                  {t(`context:empty.${section.emptyReason}`)}
                </p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {section.items.map((item) => (
                    <li key={item.key} className="rounded-md border p-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span className="break-words font-medium">
                          {labelFor(item)}
                          {item.detail ? (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {item.detail}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`context:state.${item.state}`)}
                          {item.scope ? ` · ${t(`context:scope.${item.scope}`)}` : ''}
                        </span>
                      </div>
                      {item.reason && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t(`context:reason.${item.reason}`)}
                        </p>
                      )}
                      {item.action && (
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto px-0 text-xs"
                          onClick={() => runAction(item.action!, item)}
                        >
                          {t(`context:action.${item.action}`)}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {section.id === 'memory' && section.items.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('context:memoryScopeNote')}
                </p>
              )}
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
