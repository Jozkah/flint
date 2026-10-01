// `RemoteExtras` over the app's stores: every value is what the desktop's own
// control reads (ComposerEffort, ContextWindowCard, WhatJanIsUsing,
// CoworkCodePanel, CoworkPreviewPanel, the Hugging Face hub), and every action
// is the call that control makes.

import type { ThreadMessage } from '@janhq/core'
import { projectListDir, projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useAssistant, defaultAssistant } from '@/hooks/useAssistant'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useHardware } from '@/hooks/useHardware'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  EFFORT_SETTING_KEY,
  effortOf,
  effortProfile,
  isThinkingOff,
} from '@/lib/modelEffort'
import { isOverridden, resolveModel } from '@/lib/modelOverrides'
import { reconcileBreakdown } from '@/lib/contextBreakdown'
import { DEFAULT_COMPACTION_POLICY, effectiveReserve, getCompactionPolicy } from '@/lib/compactionPolicy'
import { usableContextValue } from '@/lib/modelCapabilities'
import { readTokenUsage } from '@/lib/tokenUsage'
import { speedStats } from '@/lib/tokenSpeed'
import { summarizeChatContext } from '@/lib/contextSummary'
import { extractFilesFromPrompt } from '@/lib/fileMetadata'
import { attributionOf, requestAttributions } from '@/lib/requestAttribution'
import type { ScopedMemoryRetrieved } from '@/lib/memoryBinding'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isLocalProvider } from '@/lib/utils'
import { forkThread } from '@/lib/forkThread'
import { regenerateTitle } from '@/lib/regenerateTitle'
import { regenerateCoworkTitle, regenerateRoomTitle } from '@/lib/regenerateSessionTitle'
import { canCompactChat, requestChatCompaction } from '@/lib/chatCompaction'
import { roomController } from '@/lib/rooms/controller'
import { JEV_ROUTABLE_ASSISTANT_IDS } from '@/lib/jevRouting'
import { collectCodeFileDiffs, changedLines } from '@/lib/coworkDiffs'
import { detectLanguage, relativeToRoot } from '@/lib/coworkCode'
import { artifactsFromTurns } from '@/lib/coworkArtifacts'
import { MAX_PREVIEW_BYTES, previewKindFor } from '@/lib/coworkPreview'
import {
  getHuggingFaceFiles,
  groupHuggingFaceFiles,
  modelIdForGroup,
  quantPreference,
  searchHuggingFaceModels,
  type HuggingFaceFileGroup,
} from '@/lib/huggingface'
import { startGgufBundle } from '@/lib/huggingfaceStart'
import { coworkTurnsOf } from './sources'
import type { RemoteExtras } from './extras'
import type {
  ChatDetails,
  CoworkPreviewResult,
  EffortLevelWire,
  HfModelCard,
  UsingSection,
} from './protocol'

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

const t = (key: string, values?: Record<string, unknown>) => i18n.t(key, values) as string
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

async function dataFolder(): Promise<string> {
  const folder = await getServiceHub().app().getJanDataFolder()
  if (!folder) throw new Error('The data folder is not available')
  return folder
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const appExtras: RemoteExtras = {
  chatDetails: async (id): Promise<ChatDetails | null> => {
    const thread = useThreads.getState().threads[id]
    if (!thread) return null
    const { ref, provider, model } = modelOf(id)
    const messages = useMessages.getState().getMessages(id) ?? []

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
        const meta = m.metadata as { tokenSpeed?: { tokenSpeed: number; durationMs?: number; tokenCount?: number }; usage?: unknown } | undefined
        const ts = meta?.tokenSpeed
        return ts
          ? { tokenSpeed: ts.tokenSpeed, durationMs: ts.durationMs, tokenCount: readTokenUsage(meta?.usage)?.outputTokens ?? ts.tokenCount }
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

  clearRoom: async (id, scope) => {
    await roomController.clearRoom(id, scope)
  },

  // CoworkCodePanel's explorer and viewer: the attached project, read-only.
  coworkFiles: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    if (!folder) return { root: null, entries: [], truncated: false }
    const listing = await projectListDir(await dataFolder(), folder, path)
    return { root: folder, entries: listing.entries, truncated: listing.truncated }
  },

  coworkFile: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    const diffs = collectCodeFileDiffs(found.turns, found.subagents)
    const touched = diffs.map((d) => relativeToRoot(folder, d.path))
    const diff = diffs.find((d) => relativeToRoot(folder, d.path) === path)
    const changed: Record<number, 'add' | 'mod'> = {}
    for (const [line, mark] of Object.entries(changedLines(diff))) {
      changed[Number(line)] = mark.removed ? 'mod' : 'add'
    }
    const base = { path, changed, language: detectLanguage(path).label, touched }
    if (!folder) return { ...base, status: 'missing', content: '' }
    try {
      const file = await projectReadFile(await dataFolder(), folder, path, false)
      if (file.oversized) return { ...base, status: 'oversized', content: '' }
      if (file.binary) return { ...base, status: 'binary', content: '' }
      return { ...base, status: 'ready', content: file.content }
    } catch (e) {
      const message = messageOf(e)
      return {
        ...base,
        status: message.startsWith('SENSITIVE:') ? 'sensitive' : message.startsWith('DENIED') ? 'denied' : 'missing',
        content: '',
      }
    }
  },

  // CoworkPreviewPanel: the session's artifacts, the chosen one's text.
  coworkPreview: async (id, path) => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const folder = found.session.folder
    const artifacts = artifactsFromTurns(found.turns, folder)
      .map((a) => relativeToRoot(folder, a.path))
      .filter((p) => ['html', 'svg', 'markdown', 'text'].includes(previewKindFor(p)))
    const chosen = path ?? [...artifacts].reverse().find((p) => previewKindFor(p) === 'html') ?? artifacts[artifacts.length - 1] ?? null
    const empty: CoworkPreviewResult = { artifacts, path: chosen, kind: null, content: null }
    if (!chosen) return empty
    const raw = previewKindFor(chosen)
    const kind: CoworkPreviewResult['kind'] = raw === 'html' || raw === 'svg' || raw === 'markdown' || raw === 'text' || raw === 'image' ? raw : 'other'
    if (!folder) return { ...empty, kind, note: 'This session has no folder to read the preview from.' }
    if (kind === 'image' || kind === 'other') return { ...empty, kind, note: 'Open this preview on the computer.' }
    try {
      const file = await projectReadFile(await dataFolder(), folder, chosen, false)
      if (file.oversized || file.binary || file.content.length > MAX_PREVIEW_BYTES) {
        return { ...empty, kind, note: 'This file is too large to preview on the phone.' }
      }
      return { ...empty, kind, content: file.content }
    } catch (e) {
      return { ...empty, kind, note: messageOf(e) }
    }
  },

  hfSearch: async ({ query, modality }) => {
    const token = useGeneralSetting.getState().huggingfaceToken || undefined
    const found = await searchHuggingFaceModels(query ?? '', token, 'gguf')
    const gpus = useHardware.getState().hardwareData?.gpus ?? []
    const best = gpus.reduce((a, g) => (g.total_memory > (a?.total_memory ?? 0) ? g : a), gpus[0])
    // The hardware store holds megabytes.
    const vramBytes = best ? best.total_memory * 1024 * 1024 : 0
    const installed = new Set(
      useModelProvider.getState().getProviderByName('llamacpp')?.models.map((m) => m.id) ?? []
    )
    const matches = (tags: string[], pipeline: string | null | undefined) => {
      const all = [...tags, pipeline ?? ''].join(' ').toLowerCase()
      switch (modality) {
        case 'vision': return /image|vision|multimodal|vl\b/.test(all)
        case 'audio': return /audio|speech|asr|tts/.test(all)
        case 'code': return /code|coder/.test(all)
        case 'embeddings': return /embed|feature-extraction|sentence/.test(all)
        case 'text': return /text-generation|conversational|chat/.test(all)
        default: return true
      }
    }
    const models: HfModelCard[] = found
      .filter((m) => !m.disabled && matches(m.tags, m.pipelineTag))
      .slice(0, 30)
      .map((m) => {
        const groups = groupHuggingFaceFiles(m.files).filter((g) => g.kind === 'model')
        return {
          repo: m.id,
          author: m.author ?? m.id.split('/')[0] ?? null,
          downloads: m.downloads,
          likes: m.likes,
          tags: m.tags.slice(0, 8),
          pipelineTag: m.pipelineTag ?? null,
          installed: groups.some((g) => installed.has(modelIdForGroup(m.id, g))),
          variants: [...groups]
            .sort((a, b) => quantPreference(b.quantization) - quantPreference(a.quantization))
            .slice(0, 3)
            .map((g) => ({
              quant: g.quantization ?? g.primary.name,
              sizeBytes: g.totalSize,
              fits: g.totalSize && vramBytes ? g.totalSize * 1.15 < vramBytes : null,
            })),
        }
      })
    return { models, device: best ? { name: best.name, vramBytes } : null }
  },

  // HuggingFaceDownloadAction's GGUF path: the preferred variant unless named.
  hfDownload: async (repo, quant) => {
    const token = useGeneralSetting.getState().huggingfaceToken || undefined
    const groups = groupHuggingFaceFiles(await getHuggingFaceFiles(repo, token))
    const models = groups.filter((g) => g.kind === 'model')
    const group: HuggingFaceFileGroup | undefined = quant
      ? models.find((g) => g.quantization === quant || g.primary.name === quant)
      : [...models].sort((a, b) => quantPreference(b.quantization) - quantPreference(a.quantization))[0]
    if (!group) throw new Error('This repository has no GGUF file to download.')
    const modelId = modelIdForGroup(repo, group)
    const bundleId = `hf:llamacpp:${modelId}`
    await startGgufBundle({ bundleId, repo, modelId, group, groups, token, models: getServiceHub().models() })
    return bundleId
  },

  downloads: () =>
    Object.values(useHuggingFaceDownloads.getState().tasks).map((task) => ({
      id: task.id,
      label: task.label,
      status: task.status,
      progress: task.progress,
      downloaded: task.downloaded,
      total: task.total ?? null,
      bytesPerSecond: task.bytesPerSecond ?? null,
    })),
}
