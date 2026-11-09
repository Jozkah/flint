// `RemoteExtras` for chats: what the composer's effort and assistant
// controls, the context card and WhatJanIsUsing read, and what they do.

import type { ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { getActiveMessages } from '@/hooks/useActiveMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useAssistant, defaultAssistant } from '@/hooks/useAssistant'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useMCPServers } from '@/hooks/useMCPServers'
import { EFFORT_SETTING_KEY, effortOf, effortProfile, isThinkingOff } from '@/lib/modelEffort'
import { isOverridden, resolveModel } from '@/lib/modelOverrides'
import { reconcileBreakdown } from '@/lib/contextBreakdown'
import {
  DEFAULT_COMPACTION_POLICY,
  effectiveReserve,
  getCompactionPolicy,
} from '@/lib/compactionPolicy'
import { usableContextValue } from '@/lib/modelCapabilities'
import { readTokenUsage } from '@/lib/tokenUsage'
import { speedStats, type SpeedSource } from '@/lib/tokenSpeed'
import { summarizeChatContext } from '@/lib/contextSummary'
import { extractFilesFromPrompt } from '@/lib/fileMetadata'
import { attributionOf, requestAttributions } from '@/lib/requestAttribution'
import type { ScopedMemoryRetrieved } from '@/lib/memoryBinding'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isLocalProvider } from '@/lib/utils'
import { forkThread } from '@/lib/forkThread'
import { BRANCH_CHANGED_EVENT, selectVersion as selectBranchVersion } from '@/lib/branchSelect'
import { regenerateTitle } from '@/lib/regenerateTitle'
import { regenerateCoworkTitle, regenerateRoomTitle } from '@/lib/regenerateSessionTitle'
import { canCompactChat, requestChatCompaction } from '@/lib/chatCompaction'
import { JEV_ROUTABLE_ASSISTANT_IDS } from '@/lib/jevRouting'
import type { RemoteExtras } from './extras'
import type { ChatDetails, EffortLevelWire, UsingSection } from './protocol'
import { t } from './appExtrasShared'

/** The context card's Tailwind swatches as colours a phone can draw. */
const SWATCH: Record<string, string> = {
  'bg-blue-500': '#3b82f6',
  'bg-orange-500': '#f97316',
  'bg-emerald-500': '#10b981',
  'bg-amber-500': '#f59e0b',
  'bg-violet-500': '#8b5cf6',
  'bg-slate-400': '#94a3b8',
  'bg-fuchsia-400': '#e879f9',
}

const isRoutable = (id: string) => (JEV_ROUTABLE_ASSISTANT_IDS as readonly string[]).includes(id)

function modelOf(threadId: string) {
  const ref = useThreads.getState().threads[threadId]?.model
  const state = useModelProvider.getState()
  const provider = ref?.provider ? state.getProviderByName(ref.provider) : undefined
  const model = ref?.id ? provider?.models.find((m) => m.id === ref.id) : undefined
  return { ref, provider, model }
}

function memoryFrom(messages: ThreadMessage[], threadId: string): ScopedMemoryRetrieved | null {
  let attribution: ReturnType<typeof attributionOf> = requestAttributions.latest(threadId) ?? null
  for (let i = messages.length - 1; !attribution && i >= 0; i--) {
    if (messages[i].role === 'assistant') attribution = attributionOf(messages[i])
  }
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

/** Chats: details, effort, assistant, forks, versions, compaction and titles. */
export const chatExtras: Pick<RemoteExtras, 'chatDetails' | 'setChatEffort' | 'setChatAssistant' | 'assistants' | 'forkChat' | 'selectVersion' | 'compactChat' | 'regenerateTitle'> = {
  chatDetails: async (id): Promise<ChatDetails | null> => {
    // The full assistant: the listed one may be a summary without instructions.
    await useThreads.getState().ensureThreadHydrated?.(id)
    const thread = useThreads.getState().threads[id]
    if (!thread) return null
    const { ref, provider, model } = modelOf(id)
    const messages = getActiveMessages(id)

    // Effort: ChatInput's `effortProfile` and the chat's own override.
    const profile = effortProfile(ref?.provider, model)
    const overrides = useModelOverrides.getState().byThread[id]
    const resolved = model ? resolveModel(model, overrides) : undefined
    const effort: ChatDetails['effort'] = profile.levels.length
      ? {
          levels: profile.levels as EffortLevelWire[],
          recommended: (profile.recommended ?? null) as EffortLevelWire | null,
          canDisable: profile.canDisable,
          value: profile.canDisable && isThinkingOff(resolved) ? 'off' : effortOf(resolved),
          overridden: isOverridden(overrides, EFFORT_SETTING_KEY) || isOverridden(overrides, 'reasoning'),
        }
      : null

    // The context window, as TokenCounter feeds ContextWindowCard.
    let usage: ReturnType<typeof readTokenUsage>
    for (let i = messages.length - 1; i >= 0 && !usage?.totalTokens; i--) {
      usage = readTokenUsage((messages[i].metadata as { usage?: unknown } | undefined)?.usage)
    }
    const stored = useContextBreakdown.getState().byId[id]
    const windowTokens = usableContextValue(model?.settings?.ctx_len?.controller_props?.value)
    const policy = await getCompactionPolicy().catch(() => DEFAULT_COMPACTION_POLICY)
    const reconciled = stored ? reconcileBreakdown(stored, usage?.totalTokens) : null
    const used = reconciled?.usedTokens ?? usage?.totalTokens ?? 0
    const context: ChatDetails['context'] =
      used > 0 || windowTokens
        ? {
            usedTokens: used,
            windowTokens: windowTokens ?? null,
            autoCompactOn: policy.auto,
            buffer: windowTokens && policy.auto ? effectiveReserve(windowTokens, policy) : 0,
            segments: (reconciled?.segments ?? []).map((s) => ({
              id: s.id,
              label: s.label,
              tokens: s.tokens,
              color: SWATCH[s.color] ?? '#71717a',
            })),
          }
        : null

    const speed = speedStats(
      messages.map((m) => {
        const meta = m.metadata as { tokenSpeed?: { tokenSpeed: number; durationMs?: number; tokenCount?: number; source?: SpeedSource }; usage?: unknown } | undefined
        const ts = meta?.tokenSpeed
        return ts
          ? { tokenSpeed: ts.tokenSpeed, durationMs: ts.durationMs, source: ts.source, tokenCount: readTokenUsage(meta?.usage)?.outputTokens ?? ts.tokenCount }
          : undefined
      })
    )

    // What Flint is using: the same summary the desktop panel renders.
    const sentFiles = messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => (m.content ?? []).flatMap((c) => (c.type === 'text' && c.text?.value ? extractFilesFromPrompt(c.text.value).files : [])))
    const assistant = thread.assistants?.[0]
    const tools = useAppState.getState().tools ?? []
    const sections = summarizeChatContext({
      model: {
        id: ref?.id,
        provider: ref?.provider,
        location: provider
          ? classifyModelLocation({ baseUrl: provider.base_url, builtInEngine: Boolean(isLocalProvider(provider.provider)) })
          : 'unknown',
      },
      assistant: { name: assistant?.name, hasInstructions: Boolean(assistant?.instructions?.trim()) },
      sentFiles,
      pendingFiles: useChatAttachments.getState().getAttachments(id) ?? [],
      indexedFiles: null,
      temporary: Boolean(thread.metadata?.isTemporary),
      memory: memoryFrom(messages, id),
      memoryViews: [],
      tools: {
        modelSupportsTools: model?.capabilities?.includes('tools') ?? false,
        known: tools.map((tool) => `${tool.server}::${tool.name}`),
        disabled: useToolAvailable.getState().disabledTools ?? [],
      },
      attribution: requestAttributions.latest(id) ?? null,
    }).map(
      (s): UsingSection => ({
        id: s.id,
        title: t(`context:section.${s.id}`),
        items: s.items.map((item) => ({
          label: item.labelIsKey ? t(`context:label.${item.label}`) : item.label,
          ...(item.detail ? { detail: item.detail } : {}),
          state: t(`context:state.${item.state}`),
        })),
        ...(s.emptyReason ? { empty: t(`context:empty.${s.emptyReason}`) } : {}),
      })
    )

    // A server the user mentioned (`@github`) that is switched off.
    const mentioned = new Set(
      messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => (m.content ?? []).flatMap((c) => (c.type === 'text' ? [...(c.text?.value ?? '').matchAll(/@([\w.-]+)/g)].map((x) => x[1]) : [])))
    )
    const servers = useMCPServers.getState().mcpServers
    const serversOff = Object.entries(servers)
      .filter(([name, cfg]) => cfg.active === false && mentioned.has(name))
      .map(([name]) => name)

    const routedId = thread.metadata?.jevRoutedAssistantId
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    const lastUsage = last ? readTokenUsage((last.metadata as { usage?: unknown } | undefined)?.usage) : undefined
    return {
      id,
      model: ref?.id && ref.provider ? { id: ref.id, provider: ref.provider, name: model?.name || ref.id } : null,
      modelMissing: Boolean(ref?.id && !model),
      assistant: {
        id: assistant?.id ?? 'none',
        name: assistant?.name ?? 'None',
        auto: Boolean(assistant && (assistant.id === 'jan' || assistant.id === routedId)),
      },
      effort,
      context,
      speed: { last: speed.last ?? null, average: speed.average ?? null },
      lastRequest: lastUsage
        ? {
            ...(lastUsage.inputTokens !== undefined ? { inputTokens: lastUsage.inputTokens } : {}),
            ...(lastUsage.outputTokens !== undefined ? { outputTokens: lastUsage.outputTokens } : {}),
            ...(lastUsage.cachedInputTokens !== undefined ? { cachedInputTokens: lastUsage.cachedInputTokens } : {}),
          }
        : null,
      sections,
      serversOff,
      files: sentFiles.map((f) => ({ name: f.name, state: 'Attached' })),
      canCompact: canCompactChat(id),
    }
  },

  // ChatInput's setEffort, scoped to the chat.
  setChatEffort: (id, choice) => {
    const o = useModelOverrides.getState()
    if (choice === null) {
      o.clearForThread(id, EFFORT_SETTING_KEY)
      o.clearForThread(id, 'reasoning')
      return
    }
    if (choice === 'off') {
      o.setForThread(id, 'reasoning', 'off')
      return
    }
    const { model } = modelOf(id)
    if (model && isThinkingOff(resolveModel(model, o.byThread[id]))) o.setForThread(id, 'reasoning', 'auto')
    o.setForThread(id, EFFORT_SETTING_KEY, choice)
  },

  // Auto is Flint, which Jev may route; any other choice pins the chat.
  setChatAssistant: (id, choice) => {
    const all = useAssistant.getState().assistants
    const next = choice === 'auto' ? (all.find((a) => a.id === 'jan') ?? defaultAssistant) : all.find((a) => a.id === choice)
    if (!next) return
    const threads = useThreads.getState()
    const thread = threads.threads[id]
    const metadata = { ...(thread?.metadata ?? {}) }
    delete metadata.jevRoutedAssistantId
    threads.updateThread(id, { assistants: [next], metadata })
  },
  assistants: () => ({
    assistants: useAssistant.getState().assistants.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      builtIn: isRoutable(a.id),
    })),
    routing: useAutomationSettings.getState().routeAssistants,
  }),
  forkChat: (id, messageId) => forkThread(id, messageId),
  selectVersion: (id, messageId, dir) => {
    // A reply being written is on the path; moving it under the stream would
    // attach the reply to the wrong version.
    const app = useAppState.getState()
    if (app.busyThreads[id] || app.currentStreamThreadId === id) return false
    if (!selectBranchVersion(id, messageId, dir)) return false
    window.dispatchEvent(
      new CustomEvent(BRANCH_CHANGED_EVENT, { detail: { threadId: id } })
    )
    return true
  },
  compactChat: (id) => requestChatCompaction(id),
  regenerateTitle: async (kind, id) => {
    try {
      if (kind === 'chat') return await regenerateTitle(id)
      if (kind === 'cowork') return await regenerateCoworkTitle(id)
      return await regenerateRoomTitle(id)
    } catch {
      return 'failed'
    }
  },
}
